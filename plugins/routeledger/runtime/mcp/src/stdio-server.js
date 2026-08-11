import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MemoryL3AuthorizationGrantStore } from "../../core/src/index.js";
import { MCP_PROTOCOL_VERSION, MCP_MRTR_PROTOCOL_VERSION, createSessionRebindFailureResponse, createRouteLedgerMcpRegistry } from "./index.js";
import { McpDecisionInputRequiredError, readMcpAuthorizationDecision } from "./mcp-decision-input.js";
import { digestMcpToolArguments, sealMcpRequestState, verifyMcpRequestState } from "./mcp-request-state.js";
const JSONRPC_VERSION = "2.0";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_NOT_INITIALIZED = -32002;
const ROUTELEDGER_INPUT_KEY = "routeledger_l3_decision";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isJsonRpcId = (value) => typeof value === "string" || typeof value === "number";
const isJsonRpcErrorResponse = (value) => isObject(value) &&
    value.jsonrpc === JSONRPC_VERSION &&
    "error" in value &&
    "id" in value;
const formatPath = (path) => path.reduce((formattedPath, segment) => {
    if (typeof segment === "number") {
        return `${formattedPath}[${segment}]`;
    }
    return `${formattedPath}.${segment}`;
}, "$");
const describeExpectedType = (schema) => typeof schema.type === "string" ? schema.type : "valid value";
const hasEnumMatch = (allowedValues, value) => allowedValues.some((allowedValue) => Object.is(allowedValue, value));
const validateValueAgainstSchema = (schema, value, path = []) => {
    const issues = [];
    const anyOf = schema.anyOf;
    if (Array.isArray(anyOf)) {
        const anyOfSchemas = anyOf.filter(isObject);
        const matchedSchema = anyOfSchemas.some((candidateSchema) => validateValueAgainstSchema(candidateSchema, value, path).length === 0);
        if (!matchedSchema) {
            issues.push({
                path: formatPath(path),
                message: "Value does not match any allowed schema."
            });
        }
        return issues;
    }
    const expectedType = schema.type;
    if (typeof expectedType === "string") {
        switch (expectedType) {
            case "object":
                if (!isObject(value)) {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected object, received ${Array.isArray(value) ? "array" : typeof value}.`
                    });
                    return issues;
                }
                break;
            case "array":
                if (!Array.isArray(value)) {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected array, received ${typeof value}.`
                    });
                    return issues;
                }
                break;
            case "string":
                if (typeof value !== "string") {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected string, received ${typeof value}.`
                    });
                    return issues;
                }
                break;
            case "integer":
                if (typeof value !== "number" || !Number.isInteger(value)) {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected integer, received ${typeof value}.`
                    });
                    return issues;
                }
                break;
            case "boolean":
                if (typeof value !== "boolean") {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected boolean, received ${typeof value}.`
                    });
                    return issues;
                }
                break;
            case "null":
                if (value !== null) {
                    issues.push({
                        path: formatPath(path),
                        message: `Expected null, received ${typeof value}.`
                    });
                    return issues;
                }
                break;
            default:
                issues.push({
                    path: formatPath(path),
                    message: `Unsupported schema type '${expectedType}'.`
                });
                return issues;
        }
    }
    if (Array.isArray(schema.enum) && !hasEnumMatch(schema.enum, value)) {
        issues.push({
            path: formatPath(path),
            message: `Expected one of ${schema.enum.map(String).join(", ")}.`
        });
    }
    if (schema.type === "object" && isObject(value)) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
            ? schema.required.filter((field) => typeof field === "string")
            : [];
        for (const field of required) {
            if (!(field in value)) {
                issues.push({
                    path: formatPath(path.concat(field)),
                    message: "Required field is missing."
                });
            }
        }
        if (schema.additionalProperties === false) {
            for (const field of Object.keys(value)) {
                if (!(field in properties)) {
                    issues.push({
                        path: formatPath(path.concat(field)),
                        message: "Additional properties are not allowed."
                    });
                }
            }
        }
        for (const [field, propertySchema] of Object.entries(properties)) {
            if (field in value && isObject(propertySchema)) {
                issues.push(...validateValueAgainstSchema(propertySchema, value[field], path.concat(field)));
            }
        }
    }
    if (schema.type === "array" && Array.isArray(value) && isObject(schema.items)) {
        value.forEach((item, index) => {
            issues.push(...validateValueAgainstSchema(schema.items, item, path.concat(index)));
        });
    }
    if (typeof schema.minimum === "number" &&
        typeof value === "number" &&
        value < schema.minimum) {
        issues.push({
            path: formatPath(path),
            message: `Expected ${describeExpectedType(schema)} greater than or equal to ${schema.minimum}.`
        });
    }
    if (typeof schema.maximum === "number" &&
        typeof value === "number" &&
        value > schema.maximum) {
        issues.push({
            path: formatPath(path),
            message: `Expected ${describeExpectedType(schema)} less than or equal to ${schema.maximum}.`
        });
    }
    return issues;
};
const validateToolInput = (toolDefinition, input) => {
    const issues = validateValueAgainstSchema(toolDefinition.inputSchema, input);
    if (issues.length === 0) {
        return null;
    }
    const [firstIssue] = issues;
    return {
        ok: false,
        error: {
            code: "INVALID_TOOL_INPUT",
            message: firstIssue?.message ?? "Invalid tool input.",
            details: {
                path: firstIssue?.path ?? "$",
                issues
            }
        }
    };
};
const errorResponse = (id, code, message, data) => ({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
        code,
        message,
        ...(data === undefined ? {} : { data })
    }
});
const successResponse = (id, result) => ({
    jsonrpc: JSONRPC_VERSION,
    id,
    result
});
const validateMessageShape = (message) => {
    if (!isObject(message)) {
        return {
            kind: "error",
            response: errorResponse(null, INVALID_REQUEST, "Request must be a JSON object.")
        };
    }
    const candidateId = message.id;
    const responseId = isJsonRpcId(candidateId) ? candidateId : null;
    if (message.jsonrpc !== JSONRPC_VERSION) {
        return {
            kind: "error",
            response: errorResponse(responseId, INVALID_REQUEST, "jsonrpc must be '2.0'.")
        };
    }
    if ("id" in message && !("method" in message)) {
        const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
        const hasError = Object.prototype.hasOwnProperty.call(message, "error");
        if (!isJsonRpcId(message.id)) {
            return {
                kind: "error",
                response: errorResponse(null, INVALID_REQUEST, "id must be a string or number.")
            };
        }
        if (hasResult === hasError) {
            return {
                kind: "error",
                response: errorResponse(message.id, INVALID_REQUEST, "Response must include exactly one of result or error.")
            };
        }
        if (hasError && !isObject(message.error)) {
            return {
                kind: "error",
                response: errorResponse(message.id, INVALID_REQUEST, "error must be an object.")
            };
        }
        return {
            kind: "response",
            response: hasError
                ? {
                    jsonrpc: JSONRPC_VERSION,
                    id: message.id,
                    error: {
                        code: typeof message.error.code === "number"
                            ? message.error.code
                            : INVALID_REQUEST,
                        message: typeof message.error.message === "string"
                            ? message.error.message
                            : "Invalid JSON-RPC error response.",
                        ...(Object.prototype.hasOwnProperty.call(message.error, "data")
                            ? { data: message.error.data }
                            : {})
                    }
                }
                : {
                    jsonrpc: JSONRPC_VERSION,
                    id: message.id,
                    result: message.result
                }
        };
    }
    if (typeof message.method !== "string" || message.method.trim().length === 0) {
        return {
            kind: "error",
            response: errorResponse(responseId, INVALID_REQUEST, "method must be a non-empty string.")
        };
    }
    if ("id" in message) {
        if (!isJsonRpcId(message.id)) {
            return {
                kind: "error",
                response: errorResponse(null, INVALID_REQUEST, "id must be a string or number.")
            };
        }
        return {
            kind: "request",
            request: {
                jsonrpc: JSONRPC_VERSION,
                id: message.id,
                method: message.method,
                params: message.params
            }
        };
    }
    return {
        kind: "notification",
        notification: {
            jsonrpc: JSONRPC_VERSION,
            method: message.method,
            params: message.params
        }
    };
};
const requireObjectParams = (request, description) => {
    if (request.params === undefined) {
        return {};
    }
    if (!isObject(request.params)) {
        return errorResponse(request.id, INVALID_PARAMS, description);
    }
    return request.params;
};
const requireInitialized = (state, request) => {
    if (state.initializedNotificationReceived) {
        return null;
    }
    return errorResponse(request.id, SERVER_NOT_INITIALIZED, "Client must send notifications/initialized before normal MCP requests.");
};
const normalizeToolArguments = (params, requestId) => {
    const name = params.name;
    if (typeof name !== "string" || name.trim().length === 0) {
        return errorResponse(requestId, INVALID_PARAMS, "tools/call requires params.name.");
    }
    const argumentsValue = params.arguments;
    if (argumentsValue === undefined) {
        return {
            name,
            arguments: {}
        };
    }
    if (!isObject(argumentsValue)) {
        return errorResponse(requestId, INVALID_PARAMS, "tools/call requires params.arguments to be an object.");
    }
    return {
        name,
        arguments: argumentsValue
    };
};
const toStructuredEnvelope = (toolResponse) => ({
    ok: toolResponse.ok,
    ...(toolResponse.data === undefined ? {} : { data: toolResponse.data }),
    ...(toolResponse.error === undefined ? {} : { error: toolResponse.error }),
    ...(toolResponse.meta === undefined ? {} : { meta: toolResponse.meta })
});
const toCallToolResult = (registry, toolName, toolResponse) => {
    const toolDefinition = registry.getTool(toolName);
    const structuredContent = toStructuredEnvelope(toolResponse);
    const text = JSON.stringify(structuredContent, null, 2);
    return {
        content: [
            {
                type: "text",
                text
            }
        ],
        structuredContent,
        ...(toolResponse.ok ? {} : { isError: true }),
        _meta: toolDefinition === undefined
            ? undefined
            : {
                routeledger: {
                    toolName,
                    hostProfile: registry.hostProfile,
                    riskLevel: toolDefinition._meta.routeledger.riskLevel,
                    highRisk: toolDefinition._meta.routeledger.highRisk
                }
            }
    };
};
const buildInitializeResult = (registry) => ({
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: registry.serverCapabilities,
    serverInfo: registry.serverInfo,
    instructions: registry.instructions
});
const read2026RequestMeta = (params) => {
    const meta = params._meta;
    if (!isObject(meta))
        return null;
    return meta["io.modelcontextprotocol/protocolVersion"] === MCP_MRTR_PROTOCOL_VERSION
        ? meta
        : null;
};
const to2026Result = (registry, result) => ({
    resultType: "complete",
    ...result,
    _meta: {
        ...(isObject(result._meta) ? result._meta : {}),
        "io.modelcontextprotocol/serverInfo": registry.serverInfo
    }
});
const normalizeRootUriCandidate = (value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    if (value.startsWith("file://")) {
        try {
            return fileURLToPath(value);
        }
        catch {
            return null;
        }
    }
    return value;
};
const collectInitializeRoots = (params) => {
    const roots = new Set();
    const rootUri = normalizeRootUriCandidate(params.rootUri);
    if (rootUri !== null) {
        roots.add(rootUri);
    }
    if (Array.isArray(params.roots)) {
        for (const candidate of params.roots) {
            if (isObject(candidate) && "uri" in candidate) {
                const normalized = normalizeRootUriCandidate(candidate.uri);
                if (normalized !== null) {
                    roots.add(normalized);
                }
            }
        }
    }
    return [...roots];
};
export const createRouteLedgerStdioServer = (options) => {
    const { l3Authorization: configuredL3Authorization, l3AuthorityBroker, ...baseRegistryOptions } = options;
    if (l3AuthorityBroker !== undefined &&
        baseRegistryOptions.approver?.id !== undefined &&
        baseRegistryOptions.approver.id !== l3AuthorityBroker.identity.subjectId) {
        throw new Error("Configured approver identity must match the host authority broker subject.");
    }
    const registryBaseOptions = {
        ...baseRegistryOptions,
        ...(l3AuthorityBroker === undefined
            ? {}
            : {
                approver: {
                    ...(baseRegistryOptions.approver ?? {}),
                    id: l3AuthorityBroker.identity.subjectId
                },
                l3AuthorityCandidateIdentity: {
                    subjectId: l3AuthorityBroker.identity.subjectId,
                    trustedClientId: l3AuthorityBroker.identity.trustedClientId
                }
            })
    };
    let nextOutboundRequestId = 1;
    const pendingRequests = new Map();
    let activeMcpRequestContext = null;
    let pendingMcpAuthorizationRequest = null;
    const sendMessage = (message) => {
        options.sendMessage?.(message);
    };
    const grantStore = configuredL3Authorization?.grantStore ?? new MemoryL3AuthorizationGrantStore();
    const authorizationSessionId = configuredL3Authorization?.sessionId ?? randomUUID();
    const state = {
        initializeCompleted: false,
        initializedNotificationReceived: false,
        clientSupportsRoots: false,
        clientSupportsElicitation: false,
        initializeRoots: [],
        listedRoots: [],
        latestRootsListRequestId: null
    };
    const requestAuthorization = (request) => {
        if (activeMcpRequestContext?.era === "2026") {
            const decision = readMcpAuthorizationDecision(activeMcpRequestContext.inputResponses, ROUTELEDGER_INPUT_KEY);
            if (decision !== null)
                return Promise.resolve(decision);
            pendingMcpAuthorizationRequest = request;
            return Promise.reject(new McpDecisionInputRequiredError(request));
        }
        if (!state.clientSupportsElicitation) {
            return Promise.reject(new Error("MCP client does not advertise the elicitation capability."));
        }
        const id = nextOutboundRequestId++;
        return new Promise((resolve, reject) => {
            pendingRequests.set(id, {
                resolve: (response) => {
                    if ("error" in response) {
                        reject(new Error(response.error.message));
                        return;
                    }
                    const result = response.result;
                    if (!isObject(result) ||
                        (result.action !== "accept" &&
                            result.action !== "decline" &&
                            result.action !== "cancel")) {
                        reject(new Error("MCP elicitation response has an invalid action."));
                        return;
                    }
                    resolve({
                        action: result.action,
                        content: isObject(result.content) ? result.content : null
                    });
                },
                reject
            });
            sendMessage({
                jsonrpc: JSONRPC_VERSION,
                id,
                method: "elicitation/create",
                params: {
                    mode: "form",
                    message: request.message,
                    requestedSchema: request.requestedSchema
                }
            });
        });
    };
    const buildRegistry = (registryOptions) => options.registryFactory?.(registryOptions) ?? createRouteLedgerMcpRegistry(registryOptions);
    const withAuthorization = (registryOptions, brokerBinding) => {
        if (l3AuthorityBroker !== undefined && brokerBinding === null) {
            return registryOptions;
        }
        const selected = brokerBinding ?? configuredL3Authorization;
        return {
            ...registryOptions,
            l3Authorization: {
                grantStore: selected?.grantStore ?? grantStore,
                interaction: configuredL3Authorization?.interaction ?? { requestAuthorization },
                sessionId: configuredL3Authorization?.sessionId ?? authorizationSessionId,
                ...(selected !== undefined && "profile" in selected && selected.profile !== undefined
                    ? { profile: selected.profile }
                    : {}),
                ...(selected?.trustedClientId === undefined
                    ? {}
                    : { trustedClientId: selected.trustedClientId }),
                ...(selected?.delegatedAuthority === undefined
                    ? {}
                    : { delegatedAuthority: selected.delegatedAuthority })
            }
        };
    };
    const initializeRegistry = buildRegistry(withAuthorization({
        ...registryBaseOptions,
        deferSessionRebind: true
    }, l3AuthorityBroker === undefined ? undefined : null));
    let activeRegistry = initializeRegistry;
    let activeBrokerBindingKey = null;
    let activeBrokerProfileDigest = null;
    const rebuildRegistry = () => {
        const effectiveRoots = state.initializeRoots.length > 0 ? state.initializeRoots : state.listedRoots;
        let nextRegistry;
        try {
            nextRegistry = buildRegistry(withAuthorization({
                ...registryBaseOptions,
                mcpRoots: effectiveRoots,
                deferSessionRebind: true
            }, l3AuthorityBroker === undefined ? undefined : null));
        }
        catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
        const previousRegistry = activeRegistry;
        activeRegistry = nextRegistry;
        activeBrokerBindingKey = null;
        activeBrokerProfileDigest = null;
        if (previousRegistry !== initializeRegistry) {
            try {
                previousRegistry.close();
            }
            catch {
                // The replacement is already active. A close hook must not roll back it.
            }
        }
        return null;
    };
    const activatePendingSessionRebind = async (registry) => {
        const nextBinding = registry.peekPendingSessionRebind();
        if (nextBinding === null) {
            return null;
        }
        // Build the replacement before releasing the old runtime. The bootstrap handler
        // has already returned its result at this point, so closing old storage cannot
        // prevent the JSON-RPC response from being formed.
        let nextRegistry;
        try {
            nextRegistry = buildRegistry(withAuthorization({
                ...registryBaseOptions,
                workspaceRoot: nextBinding.workspaceRoot,
                workspaceRootSource: "explicit_arg",
                routeledgerRoot: nextBinding.routeledgerRoot,
                mcpRoots: undefined,
                deferSessionRebind: true
            }, l3AuthorityBroker === undefined ? undefined : null));
        }
        catch (error) {
            return {
                ...createSessionRebindFailureResponse(nextBinding, error),
                meta: await registry.getRuntimeContextMeta()
            };
        }
        let activationResponse;
        try {
            activationResponse = await nextRegistry.createActivationSuccessResponse(nextBinding);
        }
        catch (error) {
            try {
                nextRegistry.close();
            }
            catch {
                // The old registry remains active; a failed candidate close is irrelevant.
            }
            return {
                ...createSessionRebindFailureResponse(nextBinding, error),
                meta: await registry.getRuntimeContextMeta()
            };
        }
        activeRegistry = nextRegistry;
        activeBrokerBindingKey = null;
        activeBrokerProfileDigest = null;
        registry.clearPendingSessionRebind();
        if (registry !== initializeRegistry) {
            try {
                registry.close();
            }
            catch {
                // The new registry is active and the call response is already formed.
            }
        }
        return activationResponse;
    };
    const ensureBrokerBinding = async () => {
        if (l3AuthorityBroker === undefined)
            return null;
        try {
            const meta = await activeRegistry.getRuntimeContextMeta();
            const runtimeContext = isObject(meta.runtimeContext) ? meta.runtimeContext : null;
            const binding = runtimeContext !== null && isObject(runtimeContext.binding)
                ? runtimeContext.binding
                : null;
            const activeProject = runtimeContext !== null && isObject(runtimeContext.activeProject)
                ? runtimeContext.activeProject
                : null;
            const workspaceRoot = binding?.workspaceRoot;
            const routeledgerRoot = binding?.routeledgerRoot;
            const projectId = activeProject?.id ?? runtimeContext?.projectId;
            if (typeof workspaceRoot !== "string" ||
                typeof routeledgerRoot !== "string" ||
                typeof projectId !== "string" ||
                projectId.trim().length === 0) {
                return null;
            }
            const selected = await l3AuthorityBroker.bind({ projectId, workspaceRoot, routeledgerRoot });
            if (selected !== null &&
                selected.bindingKey === activeBrokerBindingKey &&
                selected.profile.profileDigest === activeBrokerProfileDigest) {
                return null;
            }
            const nextRegistry = buildRegistry(withAuthorization({
                ...registryBaseOptions,
                workspaceRoot,
                workspaceRootSource: "explicit_arg",
                routeledgerRoot,
                mcpRoots: undefined,
                deferSessionRebind: true
            }, selected));
            const previousRegistry = activeRegistry;
            activeRegistry = nextRegistry;
            activeBrokerBindingKey = selected?.bindingKey ?? null;
            activeBrokerProfileDigest = selected?.profile.profileDigest ?? null;
            if (previousRegistry !== initializeRegistry) {
                try {
                    previousRegistry.close();
                }
                catch {
                    // The fully constructed replacement is already active.
                }
            }
            return null;
        }
        catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
    };
    const requestRootsList = () => {
        if (!state.clientSupportsRoots) {
            return;
        }
        const id = nextOutboundRequestId++;
        state.latestRootsListRequestId = id;
        const request = {
            jsonrpc: JSONRPC_VERSION,
            id,
            method: "roots/list"
        };
        pendingRequests.set(id, {
            resolve: (response) => {
                if (state.latestRootsListRequestId !== id) {
                    return;
                }
                if ("error" in response) {
                    return;
                }
                const result = response.result;
                if (!isObject(result) || !Array.isArray(result.roots)) {
                    return;
                }
                const nextRoots = result.roots
                    .flatMap((candidate) => {
                    if (!isObject(candidate) || typeof candidate.uri !== "string") {
                        return [];
                    }
                    if (!candidate.uri.startsWith("file://")) {
                        return [];
                    }
                    const normalized = normalizeRootUriCandidate(candidate.uri);
                    return normalized === null ? [] : [normalized];
                });
                const uniqueRoots = [...new Set(nextRoots)];
                if (uniqueRoots.length === 0) {
                    return;
                }
                const previousListedRoots = state.listedRoots;
                state.listedRoots = uniqueRoots;
                const rebuildError = rebuildRegistry();
                if (rebuildError !== null) {
                    // Keep activeRegistry and the last accepted root set aligned. A later
                    // roots/list_changed notification can retry without a half-switch.
                    state.listedRoots = previousListedRoots;
                }
            },
            reject: () => undefined
        });
        sendMessage(request);
    };
    return {
        close: () => {
            for (const pending of pendingRequests.values()) {
                pending.reject(new Error("RouteLedger stdio server closed before response arrived."));
            }
            pendingRequests.clear();
            try {
                activeRegistry.close();
            }
            catch {
                // Shutdown must release the remaining registry even if one close hook fails.
            }
            if (activeRegistry !== initializeRegistry) {
                try {
                    initializeRegistry.close();
                }
                catch {
                    // Best-effort server shutdown; no JSON-RPC response is in flight.
                }
            }
        },
        listTools: () => activeRegistry.tools,
        handleMessage: async (message) => {
            const validated = validateMessageShape(message);
            if (validated.kind === "error") {
                if (validated.response.id !== null) {
                    pendingRequests.delete(validated.response.id);
                }
                return validated.response;
            }
            if (validated.kind === "notification") {
                const { notification } = validated;
                if (notification.method === "notifications/initialized") {
                    if (!state.initializeCompleted) {
                        return null;
                    }
                    state.initializedNotificationReceived = true;
                    requestRootsList();
                    return null;
                }
                if (notification.method === "notifications/roots/list_changed") {
                    if (!state.initializedNotificationReceived) {
                        return null;
                    }
                    requestRootsList();
                    return null;
                }
                return null;
            }
            if (validated.kind === "response") {
                const pending = pendingRequests.get(validated.response.id);
                if (pending === undefined) {
                    return null;
                }
                pendingRequests.delete(validated.response.id);
                if ("error" in validated.response) {
                    pending.reject(new Error(validated.response.error.message));
                }
                else {
                    pending.resolve(validated.response);
                }
                return null;
            }
            const { request } = validated;
            try {
                switch (request.method) {
                    case "server/discover": {
                        const params = requireObjectParams(request, "server/discover requires object params.");
                        if (isJsonRpcErrorResponse(params))
                            return params;
                        return successResponse(request.id, to2026Result(activeRegistry, {
                            supportedVersions: [MCP_MRTR_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION],
                            capabilities: activeRegistry.serverCapabilities,
                            instructions: activeRegistry.instructions
                        }));
                    }
                    case "initialize": {
                        if (state.initializeCompleted) {
                            return errorResponse(request.id, INVALID_REQUEST, "initialize may only be called once per connection.");
                        }
                        const params = requireObjectParams(request, "initialize requires object params.");
                        if (isJsonRpcErrorResponse(params)) {
                            return params;
                        }
                        const protocolVersion = params.protocolVersion;
                        if (typeof protocolVersion !== "string" || protocolVersion.trim().length === 0) {
                            return errorResponse(request.id, INVALID_PARAMS, "initialize requires params.protocolVersion.");
                        }
                        if (!isObject(params.capabilities)) {
                            return errorResponse(request.id, INVALID_PARAMS, "initialize requires object params.capabilities.");
                        }
                        if (!isObject(params.clientInfo)) {
                            return errorResponse(request.id, INVALID_PARAMS, "initialize requires object params.clientInfo.");
                        }
                        if (typeof params.clientInfo.name !== "string" ||
                            params.clientInfo.name.trim().length === 0) {
                            return errorResponse(request.id, INVALID_PARAMS, "initialize params.clientInfo.name must be a non-empty string.");
                        }
                        if (typeof params.clientInfo.version !== "string" ||
                            params.clientInfo.version.trim().length === 0) {
                            return errorResponse(request.id, INVALID_PARAMS, "initialize params.clientInfo.version must be a non-empty string.");
                        }
                        const initializeRoots = collectInitializeRoots(params);
                        const previousInitializeRoots = state.initializeRoots;
                        state.initializeRoots = initializeRoots;
                        state.clientSupportsRoots = isObject(params.capabilities.roots);
                        state.clientSupportsElicitation = isObject(params.capabilities.elicitation);
                        const rebuildError = rebuildRegistry();
                        if (rebuildError !== null) {
                            state.initializeRoots = previousInitializeRoots;
                            state.clientSupportsRoots = false;
                            return errorResponse(request.id, INTERNAL_ERROR, `RouteLedger could not construct the requested Roots binding: ${rebuildError.message}`);
                        }
                        state.initializeCompleted = true;
                        return successResponse(request.id, buildInitializeResult(activeRegistry));
                    }
                    case "ping": {
                        const params = requireObjectParams(request, "ping params must be an object.");
                        if (isJsonRpcErrorResponse(params))
                            return params;
                        return successResponse(request.id, read2026RequestMeta(params) === null
                            ? {}
                            : to2026Result(activeRegistry, {}));
                    }
                    case "tools/list": {
                        const params = requireObjectParams(request, "tools/list params must be an object.");
                        if (isJsonRpcErrorResponse(params)) {
                            return params;
                        }
                        const is2026Request = read2026RequestMeta(params) !== null;
                        const initializationError = is2026Request ? null : requireInitialized(state, request);
                        if (initializationError !== null) {
                            return initializationError;
                        }
                        const result = { tools: activeRegistry.tools };
                        return successResponse(request.id, is2026Request ? to2026Result(activeRegistry, result) : result);
                    }
                    case "tools/call": {
                        const params = requireObjectParams(request, "tools/call params must be an object.");
                        if (isJsonRpcErrorResponse(params)) {
                            return params;
                        }
                        const requestMeta = read2026RequestMeta(params);
                        const is2026Request = requestMeta !== null;
                        const initializationError = is2026Request ? null : requireInitialized(state, request);
                        if (initializationError !== null) {
                            return initializationError;
                        }
                        const brokerError = await ensureBrokerBinding();
                        if (brokerError !== null) {
                            return errorResponse(request.id, INTERNAL_ERROR, `RouteLedger could not bind the host-owned L3 authority: ${brokerError.message}`);
                        }
                        const toolCall = normalizeToolArguments(params, request.id);
                        if (isJsonRpcErrorResponse(toolCall)) {
                            return toolCall;
                        }
                        if (activeRegistry.getTool(toolCall.name) === undefined) {
                            return errorResponse(request.id, INVALID_PARAMS, `Unknown tool '${toolCall.name}'.`);
                        }
                        if (is2026Request &&
                            toolCall.name === "execute_l3_operation" &&
                            options.mcpRequestStateSecret === undefined) {
                            return successResponse(request.id, to2026Result(activeRegistry, toCallToolResult(activeRegistry, toolCall.name, {
                                ok: false,
                                error: {
                                    code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
                                    message: "MCP 2026 L3 execution requires ROUTELEDGER_MCP_REQUEST_STATE_SECRET."
                                }
                            })));
                        }
                        const toolDefinition = activeRegistry.getTool(toolCall.name);
                        const validationError = toolDefinition === undefined
                            ? null
                            : validateToolInput(toolDefinition, toolCall.arguments);
                        const invocationRegistry = activeRegistry;
                        let invocationArguments = toolCall.arguments;
                        if (is2026Request && toolCall.name === "execute_l3_operation") {
                            const argumentsDigest = digestMcpToolArguments(toolCall.arguments);
                            if (params.requestState !== undefined) {
                                if (typeof params.requestState !== "string") {
                                    return errorResponse(request.id, INVALID_PARAMS, "requestState must be a string.");
                                }
                                if (options.mcpRequestStateSecret === undefined) {
                                    return errorResponse(request.id, INVALID_PARAMS, "MCP 2026 request-state verification is not configured.");
                                }
                                let resumed;
                                try {
                                    resumed = verifyMcpRequestState(params.requestState, options.mcpRequestStateSecret, {
                                        toolName: toolCall.name,
                                        argumentsDigest
                                    });
                                }
                                catch (error) {
                                    return errorResponse(request.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error));
                                }
                                invocationArguments = {
                                    ...toolCall.arguments,
                                    __routeledgerMcpResumeProposalId: resumed.pendingOperationId
                                };
                            }
                            else if (params.inputResponses !== undefined) {
                                return errorResponse(request.id, INVALID_PARAMS, "inputResponses require the matching requestState.");
                            }
                        }
                        activeMcpRequestContext = {
                            era: is2026Request ? "2026" : "2025",
                            ...(params.inputResponses === undefined
                                ? {}
                                : { inputResponses: params.inputResponses })
                        };
                        pendingMcpAuthorizationRequest = null;
                        let toolResponse;
                        try {
                            toolResponse =
                                validationError === null
                                    ? await invocationRegistry.invoke(toolCall.name, invocationArguments)
                                    : {
                                        ...validationError,
                                        meta: await invocationRegistry.getRuntimeContextMeta()
                                    };
                        }
                        finally {
                            activeMcpRequestContext = null;
                        }
                        const rebindResponse = validationError === null && toolCall.name === "activate_routeledger_binding"
                            ? await activatePendingSessionRebind(invocationRegistry)
                            : null;
                        const effectiveToolResponse = rebindResponse ?? toolResponse;
                        if (is2026Request &&
                            toolCall.name === "execute_l3_operation" &&
                            effectiveToolResponse.ok &&
                            isObject(effectiveToolResponse.data) &&
                            effectiveToolResponse.data.status === "input_required") {
                            if (options.mcpRequestStateSecret === undefined ||
                                pendingMcpAuthorizationRequest === null) {
                                return successResponse(request.id, to2026Result(activeRegistry, toCallToolResult(activeRegistry, toolCall.name, {
                                    ok: false,
                                    error: {
                                        code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
                                        message: "MCP 2026 interactive authorization requires an explicit request-state secret."
                                    }
                                })));
                            }
                            const requestState = effectiveToolResponse.data.requestState;
                            if (!isObject(requestState) || typeof requestState.proposalId !== "string") {
                                return errorResponse(request.id, INTERNAL_ERROR, "Invalid L3 input-required state.");
                            }
                            const authorizationRequest = pendingMcpAuthorizationRequest;
                            const now = new Date();
                            return successResponse(request.id, {
                                resultType: "input_required",
                                inputRequests: {
                                    [ROUTELEDGER_INPUT_KEY]: {
                                        method: "elicitation/create",
                                        params: {
                                            mode: "form",
                                            message: authorizationRequest.message,
                                            requestedSchema: authorizationRequest.requestedSchema
                                        }
                                    }
                                },
                                requestState: sealMcpRequestState({
                                    schemaVersion: 1,
                                    toolName: "execute_l3_operation",
                                    argumentsDigest: digestMcpToolArguments(toolCall.arguments),
                                    pendingOperationId: requestState.proposalId,
                                    issuedAt: now.toISOString(),
                                    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
                                }, options.mcpRequestStateSecret),
                                _meta: {
                                    "io.modelcontextprotocol/serverInfo": activeRegistry.serverInfo
                                }
                            });
                        }
                        const callResult = toCallToolResult(activeRegistry, toolCall.name, effectiveToolResponse);
                        return successResponse(request.id, is2026Request
                            ? to2026Result(activeRegistry, callResult)
                            : callResult);
                    }
                    case "notifications/initialized":
                        return errorResponse(request.id, INVALID_REQUEST, "notifications/initialized must be sent without an id.");
                    default:
                        return errorResponse(request.id, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
                }
            }
            catch (error) {
                return errorResponse(request.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
            }
        }
    };
};
const closeReadline = (readline) => {
    readline?.close();
};
const writeJsonRpcMessage = (output, message) => {
    output.write(`${JSON.stringify(message)}\n`);
};
export const runRouteLedgerStdioServer = async (options) => {
    const server = createRouteLedgerStdioServer({
        workspaceRoot: options.workspaceRoot,
        workspaceRootSource: options.workspaceRootSource,
        routeledgerRoot: options.routeledgerRoot,
        sqliteReadModel: options.sqliteReadModel,
        hostProfile: options.hostProfile,
        runtimeProfile: options.runtimeProfile,
        hostPermissionContext: options.hostPermissionContext,
        mcpRequestStateSecret: options.mcpRequestStateSecret,
        actor: options.actor,
        approver: options.approver,
        defaultResponseLocale: options.defaultResponseLocale,
        ...(options.l3Authorization === undefined
            ? {}
            : { l3Authorization: options.l3Authorization }),
        ...(options.l3AuthorityBroker === undefined
            ? {}
            : { l3AuthorityBroker: options.l3AuthorityBroker }),
        sendMessage: (message) => {
            writeJsonRpcMessage(options.output, message);
        }
    });
    const readline = createInterface({
        input: options.input,
        crlfDelay: Infinity
    });
    let inboundRequestChain = Promise.resolve();
    const dispatchAndWrite = async (parsed) => {
        const response = await server.handleMessage(parsed);
        if (response !== null) {
            writeJsonRpcMessage(options.output, response);
        }
    };
    try {
        for await (const line of readline) {
            if (line.trim().length === 0) {
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch (error) {
                writeJsonRpcMessage(options.output, errorResponse(null, PARSE_ERROR, "Parse error.", error instanceof Error ? { detail: error.message } : undefined));
                if (options.once) {
                    break;
                }
                continue;
            }
            const isClientResponse = isObject(parsed) &&
                !("method" in parsed) &&
                "id" in parsed &&
                ("result" in parsed || "error" in parsed);
            if (isClientResponse) {
                // A tool call may be suspended waiting for elicitation/create. Responses
                // must bypass the ordinary request queue so they can resume that call.
                await dispatchAndWrite(parsed);
            }
            else {
                inboundRequestChain = inboundRequestChain.then(() => dispatchAndWrite(parsed));
            }
            if (options.once) {
                await inboundRequestChain;
                break;
            }
        }
        await inboundRequestChain;
    }
    catch (error) {
        if (options.errorOutput !== undefined) {
            const detail = error instanceof Error ? error.stack ?? error.message : String(error);
            options.errorOutput.write(`${detail}\n`);
        }
        throw error;
    }
    finally {
        closeReadline(readline);
        server.close();
    }
};
