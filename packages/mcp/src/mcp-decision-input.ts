import type {
  ExactProposalDecisionRequest,
  L3DecisionInputRequest
} from "@routeledger/core";

import type {
  RouteLedgerMcpAuthorizationDecision,
  RouteLedgerMcpAuthorizationRequest
} from "./l3-authorization-contract.js";

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
  if (response === undefined) return null;
  return parseMcpAuthorizationDecisionResponse(response);
};

export const parseMcpAuthorizationDecisionResponse = (
  response: unknown
): RouteLedgerMcpAuthorizationDecision => {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("MCP authorization decision response is invalid.");
  }
  const record = response as Record<string, unknown>;
  const action = record.action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    throw new Error("MCP authorization decision action is invalid.");
  }
  const content = record.content;
  const responseKeys = Object.keys(record).sort();
  if (action === "accept") {
    if (
      responseKeys.join(",") !== "action,content" ||
      content === null ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      Object.keys(content as Record<string, unknown>).join(",") !== "approve" ||
      typeof (content as Record<string, unknown>).approve !== "boolean"
    ) {
      throw new Error("MCP authorization accept response must contain only approve.");
    }
  } else if (
    responseKeys.some((key) => key !== "action" && key !== "content") ||
    (content !== undefined && content !== null)
  ) {
    throw new Error("MCP authorization decline or cancel response is invalid.");
  }
  return {
    action,
    content:
      content !== null && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : null
  };
};
