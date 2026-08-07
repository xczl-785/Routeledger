import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  MCP_PROTOCOL_VERSION,
  createSessionRebindFailureResponse,
  createRouteLedgerMcpRegistry,
  type RouteLedgerMcpRegistry,
  type RouteLedgerMcpRegistryOptions,
  type ToolDefinition,
  type ToolResponse
} from "./index.js";

type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
type JsonRpcResponseWithId =
  | JsonRpcSuccessResponse
  | (JsonRpcErrorResponse & { id: JsonRpcId });

export interface JsonRpcClientRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcClientRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export interface RouteLedgerStdioServer {
  close: () => void;
  listTools: () => ToolDefinition[];
  handleMessage: (message: unknown) => Promise<JsonRpcResponse | null>;
}

export interface CreateRouteLedgerStdioServerOptions extends RouteLedgerMcpRegistryOptions {
  sendMessage?: (message: JsonRpcMessage) => void;
  /** Test-only factory injection for verifying session-rebind failure behavior. */
  registryFactory?: (options: RouteLedgerMcpRegistryOptions) => RouteLedgerMcpRegistry;
}

export interface RunRouteLedgerStdioServerOptions extends CreateRouteLedgerStdioServerOptions {
  input: Readable;
  output: Writable;
  errorOutput?: Writable;
  once?: boolean;
}

interface JsonRpcRequestShape {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationShape {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface ProtocolState {
  initializeCompleted: boolean;
  initializedNotificationReceived: boolean;
  clientSupportsRoots: boolean;
  initializeRoots: string[];
  listedRoots: string[];
  latestRootsListRequestId: JsonRpcId | null;
}

type PendingRequestHandlers = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
};

interface ToolInputValidationIssue {
  path: string;
  message: string;
}

const JSONRPC_VERSION = "2.0" as const;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_NOT_INITIALIZED = -32002;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || typeof value === "number";

const isJsonRpcErrorResponse = (value: unknown): value is JsonRpcErrorResponse =>
  isObject(value) &&
  value.jsonrpc === JSONRPC_VERSION &&
  "error" in value &&
  "id" in value;

const formatPath = (path: Array<string | number>): string =>
  path.reduce<string>((formattedPath, segment) => {
    if (typeof segment === "number") {
      return `${formattedPath}[${segment}]`;
    }

    return `${formattedPath}.${segment}`;
  }, "$");

const describeExpectedType = (schema: Record<string, unknown>): string =>
  typeof schema.type === "string" ? schema.type : "valid value";

const hasEnumMatch = (allowedValues: unknown[], value: unknown): boolean =>
  allowedValues.some((allowedValue) => Object.is(allowedValue, value));

const validateValueAgainstSchema = (
  schema: Record<string, unknown>,
  value: unknown,
  path: Array<string | number> = []
): ToolInputValidationIssue[] => {
  const issues: ToolInputValidationIssue[] = [];
  const anyOf = schema.anyOf;

  if (Array.isArray(anyOf)) {
    const anyOfSchemas = anyOf.filter(isObject);
    const matchedSchema = anyOfSchemas.some(
      (candidateSchema) => validateValueAgainstSchema(candidateSchema, value, path).length === 0
    );

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
      ? schema.required.filter((field): field is string => typeof field === "string")
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
        issues.push(
          ...validateValueAgainstSchema(propertySchema, value[field], path.concat(field))
        );
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) => {
      issues.push(...validateValueAgainstSchema(schema.items as Record<string, unknown>, item, path.concat(index)));
    });
  }

  if (
    typeof schema.minimum === "number" &&
    typeof value === "number" &&
    value < schema.minimum
  ) {
    issues.push({
      path: formatPath(path),
      message: `Expected ${describeExpectedType(schema)} greater than or equal to ${schema.minimum}.`
    });
  }

  if (
    typeof schema.maximum === "number" &&
    typeof value === "number" &&
    value > schema.maximum
  ) {
    issues.push({
      path: formatPath(path),
      message: `Expected ${describeExpectedType(schema)} less than or equal to ${schema.maximum}.`
    });
  }

  return issues;
};

const validateToolInput = (
  toolDefinition: ToolDefinition,
  input: Record<string, unknown>
): ToolResponse | null => {
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

const errorResponse = (
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data })
  }
});

const successResponse = (id: JsonRpcId, result: unknown): JsonRpcSuccessResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result
});

const validateMessageShape = (
  message: unknown
):
  | { kind: "request"; request: JsonRpcRequestShape }
  | { kind: "notification"; notification: JsonRpcNotificationShape }
  | { kind: "response"; response: JsonRpcResponseWithId }
  | { kind: "error"; response: JsonRpcErrorResponse } => {
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
              code:
                typeof (message.error as Record<string, unknown>).code === "number"
                  ? ((message.error as Record<string, unknown>).code as number)
                  : INVALID_REQUEST,
              message:
                typeof (message.error as Record<string, unknown>).message === "string"
                  ? ((message.error as Record<string, unknown>).message as string)
                  : "Invalid JSON-RPC error response.",
              ...(Object.prototype.hasOwnProperty.call(
                message.error as Record<string, unknown>,
                "data"
              )
                ? { data: (message.error as Record<string, unknown>).data }
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

const requireObjectParams = (
  request: JsonRpcRequestShape,
  description: string
): Record<string, unknown> | JsonRpcErrorResponse => {
  if (request.params === undefined) {
    return {};
  }

  if (!isObject(request.params)) {
    return errorResponse(request.id, INVALID_PARAMS, description);
  }

  return request.params;
};

const requireInitialized = (
  state: ProtocolState,
  request: JsonRpcRequestShape
): JsonRpcErrorResponse | null => {
  if (state.initializedNotificationReceived) {
    return null;
  }

  return errorResponse(
    request.id,
    SERVER_NOT_INITIALIZED,
    "Client must send notifications/initialized before normal MCP requests."
  );
};

const normalizeToolArguments = (
  params: Record<string, unknown>,
  requestId: JsonRpcId
): { name: string; arguments: Record<string, unknown> } | JsonRpcErrorResponse => {
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
    return errorResponse(
      requestId,
      INVALID_PARAMS,
      "tools/call requires params.arguments to be an object."
    );
  }

  return {
    name,
    arguments: argumentsValue
  };
};

const toStructuredEnvelope = (
  toolResponse: ToolResponse
): {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
} => ({
  ok: toolResponse.ok,
  ...(toolResponse.data === undefined ? {} : { data: toolResponse.data }),
  ...(toolResponse.error === undefined ? {} : { error: toolResponse.error }),
  ...(toolResponse.meta === undefined ? {} : { meta: toolResponse.meta })
});

const toCallToolResult = (
  registry: RouteLedgerMcpRegistry,
  toolName: string,
  toolResponse: ToolResponse
) => {
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
    _meta:
      toolDefinition === undefined
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

const buildInitializeResult = (registry: RouteLedgerMcpRegistry) => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: registry.serverCapabilities,
  serverInfo: registry.serverInfo,
  instructions: registry.instructions
});

const normalizeRootUriCandidate = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }

  return value;
};

const collectInitializeRoots = (params: Record<string, unknown>): string[] => {
  const roots = new Set<string>();
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

export const createRouteLedgerStdioServer = (
  options: CreateRouteLedgerStdioServerOptions
): RouteLedgerStdioServer => {
  const buildRegistry = (registryOptions: RouteLedgerMcpRegistryOptions): RouteLedgerMcpRegistry =>
    options.registryFactory?.(registryOptions) ?? createRouteLedgerMcpRegistry(registryOptions);
  const initializeRegistry = buildRegistry({
    ...options,
    deferSessionRebind: true
  });
  let activeRegistry = initializeRegistry;
  const state: ProtocolState = {
    initializeCompleted: false,
    initializedNotificationReceived: false,
    clientSupportsRoots: false,
    initializeRoots: [],
    listedRoots: [],
    latestRootsListRequestId: null
  };
  let nextOutboundRequestId = 1;
  const pendingRequests = new Map<JsonRpcId, PendingRequestHandlers>();

  const rebuildRegistry = (): Error | null => {
    const effectiveRoots =
      state.initializeRoots.length > 0 ? state.initializeRoots : state.listedRoots;

    let nextRegistry: RouteLedgerMcpRegistry;
    try {
      nextRegistry = buildRegistry({
        ...options,
        mcpRoots: effectiveRoots,
        deferSessionRebind: true
      });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }

    const previousRegistry = activeRegistry;
    activeRegistry = nextRegistry;
    if (previousRegistry !== initializeRegistry) {
      try {
        previousRegistry.close();
      } catch {
        // The replacement is already active. A close hook must not roll back it.
      }
    }
    return null;
  };

  const activatePendingSessionRebind = async (
    registry: RouteLedgerMcpRegistry
  ): Promise<ToolResponse | null> => {
    const nextBinding = registry.peekPendingSessionRebind();
    if (nextBinding === null) {
      return null;
    }

    // Build the replacement before releasing the old runtime. The bootstrap handler
    // has already returned its result at this point, so closing old storage cannot
    // prevent the JSON-RPC response from being formed.
    let nextRegistry: RouteLedgerMcpRegistry;
    try {
      nextRegistry = buildRegistry({
        ...options,
        workspaceRoot: nextBinding.workspaceRoot,
        workspaceRootSource: "explicit_arg",
        routeledgerRoot: nextBinding.routeledgerRoot,
        mcpRoots: undefined,
        deferSessionRebind: true
      });
    } catch (error) {
      return {
        ...createSessionRebindFailureResponse(nextBinding, error),
        meta: await registry.getRuntimeContextMeta()
      };
    }

    let activationResponse: ToolResponse;
    try {
      activationResponse = await nextRegistry.createActivationSuccessResponse(nextBinding);
    } catch (error) {
      try {
        nextRegistry.close();
      } catch {
        // The old registry remains active; a failed candidate close is irrelevant.
      }
      return {
        ...createSessionRebindFailureResponse(nextBinding, error),
        meta: await registry.getRuntimeContextMeta()
      };
    }

    activeRegistry = nextRegistry;
    registry.clearPendingSessionRebind();
    if (registry !== initializeRegistry) {
      try {
        registry.close();
      } catch {
        // The new registry is active and the call response is already formed.
      }
    }
    return activationResponse;
  };

  const sendMessage = (message: JsonRpcMessage): void => {
    options.sendMessage?.(message);
  };

  const requestRootsList = (): void => {
    if (!state.clientSupportsRoots) {
      return;
    }

    const id = nextOutboundRequestId++;
    state.latestRootsListRequestId = id;
    const request: JsonRpcClientRequest = {
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
      } catch {
        // Shutdown must release the remaining registry even if one close hook fails.
      }
      if (activeRegistry !== initializeRegistry) {
        try {
          initializeRegistry.close();
        } catch {
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
        } else {
          pending.resolve(validated.response);
        }

        return null;
      }

      const { request } = validated;

      try {
        switch (request.method) {
          case "initialize": {
            if (state.initializeCompleted) {
              return errorResponse(
                request.id,
                INVALID_REQUEST,
                "initialize may only be called once per connection."
              );
            }

            const params = requireObjectParams(
              request,
              "initialize requires object params."
            );

            if (isJsonRpcErrorResponse(params)) {
              return params;
            }

            const protocolVersion = params.protocolVersion;

            if (typeof protocolVersion !== "string" || protocolVersion.trim().length === 0) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                "initialize requires params.protocolVersion."
              );
            }

            if (!isObject(params.capabilities)) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                "initialize requires object params.capabilities."
              );
            }

            if (!isObject(params.clientInfo)) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                "initialize requires object params.clientInfo."
              );
            }

            if (
              typeof params.clientInfo.name !== "string" ||
              params.clientInfo.name.trim().length === 0
            ) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                "initialize params.clientInfo.name must be a non-empty string."
              );
            }

            if (
              typeof params.clientInfo.version !== "string" ||
              params.clientInfo.version.trim().length === 0
            ) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                "initialize params.clientInfo.version must be a non-empty string."
              );
            }

            const initializeRoots = collectInitializeRoots(params);
            const previousInitializeRoots = state.initializeRoots;
            state.initializeRoots = initializeRoots;
            state.clientSupportsRoots = isObject(params.capabilities.roots);
            const rebuildError = rebuildRegistry();
            if (rebuildError !== null) {
              state.initializeRoots = previousInitializeRoots;
              state.clientSupportsRoots = false;
              return errorResponse(
                request.id,
                INTERNAL_ERROR,
                `RouteLedger could not construct the requested Roots binding: ${rebuildError.message}`
              );
            }
            state.initializeCompleted = true;
            return successResponse(request.id, buildInitializeResult(activeRegistry));
          }
          case "ping":
            return successResponse(request.id, {});
          case "tools/list": {
            const initializationError = requireInitialized(state, request);

            if (initializationError !== null) {
              return initializationError;
            }

            const params = requireObjectParams(request, "tools/list params must be an object.");

            if (isJsonRpcErrorResponse(params)) {
              return params;
            }

            return successResponse(request.id, {
              tools: activeRegistry.tools
            });
          }
          case "tools/call": {
            const initializationError = requireInitialized(state, request);

            if (initializationError !== null) {
              return initializationError;
            }

            const params = requireObjectParams(request, "tools/call params must be an object.");

            if (isJsonRpcErrorResponse(params)) {
              return params;
            }

            const toolCall = normalizeToolArguments(params, request.id);

            if (isJsonRpcErrorResponse(toolCall)) {
              return toolCall;
            }

            if (activeRegistry.getTool(toolCall.name) === undefined) {
              return errorResponse(
                request.id,
                INVALID_PARAMS,
                `Unknown tool '${toolCall.name}'.`
              );
            }

            const toolDefinition = activeRegistry.getTool(toolCall.name);
            const validationError =
              toolDefinition === undefined
                ? null
                : validateToolInput(toolDefinition, toolCall.arguments);
            const invocationRegistry = activeRegistry;
            const toolResponse =
              validationError === null
                ? await invocationRegistry.invoke(toolCall.name, toolCall.arguments)
                : {
                    ...validationError,
                    meta: await invocationRegistry.getRuntimeContextMeta()
                  };
            const rebindResponse =
              validationError === null && toolCall.name === "activate_routeledger_binding"
                ? await activatePendingSessionRebind(invocationRegistry)
                : null;

            return successResponse(
              request.id,
              toCallToolResult(
                activeRegistry,
                toolCall.name,
                rebindResponse ?? toolResponse
              )
            );
          }
          case "notifications/initialized":
            return errorResponse(
              request.id,
              INVALID_REQUEST,
              "notifications/initialized must be sent without an id."
            );
          default:
            return errorResponse(
              request.id,
              METHOD_NOT_FOUND,
              `Method not found: ${request.method}`
            );
        }
      } catch (error) {
        return errorResponse(
          request.id,
          INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  };
};

const closeReadline = (readline: ReadLineInterface | null): void => {
  readline?.close();
};

const writeJsonRpcMessage = (output: Writable, message: JsonRpcMessage): void => {
  output.write(`${JSON.stringify(message)}\n`);
};

export const runRouteLedgerStdioServer = async (
  options: RunRouteLedgerStdioServerOptions
): Promise<void> => {
  const server = createRouteLedgerStdioServer({
    workspaceRoot: options.workspaceRoot,
    workspaceRootSource: options.workspaceRootSource,
    routeledgerRoot: options.routeledgerRoot,
    sqliteReadModel: options.sqliteReadModel,
    hostProfile: options.hostProfile,
    runtimeProfile: options.runtimeProfile,
    actor: options.actor,
    approver: options.approver,
    sendMessage: (message) => {
      writeJsonRpcMessage(options.output, message);
    }
  });
  const readline = createInterface({
    input: options.input,
    crlfDelay: Infinity
  });

  try {
    for await (const line of readline) {
      if (line.trim().length === 0) {
        continue;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch (error) {
        writeJsonRpcMessage(
          options.output,
          errorResponse(
            null,
            PARSE_ERROR,
            "Parse error.",
            error instanceof Error ? { detail: error.message } : undefined
          )
        );

        if (options.once) {
          break;
        }

        continue;
      }

      const response = await server.handleMessage(parsed);

      if (response !== null) {
        writeJsonRpcMessage(options.output, response);
      }

      if (options.once) {
        break;
      }
    }
  } catch (error) {
    if (options.errorOutput !== undefined) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      options.errorOutput.write(`${detail}\n`);
    }

    throw error;
  } finally {
    closeReadline(readline);
    server.close();
  }
};
