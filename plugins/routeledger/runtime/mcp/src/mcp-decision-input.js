export class McpDecisionInputRequiredError extends Error {
    authorizationRequest;
    name = "McpDecisionInputRequiredError";
    constructor(authorizationRequest) {
        super("The MCP host must provide an authorization decision.");
        this.authorizationRequest = authorizationRequest;
    }
}
export const isMcpDecisionInputRequiredError = (error) => error instanceof McpDecisionInputRequiredError;
export const toL3DecisionInputRequest = (request, error) => ({
    proposalId: request.proposalId,
    projectId: request.projectId,
    actionType: request.actionType,
    targetId: request.targetId,
    operationDigest: request.operationDigest,
    reason: error.message
});
export const readMcpAuthorizationDecision = (inputResponses, key = "routeledger_l3_decision") => {
    if (inputResponses === null ||
        typeof inputResponses !== "object" ||
        Array.isArray(inputResponses)) {
        return null;
    }
    const response = inputResponses[key];
    if (response === null || typeof response !== "object" || Array.isArray(response))
        return null;
    const action = response.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel")
        return null;
    const content = response.content;
    return {
        action,
        content: content !== null && typeof content === "object" && !Array.isArray(content)
            ? content
            : null
    };
};
