/**
 * Runs the fixed MCP tools/call lifecycle. A stage can finish with a protocol
 * response without invoking later stages; unexpected exceptions have exactly
 * one transport-level error mapping point.
 */
export const runMcpToolCallPipeline = async (stages) => {
    try {
        const validated = await stages.validate();
        if (validated.kind === "respond")
            return validated.response;
        const bound = await stages.bind(validated.value);
        if (bound.kind === "respond")
            return bound.response;
        const authorized = await stages.authorize(bound.value);
        if (authorized.kind === "respond")
            return authorized.response;
        const executed = await stages.execute(authorized.value);
        if (executed.kind === "respond")
            return executed.response;
        const rebound = await stages.rebind(executed.value);
        if (rebound.kind === "respond")
            return rebound.response;
        return await stages.project(rebound.value);
    }
    catch (error) {
        return stages.mapError(error);
    }
};
