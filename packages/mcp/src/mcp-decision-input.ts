import type {
  ExactProposalDecisionRequest,
  L3DecisionInputRequest
} from "@routeledger/core";

import type {
  RouteLedgerMcpAuthorizationDecision,
  RouteLedgerMcpAuthorizationRequest
} from "./index.js";

export class McpDecisionInputRequiredError extends Error {
  readonly name = "McpDecisionInputRequiredError";

  constructor(readonly authorizationRequest: RouteLedgerMcpAuthorizationRequest) {
    super("The MCP host must provide an authorization decision.");
  }
}

export const isMcpDecisionInputRequiredError = (
  error: unknown
): error is McpDecisionInputRequiredError => error instanceof McpDecisionInputRequiredError;

export const toL3DecisionInputRequest = (
  request: ExactProposalDecisionRequest,
  error: McpDecisionInputRequiredError
): L3DecisionInputRequest => ({
  proposalId: request.proposalId,
  projectId: request.projectId,
  actionType: request.actionType,
  targetId: request.targetId,
  operationDigest: request.operationDigest,
  reason: error.message
});

export const readMcpAuthorizationDecision = (
  inputResponses: unknown,
  key = "routeledger_l3_decision"
): RouteLedgerMcpAuthorizationDecision | null => {
  if (
    inputResponses === null ||
    typeof inputResponses !== "object" ||
    Array.isArray(inputResponses)
  ) {
    return null;
  }
  const response = (inputResponses as Record<string, unknown>)[key];
  if (response === null || typeof response !== "object" || Array.isArray(response)) return null;
  const action = (response as Record<string, unknown>).action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") return null;
  const content = (response as Record<string, unknown>).content;
  return {
    action,
    content:
      content !== null && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : null
  };
};
