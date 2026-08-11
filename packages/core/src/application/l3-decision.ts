import type {
  L3AuthorizationConsumptionReceipt,
  L3AuthorizationGrantSource
} from "./l3-authorization-grant.js";
import type {
  ApprovalArtifact,
  L3ActionType,
  PendingOperation
} from "./types.js";

export type L3DecisionPhase =
  | "proposed"
  | "decision_required"
  | "decision_resolved"
  | "committing"
  | "committed"
  | "rejected"
  | "stale"
  | "failed";

export interface ExactProposalDecisionRequest {
  readonly proposalId: string;
  readonly projectId: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly proposalCreatedAt: string;
}

export interface ExactDecision {
  readonly proposalId: string;
  readonly projectId: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly source: L3AuthorizationGrantSource;
  readonly decisionRef: string;
  readonly authorizationGrantId?: string;
}

export interface DecisionArtifact {
  readonly id: string;
  readonly proposalId: string;
  readonly projectId: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly status: ApprovalArtifact["status"];
  readonly source: ApprovalArtifact["approvalSource"] | "legacy";
  readonly decisionRef: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export const projectDecisionArtifact = (
  artifact: Readonly<ApprovalArtifact>
): DecisionArtifact => ({
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

export interface L3DecisionInputRequest {
  readonly proposalId: string;
  readonly projectId: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly reason: string;
}

export type DecisionResolution =
  | { readonly status: "resolved"; readonly decision: ExactDecision }
  | { readonly status: "input_required"; readonly request: L3DecisionInputRequest }
  | { readonly status: "denied"; readonly code: string; readonly reason: string };

export interface L3DecisionAdapter {
  readonly id: string;
  resolve(request: ExactProposalDecisionRequest): Promise<DecisionResolution>;
}

export type L3DecisionPhaseObservation =
  | {
      readonly kind: "decision_required";
      readonly code: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: "stale";
      readonly code: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly observedAt: string;
    };

export interface L3DecisionPhaseEvidence {
  readonly proposal: Readonly<PendingOperation>;
  readonly approvalArtifact?: Readonly<ApprovalArtifact> | null;
  readonly authorizationReceipt?: Readonly<L3AuthorizationConsumptionReceipt> | null;
  readonly observation?: L3DecisionPhaseObservation | null;
}

export interface L3DecisionPhaseProjection {
  readonly phase: L3DecisionPhase;
  readonly reason: string;
}

export type L3DecisionProjectionErrorCode =
  | "DECISION_RESOLUTION_BINDING_MISMATCH"
  | "DECISION_ARTIFACT_BINDING_MISMATCH"
  | "AUTHORIZATION_RECEIPT_BINDING_MISMATCH"
  | "CONTRADICTORY_DECISION_EVIDENCE"
  | "ILLEGAL_DECISION_PHASE_TRANSITION";

export class L3DecisionProjectionError extends Error {
  constructor(
    readonly code: L3DecisionProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "L3DecisionProjectionError";
  }
}

const fail = (code: L3DecisionProjectionErrorCode, message: string): never => {
  throw new L3DecisionProjectionError(code, message);
};

export const createExactProposalDecisionRequest = (
  proposal: Readonly<PendingOperation>
): ExactProposalDecisionRequest => ({
  proposalId: proposal.id,
  projectId: proposal.projectId,
  actionType: proposal.actionType,
  targetId: proposal.targetId,
  operationDigest: proposal.digest.value,
  proposalCreatedAt: proposal.createdAt
});

const exactResolutionBindingMatches = (
  request: ExactProposalDecisionRequest,
  candidate: {
    readonly proposalId: string;
    readonly projectId: string;
    readonly actionType: L3ActionType;
    readonly targetId: string;
    readonly operationDigest: string;
  }
): boolean =>
  candidate.proposalId === request.proposalId &&
  candidate.projectId === request.projectId &&
  candidate.actionType === request.actionType &&
  candidate.targetId === request.targetId &&
  candidate.operationDigest === request.operationDigest;

export const assertDecisionResolutionMatchesRequest = (
  request: ExactProposalDecisionRequest,
  resolution: DecisionResolution
): void => {
  if (resolution.status === "denied") {
    if (resolution.code.trim().length === 0 || resolution.reason.trim().length === 0) {
      fail(
        "DECISION_RESOLUTION_BINDING_MISMATCH",
        "A denied decision resolution requires a non-empty code and reason."
      );
    }
    return;
  }

  const candidate = resolution.status === "resolved" ? resolution.decision : resolution.request;
  const exactBinding = exactResolutionBindingMatches(request, candidate);
  const resolutionDetailIsValid =
    resolution.status === "resolved"
      ? resolution.decision.decisionRef.trim().length > 0 &&
        (resolution.decision.authorizationGrantId === undefined ||
          resolution.decision.authorizationGrantId.trim().length > 0)
      : resolution.request.reason.trim().length > 0;

  if (!exactBinding || !resolutionDetailIsValid) {
    fail(
      "DECISION_RESOLUTION_BINDING_MISMATCH",
      "The decision resolution does not match the exact proposal request."
    );
  }
};

const artifactMatchesProposal = (
  artifact: Readonly<ApprovalArtifact>,
  proposal: Readonly<PendingOperation>
): boolean =>
  artifact.pendingOperationId === proposal.id &&
  artifact.projectId === proposal.projectId &&
  artifact.actionType === proposal.actionType &&
  artifact.targetId === proposal.targetId &&
  artifact.digest.value === proposal.digest.value;

const receiptMatchesProposal = (
  receipt: Readonly<L3AuthorizationConsumptionReceipt>,
  artifact: Readonly<ApprovalArtifact>,
  proposal: Readonly<PendingOperation>
): boolean =>
  receipt.approvalArtifactId === artifact.id &&
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

const validateEvidenceBindings = (
  evidence: L3DecisionPhaseEvidence
): {
  artifact: Readonly<ApprovalArtifact> | null;
  receipt: Readonly<L3AuthorizationConsumptionReceipt> | null;
} => {
  const artifact = evidence.approvalArtifact ?? null;
  const receipt = evidence.authorizationReceipt ?? null;

  if (artifact !== null && !artifactMatchesProposal(artifact, evidence.proposal)) {
    return fail(
      "DECISION_ARTIFACT_BINDING_MISMATCH",
      "The decision artifact does not match the exact proposal."
    );
  }
  if (receipt !== null && artifact === null) {
    return fail(
      "AUTHORIZATION_RECEIPT_BINDING_MISMATCH",
      "The authorization receipt has no exact decision artifact."
    );
  }
  if (
    receipt !== null &&
    artifact !== null &&
    !receiptMatchesProposal(receipt, artifact, evidence.proposal)
  ) {
    return fail(
      "AUTHORIZATION_RECEIPT_BINDING_MISMATCH",
      "The authorization receipt does not match the exact proposal and decision artifact."
    );
  }

  return { artifact, receipt };
};

const validateCanonicalStatus = (
  evidence: L3DecisionPhaseEvidence,
  artifact: Readonly<ApprovalArtifact> | null,
  receipt: Readonly<L3AuthorizationConsumptionReceipt> | null
): L3DecisionPhaseProjection | null => {
  const { proposal, observation } = evidence;

  if (proposal.status === "rejected") {
    if (observation?.kind === "stale" || observation?.kind === "failed") {
      return fail(
        "CONTRADICTORY_DECISION_EVIDENCE",
        "The execution observation contradicts the canonical operation status."
      );
    }
    return { phase: "rejected", reason: "canonical_operation_rejected" };
  }

  if (proposal.status !== "committed") return null;

  if (observation !== null && observation !== undefined) {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "The execution observation contradicts the canonical operation status."
    );
  }
  if (
    artifact === null ||
    artifact.status !== "consumed" ||
    artifact.consumedAt === null ||
    proposal.approvalArtifactId !== artifact.id ||
    proposal.committedAt === null ||
    artifact.consumedAt !== proposal.committedAt
  ) {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "The committed operation lacks its exact consumed decision artifact."
    );
  }
  if (
    receipt !== null &&
    (receipt.status !== "committed" || receipt.committedAt !== proposal.committedAt)
  ) {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "The trusted authorization receipt contradicts the committed operation."
    );
  }
  return { phase: "committed", reason: "canonical_operation_committed" };
};

export const projectL3DecisionPhase = (
  evidence: L3DecisionPhaseEvidence
): L3DecisionPhaseProjection => {
  const { artifact, receipt } = validateEvidenceBindings(evidence);
  const canonical = validateCanonicalStatus(evidence, artifact, receipt);
  if (canonical !== null) return canonical;

  if (artifact?.status === "consumed") {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "A pending operation cannot have a consumed decision artifact."
    );
  }
  if (receipt?.status === "committed") {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "A pending operation cannot have a committed authorization receipt."
    );
  }
  if (
    receipt?.status === "commit_claimed" &&
    (receipt.commitClaimId == null ||
      receipt.commitClaimId.trim().length === 0 ||
      receipt.commitClaimedAt == null)
  ) {
    return fail(
      "CONTRADICTORY_DECISION_EVIDENCE",
      "A commit-claimed receipt is missing its exact claim evidence."
    );
  }

  const observation = evidence.observation ?? null;
  if (observation?.kind === "decision_required") {
    if (artifact?.status === "approved") {
      return fail(
        "CONTRADICTORY_DECISION_EVIDENCE",
        "Input-required evidence contradicts an already resolved exact decision."
      );
    }
    return { phase: "decision_required", reason: observation.code };
  }

  if (observation?.kind === "stale" || observation?.kind === "failed") {
    if (artifact?.status !== "approved") {
      return fail(
        "CONTRADICTORY_DECISION_EVIDENCE",
        "A commit execution outcome requires an approved exact decision artifact."
      );
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

const L3_DECISION_PHASE_TRANSITIONS: Readonly<
  Record<L3DecisionPhase, readonly L3DecisionPhase[]>
> = {
  proposed: ["decision_required", "decision_resolved"],
  decision_required: ["decision_resolved", "rejected"],
  decision_resolved: ["committing"],
  committing: ["committed", "stale", "failed"],
  committed: [],
  rejected: [],
  stale: [],
  failed: []
};

export const assertL3DecisionPhaseTransition = (
  from: L3DecisionPhase,
  to: L3DecisionPhase
): void => {
  if (!L3_DECISION_PHASE_TRANSITIONS[from].includes(to)) {
    fail(
      "ILLEGAL_DECISION_PHASE_TRANSITION",
      `Illegal L3 decision phase transition: ${from} -> ${to}.`
    );
  }
};
