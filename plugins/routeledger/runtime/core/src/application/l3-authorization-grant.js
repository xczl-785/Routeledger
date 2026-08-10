const cloneGrant = (grant) => ({
    ...grant,
    allowedActions: [...grant.allowedActions],
    allowedTargetIds: [...grant.allowedTargetIds]
});
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
    return null;
};
export class MemoryL3AuthorizationGrantStore {
    grants = new Map();
    receipts = new Map();
    async issue(grant) {
        if (this.grants.has(grant.id)) {
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
    async recordConsumptionReceipt(receipt) {
        if (this.receipts.has(receipt.approvalArtifactId)) {
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
        return cloneGrant(updated);
    }
}
