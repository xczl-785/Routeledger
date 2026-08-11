import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digestL3AuthorizationPolicy, evaluateL3AuthorizationPolicy, validateL3AuthorizationProfile, validateL3AuthorizationGrant, validateL3AuthorizationPolicy } from "../../core/src/index.js";
export const LOCAL_L3_AUTHORITY_SCHEMA_VERSION = 1;
export const LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION = 1;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const emptyState = () => ({
    schemaVersion: LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION,
    revision: 0,
    activePolicies: {},
    policyUsages: {},
    reservedGrants: {},
    grants: {},
    receipts: {}
});
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isContainedPath = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const realpathForPotentialFile = async (candidate) => {
    try {
        return await fs.realpath(candidate);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        const parent = await fs.realpath(path.dirname(candidate));
        return path.join(parent, path.basename(candidate));
    }
};
const assertTrustedPath = async (candidate, workspaceRoot, routeledgerRoot, label) => {
    if (!path.isAbsolute(candidate)) {
        throw new Error(`${label} must be an absolute path.`);
    }
    const [resolvedCandidate, resolvedWorkspace, resolvedRouteLedger] = await Promise.all([
        realpathForPotentialFile(candidate),
        fs.realpath(workspaceRoot),
        fs.realpath(routeledgerRoot)
    ]);
    if (isContainedPath(resolvedCandidate, resolvedWorkspace) ||
        isContainedPath(resolvedCandidate, resolvedRouteLedger)) {
        throw new Error(`${label} must stay outside the workspace and RouteLedger root.`);
    }
    return resolvedCandidate;
};
const assertPrivateExistingFile = async (filePath, label) => {
    const file = await fs.lstat(filePath);
    if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error(`${label} must be a regular file, not a symlink.`);
    }
    if (process.platform !== "win32" && (file.mode & 0o022) !== 0) {
        throw new Error(`${label} must not be group-writable or world-writable.`);
    }
    if (process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        file.uid !== process.getuid()) {
        throw new Error(`${label} must be owned by the current OS user.`);
    }
};
const assertPrivateDirectory = async (directoryPath, label) => {
    const directory = await fs.lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error(`${label} directory must be a regular directory, not a symlink.`);
    }
    if (process.platform !== "win32" && (directory.mode & 0o022) !== 0) {
        throw new Error(`${label} directory must not be group-writable or world-writable.`);
    }
    if (process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        directory.uid !== process.getuid()) {
        throw new Error(`${label} directory must be owned by the current OS user.`);
    }
};
const validateConfig = (value, hostKind, subjectId) => {
    if (!isObject(value))
        throw new Error("Local L3 authority config must be a JSON object.");
    if (value.schemaVersion !== LOCAL_L3_AUTHORITY_SCHEMA_VERSION) {
        throw new Error("Unsupported local L3 authority config schemaVersion.");
    }
    if (!isNonEmptyString(value.authorityId))
        throw new Error("authorityId is required.");
    if (!isNonEmptyString(value.statePath) || !path.isAbsolute(value.statePath)) {
        throw new Error("statePath must be an absolute path.");
    }
    if (!Number.isInteger(value.grantTtlSeconds) ||
        value.grantTtlSeconds < 30 ||
        value.grantTtlSeconds > 86_400) {
        throw new Error("grantTtlSeconds must be an integer from 30 through 86400.");
    }
    if (value.trustedClientId !== undefined && !isNonEmptyString(value.trustedClientId)) {
        throw new Error("trustedClientId must be a non-empty string when provided.");
    }
    if (!isObject(value.policy))
        throw new Error("policy is required.");
    const policy = value.policy;
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
    return value;
};
const parseState = (value) => {
    if (!isObject(value) ||
        value.schemaVersion !== LOCAL_L3_AUTHORITY_STATE_SCHEMA_VERSION ||
        !Number.isInteger(value.revision) ||
        !isObject(value.activePolicies) ||
        !isObject(value.policyUsages) ||
        !isObject(value.reservedGrants) ||
        !isObject(value.grants) ||
        !isObject(value.receipts)) {
        throw new Error("Local L3 authority state is invalid and cannot be trusted.");
    }
    for (const [authorityId, active] of Object.entries(value.activePolicies)) {
        if (!isNonEmptyString(authorityId) ||
            !isObject(active) ||
            !isNonEmptyString(active.policyDigest) ||
            !isNonEmptyString(active.updatedAt) ||
            Number.isNaN(Date.parse(active.updatedAt))) {
            throw new Error("Local L3 authority active-policy state is invalid and cannot be trusted.");
        }
    }
    for (const [usageKey, usage] of Object.entries(value.policyUsages)) {
        if (!isNonEmptyString(usageKey) ||
            !isObject(usage) ||
            !isNonEmptyString(usage.policyDigest) ||
            !isNonEmptyString(usage.ruleId) ||
            !Number.isInteger(usage.uses) ||
            usage.uses < 0 ||
            !Number.isInteger(usage.maxUses) ||
            usage.maxUses <= 0 ||
            usage.uses > usage.maxUses ||
            !isNonEmptyString(usage.updatedAt) ||
            Number.isNaN(Date.parse(usage.updatedAt))) {
            throw new Error("Local L3 authority policy-usage state is invalid and cannot be trusted.");
        }
    }
    const validateStoredGrant = (entryId, grant) => {
        if (!isObject(grant) ||
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
            grant.maxUses <= 0 ||
            !Number.isInteger(grant.uses) ||
            grant.uses < 0 ||
            grant.uses > grant.maxUses ||
            (grant.status !== "active" && grant.status !== "revoked" && grant.status !== "exhausted") ||
            !isNonEmptyString(grant.createdAt) ||
            !isNonEmptyString(grant.expiresAt) ||
            Number.isNaN(Date.parse(grant.createdAt)) ||
            Number.isNaN(Date.parse(grant.expiresAt))) {
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
        if (!isObject(receipt) ||
            receipt.approvalArtifactId !== artifactId ||
            !isNonEmptyString(receipt.pendingOperationId) ||
            !isNonEmptyString(receipt.grantId) ||
            !isNonEmptyString(receipt.operationDigest) ||
            !Number.isInteger(receipt.consumedUse) ||
            receipt.consumedUse <= 0 ||
            (receipt.status !== undefined &&
                receipt.status !== "authorized" &&
                receipt.status !== "commit_claimed" &&
                receipt.status !== "committed" &&
                receipt.status !== "revoked") ||
            ((receipt.status === "commit_claimed" || receipt.status === "committed") &&
                !isNonEmptyString(receipt.commitClaimId)) ||
            (receipt.status === "commit_claimed" && !isNonEmptyString(receipt.commitClaimedAt)) ||
            (receipt.status === "committed" && !isNonEmptyString(receipt.committedAt)) ||
            (receipt.status === "revoked" && !isNonEmptyString(receipt.revokedAt))) {
            throw new Error("Local L3 authority receipt state is invalid and cannot be trusted.");
        }
    }
    return value;
};
const delay = async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
class LocalL3AuthorityStateFile {
    testHooks;
    statePath;
    lockPath;
    constructor(statePath, testHooks) {
        this.testHooks = testHooks;
        this.statePath = statePath;
        this.lockPath = `${statePath}.lock`;
    }
    async initialize() {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
        await assertPrivateDirectory(path.dirname(this.statePath), "Local L3 authority state");
        try {
            await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await this.writeAtomic(emptyState());
        }
        await this.read();
    }
    async read() {
        await assertPrivateExistingFile(this.statePath, "Local L3 authority state");
        return parseState(JSON.parse(await fs.readFile(this.statePath, "utf8")));
    }
    async activatePolicy(authorityId, policyDigest, activatedAt) {
        await this.transact((state) => {
            const previous = state.activePolicies[authorityId];
            if (previous?.policyDigest === policyDigest)
                return;
            for (const [grantId, grant] of Object.entries(state.reservedGrants)) {
                const grantAuthorizationDigest = grant.profileId === undefined
                    ? grant.policyDigest
                    : grant.profileDigest;
                if (grant.issuer === authorityId && grantAuthorizationDigest !== policyDigest) {
                    delete state.reservedGrants[grantId];
                }
            }
            for (const [grantId, grant] of Object.entries(state.grants)) {
                if (grant.issuer === authorityId &&
                    (grant.profileId !== undefined || grant.source === "delegated_policy") &&
                    (grant.profileId === undefined ? grant.policyDigest : grant.profileDigest) !== policyDigest &&
                    grant.status === "active") {
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
    async transact(mutate) {
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
        }
        finally {
            await lock.release();
        }
    }
    async acquireLock() {
        const waitTimeoutMs = this.testHooks?.lockWaitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
        const retryMs = this.testHooks?.lockRetryMs ?? LOCK_RETRY_MS;
        const heartbeatIntervalMs = this.testHooks?.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS;
        const deadline = Date.now() + waitTimeoutMs;
        while (Date.now() < deadline) {
            const now = new Date().toISOString();
            const metadata = {
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
                }
                catch (error) {
                    await fs.rm(candidatePath, { recursive: true, force: true });
                    try {
                        await fs.lstat(this.lockPath);
                        const contention = new Error("Local L3 authority state lock exists.");
                        contention.code = "EEXIST";
                        throw contention;
                    }
                    catch (inspectionError) {
                        if (inspectionError.code !== "ENOENT") {
                            throw inspectionError;
                        }
                    }
                    throw error;
                }
                let heartbeatFailure = null;
                let heartbeatPending = Promise.resolve();
                const heartbeat = setInterval(() => {
                    if (heartbeatFailure !== null)
                        return;
                    heartbeatPending = heartbeatPending
                        .then(() => this.renewLock(metadata))
                        .catch((error) => {
                        heartbeatFailure =
                            error instanceof Error
                                ? error
                                : new Error("Local L3 authority lock heartbeat failed.");
                    });
                }, heartbeatIntervalMs);
                heartbeat.unref();
                const assertOwned = async () => {
                    await heartbeatPending;
                    if (heartbeatFailure !== null)
                        throw heartbeatFailure;
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
                        if (current?.lockId !== metadata.lockId)
                            return;
                        const releasedPath = `${this.lockPath}.released-${metadata.lockId}`;
                        try {
                            await fs.rename(this.lockPath, releasedPath);
                            await fs.rm(releasedPath, { recursive: true, force: true });
                        }
                        catch (error) {
                            if (error.code !== "ENOENT")
                                throw error;
                        }
                    }
                };
            }
            catch (error) {
                await fs.rm(candidatePath, { recursive: true, force: true });
                if (error.code !== "EEXIST")
                    throw error;
                let lock;
                try {
                    lock = await fs.lstat(this.lockPath);
                }
                catch (inspectionError) {
                    if (inspectionError.code === "ENOENT")
                        continue;
                    throw inspectionError;
                }
                if (!lock.isDirectory() || lock.isSymbolicLink()) {
                    throw new Error("Local L3 authority lock path is not a trusted directory.");
                }
                const metadata = await this.readLockMetadata();
                const updatedAtMs = metadata === null ? lock.mtimeMs : Date.parse(metadata.updatedAt);
                const leaseExpired = !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > LOCK_STALE_AFTER_MS;
                const ownerAlive = metadata === null ? null : this.isProcessAlive(metadata.pid);
                if (leaseExpired && ownerAlive !== true) {
                    const stalePath = `${this.lockPath}.stale-${randomUUID()}`;
                    try {
                        await fs.rename(this.lockPath, stalePath);
                        await fs.rm(stalePath, { recursive: true, force: true });
                    }
                    catch (claimError) {
                        if (claimError.code !== "ENOENT")
                            throw claimError;
                    }
                    continue;
                }
                await delay(retryMs);
            }
        }
        throw new Error("Timed out waiting for the local L3 authority state lock.");
    }
    async readLockMetadata() {
        try {
            const value = JSON.parse(await fs.readFile(path.join(this.lockPath, "metadata.json"), "utf8"));
            if (!isNonEmptyString(value.lockId) ||
                !isNonEmptyString(value.createdAt) ||
                !isNonEmptyString(value.updatedAt) ||
                !Number.isInteger(value.pid)) {
                return null;
            }
            return value;
        }
        catch (error) {
            if (error.code === "ENOENT" ||
                error instanceof SyntaxError) {
                return null;
            }
            throw error;
        }
    }
    async writeLockMetadata(metadata, lockRoot = this.lockPath) {
        const metadataPath = path.join(lockRoot, "metadata.json");
        const temporaryPath = path.join(lockRoot, `.metadata-${metadata.lockId}.tmp`);
        await fs.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600
        });
        await fs.rename(temporaryPath, metadataPath);
        await fs.utimes(lockRoot, new Date(), new Date());
    }
    async renewLock(metadata) {
        const current = await this.readLockMetadata();
        if (current?.lockId !== metadata.lockId) {
            throw new Error("Local L3 authority state lock ownership was lost.");
        }
        metadata.updatedAt = new Date().toISOString();
        try {
            await this.writeLockMetadata(metadata);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                throw new Error("Local L3 authority state lock ownership was lost.");
            }
            throw error;
        }
    }
    isProcessAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            return error.code !== "ESRCH";
        }
    }
    async writeAtomic(state) {
        const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
        const handle = await fs.open(temporaryPath, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(temporaryPath, this.statePath);
        if (process.platform !== "win32") {
            const directory = await fs.open(path.dirname(this.statePath), "r");
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
    }
}
class PersistentLocalL3AuthorizationGrantStore {
    stateFile;
    constructor(stateFile) {
        this.stateFile = stateFile;
    }
    async issue(grant) {
        await this.stateFile.transact((state) => {
            const existing = state.grants[grant.id];
            if (existing !== undefined) {
                if (isDeepStrictEqual(existing, grant))
                    return;
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
    async get(grantId) {
        const grant = (await this.stateFile.read()).grants[grantId];
        return grant === undefined ? null : structuredClone(grant);
    }
    async findMatching(context) {
        const matches = Object.values((await this.stateFile.read()).grants)
            .filter((grant) => validateL3AuthorizationGrant(grant, context) === null)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return matches[0] === undefined ? null : structuredClone(matches[0]);
    }
    async consume(grantId, context) {
        return this.stateFile.transact((state) => {
            const grant = state.grants[grantId];
            if (grant === undefined)
                return { ok: false, code: "GRANT_NOT_FOUND" };
            const failure = validateL3AuthorizationGrant(grant, context);
            if (failure !== null)
                return { ok: false, code: failure };
            const consumedUse = grant.uses + 1;
            const updated = {
                ...grant,
                uses: consumedUse,
                status: consumedUse >= grant.maxUses ? "exhausted" : "active"
            };
            state.grants[grantId] = updated;
            return { ok: true, grant: structuredClone(updated), consumedUse };
        });
    }
    async consumeAndRecordReceipt(grantId, context, pendingOperationId, createReceipt) {
        return this.stateFile.transact((state) => {
            const replayReceipt = Object.values(state.receipts).find((receipt) => receipt.grantId === grantId &&
                receipt.pendingOperationId === pendingOperationId &&
                receipt.audience === context.audience &&
                receipt.subjectId === context.subjectId &&
                receipt.projectId === context.projectId &&
                receipt.routeledgerRootDigest === context.routeledgerRootDigest &&
                receipt.profileId === context.profileId &&
                receipt.modeEpoch === context.modeEpoch &&
                receipt.profileDigest === context.profileDigest &&
                receipt.actionType === context.actionType &&
                receipt.targetId === context.targetId &&
                receipt.operationDigest === context.operationDigest &&
                receipt.hostKind === context.hostKind &&
                (receipt.clientId == null || receipt.clientId === context.clientId) &&
                (receipt.sessionId == null || receipt.sessionId === context.sessionId));
            const grant = state.grants[grantId];
            if (grant === undefined)
                return { ok: false, code: "GRANT_NOT_FOUND" };
            if (replayReceipt !== undefined) {
                return {
                    ok: true,
                    grant: structuredClone(grant),
                    consumedUse: replayReceipt.consumedUse,
                    receipt: structuredClone(replayReceipt)
                };
            }
            const failure = validateL3AuthorizationGrant(grant, context);
            if (failure !== null)
                return { ok: false, code: failure };
            const consumedUse = grant.uses + 1;
            const updated = {
                ...grant,
                uses: consumedUse,
                status: consumedUse >= grant.maxUses ? "exhausted" : "active"
            };
            const consumption = {
                ok: true,
                grant: structuredClone(updated),
                consumedUse
            };
            const receipt = createReceipt(consumption);
            if (receipt.grantId !== grantId ||
                receipt.pendingOperationId !== pendingOperationId ||
                receipt.audience !== context.audience ||
                receipt.subjectId !== context.subjectId ||
                receipt.projectId !== context.projectId ||
                receipt.routeledgerRootDigest !== context.routeledgerRootDigest ||
                receipt.profileId !== context.profileId ||
                receipt.modeEpoch !== context.modeEpoch ||
                receipt.profileDigest !== context.profileDigest ||
                receipt.actionType !== context.actionType ||
                receipt.targetId !== context.targetId ||
                receipt.operationDigest !== context.operationDigest ||
                receipt.hostKind !== context.hostKind ||
                (receipt.clientId != null && receipt.clientId !== context.clientId) ||
                (receipt.sessionId != null && receipt.sessionId !== context.sessionId) ||
                receipt.consumedUse !== consumedUse ||
                receipt.approvalArtifactId.trim().length === 0 ||
                receipt.pendingOperationId.trim().length === 0) {
                throw new Error("L3 authorization consumption receipt does not match the consumed grant.");
            }
            if (state.receipts[receipt.approvalArtifactId] !== undefined) {
                throw new Error(`L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`);
            }
            state.grants[grantId] = updated;
            state.receipts[receipt.approvalArtifactId] = structuredClone(receipt);
            return { ...consumption, receipt: structuredClone(receipt) };
        });
    }
    async findConsumedAuthorization(context, pendingOperationId) {
        const state = await this.stateFile.read();
        const receipt = Object.values(state.receipts).find((candidate) => candidate.status !== "revoked" &&
            candidate.pendingOperationId === pendingOperationId &&
            candidate.audience === context.audience &&
            candidate.subjectId === context.subjectId &&
            candidate.projectId === context.projectId &&
            candidate.routeledgerRootDigest === context.routeledgerRootDigest &&
            candidate.profileId === context.profileId &&
            candidate.modeEpoch === context.modeEpoch &&
            candidate.profileDigest === context.profileDigest &&
            candidate.actionType === context.actionType &&
            candidate.targetId === context.targetId &&
            candidate.operationDigest === context.operationDigest &&
            candidate.hostKind === context.hostKind &&
            (candidate.clientId == null || candidate.clientId === context.clientId) &&
            (candidate.sessionId == null || candidate.sessionId === context.sessionId));
        if (receipt === undefined)
            return null;
        const grant = state.grants[receipt.grantId];
        if (grant === undefined)
            return null;
        return {
            grant: structuredClone(grant),
            receipt: structuredClone(receipt)
        };
    }
    async recordConsumptionReceipt(receipt) {
        await this.stateFile.transact((state) => {
            const existing = state.receipts[receipt.approvalArtifactId];
            if (existing !== undefined) {
                if (isDeepStrictEqual(existing, receipt))
                    return;
                throw new Error(`L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`);
            }
            state.receipts[receipt.approvalArtifactId] = structuredClone(receipt);
        });
    }
    async verifyConsumptionReceipt(binding) {
        const receipt = (await this.stateFile.read()).receipts[binding.approvalArtifactId];
        return (receipt !== undefined &&
            receipt.consumedUse > 0 &&
            Object.entries(binding).every(([key, value]) => receipt[key] === value));
    }
    async claimCommit(binding, claim) {
        return this.stateFile.transact((state) => {
            const receipt = state.receipts[binding.approvalArtifactId];
            if (receipt === undefined)
                return { ok: false, code: "RECEIPT_NOT_FOUND" };
            if (!this.receiptMatchesBinding(receipt, binding)) {
                return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
            }
            if (receipt.status === "revoked") {
                return { ok: false, code: "RECEIPT_REVOKED" };
            }
            if (receipt.status === "commit_claimed" || receipt.status === "committed") {
                if (receipt.commitClaimId !== claim.claimId) {
                    return { ok: false, code: "RECEIPT_CLAIMED_BY_OTHER" };
                }
                return { ok: true, receipt: structuredClone(receipt), replayed: true };
            }
            const claimed = {
                ...receipt,
                status: "commit_claimed",
                commitClaimId: claim.claimId,
                commitClaimedAt: claim.claimedAt,
                committedAt: null,
                revokedAt: null
            };
            state.receipts[receipt.approvalArtifactId] = claimed;
            return { ok: true, receipt: structuredClone(claimed), replayed: false };
        });
    }
    async finalizeCommit(binding, claimId, committedAt) {
        return this.stateFile.transact((state) => {
            const receipt = state.receipts[binding.approvalArtifactId];
            if (receipt === undefined)
                return { ok: false, code: "RECEIPT_NOT_FOUND" };
            if (!this.receiptMatchesBinding(receipt, binding)) {
                return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
            }
            if (receipt.status === "revoked") {
                return { ok: false, code: "RECEIPT_REVOKED" };
            }
            if (receipt.commitClaimId !== claimId || receipt.status === "authorized") {
                return { ok: false, code: "RECEIPT_CLAIMED_BY_OTHER" };
            }
            if (receipt.status === "committed") {
                return { ok: true, receipt: structuredClone(receipt), replayed: true };
            }
            const committed = {
                ...receipt,
                status: "committed",
                committedAt
            };
            state.receipts[receipt.approvalArtifactId] = committed;
            return { ok: true, receipt: structuredClone(committed), replayed: false };
        });
    }
    async revokeProfileReceipts(profileId, beforeModeEpoch, revokedAt) {
        return this.stateFile.transact((state) => {
            let revoked = 0;
            for (const [approvalArtifactId, receipt] of Object.entries(state.receipts)) {
                if (receipt.profileId === profileId &&
                    receipt.modeEpoch !== undefined &&
                    receipt.modeEpoch < beforeModeEpoch &&
                    (receipt.status === undefined || receipt.status === "authorized")) {
                    state.receipts[approvalArtifactId] = { ...receipt, status: "revoked", revokedAt };
                    revoked += 1;
                }
            }
            return revoked;
        });
    }
    receiptMatchesBinding(receipt, binding) {
        return Object.entries(binding).every(([key, value]) => receipt[key] === value);
    }
    async revoke(grantId, revokedAt) {
        return this.stateFile.transact((state) => {
            const grant = state.grants[grantId];
            if (grant === undefined)
                return null;
            const updated = { ...grant, status: "revoked", revokedAt };
            state.grants[grantId] = updated;
            for (const [approvalArtifactId, receipt] of Object.entries(state.receipts)) {
                if (receipt.grantId === grantId &&
                    (receipt.status === undefined || receipt.status === "authorized")) {
                    state.receipts[approvalArtifactId] = { ...receipt, status: "revoked", revokedAt };
                }
            }
            return structuredClone(updated);
        });
    }
}
const minimumIsoTimestamp = (...timestamps) => timestamps.reduce((minimum, candidate) => Date.parse(candidate) < Date.parse(minimum) ? candidate : minimum);
export const installLocalL3AuthorityConfig = async (input) => {
    if (input.config.policy.binding.hostKind === undefined ||
        input.config.policy.binding.subjectId === undefined) {
        throw new Error("Installed local authority policy requires exact hostKind and subjectId bindings.");
    }
    const config = validateConfig(input.config, input.config.policy.binding.hostKind, input.config.policy.binding.subjectId);
    const configPath = await assertTrustedPath(input.configPath, input.workspaceRoot, input.routeledgerRoot, "Local L3 authority config");
    await assertTrustedPath(config.statePath, input.workspaceRoot, input.routeledgerRoot, "Local L3 authority state");
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
export const loadLocalL3AuthorityRuntime = async (input) => {
    const configPath = await assertTrustedPath(input.configPath, input.workspaceRoot, input.routeledgerRoot, "Local L3 authority config");
    await assertPrivateExistingFile(configPath, "Local L3 authority config");
    await assertPrivateDirectory(path.dirname(configPath), "Local L3 authority config");
    const config = validateConfig(JSON.parse(await fs.readFile(configPath, "utf8")), input.hostKind, input.subjectId);
    const statePath = await assertTrustedPath(config.statePath, input.workspaceRoot, input.routeledgerRoot, "Local L3 authority state");
    const stateFile = new LocalL3AuthorityStateFile(statePath, input.testHooks);
    await stateFile.initialize();
    const grantStore = new PersistentLocalL3AuthorizationGrantStore(stateFile);
    const policyDigest = digestL3AuthorizationPolicy(config.policy);
    await stateFile.activatePolicy(config.authorityId, policyDigest, new Date().toISOString());
    const authorityHandle = `local:${config.authorityId}:${policyDigest}`;
    const authority = {
        authorityHandle,
        requestGrant: async (request) => {
            if (request.authorityHandle !== authorityHandle) {
                throw new Error("Local L3 authority handle mismatch.");
            }
            const decision = evaluateL3AuthorizationPolicy(config.policy, request.context);
            if (decision.effect !== "allow" || decision.matchedRuleId === null) {
                const effect = decision.effect === "prompt" ? "prompt" : "deny";
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
            const grant = {
                id: `grant-${randomUUID()}`,
                issuer: config.authorityId,
                subjectId: request.context.subjectId ?? config.policy.binding.subjectId,
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
                expiresAt: minimumIsoTimestamp(rule.conditions.expiresAt, new Date(Date.parse(now) + config.grantTtlSeconds * 1000).toISOString()),
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
                ].find((candidate) => candidate.issuer === config.authorityId &&
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
                    Date.parse(now) < Date.parse(candidate.expiresAt));
                if (recoverableGrant !== undefined) {
                    return { effect: "allow", grant: structuredClone(recoverableGrant) };
                }
                const usage = state.policyUsages[usageKey] ?? {
                    policyDigest,
                    ruleId: rule.id,
                    uses: 0,
                    maxUses: rule.conditions.maxUses,
                    updatedAt: now
                };
                if (usage.maxUses !== rule.conditions.maxUses || usage.uses >= usage.maxUses) {
                    return { effect: "deny" };
                }
                state.policyUsages[usageKey] = { ...usage, uses: usage.uses + 1, updatedAt: now };
                state.reservedGrants[grant.id] = structuredClone(grant);
                return { effect: "allow", grant };
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
export const loadLocalL3AuthorityProfileRuntime = async (input) => {
    const validation = validateL3AuthorizationProfile(input.profile);
    if (!validation.valid) {
        throw new Error(`Local L3 authorization profile is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`);
    }
    if (input.profile.binding.subjectId !== input.subjectId ||
        input.profile.binding.hostKind !== input.hostKind) {
        throw new Error("Local L3 authorization profile does not match the trusted host identity.");
    }
    const statePath = await assertTrustedPath(input.statePath, input.workspaceRoot, input.routeledgerRoot, "Local L3 authority profile state");
    const stateFile = new LocalL3AuthorityStateFile(statePath, input.testHooks);
    await stateFile.initialize();
    const grantStore = new PersistentLocalL3AuthorizationGrantStore(stateFile);
    const baseRuntime = {
        profile: structuredClone(input.profile),
        grantStore,
        ...(input.profile.binding.trustedClientId === null
            ? {}
            : { trustedClientId: input.profile.binding.trustedClientId }),
        statePath
    };
    await stateFile.activatePolicy(input.profile.profileId, input.profile.profileDigest, new Date().toISOString());
    await grantStore.revokeProfileReceipts(input.profile.profileId, input.profile.modeEpoch, new Date().toISOString());
    if (input.profile.status !== "active" || input.profile.mode !== "delegated") {
        return baseRuntime;
    }
    const policy = input.profile.delegatedPolicy;
    if (policy === null) {
        throw new Error("An active delegated profile requires a deterministic policy.");
    }
    const policyDigest = digestL3AuthorizationPolicy(policy);
    const authorityHandle = `local-profile:${input.profile.profileId}:${input.profile.profileDigest}`;
    const delegatedAuthority = {
        authorityHandle,
        requestGrant: async (request) => {
            if (request.authorityHandle !== authorityHandle) {
                throw new Error("Local L3 profile authority handle mismatch.");
            }
            if (request.context.profileId !== input.profile.profileId ||
                request.context.modeEpoch !== input.profile.modeEpoch ||
                request.context.profileDigest !== input.profile.profileDigest) {
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
            if (rule?.conditions?.maxUses === undefined || rule.conditions.expiresAt === undefined) {
                throw new Error("Matched delegated rule has no finite budget or expiry.");
            }
            const now = request.context.now;
            const grant = {
                id: `grant-${randomUUID()}`,
                issuer: input.profile.profileId,
                subjectId: input.profile.binding.subjectId,
                audience: "routeledger-core",
                projectId: request.context.projectId,
                routeledgerRootDigest: request.context.routeledgerRootDigest,
                profileId: input.profile.profileId,
                modeEpoch: input.profile.modeEpoch,
                profileDigest: input.profile.profileDigest,
                allowedActions: [request.context.actionType],
                allowedTargetIds: [request.context.targetId],
                operationDigest: request.context.operationDigest,
                scope: "operation",
                source: "delegated_policy",
                policyId: policy.policyId,
                policyDigest,
                decisionId: `decision-${randomUUID()}`,
                hostKind: input.profile.binding.hostKind,
                clientId: input.profile.binding.trustedClientId,
                sessionId: null,
                nonce: randomUUID(),
                createdAt: now,
                expiresAt: minimumIsoTimestamp(rule.conditions.expiresAt, new Date(Date.parse(now) + input.profile.limits.maxGrantTtlSeconds * 1000).toISOString()),
                maxUses: 1,
                uses: 0,
                status: "active",
                revokedAt: null
            };
            const usageKey = `${input.profile.profileDigest}:${rule.id}`;
            const grantDecision = await stateFile.transact((state) => {
                const recoverableGrant = [
                    ...Object.values(state.reservedGrants),
                    ...Object.values(state.grants)
                ].find((candidate) => candidate.issuer === input.profile.profileId &&
                    candidate.source === "delegated_policy" &&
                    candidate.profileId === input.profile.profileId &&
                    candidate.modeEpoch === input.profile.modeEpoch &&
                    candidate.profileDigest === input.profile.profileDigest &&
                    candidate.subjectId === grant.subjectId &&
                    candidate.projectId === grant.projectId &&
                    candidate.routeledgerRootDigest === grant.routeledgerRootDigest &&
                    candidate.hostKind === grant.hostKind &&
                    candidate.clientId === grant.clientId &&
                    candidate.sessionId === null &&
                    candidate.operationDigest === grant.operationDigest &&
                    candidate.allowedActions.includes(request.context.actionType) &&
                    candidate.allowedTargetIds.includes(request.context.targetId) &&
                    candidate.uses === 0 &&
                    candidate.status === "active" &&
                    Date.parse(now) < Date.parse(candidate.expiresAt));
                if (recoverableGrant !== undefined) {
                    return { effect: "allow", grant: structuredClone(recoverableGrant) };
                }
                const usage = state.policyUsages[usageKey] ?? {
                    policyDigest: input.profile.profileDigest,
                    ruleId: rule.id,
                    uses: 0,
                    maxUses: rule.conditions.maxUses,
                    updatedAt: now
                };
                if (usage.maxUses !== rule.conditions.maxUses || usage.uses >= usage.maxUses) {
                    return { effect: "deny" };
                }
                state.policyUsages[usageKey] = { ...usage, uses: usage.uses + 1, updatedAt: now };
                state.reservedGrants[grant.id] = structuredClone(grant);
                return { effect: "allow", grant };
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
