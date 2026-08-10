import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  digestL3AuthorizationPolicy,
  evaluateL3AuthorizationPolicy,
  validateL3AuthorizationGrant,
  validateL3AuthorizationPolicy,
  type L3AuthorizationConsumptionReceipt,
  type L3ConsumedAuthorizationReplay,
  type L3AuthorizationGrant,
  type L3AuthorizationGrantConsumption,
  type L3AuthorizationGrantConsumeWithReceiptResult,
  type L3AuthorizationGrantConsumeResult,
  type L3AuthorizationGrantContext,
  type L3AuthorizationGrantStore,
  type L3AuthorizationPolicy,
  type L3AuthorizationReceiptBinding
} from "@routeledger/core";

import type {
  RouteLedgerMcpDelegatedAuthorizationAuthority,
  RouteLedgerMcpDelegatedAuthorizationResult
} from "./index.js";

export const LOCAL_L3_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION = 1 as const;

export interface LocalL3AuthorityConfig {
  schemaVersion: typeof LOCAL_L3_AUTHORITY_SCHEMA_VERSION;
  authorityId: string;
  statePath: string;
  policy: L3AuthorizationPolicy;
  grantTtlSeconds: number;
  trustedClientId?: string;
}

export interface LocalL3AuthorityRuntime {
  authority: RouteLedgerMcpDelegatedAuthorizationAuthority;
  grantStore: L3AuthorizationGrantStore;
  trustedClientId?: string;
  configPath: string;
  statePath: string;
  policyDigest: string;
}

export interface LoadLocalL3AuthorityRuntimeInput {
  configPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  hostKind: string;
  subjectId: string;
  /** @internal Test-only hooks for exercising state-lock interruption boundaries. */
  testHooks?: LocalL3AuthorityStateTestHooks;
}

export interface LocalL3AuthorityStateTestHooks {
  afterStateRead?: () => void | Promise<void>;
  heartbeatIntervalMs?: number;
  lockWaitTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface InstallLocalL3AuthorityConfigInput {
  configPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  config: LocalL3AuthorityConfig;
}

interface LocalL3PolicyUsage {
  policyDigest: string;
  ruleId: string;
  uses: number;
  maxUses: number;
  updatedAt: string;
}

interface LocalL3AuthorityState {
  schemaVersion: typeof LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION;
  revision: number;
  activePolicies: Record<string, { policyDigest: string; updatedAt: string }>;
  policyUsages: Record<string, LocalL3PolicyUsage>;
  reservedGrants: Record<string, L3AuthorizationGrant>;
  grants: Record<string, L3AuthorizationGrant>;
  receipts: Record<string, L3AuthorizationConsumptionReceipt>;
}

interface LockMetadata {
  lockId: string;
  createdAt: string;
  updatedAt: string;
  pid: number;
}

interface LocalL3AuthorityStateLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

const emptyState = (): LocalL3AuthorityState => ({
  schemaVersion: LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION,
  revision: 0,
  activePolicies: {},
  policyUsages: {},
  reservedGrants: {},
  grants: {},
  receipts: {}
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isContainedPath = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const realpathForPotentialFile = async (candidate: string): Promise<string> => {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(candidate));
    return path.join(parent, path.basename(candidate));
  }
};

const assertTrustedPath = async (
  candidate: string,
  workspaceRoot: string,
  routeledgerRoot: string,
  label: string
): Promise<string> => {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const [resolvedCandidate, resolvedWorkspace, resolvedRouteLedger] = await Promise.all([
    realpathForPotentialFile(candidate),
    fs.realpath(workspaceRoot),
    fs.realpath(routeledgerRoot)
  ]);
  if (
    isContainedPath(resolvedCandidate, resolvedWorkspace) ||
    isContainedPath(resolvedCandidate, resolvedRouteLedger)
  ) {
    throw new Error(`${label} must stay outside the workspace and RouteLedger root.`);
  }
  return resolvedCandidate;
};

const assertPrivateExistingFile = async (filePath: string, label: string): Promise<void> => {
  const file = await fs.lstat(filePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  if (process.platform !== "win32" && (file.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group-writable or world-writable.`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    file.uid !== process.getuid()
  ) {
    throw new Error(`${label} must be owned by the current OS user.`);
  }
};

const assertPrivateDirectory = async (directoryPath: string, label: string): Promise<void> => {
  const directory = await fs.lstat(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`${label} directory must be a regular directory, not a symlink.`);
  }
  if (process.platform !== "win32" && (directory.mode & 0o022) !== 0) {
    throw new Error(`${label} directory must not be group-writable or world-writable.`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    directory.uid !== process.getuid()
  ) {
    throw new Error(`${label} directory must be owned by the current OS user.`);
  }
};

const validateConfig = (
  value: unknown,
  hostKind: string,
  subjectId: string
): LocalL3AuthorityConfig => {
  if (!isObject(value)) throw new Error("Local L3 authority config must be a JSON object.");
  if (value.schemaVersion !== LOCAL_L3_AUTHORITY_SCHEMA_VERSION) {
    throw new Error("Unsupported local L3 authority config schemaVersion.");
  }
  if (!isNonEmptyString(value.authorityId)) throw new Error("authorityId is required.");
  if (!isNonEmptyString(value.statePath) || !path.isAbsolute(value.statePath)) {
    throw new Error("statePath must be an absolute path.");
  }
  if (
    !Number.isInteger(value.grantTtlSeconds) ||
    (value.grantTtlSeconds as number) < 30 ||
    (value.grantTtlSeconds as number) > 86_400
  ) {
    throw new Error("grantTtlSeconds must be an integer from 30 through 86400.");
  }
  if (value.trustedClientId !== undefined && !isNonEmptyString(value.trustedClientId)) {
    throw new Error("trustedClientId must be a non-empty string when provided.");
  }
  if (!isObject(value.policy)) throw new Error("policy is required.");
  const policy = value.policy as unknown as L3AuthorizationPolicy;
  const validation = validateL3AuthorizationPolicy(policy);
  if (!validation.valid) {
    throw new Error(`Local L3 authority policy is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`);
  }
  if (policy.mode !== "delegated") {
    throw new Error("A local delegated authority config requires policy.mode=delegated.");
  }
  if (policy.binding.subjectId !== subjectId) {
    throw new Error("The policy subject binding must exactly match the trusted approver identity.");
  }
  if (policy.binding.hostKind !== hostKind) {
    throw new Error("The policy host binding must exactly match the configured MCP host profile.");
  }
  if (policy.binding.clientId !== value.trustedClientId) {
    throw new Error("The policy client binding must exactly match trustedClientId.");
  }
  for (const rule of policy.rules.filter((candidate) => candidate.effect === "allow")) {
    if (rule.conditions?.maxUses === undefined || rule.conditions.expiresAt === undefined) {
      throw new Error(`Delegated allow rule ${rule.id} requires maxUses and expiresAt.`);
    }
  }
  return value as unknown as LocalL3AuthorityConfig;
};

const parseState = (value: unknown): LocalL3AuthorityState => {
  if (
    !isObject(value) ||
    value.schemaVersion !== LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION ||
    !Number.isInteger(value.revision) ||
    !isObject(value.activePolicies) ||
    !isObject(value.policyUsages) ||
    !isObject(value.reservedGrants) ||
    !isObject(value.grants) ||
    !isObject(value.receipts)
  ) {
    throw new Error("Local L3 authority state is invalid and cannot be trusted.");
  }
  for (const [authorityId, active] of Object.entries(value.activePolicies)) {
    if (
      !isNonEmptyString(authorityId) ||
      !isObject(active) ||
      !isNonEmptyString(active.policyDigest) ||
      !isNonEmptyString(active.updatedAt) ||
      Number.isNaN(Date.parse(active.updatedAt))
    ) {
      throw new Error("Local L3 authority active-policy state is invalid and cannot be trusted.");
    }
  }
  for (const [usageKey, usage] of Object.entries(value.policyUsages)) {
    if (
      !isNonEmptyString(usageKey) ||
      !isObject(usage) ||
      !isNonEmptyString(usage.policyDigest) ||
      !isNonEmptyString(usage.ruleId) ||
      !Number.isInteger(usage.uses) ||
      (usage.uses as number) < 0 ||
      !Number.isInteger(usage.maxUses) ||
      (usage.maxUses as number) <= 0 ||
      (usage.uses as number) > (usage.maxUses as number) ||
      !isNonEmptyString(usage.updatedAt) ||
      Number.isNaN(Date.parse(usage.updatedAt))
    ) {
      throw new Error("Local L3 authority policy-usage state is invalid and cannot be trusted.");
    }
  }
  const validateStoredGrant = (entryId: string, grant: unknown): void => {
    if (
      !isObject(grant) ||
      grant.id !== entryId ||
      !isNonEmptyString(grant.issuer) ||
      !isNonEmptyString(grant.subjectId) ||
      !isNonEmptyString(grant.audience) ||
      !isNonEmptyString(grant.projectId) ||
      !isNonEmptyString(grant.routeledgerRootDigest) ||
      !Array.isArray(grant.allowedActions) ||
      grant.allowedActions.length === 0 ||
      !Array.isArray(grant.allowedTargetIds) ||
      grant.allowedTargetIds.length === 0 ||
      !Number.isInteger(grant.maxUses) ||
      (grant.maxUses as number) <= 0 ||
      !Number.isInteger(grant.uses) ||
      (grant.uses as number) < 0 ||
      (grant.uses as number) > (grant.maxUses as number) ||
      (grant.status !== "active" && grant.status !== "revoked" && grant.status !== "exhausted") ||
      !isNonEmptyString(grant.createdAt) ||
      !isNonEmptyString(grant.expiresAt) ||
      Number.isNaN(Date.parse(grant.createdAt)) ||
      Number.isNaN(Date.parse(grant.expiresAt))
    ) {
      throw new Error("Local L3 authority grant state is invalid and cannot be trusted.");
    }
  };
  for (const [grantId, grant] of Object.entries(value.reservedGrants)) {
    validateStoredGrant(grantId, grant);
  }
  for (const [grantId, grant] of Object.entries(value.grants)) {
    validateStoredGrant(grantId, grant);
  }
  for (const [artifactId, receipt] of Object.entries(value.receipts)) {
    if (
      !isObject(receipt) ||
      receipt.approvalArtifactId !== artifactId ||
      !isNonEmptyString(receipt.pendingOperationId) ||
      !isNonEmptyString(receipt.grantId) ||
      !isNonEmptyString(receipt.operationDigest) ||
      !Number.isInteger(receipt.consumedUse) ||
      (receipt.consumedUse as number) <= 0
    ) {
      throw new Error("Local L3 authority receipt state is invalid and cannot be trusted.");
    }
  }
  return value as unknown as LocalL3AuthorityState;
};

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

class LocalL3AuthorityStateFile {
  readonly statePath: string;
  private readonly lockPath: string;

  constructor(
    statePath: string,
    private readonly testHooks?: LocalL3AuthorityStateTestHooks
  ) {
    this.statePath = statePath;
    this.lockPath = `${statePath}.lock`;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(path.dirname(this.statePath), "Local L3 authority state");
    try {
      await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeAtomic(emptyState());
    }
    await this.read();
  }

  async read(): Promise<LocalL3AuthorityState> {
    await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
    return parseState(JSON.parse(await fs.readFile(this.statePath, "utf8")));
  }

  async activatePolicy(
    authorityId: string,
    policyDigest: string,
    activatedAt: string
  ): Promise<void> {
    await this.transact((state) => {
      const previous = state.activePolicies[authorityId];
      if (previous?.policyDigest === policyDigest) return;
      for (const [grantId, grant] of Object.entries(state.reservedGrants)) {
        if (grant.issuer === authorityId && grant.policyDigest !== policyDigest) {
          delete state.reservedGrants[grantId];
        }
      }
      for (const [grantId, grant] of Object.entries(state.grants)) {
        if (
          grant.issuer === authorityId &&
          grant.source === "delegated_policy" &&
          grant.policyDigest !== policyDigest &&
          grant.status === "active"
        ) {
          state.grants[grantId] = {
            ...grant,
            status: "revoked",
            revokedAt: activatedAt
          };
        }
      }
      state.activePolicies[authorityId] = { policyDigest, updatedAt: activatedAt };
    });
  }

  async transact<T>(
    mutate: (state: LocalL3AuthorityState) => T | Promise<T>
  ): Promise<T> {
    const lock = await this.acquireLock();
    try {
      const state = await this.read();
      const expectedRevision = state.revision;
      await this.testHooks?.afterStateRead?.();
      const result = await mutate(state);
      await lock.assertOwned();
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        throw new Error("Local L3 authority state revision changed during a locked transaction.");
      }
      state.revision = expectedRevision + 1;
      await lock.assertOwned();
      await this.writeAtomic(state);
      return result;
    } finally {
      await lock.release();
    }
  }

  private async acquireLock(): Promise<LocalL3AuthorityStateLock> {
    const waitTimeoutMs = this.testHooks?.lockWaitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
    const retryMs = this.testHooks?.lockRetryMs ?? LOCK_RETRY_MS;
    const heartbeatIntervalMs =
      this.testHooks?.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS;
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      const now = new Date().toISOString();
      const metadata: LockMetadata = {
        lockId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        pid: process.pid
      };
      const candidatePath = `${this.lockPath}.candidate-${metadata.lockId}`;
      try {
        await fs.mkdir(candidatePath, { mode: 0o700 });
        await this.writeLockMetadata(metadata, candidatePath);
        try {
          await fs.rename(candidatePath, this.lockPath);
        } catch (error) {
          await fs.rm(candidatePath, { recursive: true, force: true });
          try {
            await fs.lstat(this.lockPath);
            const contention = new Error(
              "Local L3 authority state lock exists."
            ) as NodeJS.ErrnoException;
            contention.code = "EEXIST";
            throw contention;
          } catch (inspectionError) {
            if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw inspectionError;
            }
          }
          throw error;
        }
        let heartbeatFailure: Error | null = null;
        let heartbeatPending = Promise.resolve();
        const heartbeat = setInterval(() => {
          if (heartbeatFailure !== null) return;
          heartbeatPending = heartbeatPending
            .then(() => this.renewLock(metadata))
            .catch((error: unknown) => {
              heartbeatFailure =
                error instanceof Error
                  ? error
                  : new Error("Local L3 authority lock heartbeat failed.");
            });
        }, heartbeatIntervalMs);
        heartbeat.unref();
        const assertOwned = async (): Promise<void> => {
          await heartbeatPending;
          if (heartbeatFailure !== null) throw heartbeatFailure;
          const current = await this.readLockMetadata();
          if (current?.lockId !== metadata.lockId) {
            throw new Error("Local L3 authority state lock ownership was lost.");
          }
        };
        return {
          assertOwned,
          release: async () => {
            clearInterval(heartbeat);
            await heartbeatPending;
            const current = await this.readLockMetadata();
            if (current?.lockId !== metadata.lockId) return;
            const releasedPath = `${this.lockPath}.released-${metadata.lockId}`;
            try {
              await fs.rename(this.lockPath, releasedPath);
              await fs.rm(releasedPath, { recursive: true, force: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        };
      } catch (error) {
        await fs.rm(candidatePath, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let lock;
        try {
          lock = await fs.lstat(this.lockPath);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw inspectionError;
        }
        if (!lock.isDirectory() || lock.isSymbolicLink()) {
          throw new Error("Local L3 authority lock path is not a trusted directory.");
        }
        const metadata = await this.readLockMetadata();
        const updatedAtMs = metadata === null ? lock.mtimeMs : Date.parse(metadata.updatedAt);
        const leaseExpired =
          !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > LOCK_STALE_AFTER_MS;
        const ownerAlive = metadata === null ? null : this.isProcessAlive(metadata.pid);
        if (leaseExpired && ownerAlive !== true) {
          const stalePath = `${this.lockPath}.stale-${randomUUID()}`;
          try {
            await fs.rename(this.lockPath, stalePath);
            await fs.rm(stalePath, { recursive: true, force: true });
          } catch (claimError) {
            if ((claimError as NodeJS.ErrnoException).code !== "ENOENT") throw claimError;
          }
          continue;
        }
        await delay(retryMs);
      }
    }
    throw new Error("Timed out waiting for the local L3 authority state lock.");
  }

  private async readLockMetadata(): Promise<LockMetadata | null> {
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(this.lockPath, "metadata.json"), "utf8")
      ) as Partial<LockMetadata>;
      if (
        !isNonEmptyString(value.lockId) ||
        !isNonEmptyString(value.createdAt) ||
        !isNonEmptyString(value.updatedAt) ||
        !Number.isInteger(value.pid)
      ) {
        return null;
      }
      return value as LockMetadata;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      ) {
        return null;
      }
      throw error;
    }
  }

  private async writeLockMetadata(
    metadata: LockMetadata,
    lockRoot = this.lockPath
  ): Promise<void> {
    const metadataPath = path.join(lockRoot, "metadata.json");
    const temporaryPath = path.join(lockRoot, `.metadata-${metadata.lockId}.tmp`);
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temporaryPath, metadataPath);
    await fs.utimes(lockRoot, new Date(), new Date());
  }

  private async renewLock(metadata: LockMetadata): Promise<void> {
    const current = await this.readLockMetadata();
    if (current?.lockId !== metadata.lockId) {
      throw new Error("Local L3 authority state lock ownership was lost.");
    }
    metadata.updatedAt = new Date().toISOString();
    try {
      await this.writeLockMetadata(metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Local L3 authority state lock ownership was lost.");
      }
      throw error;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async writeAtomic(state: LocalL3AuthorityState): Promise<void> {
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, this.statePath);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(this.statePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
}

class PersistentLocalL3AuthorizationGrantStore implements L3AuthorizationGrantStore {
  constructor(private readonly stateFile: LocalL3AuthorityStateFile) {}

  async issue(grant: L3AuthorizationGrant): Promise<void> {
    await this.stateFile.transact((state) => {
      const existing = state.grants[grant.id];
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing, grant)) return;
        throw new Error(`L3 authorization grant already exists: ${grant.id}`);
      }
      const reserved = state.reservedGrants[grant.id];
      if (reserved !== undefined && !isDeepStrictEqual(reserved, grant)) {
        throw new Error(`Reserved L3 authorization grant mismatch: ${grant.id}`);
      }
      delete state.reservedGrants[grant.id];
      state.grants[grant.id] = structuredClone(grant);
    });
  }

  async get(grantId: string): Promise<L3AuthorizationGrant | null> {
    const grant = (await this.stateFile.read()).grants[grantId];
    return grant === undefined ? null : structuredClone(grant);
  }

  async findMatching(context: L3AuthorizationGrantContext): Promise<L3AuthorizationGrant | null> {
    const matches = Object.values((await this.stateFile.read()).grants)
      .filter((grant) => validateL3AuthorizationGrant(grant, context) === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return matches[0] === undefined ? null : structuredClone(matches[0]);
  }

  async consume(
    grantId: string,
    context: L3AuthorizationGrantContext
  ): Promise<L3AuthorizationGrantConsumeResult> {
    return this.stateFile.transact((state) => {
      const grant = state.grants[grantId];
      if (grant === undefined) return { ok: false as const, code: "GRANT_NOT_FOUND" as const };
      const failure = validateL3AuthorizationGrant(grant, context);
      if (failure !== null) return { ok: false as const, code: failure };
      const consumedUse = grant.uses + 1;
      const updated: L3AuthorizationGrant = {
        ...grant,
        uses: consumedUse,
        status: consumedUse >= grant.maxUses ? "exhausted" : "active"
      };
      state.grants[grantId] = updated;
      return { ok: true as const, grant: structuredClone(updated), consumedUse };
    });
  }

  async consumeAndRecordReceipt(
    grantId: string,
    context: L3AuthorizationGrantContext,
    pendingOperationId: string,
    createReceipt: (
      consumption: L3AuthorizationGrantConsumption
    ) => L3AuthorizationConsumptionReceipt
  ): Promise<L3AuthorizationGrantConsumeWithReceiptResult> {
    return this.stateFile.transact((state) => {
      const replayReceipt = Object.values(state.receipts).find(
        (receipt) =>
          receipt.grantId === grantId &&
          receipt.pendingOperationId === pendingOperationId &&
          receipt.audience === context.audience &&
          receipt.subjectId === context.subjectId &&
          receipt.projectId === context.projectId &&
          receipt.routeledgerRootDigest === context.routeledgerRootDigest &&
          receipt.actionType === context.actionType &&
          receipt.targetId === context.targetId &&
          receipt.operationDigest === context.operationDigest &&
          receipt.hostKind === context.hostKind &&
          (receipt.clientId == null || receipt.clientId === context.clientId) &&
          (receipt.sessionId == null || receipt.sessionId === context.sessionId)
      );
      const grant = state.grants[grantId];
      if (grant === undefined) return { ok: false as const, code: "GRANT_NOT_FOUND" as const };
      if (replayReceipt !== undefined) {
        return {
          ok: true as const,
          grant: structuredClone(grant),
          consumedUse: replayReceipt.consumedUse,
          receipt: structuredClone(replayReceipt)
        };
      }
      const failure = validateL3AuthorizationGrant(grant, context);
      if (failure !== null) return { ok: false as const, code: failure };
      const consumedUse = grant.uses + 1;
      const updated: L3AuthorizationGrant = {
        ...grant,
        uses: consumedUse,
        status: consumedUse >= grant.maxUses ? "exhausted" : "active"
      };
      const consumption = {
        ok: true as const,
        grant: structuredClone(updated),
        consumedUse
      };
      const receipt = createReceipt(consumption);
      if (
        receipt.grantId !== grantId ||
        receipt.pendingOperationId !== pendingOperationId ||
        receipt.audience !== context.audience ||
        receipt.subjectId !== context.subjectId ||
        receipt.projectId !== context.projectId ||
        receipt.routeledgerRootDigest !== context.routeledgerRootDigest ||
        receipt.actionType !== context.actionType ||
        receipt.targetId !== context.targetId ||
        receipt.operationDigest !== context.operationDigest ||
        receipt.hostKind !== context.hostKind ||
        (receipt.clientId != null && receipt.clientId !== context.clientId) ||
        (receipt.sessionId != null && receipt.sessionId !== context.sessionId) ||
        receipt.consumedUse !== consumedUse ||
        receipt.approvalArtifactId.trim().length === 0 ||
        receipt.pendingOperationId.trim().length === 0
      ) {
        throw new Error("L3 authorization consumption receipt does not match the consumed grant.");
      }
      if (state.receipts[receipt.approvalArtifactId] !== undefined) {
        throw new Error(
          `L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`
        );
      }
      state.grants[grantId] = updated;
      state.receipts[receipt.approvalArtifactId] = structuredClone(receipt);
      return { ...consumption, receipt: structuredClone(receipt) };
    });
  }

  async findConsumedAuthorization(
    context: L3AuthorizationGrantContext,
    pendingOperationId: string
  ): Promise<L3ConsumedAuthorizationReplay | null> {
    const state = await this.stateFile.read();
    const receipt = Object.values(state.receipts).find(
      (candidate) =>
        candidate.pendingOperationId === pendingOperationId &&
        candidate.audience === context.audience &&
        candidate.subjectId === context.subjectId &&
        candidate.projectId === context.projectId &&
        candidate.routeledgerRootDigest === context.routeledgerRootDigest &&
        candidate.actionType === context.actionType &&
        candidate.targetId === context.targetId &&
        candidate.operationDigest === context.operationDigest &&
        candidate.hostKind === context.hostKind &&
        (candidate.clientId == null || candidate.clientId === context.clientId) &&
        (candidate.sessionId == null || candidate.sessionId === context.sessionId)
    );
    if (receipt === undefined) return null;
    const grant = state.grants[receipt.grantId];
    if (grant === undefined) return null;
    return {
      grant: structuredClone(grant),
      receipt: structuredClone(receipt)
    };
  }

  async recordConsumptionReceipt(receipt: L3AuthorizationConsumptionReceipt): Promise<void> {
    await this.stateFile.transact((state) => {
      const existing = state.receipts[receipt.approvalArtifactId];
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing, receipt)) return;
        throw new Error(
          `L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`
        );
      }
      state.receipts[receipt.approvalArtifactId] = structuredClone(receipt);
    });
  }

  async verifyConsumptionReceipt(binding: L3AuthorizationReceiptBinding): Promise<boolean> {
    const receipt = (await this.stateFile.read()).receipts[binding.approvalArtifactId];
    return (
      receipt !== undefined &&
      receipt.consumedUse > 0 &&
      Object.entries(binding).every(
        ([key, value]) => receipt[key as keyof L3AuthorizationConsumptionReceipt] === value
      )
    );
  }

  async revoke(grantId: string, revokedAt: string): Promise<L3AuthorizationGrant | null> {
    return this.stateFile.transact((state) => {
      const grant = state.grants[grantId];
      if (grant === undefined) return null;
      const updated: L3AuthorizationGrant = { ...grant, status: "revoked", revokedAt };
      state.grants[grantId] = updated;
      return structuredClone(updated);
    });
  }
}

const minimumIsoTimestamp = (...timestamps: string[]): string =>
  timestamps.reduce((minimum, candidate) =>
    Date.parse(candidate) < Date.parse(minimum) ? candidate : minimum
  );

export const installLocalL3AuthorityConfig = async (
  input: InstallLocalL3AuthorityConfigInput
): Promise<void> => {
  if (
    input.config.policy.binding.hostKind === undefined ||
    input.config.policy.binding.subjectId === undefined
  ) {
    throw new Error("Installed local authority policy requires exact hostKind and subjectId bindings.");
  }
  const config = validateConfig(
    input.config,
    input.config.policy.binding.hostKind,
    input.config.policy.binding.subjectId
  );
  const configPath = await assertTrustedPath(
    input.configPath,
    input.workspaceRoot,
    input.routeledgerRoot,
    "Local L3 authority config"
  );
  await assertTrustedPath(
    config.statePath,
    input.workspaceRoot,
    input.routeledgerRoot,
    "Local L3 authority state"
  );
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path.dirname(configPath), "Local L3 authority config");
  await fs.mkdir(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path.dirname(config.statePath), "Local L3 authority state");
  const temporaryPath = `${configPath}.tmp-${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporaryPath, configPath);
};

export const loadLocalL3AuthorityRuntime = async (
  input: LoadLocalL3AuthorityRuntimeInput
): Promise<LocalL3AuthorityRuntime> => {
  const configPath = await assertTrustedPath(
    input.configPath,
    input.workspaceRoot,
    input.routeledgerRoot,
    "Local L3 authority config"
  );
  await assertPrivateExistingFile(configPath, "Local L3 authority config");
  await assertPrivateDirectory(path.dirname(configPath), "Local L3 authority config");
  const config = validateConfig(
    JSON.parse(await fs.readFile(configPath, "utf8")),
    input.hostKind,
    input.subjectId
  );
  const statePath = await assertTrustedPath(
    config.statePath,
    input.workspaceRoot,
    input.routeledgerRoot,
    "Local L3 authority state"
  );
  const stateFile = new LocalL3AuthorityStateFile(statePath, input.testHooks);
  await stateFile.initialize();
  const grantStore = new PersistentLocalL3AuthorizationGrantStore(stateFile);
  const policyDigest = digestL3AuthorizationPolicy(config.policy);
  await stateFile.activatePolicy(config.authorityId, policyDigest, new Date().toISOString());
  const authorityHandle = `local:${config.authorityId}:${policyDigest}`;
  const authority: RouteLedgerMcpDelegatedAuthorizationAuthority = {
    authorityHandle,
    requestGrant: async (request): Promise<RouteLedgerMcpDelegatedAuthorizationResult> => {
      if (request.authorityHandle !== authorityHandle) {
        throw new Error("Local L3 authority handle mismatch.");
      }
      const decision = evaluateL3AuthorizationPolicy(config.policy, request.context);
      if (decision.effect !== "allow" || decision.matchedRuleId === null) {
        const effect: "prompt" | "deny" =
          decision.effect === "prompt" ? "prompt" : "deny";
        return {
          effect,
          code: decision.code,
          policyId: decision.policyId,
          policyDigest: decision.policyDigest,
          ...(decision.matchedRuleId === null ? {} : { matchedRuleId: decision.matchedRuleId })
        };
      }
      const rule = config.policy.rules.find((candidate) => candidate.id === decision.matchedRuleId);
      if (rule?.conditions?.maxUses === undefined || rule.conditions.expiresAt === undefined) {
        throw new Error("Matched delegated rule has no finite budget or expiry.");
      }
      const now = request.context.now;
      const grant: L3AuthorizationGrant = {
        id: `grant-${randomUUID()}`,
        issuer: config.authorityId,
        subjectId: request.context.subjectId ?? config.policy.binding.subjectId!,
        audience: "routeledger-core",
        projectId: request.context.projectId,
        routeledgerRootDigest: request.context.routeledgerRootDigest,
        allowedActions: [request.context.actionType],
        allowedTargetIds: [request.context.targetId],
        operationDigest: request.context.operationDigest,
        scope: "operation",
        source: "delegated_policy",
        policyId: config.policy.policyId,
        policyDigest,
        decisionId: `decision-${randomUUID()}`,
        hostKind: request.context.hostKind ?? input.hostKind,
        clientId: request.context.clientId ?? null,
        sessionId: null,
        nonce: randomUUID(),
        createdAt: now,
        expiresAt: minimumIsoTimestamp(
          rule.conditions.expiresAt,
          new Date(Date.parse(now) + config.grantTtlSeconds * 1000).toISOString()
        ),
        maxUses: 1,
        uses: 0,
        status: "active",
        revokedAt: null
      };
      const usageKey = `${policyDigest}:${rule.id}`;
      const grantDecision = await stateFile.transact((state) => {
        const recoverableGrant = [
          ...Object.values(state.reservedGrants),
          ...Object.values(state.grants)
        ].find(
          (candidate) =>
            candidate.issuer === config.authorityId &&
            candidate.source === "delegated_policy" &&
            candidate.policyDigest === policyDigest &&
            candidate.subjectId === grant.subjectId &&
            candidate.projectId === grant.projectId &&
            candidate.routeledgerRootDigest === grant.routeledgerRootDigest &&
            candidate.hostKind === grant.hostKind &&
            candidate.clientId === grant.clientId &&
            candidate.sessionId === grant.sessionId &&
            candidate.operationDigest === grant.operationDigest &&
            candidate.allowedActions.includes(request.context.actionType) &&
            candidate.allowedTargetIds.includes(request.context.targetId) &&
            candidate.uses === 0 &&
            candidate.status === "active" &&
            Date.parse(now) < Date.parse(candidate.expiresAt)
        );
        if (recoverableGrant !== undefined) {
          return { effect: "allow" as const, grant: structuredClone(recoverableGrant) };
        }
        const usage = state.policyUsages[usageKey] ?? {
          policyDigest,
          ruleId: rule.id,
          uses: 0,
          maxUses: rule.conditions!.maxUses!,
          updatedAt: now
        };
        if (usage.maxUses !== rule.conditions!.maxUses || usage.uses >= usage.maxUses) {
          return { effect: "deny" as const };
        }
        state.policyUsages[usageKey] = { ...usage, uses: usage.uses + 1, updatedAt: now };
        state.reservedGrants[grant.id] = structuredClone(grant);
        return { effect: "allow" as const, grant };
      });
      return grantDecision.effect === "allow"
        ? grantDecision
        : {
            effect: "deny",
            code: "POLICY_BUDGET_EXHAUSTED",
            policyId: config.policy.policyId,
            policyDigest,
            matchedRuleId: rule.id
          };
    }
  };
  return {
    authority,
    grantStore,
    ...(config.trustedClientId === undefined
      ? {}
      : { trustedClientId: config.trustedClientId }),
    configPath,
    statePath,
    policyDigest
  };
};
