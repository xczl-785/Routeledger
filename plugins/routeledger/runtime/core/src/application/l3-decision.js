export const projectDecisionArtifact = (artifact) => ({
    id: artifact.id,
    proposalId: artifact.pendingOperationId,
    projectId: artifact.projectId,
    actionType: artifact.actionType,
    targetId: artifact.targetId,
    operationDigest: artifact.digest.value,
    status: artifact.status,
    source: artifact.approvalSource ?? "legacy",
    decisionRef: artifact.decisionRef,
    decidedAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    consumedAt: artifact.consumedAt
});
export class L3DecisionProjectionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "L3DecisionProjectionError";
    }
}
const fail = (code, message) => {
    throw new L3DecisionProjectionError(code, message);
};
export const createExactProposalDecisionRequest = (proposal) => ({
    proposalId: proposal.id,
    projectId: proposal.projectId,
    actionType: proposal.actionType,
    targetId: proposal.targetId,
    operationDigest: proposal.digest.value,
    proposalCreatedAt: proposal.createdAt
});
const exactResolutionBindingMatches = (request, candidate) => candidate.proposalId === request.proposalId &&
    candidate.projectId === request.projectId &&
    candidate.actionType === request.actionType &&
    candidate.targetId === request.targetId &&
    candidate.operationDigest === request.operationDigest;
export const assertDecisionResolutionMatchesRequest = (request, resolution) => {
    if (resolution.status === "denied") {
        if (resolution.code.trim().length === 0 || resolution.reason.trim().length === 0) {
            fail("DECISION_RESOLUTION_BINDING_MISMATCH", "A denied decision resolution requires a non-empty code and reason.");
        }
        return;
    }
    const candidate = resolution.status === "resolved" ? resolution.decision : resolution.request;
    const exactBinding = exactResolutionBindingMatches(request, candidate);
    const resolutionDetailIsValid = resolution.status === "resolved"
        ? resolution.decision.decisionRef.trim().length > 0 &&
            (resolution.decision.authorizationGrantId === undefined ||
                resolution.decision.authorizationGrantId.trim().length > 0)
        : resolution.request.reason.trim().length > 0;
    if (!exactBinding || !resolutionDetailIsValid) {
        fail("DECISION_RESOLUTION_BINDING_MISMATCH", "The decision resolution does not match the exact proposal request.");
    }
};
const artifactMatchesProposal = (artifact, proposal) => artifact.pendingOperationId === proposal.id &&
    artifact.projectId === proposal.projectId &&
    artifact.actionType === proposal.actionType &&
    artifact.targetId === proposal.targetId &&
    artifact.digest.value === proposal.digest.value;
const receiptMatchesProposal = (receipt, artifact, proposal) => receipt.approvalArtifactId === artifact.id &&
    receipt.pendingOperationId === proposal.id &&
    receipt.projectId === proposal.projectId &&
    receipt.actionType === proposal.actionType &&
    receipt.targetId === proposal.targetId &&
    receipt.operationDigest === proposal.digest.value &&
    artifact.authorizationGrantId !== undefined &&
    receipt.grantId === artifact.authorizationGrantId &&
    receipt.approvalSource === artifact.approvalSource &&
    receipt.decisionRef === artifact.decisionRef &&
    receipt.approverId === artifact.approver.id &&
    receipt.approverType === artifact.approver.type &&
    receipt.approverDisplayName === artifact.approver.displayName &&
    receipt.policyId === artifact.policyId &&
    receipt.policyDigest === artifact.policyDigest &&
    receipt.profileId === artifact.profileId &&
    receipt.modeEpoch === artifact.modeEpoch &&
    receipt.profileDigest === artifact.profileDigest &&
    receipt.hostKind === artifact.hostKind &&
    receipt.clientId === artifact.clientId &&
    receipt.sessionId === artifact.sessionId;
const validateEvidenceBindings = (evidence) => {
    const artifact = evidence.approvalArtifact ?? null;
    const receipt = evidence.authorizationReceipt ?? null;
    if (artifact !== null && !artifactMatchesProposal(artifact, evidence.proposal)) {
        return fail("DECISION_ARTIFACT_BINDING_MISMATCH", "The decision artifact does not match the exact proposal.");
    }
    if (receipt !== null && artifact === null) {
        return fail("AUTHORIZATION_RECEIPT_BINDING_MISMATCH", "The authorization receipt has no exact decision artifact.");
    }
    if (receipt !== null &&
        artifact !== null &&
        !receiptMatchesProposal(receipt, artifact, evidence.proposal)) {
        return fail("AUTHORIZATION_RECEIPT_BINDING_MISMATCH", "The authorization receipt does not match the exact proposal and decision artifact.");
    }
    return { artifact, receipt };
};
const validateCanonicalStatus = (evidence, artifact, receipt) => {
    const { proposal, observation } = evidence;
    if (proposal.status === "rejected") {
        if (observation?.kind === "stale" || observation?.kind === "failed") {
            return fail("CONTRADICTORY_DECISION_EVIDENCE", "The execution observation contradicts the canonical operation status.");
        }
        return { phase: "rejected", reason: "canonical_operation_rejected" };
    }
    if (proposal.status !== "committed")
        return null;
    if (observation !== null && observation !== undefined) {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "The execution observation contradicts the canonical operation status.");
    }
    if (artifact === null ||
        artifact.status !== "consumed" ||
        artifact.consumedAt === null ||
        proposal.approvalArtifactId !== artifact.id ||
        proposal.committedAt === null ||
        artifact.consumedAt !== proposal.committedAt) {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "The committed operation lacks its exact consumed decision artifact.");
    }
    if (receipt !== null &&
        (receipt.status !== "committed" || receipt.committedAt !== proposal.committedAt)) {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "The trusted authorization receipt contradicts the committed operation.");
    }
    return { phase: "committed", reason: "canonical_operation_committed" };
};
export const projectL3DecisionPhase = (evidence) => {
    const { artifact, receipt } = validateEvidenceBindings(evidence);
    const canonical = validateCanonicalStatus(evidence, artifact, receipt);
    if (canonical !== null)
        return canonical;
    if (artifact?.status === "consumed") {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "A pending operation cannot have a consumed decision artifact.");
    }
    if (receipt?.status === "committed") {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "A pending operation cannot have a committed authorization receipt.");
    }
    if (receipt?.status === "commit_claimed" &&
        (receipt.commitClaimId == null ||
            receipt.commitClaimId.trim().length === 0 ||
            receipt.commitClaimedAt == null)) {
        return fail("CONTRADICTORY_DECISION_EVIDENCE", "A commit-claimed receipt is missing its exact claim evidence.");
    }
    const observation = evidence.observation ?? null;
    if (observation?.kind === "decision_required") {
        if (artifact?.status === "approved") {
            return fail("CONTRADICTORY_DECISION_EVIDENCE", "Input-required evidence contradicts an already resolved exact decision.");
        }
        return { phase: "decision_required", reason: observation.code };
    }
    if (observation?.kind === "stale" || observation?.kind === "failed") {
        if (artifact?.status !== "approved") {
            return fail("CONTRADICTORY_DECISION_EVIDENCE", "A commit execution outcome requires an approved exact decision artifact.");
        }
        return { phase: observation.kind, reason: observation.code };
    }
    if (artifact === null) {
        return { phase: "proposed", reason: "proposal_recorded" };
    }
    if (artifact.status === "rejected") {
        return { phase: "rejected", reason: "decision_artifact_rejected" };
    }
    if (artifact.status === "pending" || artifact.status === "expired") {
        return { phase: "decision_required", reason: `decision_artifact_${artifact.status}` };
    }
    if (receipt?.status === "revoked") {
        return { phase: "decision_required", reason: "authorization_receipt_revoked" };
    }
    if (receipt?.status === "commit_claimed") {
        return { phase: "committing", reason: "authorization_commit_claimed" };
    }
    return { phase: "decision_resolved", reason: "exact_decision_artifact" };
};
const L3_DECISION_PHASE_TRANSITIONS = {
    proposed: ["decision_required", "decision_resolved"],
    decision_required: ["decision_resolved", "rejected"],
    decision_resolved: ["committing"],
    committing: ["committed", "stale", "failed"],
    committed: [],
    rejected: [],
    stale: [],
    failed: []
};
export const assertL3DecisionPhaseTransition = (from, to) => {
    if (!L3_DECISION_PHASE_TRANSITIONS[from].includes(to)) {
        fail("ILLEGAL_DECISION_PHASE_TRANSITION", `Illegal L3 decision phase transition: ${from} -> ${to}.`);
    }
};
