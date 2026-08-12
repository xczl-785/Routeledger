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
    if (response === undefined)
        return null;
    return parseMcpAuthorizationDecisionResponse(response);
};
export const parseMcpAuthorizationDecisionResponse = (response) => {
    if (response === null || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("MCP authorization decision response is invalid.");
    }
    const record = response;
    const action = record.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
        throw new Error("MCP authorization decision action is invalid.");
    }
    const content = record.content;
    const responseKeys = Object.keys(record).sort();
    if (action === "accept") {
        if (responseKeys.join(",") !== "action,content" ||
            content === null ||
            typeof content !== "object" ||
            Array.isArray(content) ||
            Object.keys(content).join(",") !== "approve" ||
            typeof content.approve !== "boolean") {
            throw new Error("MCP authorization accept response must contain only approve.");
        }
    }
    else if (responseKeys.some((key) => key !== "action" && key !== "content") ||
        (content !== undefined && content !== null)) {
        throw new Error("MCP authorization decline or cancel response is invalid.");
    }
    return {
        action,
        content: content !== null && typeof content === "object" && !Array.isArray(content)
            ? content
            : null
    };
};
