import { ApplicationError } from "./errors.js";
import { loadRequiredProjectAggregate } from "./project-aggregate-access.js";
import { buildBalancedL3AuthorizationPolicy } from "./l3-authorization.js";
const requireL3Proposal = (snapshot, pendingOperationId) => {
    const proposal = snapshot.pendingOperations.find((operation) => operation.id === pendingOperationId);
    if (proposal === undefined) {
        throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
            projectId: snapshot.project.id,
            pendingOperationId
        });
    }
    return proposal;
};
export class L3ProposalReadService {
    storage;
    clock;
    constructor(options) {
        this.storage = options.storage;
        this.clock = options.clock;
    }
    async listL3Proposals(projectId) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);
        return snapshot.pendingOperations
            .slice()
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    async getL3Proposal(projectId, pendingOperationId) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);
        return requireL3Proposal(snapshot, pendingOperationId);
    }
    async getL3AuthorizationEvaluationContext(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        const proposal = requireL3Proposal(snapshot, input.pendingOperationId);
        const currentVersion = snapshot.versions.find((version) => version.id === snapshot.project.currentVersionId);
        const targetRelation = proposal.targetId === snapshot.project.currentVersionId
            ? "current"
            : currentVersion?.nextVersionId === proposal.targetId
                ? "legal-successor"
                : "other";
        return {
            projectId: input.projectId,
            routeledgerRootDigest: input.routeledgerRootDigest,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
            ...(input.modeEpoch === undefined ? {} : { modeEpoch: input.modeEpoch }),
            ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
            actionType: proposal.actionType,
            targetId: proposal.targetId,
            currentVersionId: snapshot.project.currentVersionId,
            targetRelation,
            gateAllowed: proposal.gateSnapshot.allowed,
            operationDigest: proposal.digest.value,
            now: this.clock.now(),
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
            ...(input.clientId === undefined ? {} : { clientId: input.clientId })
        };
    }
    async recommendBalancedL3AuthorizationPolicy(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return buildBalancedL3AuthorizationPolicy({
            policyId: input.policyId,
            projectId: input.projectId,
            routeledgerRootDigest: input.routeledgerRootDigest,
            currentVersionId: snapshot.project.currentVersionId,
            routeVersionIds: snapshot.versions.map((version) => version.id),
            expiresAt: input.expiresAt,
            decisionBudget: input.decisionBudget,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
            ...(input.clientId === undefined ? {} : { clientId: input.clientId })
        });
    }
}
