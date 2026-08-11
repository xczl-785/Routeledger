import {
  assertDecisionResolutionMatchesRequest,
  createExactProposalDecisionRequest,
  type ExactDecision,
  type L3DecisionAdapter,
  type L3DecisionInputRequest
} from "./l3-decision.js";
import type { PendingOperation } from "./types.js";

export interface L3OperationRequestState extends L3DecisionInputRequest {
  readonly schemaVersion: 1;
  readonly adapterId: string;
}

export interface L3OperationOrchestrationPort<TArtifact, TCommit, TRejection> {
  authorize(
    proposal: Readonly<PendingOperation>,
    decision: Readonly<ExactDecision>
  ): Promise<TArtifact>;
  commit(proposal: Readonly<PendingOperation>, artifact: Readonly<TArtifact>): Promise<TCommit>;
  reject(
    proposal: Readonly<PendingOperation>,
    denial: { readonly code: string; readonly reason: string }
  ): Promise<TRejection>;
}

export type L3OperationOrchestrationResult<TArtifact, TCommit, TRejection> =
  | {
      readonly status: "committed";
      readonly proposalId: string;
      readonly decision: ExactDecision;
      readonly approvalArtifact: TArtifact;
      readonly commit: TCommit;
    }
  | {
      readonly status: "input_required";
      readonly requestState: L3OperationRequestState;
    }
  | {
      readonly status: "denied";
      readonly proposalId: string;
      readonly code: string;
      readonly reason: string;
      readonly rejection: TRejection;
    };

export const assertL3OperationRequestStateMatchesProposal = (
  state: Readonly<L3OperationRequestState>,
  proposal: Readonly<PendingOperation>,
  adapterId?: string
): void => {
  if (state.schemaVersion !== 1 || (adapterId !== undefined && state.adapterId !== adapterId)) {
    throw new Error("The L3 operation request state does not match the active adapter.");
  }
  const request = createExactProposalDecisionRequest(proposal);
  assertDecisionResolutionMatchesRequest(request, {
    status: "input_required",
    request: state
  });
};

export const orchestrateL3Operation = async <TArtifact, TCommit, TRejection>(input: {
  readonly proposal: Readonly<PendingOperation>;
  readonly adapter: L3DecisionAdapter;
  readonly port: L3OperationOrchestrationPort<TArtifact, TCommit, TRejection>;
}): Promise<L3OperationOrchestrationResult<TArtifact, TCommit, TRejection>> => {
  const request = createExactProposalDecisionRequest(input.proposal);
  const resolution = await input.adapter.resolve(request);
  assertDecisionResolutionMatchesRequest(request, resolution);

  if (resolution.status === "input_required") {
    return {
      status: "input_required",
      requestState: {
        schemaVersion: 1,
        adapterId: input.adapter.id,
        ...resolution.request
      }
    };
  }

  if (resolution.status === "denied") {
    return {
      status: "denied",
      proposalId: input.proposal.id,
      code: resolution.code,
      reason: resolution.reason,
      rejection: await input.port.reject(input.proposal, resolution)
    };
  }

  const approvalArtifact = await input.port.authorize(input.proposal, resolution.decision);
  return {
    status: "committed",
    proposalId: input.proposal.id,
    decision: resolution.decision,
    approvalArtifact,
    commit: await input.port.commit(input.proposal, approvalArtifact)
  };
};
