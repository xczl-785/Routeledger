/**
 * The transport-facing call path is deliberately expressed as ordered stages.
 * Capability handlers stay in the registry; this pipeline owns only MCP request
 * admission, host binding, response projection, and exception mapping.
 */
export type McpToolCallPipelineStep<TValue, TResponse> =
  | { kind: "continue"; value: TValue }
  | { kind: "respond"; response: TResponse };

export interface McpToolCallPipelineStages<
  TValidated,
  TBound,
  TAuthorized,
  TExecuted,
  TRebound,
  TResponse
> {
  validate: () => Promise<McpToolCallPipelineStep<TValidated, TResponse>>;
  bind: (validated: TValidated) => Promise<McpToolCallPipelineStep<TBound, TResponse>>;
  authorize: (bound: TBound) => Promise<McpToolCallPipelineStep<TAuthorized, TResponse>>;
  execute: (authorized: TAuthorized) => Promise<McpToolCallPipelineStep<TExecuted, TResponse>>;
  rebind: (executed: TExecuted) => Promise<McpToolCallPipelineStep<TRebound, TResponse>>;
  project: (rebound: TRebound) => Promise<TResponse>;
  mapError: (error: unknown) => TResponse;
}

/**
 * Runs the fixed MCP tools/call lifecycle. A stage can finish with a protocol
 * response without invoking later stages; unexpected exceptions have exactly
 * one transport-level error mapping point.
 */
export const runMcpToolCallPipeline = async <
  TValidated,
  TBound,
  TAuthorized,
  TExecuted,
  TRebound,
  TResponse
>(
  stages: McpToolCallPipelineStages<
    TValidated,
    TBound,
    TAuthorized,
    TExecuted,
    TRebound,
    TResponse
  >
): Promise<TResponse> => {
  try {
    const validated = await stages.validate();
    if (validated.kind === "respond") return validated.response;

    const bound = await stages.bind(validated.value);
    if (bound.kind === "respond") return bound.response;

    const authorized = await stages.authorize(bound.value);
    if (authorized.kind === "respond") return authorized.response;

    const executed = await stages.execute(authorized.value);
    if (executed.kind === "respond") return executed.response;

    const rebound = await stages.rebind(executed.value);
    if (rebound.kind === "respond") return rebound.response;

    return await stages.project(rebound.value);
  } catch (error) {
    return stages.mapError(error);
  }
};
