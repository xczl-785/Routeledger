export interface ExactCommitOwnerIdentity {
  readonly attemptId: string;
  readonly processId: number;
  readonly processStartedAt: string;
  readonly instanceId: string;
}

export type ExactCommitProcessIdentity = Omit<ExactCommitOwnerIdentity, "attemptId">;

export interface ExactCommitCoordinationRecord {
  readonly commitKey: string;
  readonly owner: ExactCommitOwnerIdentity;
  readonly generation: number;
  readonly leaseExpiresAt: string;
  readonly status: "owned" | "released";
  readonly releasedAt: string | null;
}

export interface ExactCommitCoordinatorState {
  readonly records: Record<string, ExactCommitCoordinationRecord>;
}

export interface ExactCommitOwnershipToken extends ExactCommitCoordinationRecord {}

export type ExactCommitOwnerLiveness = "alive" | "dead" | "unknown";

export type ExactCommitAcquireResult =
  | { readonly ok: true; readonly token: ExactCommitOwnershipToken }
  | {
      readonly ok: false;
      readonly code: "COMMIT_OWNED_BY_LIVE_PROCESS" | "COMMIT_OWNER_LIVENESS_UNKNOWN";
    };

export type ExactCommitRenewResult =
  | { readonly ok: true; readonly token: ExactCommitOwnershipToken }
  | { readonly ok: false; readonly code: "COMMIT_OWNERSHIP_LOST" };

export interface ExactCommitCoordinator {
  acquire(input: {
    readonly commitKey: string;
    readonly attemptId: string;
  }): Promise<ExactCommitAcquireResult>;
  assertOwned(token: ExactCommitOwnershipToken): Promise<boolean>;
  renew(token: ExactCommitOwnershipToken): Promise<ExactCommitRenewResult>;
  release(token: ExactCommitOwnershipToken): Promise<void>;
}

interface MemoryExactCommitCoordinatorOptions {
  readonly state?: ExactCommitCoordinatorState;
  readonly currentProcess: ExactCommitProcessIdentity;
  readonly leaseDurationMs: number;
  readonly now: () => string;
  readonly resolveOwnerLiveness: (
    owner: ExactCommitOwnerIdentity
  ) => Promise<ExactCommitOwnerLiveness>;
}

const clone = <T>(value: T): T => structuredClone(value);

const requireNonEmpty = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new Error(`Exact commit ${field} is required.`);
};

const requireTimestamp = (value: string, field: string): void => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Exact commit ${field} is invalid.`);
  }
};

const requireLeaseDuration = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Exact commit leaseDurationMs is invalid.");
  }
};

const buildLeaseExpiry = (now: string, leaseDurationMs: number): string => {
  const expiresAt = Date.parse(now) + leaseDurationMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000) {
    throw new Error("Exact commit lease expiry is invalid.");
  }
  return new Date(expiresAt).toISOString();
};

const validateOwner = (owner: ExactCommitOwnerIdentity): void => {
  requireNonEmpty(owner.attemptId, "attemptId");
  if (!Number.isSafeInteger(owner.processId) || owner.processId <= 0) {
    throw new Error("Exact commit processId is invalid.");
  }
  requireTimestamp(owner.processStartedAt, "processStartedAt");
  requireNonEmpty(owner.instanceId, "instanceId");
};

const validateRecord = (key: string, record: ExactCommitCoordinationRecord): void => {
  requireNonEmpty(key, "state key");
  requireNonEmpty(record.commitKey, "commitKey");
  if (key !== record.commitKey) throw new Error("Exact commit state key mismatch.");
  validateOwner(record.owner);
  if (!Number.isSafeInteger(record.generation) || record.generation <= 0) {
    throw new Error("Exact commit generation is invalid.");
  }
  requireTimestamp(record.leaseExpiresAt, "leaseExpiresAt");
  if (record.status !== "owned" && record.status !== "released") {
    throw new Error("Exact commit status is invalid.");
  }
  if (record.status === "owned" && record.releasedAt !== null) {
    throw new Error("An owned exact commit cannot have releasedAt.");
  }
  if (record.status === "released") {
    if (record.releasedAt === null) {
      throw new Error("A released exact commit requires releasedAt.");
    }
    requireTimestamp(record.releasedAt, "releasedAt");
  }
};

const ownerMatches = (
  left: ExactCommitOwnerIdentity,
  right: ExactCommitOwnerIdentity
): boolean =>
  left.attemptId === right.attemptId &&
  left.processId === right.processId &&
  left.processStartedAt === right.processStartedAt &&
  left.instanceId === right.instanceId;

const ownershipMatches = (
  record: ExactCommitCoordinationRecord,
  token: ExactCommitOwnershipToken
): boolean =>
  record.status === "owned" &&
  token.status === "owned" &&
  record.commitKey === token.commitKey &&
  record.generation === token.generation &&
  ownerMatches(record.owner, token.owner);

const recordMatches = (
  left: ExactCommitCoordinationRecord | undefined,
  right: ExactCommitCoordinationRecord
): boolean =>
  left !== undefined &&
  ownershipMatches(left, right) &&
  left.leaseExpiresAt === right.leaseExpiresAt &&
  left.releasedAt === right.releasedAt;

export class MemoryExactCommitCoordinator implements ExactCommitCoordinator {
  private readonly records = new Map<string, ExactCommitCoordinationRecord>();
  private readonly now: () => string;
  private readonly resolveOwnerLiveness: (
    owner: ExactCommitOwnerIdentity
  ) => Promise<ExactCommitOwnerLiveness>;

  private readonly currentProcess: ExactCommitProcessIdentity;

  private readonly leaseDurationMs: number;

  constructor(options: MemoryExactCommitCoordinatorOptions) {
    this.now = options.now;
    this.resolveOwnerLiveness = options.resolveOwnerLiveness;
    validateOwner({ ...options.currentProcess, attemptId: "process-validation" });
    this.currentProcess = clone(options.currentProcess);
    requireLeaseDuration(options.leaseDurationMs);
    this.leaseDurationMs = options.leaseDurationMs;
    for (const [key, record] of Object.entries(options.state?.records ?? {})) {
      validateRecord(key, record);
      this.records.set(key, clone(record));
    }
  }

  async acquire(input: {
    readonly commitKey: string;
    readonly attemptId: string;
  }): Promise<ExactCommitAcquireResult> {
    requireNonEmpty(input.commitKey, "commitKey");
    const owner: ExactCommitOwnerIdentity = {
      ...this.currentProcess,
      attemptId: input.attemptId
    };
    validateOwner(owner);

    const now = this.now();
    requireTimestamp(now, "current time");
    let generation = 1;
    while (true) {
      const current = this.records.get(input.commitKey);
      generation = current === undefined ? 1 : current.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new Error("Exact commit generation is exhausted.");
      }
      if (current === undefined || current.status === "released") break;
      if (Date.parse(current.leaseExpiresAt) > Date.parse(now)) {
        return { ok: false, code: "COMMIT_OWNED_BY_LIVE_PROCESS" };
      }
      const liveness = await this.resolveOwnerLiveness(clone(current.owner));
      if (!recordMatches(this.records.get(input.commitKey), current)) {
        continue;
      }
      if (liveness === "alive") {
        return { ok: false, code: "COMMIT_OWNED_BY_LIVE_PROCESS" };
      }
      if (liveness !== "dead") {
        return { ok: false, code: "COMMIT_OWNER_LIVENESS_UNKNOWN" };
      }
      break;
    }

    const token: ExactCommitOwnershipToken = {
      commitKey: input.commitKey,
      owner,
      generation,
      leaseExpiresAt: buildLeaseExpiry(now, this.leaseDurationMs),
      status: "owned",
      releasedAt: null
    };
    this.records.set(input.commitKey, clone(token));
    return { ok: true, token };
  }

  async assertOwned(token: ExactCommitOwnershipToken): Promise<boolean> {
    validateRecord(token.commitKey, token);
    const now = this.now();
    requireTimestamp(now, "current time");
    const current = this.records.get(token.commitKey);
    return (
      current !== undefined &&
      ownershipMatches(current, token) &&
      Date.parse(current.leaseExpiresAt) > Date.parse(now)
    );
  }

  async renew(token: ExactCommitOwnershipToken): Promise<ExactCommitRenewResult> {
    validateRecord(token.commitKey, token);
    const current = this.records.get(token.commitKey);
    if (current === undefined || !ownershipMatches(current, token)) {
      return { ok: false, code: "COMMIT_OWNERSHIP_LOST" };
    }
    const now = this.now();
    requireTimestamp(now, "current time");
    const renewed: ExactCommitOwnershipToken = {
      ...current,
      leaseExpiresAt: buildLeaseExpiry(now, this.leaseDurationMs)
    };
    this.records.set(token.commitKey, clone(renewed));
    return { ok: true, token: renewed };
  }

  async release(token: ExactCommitOwnershipToken): Promise<void> {
    validateRecord(token.commitKey, token);
    const current = this.records.get(token.commitKey);
    if (
      current === undefined ||
      !ownershipMatches(current, token)
    ) {
      return;
    }
    const releasedAt = this.now();
    requireTimestamp(releasedAt, "current time");
    this.records.set(token.commitKey, {
      ...current,
      status: "released",
      releasedAt
    });
  }

  exportState(): ExactCommitCoordinatorState {
    return {
      records: Object.fromEntries(
        [...this.records.entries()].map(([key, record]) => [key, clone(record)])
      )
    };
  }
}
