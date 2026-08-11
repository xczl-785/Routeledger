import { assertDecisionResolutionMatchesRequest, createExactProposalDecisionRequest } from "./l3-decision.js";
export const assertL3OperationRequestStateMatchesProposal = (state, proposal, adapterId) => {
    if (state.schemaVersion !== 1 || (adapterId !== undefined && state.adapterId !== adapterId)) {
        throw new Error("The L3 operation request state does not match the active adapter.");
    }
    const request = createExactProposalDecisionRequest(proposal);
    assertDecisionResolutionMatchesRequest(request, {
        status: "input_required",
        request: state
    });
};
export const orchestrateL3Operation = async (input) => {
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
