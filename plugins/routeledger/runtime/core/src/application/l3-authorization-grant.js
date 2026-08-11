import { isDeepStrictEqual } from "node:util";
const cloneGrant = (grant) => ({
    ...grant,
    allowedActions: [...grant.allowedActions],
    allowedTargetIds: [...grant.allowedTargetIds]
});
const receiptMatchesAuthorizationContext = (receipt, grantId, context, pendingOperationId) => receipt.grantId === grantId &&
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
    (receipt.sessionId == null || receipt.sessionId === context.sessionId);
const validateCreatedReceipt = (receipt, grantId, context, pendingOperationId, consumedUse) => {
    if (!receiptMatchesAuthorizationContext(receipt, grantId, context, pendingOperationId) ||
        receipt.consumedUse !== consumedUse ||
        receipt.approvalArtifactId.trim().length === 0 ||
        receipt.pendingOperationId.trim().length === 0) {
        throw new Error("L3 authorization consumption receipt does not match the consumed grant.");
    }
};
export const validateL3AuthorizationGrant = (grant, context) => {
    if (grant.status !== "active")
        return "GRANT_INACTIVE";
    if (Date.parse(context.now) >= Date.parse(grant.expiresAt))
        return "GRANT_EXPIRED";
    if (grant.uses >= grant.maxUses)
        return "GRANT_EXHAUSTED";
    if (grant.audience !== context.audience)
        return "GRANT_AUDIENCE_MISMATCH";
    if (grant.subjectId !== context.subjectId)
        return "GRANT_SUBJECT_MISMATCH";
    if (grant.projectId !== context.projectId)
        return "GRANT_PROJECT_MISMATCH";
    if (grant.routeledgerRootDigest !== context.routeledgerRootDigest)
        return "GRANT_ROOT_MISMATCH";
    if (grant.profileId !== context.profileId)
        return "GRANT_PROFILE_MISMATCH";
    if (grant.modeEpoch !== context.modeEpoch)
        return "GRANT_MODE_EPOCH_MISMATCH";
    if (grant.profileDigest !== context.profileDigest)
        return "GRANT_PROFILE_DIGEST_MISMATCH";
    if (!grant.allowedActions.includes(context.actionType))
        return "GRANT_ACTION_MISMATCH";
    if (!grant.allowedTargetIds.includes(context.targetId))
        return "GRANT_TARGET_MISMATCH";
    if (grant.operationDigest !== null && grant.operationDigest !== context.operationDigest) {
        return "GRANT_OPERATION_MISMATCH";
    }
    if (grant.scope === "operation" && grant.operationDigest === null) {
        return "GRANT_OPERATION_MISMATCH";
    }
    if (grant.hostKind !== context.hostKind)
        return "GRANT_HOST_MISMATCH";
    if (grant.clientId !== null && grant.clientId !== context.clientId) {
        return "GRANT_CLIENT_MISMATCH";
    }
    if (grant.sessionId !== null && grant.sessionId !== context.sessionId) {
        return "GRANT_SESSION_MISMATCH";
    }
    const hasCompleteProfileProvenance = typeof grant.profileId === "string" &&
        grant.profileId.trim().length > 0 &&
        Number.isInteger(grant.modeEpoch) &&
        grant.modeEpoch > 0 &&
        typeof grant.profileDigest === "string" &&
        grant.profileDigest.trim().length > 0;
    const hasNoProfileProvenance = grant.profileId === undefined &&
        grant.modeEpoch === undefined &&
        grant.profileDigest === undefined;
    if (!hasCompleteProfileProvenance && !hasNoProfileProvenance)
        return "GRANT_SCOPE_INVALID";
    if (grant.allowedActions.length === 0 ||
        grant.allowedTargetIds.length === 0 ||
        grant.maxUses <= 0) {
        return "GRANT_SCOPE_INVALID";
    }
    if (grant.scope === "operation" &&
        (grant.operationDigest === null ||
            grant.allowedActions.length !== 1 ||
            grant.allowedTargetIds.length !== 1 ||
            grant.maxUses !== 1)) {
        return "GRANT_SCOPE_INVALID";
    }
    if (grant.scope === "session" &&
        (grant.operationDigest !== null || grant.sessionId === null || grant.sessionId.trim().length === 0)) {
        return "GRANT_SCOPE_INVALID";
    }
    if (grant.scope === "time_window" &&
        (grant.operationDigest !== null || grant.sessionId !== null)) {
        return "GRANT_SCOPE_INVALID";
    }
    if (grant.scope === "turn")
        return "GRANT_SCOPE_INVALID";
    return null;
};
export class MemoryL3AuthorizationGrantStore {
    grants = new Map();
    receipts = new Map();
    async issue(grant) {
        const existing = this.grants.get(grant.id);
        if (existing !== undefined) {
            if (isDeepStrictEqual(existing, grant))
                return;
            throw new Error(`L3 authorization grant already exists: ${grant.id}`);
        }
        this.grants.set(grant.id, cloneGrant(grant));
    }
    async get(grantId) {
        const grant = this.grants.get(grantId);
        return grant === undefined ? null : cloneGrant(grant);
    }
    async findMatching(context) {
        const matches = [...this.grants.values()]
            .filter((grant) => validateL3AuthorizationGrant(grant, context) === null)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return matches[0] === undefined ? null : cloneGrant(matches[0]);
    }
    async consume(grantId, context) {
        const grant = this.grants.get(grantId);
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
        this.grants.set(grantId, updated);
        return { ok: true, grant: cloneGrant(updated), consumedUse };
    }
    async consumeAndRecordReceipt(grantId, context, pendingOperationId, createReceipt) {
        const replayReceipt = [...this.receipts.values()].find((receipt) => receiptMatchesAuthorizationContext(receipt, grantId, context, pendingOperationId));
        if (replayReceipt !== undefined) {
            const replayGrant = this.grants.get(grantId);
            if (replayGrant === undefined)
                return { ok: false, code: "GRANT_NOT_FOUND" };
            return {
                ok: true,
                grant: cloneGrant(replayGrant),
                consumedUse: replayReceipt.consumedUse,
                receipt: structuredClone(replayReceipt)
            };
        }
        const grant = this.grants.get(grantId);
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
        const consumption = {
            ok: true,
            grant: cloneGrant(updated),
            consumedUse
        };
        const receipt = createReceipt(consumption);
        validateCreatedReceipt(receipt, grantId, context, pendingOperationId, consumedUse);
        if (this.receipts.has(receipt.approvalArtifactId)) {
            throw new Error(`L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`);
        }
        this.grants.set(grantId, updated);
        this.receipts.set(receipt.approvalArtifactId, structuredClone(receipt));
        return { ...consumption, receipt: structuredClone(receipt) };
    }
    async findConsumedAuthorization(context, pendingOperationId) {
        const receipt = [...this.receipts.values()].find((candidate) => receiptMatchesAuthorizationContext(candidate, candidate.grantId, context, pendingOperationId));
        if (receipt === undefined)
            return null;
        const grant = this.grants.get(receipt.grantId);
        if (grant === undefined)
            return null;
        return { grant: cloneGrant(grant), receipt: structuredClone(receipt) };
    }
    async recordConsumptionReceipt(receipt) {
        const existing = this.receipts.get(receipt.approvalArtifactId);
        if (existing !== undefined) {
            if (isDeepStrictEqual(existing, receipt))
                return;
            throw new Error(`L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`);
        }
        this.receipts.set(receipt.approvalArtifactId, structuredClone(receipt));
    }
    async verifyConsumptionReceipt(binding) {
        const receipt = this.receipts.get(binding.approvalArtifactId);
        if (receipt === undefined)
            return false;
        return (receipt.consumedUse > 0 &&
            Object.entries(binding).every(([key, value]) => receipt[key] === value));
    }
    async claimCommit(binding, claim) {
        const receipt = this.receipts.get(binding.approvalArtifactId);
        if (receipt === undefined)
            return { ok: false, code: "RECEIPT_NOT_FOUND" };
        if (!this.receiptMatchesBinding(receipt, binding)) {
            return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
        }
        if (receipt.status === "revoked")
            return { ok: false, code: "RECEIPT_REVOKED" };
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
        this.receipts.set(receipt.approvalArtifactId, claimed);
        return { ok: true, receipt: structuredClone(claimed), replayed: false };
    }
    async finalizeCommit(binding, claimId, committedAt) {
        const receipt = this.receipts.get(binding.approvalArtifactId);
        if (receipt === undefined)
            return { ok: false, code: "RECEIPT_NOT_FOUND" };
        if (!this.receiptMatchesBinding(receipt, binding)) {
            return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
        }
        if (receipt.status === "revoked")
            return { ok: false, code: "RECEIPT_REVOKED" };
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
        this.receipts.set(receipt.approvalArtifactId, committed);
        return { ok: true, receipt: structuredClone(committed), replayed: false };
    }
    async revokeProfileReceipts(profileId, beforeModeEpoch, revokedAt) {
        let revoked = 0;
        for (const [approvalArtifactId, receipt] of this.receipts) {
            if (receipt.profileId === profileId &&
                receipt.modeEpoch !== undefined &&
                receipt.modeEpoch < beforeModeEpoch &&
                (receipt.status === undefined || receipt.status === "authorized")) {
                this.receipts.set(approvalArtifactId, {
                    ...receipt,
                    status: "revoked",
                    revokedAt
                });
                revoked += 1;
            }
        }
        return revoked;
    }
    receiptMatchesBinding(receipt, binding) {
        return Object.entries(binding).every(([key, value]) => receipt[key] === value);
    }
    async revoke(grantId, revokedAt) {
        const grant = this.grants.get(grantId);
        if (grant === undefined)
            return null;
        const updated = {
            ...grant,
            status: "revoked",
            revokedAt
        };
        this.grants.set(grantId, updated);
        for (const [approvalArtifactId, receipt] of this.receipts) {
            if (receipt.grantId === grantId &&
                (receipt.status === undefined || receipt.status === "authorized")) {
                this.receipts.set(approvalArtifactId, {
                    ...receipt,
                    status: "revoked",
                    revokedAt
                });
            }
        }
        return cloneGrant(updated);
    }
}
