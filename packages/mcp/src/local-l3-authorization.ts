import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  digestL3AuthorizationPolicy,
  evaluateL3AuthorizationPolicy,
  MemoryExactAuthorizationStore,
  validateL3AuthorizationProfile,
  validateL3AuthorizationPolicy,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationPolicy,
  type L3AuthorizationProfileV2,
  type ExactAuthorizationCandidate,
  type ExactAuthorizationStore,
  type ExactAuthorizationStoreState
} from "@routeledger/core";

import type {
  RouteLedgerMcpDelegatedAuthorizationAuthority,
  RouteLedgerMcpDelegatedAuthorizationResult
} from "./index.js";
import {
  LEGACY_AUTHORITY_CONFIG_TTL_FIELD,
  LEGACY_GRANT_FIELDS,
  type LegacyL3AuthorizationGrant,
  type LegacyL3AuthorizationReceipt
} from "./legacy-local-l3-authority-decoder.js";

export const LOCAL_L3_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION = 2 as const;

export interface LocalL3AuthorityConfig {
  schemaVersion: typeof LOCAL_L3_AUTHORITY_SCHEMA_VERSION;
  authorityId: string;
  statePath: string;
  policy: L3AuthorizationPolicy;
  authorizationTtlSeconds: number;
  trustedClientId?: string;
}

export interface LocalL3AuthorityRuntime {
  authority: RouteLedgerMcpDelegatedAuthorizationAuthority;
  exactStore: ExactAuthorizationStore;
  trustedClientId?: string;
  configPath: string;
  statePath: string;
  policyDigest: string;
}

export interface LocalL3AuthorityProfileRuntime {
  profile: L3AuthorizationProfileV2;
  exactStore: ExactAuthorizationStore;
  trustedClientId?: string;
  statePath: string;
  delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
}

export interface LoadLocalL3AuthorityProfileRuntimeInput {
  profile: L3AuthorizationProfileV2;
  statePath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  hostKind: string;
  subjectId: string;
  /** @internal Test-only hooks for exercising state-lock interruption boundaries. */
  testHooks?: LocalL3AuthorityStateTestHooks;
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
  beforeStateWrite?: () => void | Promise<void>;
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
  decisions: number;
  decisionBudget: number;
  updatedAt: string;
}

interface LocalL3AuthorityState {
  schemaVersion: typeof LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION;
  revision: number;
  activePolicies: Record<string, { policyDigest: string; updatedAt: string }>;
  policyUsages: Record<string, LocalL3PolicyUsage>;
  reservedGrants: Record<string, LegacyL3AuthorizationGrant>;
  grants: Record<string, LegacyL3AuthorizationGrant>;
  receipts: Record<string, LegacyL3AuthorizationReceipt>;
  legacyTombstones: Record<string, {
    recordKind: "grant" | "reserved_grant";
    reason: "legacy_reauthorization_required";
    migratedAt: string;
  }>;
  exactStore: ExactAuthorizationStoreState;
}

interface ActiveExactPolicyIdentity {
  issuerId: string;
  policyId: string;
  policyDigest: string;
  profileId: string | null;
  modeEpoch: number | null;
  profileDigest: string | null;
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
const LOCK_RELEASE_RETRY_DELAYS_MS = [10, 30, 100] as const;

const emptyState = (): LocalL3AuthorityState => ({
  schemaVersion: LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION,
  revision: 0,
  activePolicies: {},
  policyUsages: {},
  reservedGrants: {},
  grants: {},
  receipts: {},
  legacyTombstones: {},
  exactStore: { authorizations: {}, receipts: {}, commitOwners: {} }
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
  const authorizationTtlSeconds =
    value.authorizationTtlSeconds ?? value[LEGACY_AUTHORITY_CONFIG_TTL_FIELD];
  if (
    !Number.isInteger(authorizationTtlSeconds) ||
    (authorizationTtlSeconds as number) < 30 ||
    (authorizationTtlSeconds as number) > 86_400
  ) {
    throw new Error("authorizationTtlSeconds must be an integer from 30 through 86400.");
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
    if (rule.conditions?.decisionBudget === undefined || rule.conditions.expiresAt === undefined) {
      throw new Error(`Delegated allow rule ${rule.id} requires decisionBudget and expiresAt.`);
    }
  }
  return {
    schemaVersion: LOCAL_L3_AUTHORITY_SCHEMA_VERSION,
    authorityId: value.authorityId,
    statePath: value.statePath,
    policy,
    authorizationTtlSeconds: authorizationTtlSeconds as number,
    ...(value.trustedClientId === undefined
      ? {}
      : { trustedClientId: value.trustedClientId as string })
  };
};

const migrateLegacyState = (value: Record<string, unknown>): LocalL3AuthorityState => {
  if (
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.revision) ||
    !isObject(value.activePolicies) ||
    !isObject(value.policyUsages) ||
    !isObject(value.reservedGrants) ||
    !isObject(value.grants) ||
    !isObject(value.receipts)
  ) {
    throw new Error("Local L3 authority state is invalid and cannot be trusted.");
  }
  const legacy = parseState({
    ...value,
    schemaVersion: LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION,
    legacyTombstones: {},
    exactStore: { authorizations: {}, receipts: {}, commitOwners: {} }
  });
  const migratedAt = new Date().toISOString();
  const tombstones: LocalL3AuthorityState["legacyTombstones"] = {};
  const revokedGrants = Object.fromEntries(
    Object.entries(legacy.grants).map(([id, grant]) => {
      tombstones[`grant:${id}`] = {
        recordKind: "grant",
        reason: "legacy_reauthorization_required",
        migratedAt
      };
      return [id, { ...grant, status: "revoked", revokedAt: migratedAt }];
    })
  );
  for (const id of Object.keys(legacy.reservedGrants)) {
    tombstones[`reserved_grant:${id}`] = {
      recordKind: "reserved_grant",
      reason: "legacy_reauthorization_required",
      migratedAt
    };
  }
  return {
    schemaVersion: 2,
    revision: legacy.revision + 1,
    activePolicies: legacy.activePolicies,
    policyUsages: legacy.policyUsages,
    reservedGrants: {},
    grants: revokedGrants as Record<string, LegacyL3AuthorizationGrant>,
    receipts: legacy.receipts,
    legacyTombstones: tombstones,
    exactStore: { authorizations: {}, receipts: {}, commitOwners: {} }
  };
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
    || !isObject(value.legacyTombstones) || !isObject(value.exactStore)
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
      !Number.isInteger(usage.decisions) ||
      (usage.decisions as number) < 0 ||
      !Number.isInteger(usage.decisionBudget) ||
      (usage.decisionBudget as number) <= 0 ||
      (usage.decisions as number) > (usage.decisionBudget as number) ||
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
      !Array.isArray(grant[LEGACY_GRANT_FIELDS.actions]) ||
      (grant[LEGACY_GRANT_FIELDS.actions] as unknown[]).length === 0 ||
      !Array.isArray(grant[LEGACY_GRANT_FIELDS.targets]) ||
      (grant[LEGACY_GRANT_FIELDS.targets] as unknown[]).length === 0 ||
      !Number.isInteger(grant[LEGACY_GRANT_FIELDS.limit]) ||
      (grant[LEGACY_GRANT_FIELDS.limit] as number) <= 0 ||
      !Number.isInteger(grant[LEGACY_GRANT_FIELDS.count]) ||
      (grant[LEGACY_GRANT_FIELDS.count] as number) < 0 ||
      (grant[LEGACY_GRANT_FIELDS.count] as number) >
        (grant[LEGACY_GRANT_FIELDS.limit] as number) ||
      (grant.status !== "active" && grant.status !== "revoked" && grant.status !== "exhausted") ||
      !isNonEmptyString(grant.createdAt) ||
      !isNonEmptyString(grant.expiresAt) ||
      Number.isNaN(Date.parse(grant.createdAt)) ||
      Number.isNaN(Date.parse(grant.expiresAt))
    ) {
      throw new Error("Local L3 authority grant state is invalid and cannot be trusted.");
    }
  };
  for (const [authorizationId, grant] of Object.entries(value.reservedGrants)) {
    validateStoredGrant(authorizationId, grant);
  }
  for (const [authorizationId, grant] of Object.entries(value.grants)) {
    validateStoredGrant(authorizationId, grant);
  }
  for (const [artifactId, receipt] of Object.entries(value.receipts)) {
    if (
      !isObject(receipt) ||
      receipt.approvalArtifactId !== artifactId ||
      !isNonEmptyString(receipt.pendingOperationId) ||
      !isNonEmptyString(receipt.authorizationId) ||
      !isNonEmptyString(receipt.operationDigest) ||
      !Number.isInteger(receipt.consumedUse) ||
      (receipt.consumedUse as number) <= 0 ||
      (receipt.status !== undefined &&
        receipt.status !== "authorized" &&
        receipt.status !== "commit_claimed" &&
        receipt.status !== "committed" &&
        receipt.status !== "revoked") ||
      ((receipt.status === "commit_claimed" || receipt.status === "committed") &&
        !isNonEmptyString(receipt.commitClaimId)) ||
      (receipt.status === "commit_claimed" && !isNonEmptyString(receipt.commitClaimedAt)) ||
      (receipt.status === "committed" && !isNonEmptyString(receipt.committedAt)) ||
      (receipt.status === "revoked" && !isNonEmptyString(receipt.revokedAt))
    ) {
      throw new Error("Local L3 authority receipt state is invalid and cannot be trusted.");
    }
  }
  for (const [recordId, tombstone] of Object.entries(value.legacyTombstones)) {
    if (
      !isNonEmptyString(recordId) ||
      !isObject(tombstone) ||
      (tombstone.recordKind !== "grant" && tombstone.recordKind !== "reserved_grant") ||
      tombstone.reason !== "legacy_reauthorization_required" ||
      !isNonEmptyString(tombstone.migratedAt) ||
      Number.isNaN(Date.parse(tombstone.migratedAt))
    ) {
      throw new Error("Local L3 authority legacy tombstone is invalid and cannot be trusted.");
    }
  }
  try {
    new MemoryExactAuthorizationStore(value.exactStore as unknown as ExactAuthorizationStoreState);
  } catch {
    throw new Error("Local exact authorization state is invalid and cannot be trusted.");
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
    const lock = await this.acquireLock();
    try {
      await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
      const raw = JSON.parse(await fs.readFile(this.statePath, "utf8")) as unknown;
      if (isObject(raw) && raw.schemaVersion === 1) {
        const migrated = migrateLegacyState(raw);
        await lock.assertOwned();
        await this.writeAtomic(migrated);
      } else {
        parseState(raw);
      }
    } finally {
      await lock.release();
    }
  }

  async read(): Promise<LocalL3AuthorityState> {
    await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
    return parseState(JSON.parse(await fs.readFile(this.statePath, "utf8")) as unknown);
  }

  async activatePolicy(
    authorityId: string,
    activationDigest: string,
    exactPolicy: ActiveExactPolicyIdentity,
    activatedAt: string
  ): Promise<void> {
    await this.transact((state) => {
      const exactStore = new MemoryExactAuthorizationStore(state.exactStore);
      const exactState = exactStore.exportState();
      const isStaleProvenance = (value: {
        issuer: string;
        policyId: string | null;
        policyDigest: string | null;
        profileId: string | null;
        modeEpoch: number | null;
        profileDigest: string | null;
      }) =>
        value.issuer === exactPolicy.issuerId &&
        (value.policyId !== exactPolicy.policyId ||
          value.policyDigest !== exactPolicy.policyDigest ||
          value.profileId !== exactPolicy.profileId ||
          value.modeEpoch !== exactPolicy.modeEpoch ||
          value.profileDigest !== exactPolicy.profileDigest);

      for (const receipt of Object.values(exactState.receipts)) {
        if (isStaleProvenance(receipt) && receipt.status === "commit_claimed") {
          throw new Error(
            "Cannot rotate the active exact policy while its prior authorization commit is claimed."
          );
        }
      }
      for (const stored of Object.values(exactState.authorizations)) {
        if (stored.status === "active" && isStaleProvenance(stored.candidate)) {
          stored.status = "revoked";
          stored.revokedAt = activatedAt;
        }
      }
      for (const [artifactId, receipt] of Object.entries(exactState.receipts)) {
        if (receipt.status === "authorized" && isStaleProvenance(receipt)) {
          exactState.receipts[artifactId] = {
            ...receipt,
            status: "revoked",
            revokedAt: activatedAt
          };
        }
      }
      state.exactStore = exactState;
      for (const [authorizationId, grant] of Object.entries(state.reservedGrants)) {
        const grantAuthorizationDigest = grant.profileId === undefined
          ? grant.policyDigest
          : grant.profileDigest;
        if (grant.issuer === authorityId && grantAuthorizationDigest !== activationDigest) {
          delete state.reservedGrants[authorizationId];
        }
      }
      for (const [authorizationId, grant] of Object.entries(state.grants)) {
        if (
          grant.issuer === authorityId &&
          (grant.profileId !== undefined || grant.source === "delegated_policy") &&
          (grant.profileId === undefined ? grant.policyDigest : grant.profileDigest) !== activationDigest &&
          grant.status === "active"
        ) {
          state.grants[authorizationId] = {
            ...grant,
            status: "revoked",
            revokedAt: activatedAt
          };
        }
      }
      if (state.activePolicies[authorityId]?.policyDigest !== activationDigest) {
        state.activePolicies[authorityId] = {
          policyDigest: activationDigest,
          updatedAt: activatedAt
        };
      }
    });
  }

  async transact<T>(
    mutate: (state: LocalL3AuthorityState) => T | Promise<T>
  ): Promise<T> {
    const lock = await this.acquireLock();
    try {
      const state = await this.read();
      const expectedRevision = state.revision;
      const before = structuredClone(state);
      await this.testHooks?.afterStateRead?.();
      const result = await mutate(state);
      await lock.assertOwned();
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        throw new Error("Local L3 authority state revision changed during a locked transaction.");
      }
      if (isDeepStrictEqual(state, before)) return result;
      state.revision = expectedRevision + 1;
      await this.testHooks?.beforeStateWrite?.();
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
          if (
            process.platform === "win32" &&
            (error as NodeJS.ErrnoException).code === "EPERM"
          ) {
            const contention = new Error(
              "Local L3 authority state lock disappeared during acquisition."
            ) as NodeJS.ErrnoException;
            contention.code = "EEXIST";
            throw contention;
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
            await this.releaseOwnedLock(metadata);
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

  private async releaseOwnedLock(metadata: LockMetadata): Promise<void> {
    const releasedPath = `${this.lockPath}.released-${metadata.lockId}`;
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.readLockMetadata();
      if (current?.lockId !== metadata.lockId) return;
      try {
        await fs.rename(this.lockPath, releasedPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (
          process.platform === "win32" &&
          code === "EPERM" &&
          attempt < LOCK_RELEASE_RETRY_DELAYS_MS.length
        ) {
          await delay(LOCK_RELEASE_RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw error;
      }
    }
    try {
      await fs.rm(releasedPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

class PersistentLocalExactAuthorizationStore implements ExactAuthorizationStore {
  constructor(private readonly stateFile: LocalL3AuthorityStateFile) {}

  private async run<T>(operation: (store: MemoryExactAuthorizationStore) => Promise<T>): Promise<T> {
    return this.stateFile.transact(async (state) => {
      const store = new MemoryExactAuthorizationStore(state.exactStore);
      const result = await operation(store);
      state.exactStore = store.exportState();
      return result;
    });
  }

  issue(candidate: Parameters<ExactAuthorizationStore["issue"]>[0]) {
    return this.run((store) => store.issue(candidate));
  }
  get(authorizationId: string) {
    return this.run((store) => store.get(authorizationId));
  }
  getReceipt(authorizationId: string) {
    return this.run((store) => store.getReceipt(authorizationId));
  }
  acquireCommitOwnership(authorizationId: string, ownerId: string) {
    return this.run((store) => store.acquireCommitOwnership(authorizationId, ownerId));
  }
  releaseCommitOwnership(authorizationId: string, ownerId: string) {
    return this.run((store) => store.releaseCommitOwnership(authorizationId, ownerId));
  }
  consumeAndRecordReceipt(input: Parameters<ExactAuthorizationStore["consumeAndRecordReceipt"]>[0]) {
    return this.run((store) => store.consumeAndRecordReceipt(input));
  }
  verifyReceipt(binding: Parameters<ExactAuthorizationStore["verifyReceipt"]>[0]) {
    return this.run((store) => store.verifyReceipt(binding));
  }
  claimCommit(
    binding: Parameters<ExactAuthorizationStore["claimCommit"]>[0],
    claim: Parameters<ExactAuthorizationStore["claimCommit"]>[1]
  ) {
    return this.run((store) => store.claimCommit(binding, claim));
  }
  finalizeCommit(
    binding: Parameters<ExactAuthorizationStore["finalizeCommit"]>[0],
    claimId: string,
    committedAt: string
  ) {
    return this.run((store) => store.finalizeCommit(binding, claimId, committedAt));
  }
  revoke(authorizationId: string, revokedAt: string) {
    return this.run((store) => store.revoke(authorizationId, revokedAt));
  }
  revokeProfileReceipts(profileId: string, beforeModeEpoch: number, revokedAt: string) {
    return this.run((store) =>
      store.revokeProfileReceipts(profileId, beforeModeEpoch, revokedAt)
    );
  }
}

const minimumIsoTimestamp = (...timestamps: string[]): string =>
  timestamps.reduce((minimum, candidate) =>
    Date.parse(candidate) < Date.parse(minimum) ? candidate : minimum
  );

const assertExactProposalContext = (
  proposal: {
    id: string;
    projectId: string;
    actionType: string;
    targetId: string;
    digest: { value: string };
  },
  context: L3AuthorizationEvaluationContext
): void => {
  if (
    proposal.id.trim().length === 0 ||
    proposal.projectId !== context.projectId ||
    proposal.actionType !== context.actionType ||
    proposal.targetId !== context.targetId ||
    proposal.digest.value !== context.operationDigest
  ) {
    throw new Error("The delegated authority request does not match the exact proposal.");
  }
};


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
  const exactStore = new PersistentLocalExactAuthorizationStore(stateFile);
  const policyDigest = digestL3AuthorizationPolicy(config.policy);
  await stateFile.activatePolicy(
    config.authorityId,
    policyDigest,
    {
      issuerId: config.authorityId,
      policyId: config.policy.policyId,
      policyDigest,
      profileId: null,
      modeEpoch: null,
      profileDigest: null
    },
    new Date().toISOString()
  );
  const authorityHandle = `local:${config.authorityId}:${policyDigest}`;
  const authority: RouteLedgerMcpDelegatedAuthorizationAuthority = {
    authorityHandle,
    issuerId: config.authorityId,
    policyId: config.policy.policyId,
    policyDigest,
    requestExactDecision: async (request): Promise<RouteLedgerMcpDelegatedAuthorizationResult> => {
      if (request.authorityHandle !== authorityHandle) {
        throw new Error("Local L3 authority handle mismatch.");
      }
      assertExactProposalContext(request.proposal, request.context);
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
      if (rule?.conditions?.decisionBudget === undefined || rule.conditions.expiresAt === undefined) {
        throw new Error("Matched delegated rule has no finite budget or expiry.");
      }
      const now = request.context.now;
      const proposalId = request.proposal.id;
      const authorization: ExactAuthorizationCandidate = {
        schemaVersion: 2,
        authorizationId: `authorization-${policyDigest}-${proposalId}`,
        binding: {
          proposalId,
          projectId: request.context.projectId,
          routeledgerRootDigest: request.context.routeledgerRootDigest,
          actionType: request.context.actionType,
          targetId: request.context.targetId,
          operationDigest: request.context.operationDigest
        },
        issuer: config.authorityId,
        subjectId: request.context.subjectId ?? config.policy.binding.subjectId!,
        audience: "routeledger-core",
        source: "delegated_policy",
        policyId: config.policy.policyId,
        policyDigest,
        decisionRef: `decision-${proposalId}`,
        profileId: null,
        modeEpoch: null,
        profileDigest: null,
        hostKind: request.context.hostKind ?? input.hostKind,
        clientId: request.context.clientId ?? null,
        createdAt: now,
        expiresAt: minimumIsoTimestamp(
          rule.conditions.expiresAt,
          new Date(Date.parse(now) + config.authorizationTtlSeconds * 1000).toISOString()
        )
      };
      const usageKey = `${policyDigest}:${rule.id}`;
      const grantDecision = await stateFile.transact(async (state) => {
        const exactStore = new MemoryExactAuthorizationStore(state.exactStore);
        const existing = await exactStore.get(authorization.authorizationId);
        if (existing !== null) return { effect: "allow" as const, authorization: existing };
        const usage = state.policyUsages[usageKey] ?? {
          policyDigest,
          ruleId: rule.id,
          decisions: 0,
          decisionBudget: rule.conditions!.decisionBudget!,
          updatedAt: now
        };
        if (usage.decisionBudget !== rule.conditions!.decisionBudget || usage.decisions >= usage.decisionBudget) {
          return { effect: "deny" as const };
        }
        state.policyUsages[usageKey] = { ...usage, decisions: usage.decisions + 1, updatedAt: now };
        await exactStore.issue(authorization);
        state.exactStore = exactStore.exportState();
        return { effect: "allow" as const, authorization };
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
    exactStore,
    ...(config.trustedClientId === undefined
      ? {}
      : { trustedClientId: config.trustedClientId }),
    configPath,
    statePath,
    policyDigest
  };
};

export const loadLocalL3AuthorityProfileRuntime = async (
  input: LoadLocalL3AuthorityProfileRuntimeInput
): Promise<LocalL3AuthorityProfileRuntime> => {
  const validation = validateL3AuthorizationProfile(input.profile);
  if (!validation.valid) {
    throw new Error(
      `Local L3 authorization profile is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`
    );
  }
  if (
    input.profile.binding.subjectId !== input.subjectId ||
    input.profile.binding.hostKind !== input.hostKind
  ) {
    throw new Error("Local L3 authorization profile does not match the trusted host identity.");
  }
  const statePath = await assertTrustedPath(
    input.statePath,
    input.workspaceRoot,
    input.routeledgerRoot,
    "Local L3 authority profile state"
  );
  const stateFile = new LocalL3AuthorityStateFile(statePath, input.testHooks);
  await stateFile.initialize();
  const exactStore = new PersistentLocalExactAuthorizationStore(stateFile);
  const baseRuntime = {
    profile: structuredClone(input.profile),
    exactStore,
    ...(input.profile.binding.trustedClientId === null
      ? {}
      : { trustedClientId: input.profile.binding.trustedClientId }),
    statePath
  };
  const profilePolicy = input.profile.delegatedPolicy;
  const profilePolicyDigest =
    profilePolicy === null ? "disabled-standing-policy" : digestL3AuthorizationPolicy(profilePolicy);
  await stateFile.activatePolicy(
    input.profile.profileId,
    input.profile.profileDigest,
    {
      issuerId: input.profile.profileId,
      policyId: profilePolicy?.policyId ?? "disabled-standing-policy",
      policyDigest: profilePolicyDigest,
      profileId: input.profile.profileId,
      modeEpoch: input.profile.modeEpoch,
      profileDigest: input.profile.profileDigest
    },
    new Date().toISOString()
  );
  if (
    input.profile.status !== "active" ||
    (input.profile.mode !== "delegated" && input.profile.mode !== "preauthorized")
  ) {
    return baseRuntime;
  }
  const policy = input.profile.delegatedPolicy;
  if (policy === null) {
    if (input.profile.mode === "preauthorized") return baseRuntime;
    throw new Error("An active policy-backed profile requires a deterministic standing policy.");
  }
  const policyDigest = digestL3AuthorizationPolicy(policy);
  const authorityHandle = `local-profile:${input.profile.profileId}:${input.profile.profileDigest}`;
  const delegatedAuthority: RouteLedgerMcpDelegatedAuthorizationAuthority = {
    authorityHandle,
    issuerId: input.profile.profileId,
    policyId: policy.policyId,
    policyDigest,
    requestExactDecision: async (request): Promise<RouteLedgerMcpDelegatedAuthorizationResult> => {
      if (request.authorityHandle !== authorityHandle) {
        throw new Error("Local L3 profile authority handle mismatch.");
      }
      assertExactProposalContext(request.proposal, request.context);
      if (
        request.context.profileId !== input.profile.profileId ||
        request.context.modeEpoch !== input.profile.modeEpoch ||
        request.context.profileDigest !== input.profile.profileDigest
      ) {
        return { effect: "deny", code: "PROFILE_PROVENANCE_MISMATCH" };
      }
      const decision = evaluateL3AuthorizationPolicy(policy, request.context);
      if (decision.effect !== "allow" || decision.matchedRuleId === null) {
        return {
          effect: decision.effect === "prompt" ? "prompt" : "deny",
          code: decision.code,
          policyId: decision.policyId,
          policyDigest: decision.policyDigest,
          ...(decision.matchedRuleId === null ? {} : { matchedRuleId: decision.matchedRuleId })
        };
      }
      const rule = policy.rules.find((candidate) => candidate.id === decision.matchedRuleId);
      if (rule?.conditions?.decisionBudget === undefined || rule.conditions.expiresAt === undefined) {
        throw new Error("Matched delegated rule has no finite budget or expiry.");
      }
      const now = request.context.now;
      const proposalId = request.proposal.id;
      const authorization: ExactAuthorizationCandidate = {
        schemaVersion: 2,
        authorizationId: `authorization-${input.profile.profileDigest}-${policyDigest}-${proposalId}`,
        binding: {
          proposalId,
          projectId: request.context.projectId,
          routeledgerRootDigest: request.context.routeledgerRootDigest,
          actionType: request.context.actionType,
          targetId: request.context.targetId,
          operationDigest: request.context.operationDigest
        },
        issuer: input.profile.profileId,
        subjectId: input.profile.binding.subjectId,
        audience: "routeledger-core",
        profileId: input.profile.profileId,
        modeEpoch: input.profile.modeEpoch,
        profileDigest: input.profile.profileDigest,
        source: input.profile.mode === "preauthorized" ? "preauthorized" : "delegated_policy",
        policyId: policy.policyId,
        policyDigest,
        decisionRef: `decision-${proposalId}`,
        hostKind: input.profile.binding.hostKind,
        clientId: input.profile.binding.trustedClientId,
        createdAt: now,
        expiresAt: minimumIsoTimestamp(
          rule.conditions.expiresAt,
          new Date(
            Date.parse(now) + input.profile.limits.maxAuthorizationTtlSeconds * 1000
          ).toISOString()
        )
      };
      const usageKey = `${input.profile.profileDigest}:${rule.id}`;
      const grantDecision = await stateFile.transact(async (state) => {
        const exactStore = new MemoryExactAuthorizationStore(state.exactStore);
        const existing = await exactStore.get(authorization.authorizationId);
        if (existing !== null) return { effect: "allow" as const, authorization: existing };
        const usage = state.policyUsages[usageKey] ?? {
          policyDigest: input.profile.profileDigest,
          ruleId: rule.id,
          decisions: 0,
          decisionBudget: rule.conditions!.decisionBudget!,
          updatedAt: now
        };
        if (usage.decisionBudget !== rule.conditions!.decisionBudget || usage.decisions >= usage.decisionBudget) {
          return { effect: "deny" as const };
        }
        state.policyUsages[usageKey] = { ...usage, decisions: usage.decisions + 1, updatedAt: now };
        await exactStore.issue(authorization);
        state.exactStore = exactStore.exportState();
        return { effect: "allow" as const, authorization };
      });
      return grantDecision.effect === "allow"
        ? grantDecision
        : {
            effect: "deny",
            code: "POLICY_BUDGET_EXHAUSTED",
            policyId: policy.policyId,
            policyDigest,
            matchedRuleId: rule.id
          };
    }
  };
  return { ...baseRuntime, delegatedAuthority };
};
