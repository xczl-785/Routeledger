import { describe, expect, it } from "vitest";

import type {
  ApprovalArtifact,
  ExactProposalDecisionRequest,
  L3AuthorizationConsumptionReceipt,
  L3DecisionAdapter,
  PendingOperation
} from "../index.js";
import {
  assertDecisionResolutionMatchesRequest,
  assertL3DecisionPhaseTransition,
  createExactProposalDecisionRequest,
  projectL3DecisionPhase
} from "../index.js";

const actor = {
  id: "agent-1",
  type: "agent" as const,
  displayName: "Agent"
};

const proposal = (status: PendingOperation["status"] = "pending"): PendingOperation => ({
  id: "proposal-1",
  projectId: "project-1",
  actionType: "start_version",
  targetId: "version-1",
  status,
  reason: "Advance the accepted route",
  gateSnapshot: {
    kind: "none",
    evaluatedAt: "2026-08-11T00:00:00.000Z",
    allowed: true,
    blockers: []
  },
  digest: {
    algorithm: "sha256",
    value: "digest-1",
    payload: { versionId: "version-1" }
  },
  payload: {},
  createdBy: actor,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  committedAt: status === "committed" ? "2026-08-11T00:01:00.000Z" : null,
  rejectedAt: status === "rejected" ? "2026-08-11T00:01:00.000Z" : null,
  rejectionReason: status === "rejected" ? "Denied" : null,
  approvalArtifactId: status === "committed" ? "artifact-1" : null
});

const artifact = (
  status: ApprovalArtifact["status"] = "approved",
  source: ApprovalArtifact["approvalSource"] = "delegated_policy"
): ApprovalArtifact => ({
  id: "artifact-1",
  projectId: "project-1",
  pendingOperationId: "proposal-1",
  actionType: "start_version",
  targetId: "version-1",
  digest: {
    algorithm: "sha256",
    value: "digest-1",
    payload: { versionId: "version-1" }
  },
  status,
  approver: actor,
  decisionRef: "decision-1",
  createdAt: "2026-08-11T00:00:30.000Z",
  expiresAt: "2026-08-11T01:00:00.000Z",
  consumedAt: status === "consumed" ? "2026-08-11T00:01:00.000Z" : null,
  authorizationGrantId: "grant-1",
  approvalSource: source,
  policyId: "policy-1",
  policyDigest: "policy-digest-1",
  hostKind: "codex",
  clientId: "client-1",
  sessionId: "session-1"
});

const receipt = (
  status: L3AuthorizationConsumptionReceipt["status"] = "authorized"
): L3AuthorizationConsumptionReceipt => ({
  approvalArtifactId: "artifact-1",
  pendingOperationId: "proposal-1",
  grantId: "grant-1",
  audience: "routeledger-core",
  subjectId: "agent-1",
  projectId: "project-1",
  routeledgerRootDigest: "root-digest",
  actionType: "start_version",
  targetId: "version-1",
  operationDigest: "digest-1",
  approvalSource: "delegated_policy",
  decisionRef: "decision-1",
  approverId: "agent-1",
  approverType: "agent",
  approverDisplayName: "Agent",
  policyId: "policy-1",
  policyDigest: "policy-digest-1",
  hostKind: "codex",
  clientId: "client-1",
  sessionId: "session-1",
  createdAt: "2026-08-11T00:00:30.000Z",
  expiresAt: "2026-08-11T01:00:00.000Z",
  consumedUse: 1,
  status,
  commitClaimId: status === "commit_claimed" ? "claim-1" : null,
  commitClaimedAt:
    status === "commit_claimed" ? "2026-08-11T00:00:45.000Z" : null,
  committedAt: status === "committed" ? "2026-08-11T00:01:00.000Z" : null,
  revokedAt: null
});

describe("L3 decision contract", () => {
  it("lets a host adapter resolve only the exact proposal request", async () => {
    const adapter: L3DecisionAdapter = {
      id: "test-adapter",
      async resolve(request) {
        return {
          status: "resolved",
          decision: {
            proposalId: request.proposalId,
            projectId: request.projectId,
            actionType: request.actionType,
            targetId: request.targetId,
            operationDigest: request.operationDigest,
            source: "delegated_policy",
            decisionRef: "decision-1",
            authorizationGrantId: "grant-1"
          }
        };
      }
    };
    const request: ExactProposalDecisionRequest = {
      proposalId: "proposal-1",
      projectId: "project-1",
      actionType: "start_version",
      targetId: "version-1",
      operationDigest: "digest-1",
      proposalCreatedAt: "2026-08-11T00:00:00.000Z"
    };

    await expect(adapter.resolve(request)).resolves.toMatchObject({
      status: "resolved",
      decision: {
        proposalId: "proposal-1",
        operationDigest: "digest-1",
        source: "delegated_policy"
      }
    });
  });

  it("derives the request from the canonical proposal and rejects widened adapter output", () => {
    const request = createExactProposalDecisionRequest(proposal());
    expect(request).toEqual({
      proposalId: "proposal-1",
      projectId: "project-1",
      actionType: "start_version",
      targetId: "version-1",
      operationDigest: "digest-1",
      proposalCreatedAt: "2026-08-11T00:00:00.000Z"
    });

    expect(() =>
      assertDecisionResolutionMatchesRequest(request, {
        status: "resolved",
        decision: {
          proposalId: "proposal-1",
          projectId: "project-1",
          actionType: "start_version",
          targetId: "version-other",
          operationDigest: "digest-1",
          source: "delegated_policy",
          decisionRef: "decision-1"
        }
      })
    ).toThrowError(/does not match the exact proposal request/);

    expect(() =>
      assertDecisionResolutionMatchesRequest(request, {
        status: "input_required",
        request: {
          proposalId: "proposal-1",
          projectId: "project-1",
          actionType: "start_version",
          targetId: "version-1",
          operationDigest: "digest-other",
          reason: "User input required"
        }
      })
    ).toThrowError(/does not match the exact proposal request/);
  });
});

describe("projectL3DecisionPhase", () => {
  it("projects proposed and explicit decision-required phases without guessing", () => {
    expect(projectL3DecisionPhase({ proposal: proposal() })).toEqual({
      phase: "proposed",
      reason: "proposal_recorded"
    });
    expect(
      projectL3DecisionPhase({
        proposal: proposal(),
        observation: {
          kind: "decision_required",
          code: "HOST_INPUT_REQUIRED",
          observedAt: "2026-08-11T00:00:10.000Z"
        }
      })
    ).toEqual({
      phase: "decision_required",
      reason: "HOST_INPUT_REQUIRED"
    });
  });

  it("projects resolved, committing, committed, and rejected from exact evidence", () => {
    expect(
      projectL3DecisionPhase({ proposal: proposal(), approvalArtifact: artifact() })
    ).toEqual({ phase: "decision_resolved", reason: "exact_decision_artifact" });

    expect(
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        authorizationReceipt: receipt("commit_claimed")
      })
    ).toEqual({ phase: "committing", reason: "authorization_commit_claimed" });

    expect(
      projectL3DecisionPhase({
        proposal: proposal("committed"),
        approvalArtifact: artifact("consumed"),
        authorizationReceipt: receipt("committed")
      })
    ).toEqual({ phase: "committed", reason: "canonical_operation_committed" });

    expect(projectL3DecisionPhase({ proposal: proposal("rejected") })).toEqual({
      phase: "rejected",
      reason: "canonical_operation_rejected"
    });
  });

  it.each(["user_interaction", "delegated_policy", "preauthorized"] as const)(
    "projects %s decisions through the same resolved phase",
    (source) => {
      expect(
        projectL3DecisionPhase({
          proposal: proposal(),
          approvalArtifact: artifact("approved", source),
          authorizationReceipt: {
            ...receipt("authorized"),
            approvalSource: source
          }
        })
      ).toEqual({ phase: "decision_resolved", reason: "exact_decision_artifact" });
    }
  );

  it("keeps legacy artifacts compatible and projects expiry and revocation honestly", () => {
    const legacyArtifact = { ...artifact() };
    delete legacyArtifact.authorizationGrantId;
    delete legacyArtifact.approvalSource;

    expect(
      projectL3DecisionPhase({ proposal: proposal(), approvalArtifact: legacyArtifact })
    ).toEqual({ phase: "decision_resolved", reason: "exact_decision_artifact" });
    expect(
      projectL3DecisionPhase({ proposal: proposal(), approvalArtifact: artifact("expired") })
    ).toEqual({ phase: "decision_required", reason: "decision_artifact_expired" });
    expect(
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        authorizationReceipt: receipt("revoked")
      })
    ).toEqual({ phase: "decision_required", reason: "authorization_receipt_revoked" });
  });

  it("projects an exact committed replay as committed without inventing another transition", () => {
    expect(
      projectL3DecisionPhase({
        proposal: proposal("committed"),
        approvalArtifact: artifact("consumed"),
        authorizationReceipt: receipt("committed")
      })
    ).toEqual({ phase: "committed", reason: "canonical_operation_committed" });
  });

  it("projects stale and failed only from explicit execution observations", () => {
    expect(
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        observation: {
          kind: "stale",
          code: "LIVE_DIGEST_MISMATCH",
          observedAt: "2026-08-11T00:00:50.000Z"
        }
      })
    ).toEqual({ phase: "stale", reason: "LIVE_DIGEST_MISMATCH" });

    expect(
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        observation: {
          kind: "failed",
          code: "PERSISTENCE_INTERRUPTED",
          observedAt: "2026-08-11T00:00:50.000Z"
        }
      })
    ).toEqual({ phase: "failed", reason: "PERSISTENCE_INTERRUPTED" });
  });

  it("fails closed on mismatched or contradictory evidence", () => {
    expect(() =>
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: { ...artifact(), pendingOperationId: "proposal-other" }
      })
    ).toThrowError(/does not match the exact proposal/);

    expect(() =>
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        authorizationReceipt: { ...receipt("commit_claimed"), operationDigest: "digest-other" }
      })
    ).toThrowError(/does not match the exact proposal/);

    expect(() =>
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        authorizationReceipt: { ...receipt("authorized"), decisionRef: "decision-other" }
      })
    ).toThrowError(/does not match the exact proposal/);

    expect(() =>
      projectL3DecisionPhase({
        proposal: proposal(),
        approvalArtifact: artifact(),
        authorizationReceipt: receipt("committed"),
        observation: {
          kind: "failed",
          code: "PERSISTENCE_INTERRUPTED",
          observedAt: "2026-08-11T00:01:01.000Z"
        }
      })
    ).toThrowError(/pending operation cannot have a committed authorization receipt/);

    expect(() =>
      projectL3DecisionPhase({
        proposal: proposal("committed"),
        approvalArtifact: artifact("consumed"),
        observation: {
          kind: "stale",
          code: "LIVE_DIGEST_MISMATCH",
          observedAt: "2026-08-11T00:01:01.000Z"
        }
      })
    ).toThrowError(/contradicts the canonical operation status/);
  });
});

describe("assertL3DecisionPhaseTransition", () => {
  it("accepts the canonical transition sequence", () => {
    expect(() => assertL3DecisionPhaseTransition("proposed", "decision_required")).not.toThrow();
    expect(() =>
      assertL3DecisionPhaseTransition("decision_required", "decision_resolved")
    ).not.toThrow();
    expect(() => assertL3DecisionPhaseTransition("decision_resolved", "committing")).not.toThrow();
    expect(() => assertL3DecisionPhaseTransition("committing", "committed")).not.toThrow();
  });

  it("rejects shortcuts and transitions out of terminal phases", () => {
    expect(() => assertL3DecisionPhaseTransition("proposed", "committing")).toThrowError(
      /Illegal L3 decision phase transition/
    );
    expect(() => assertL3DecisionPhaseTransition("committed", "proposed")).toThrowError(
      /Illegal L3 decision phase transition/
    );
  });
});
