const expectedRouteLedgerRootSchema = {
    type: "string",
    description: "Runtime-required absolute routeledgerRoot assertion for write/high-risk tools, including dry_run previews. It must exactly match the MCP server routeledgerRoot."
};
const responseLocaleSchema = {
    type: "string",
    description: "Optional BCP 47 locale for human-readable tool messages. It is not persisted as project content_locale."
};
const approvalModeForRisk = (riskLevel) => {
    switch (riskLevel) {
        case "read-only":
            return "auto";
        case "write":
        case "high-risk":
            return "prompt";
        default: {
            const exhaustiveRiskLevel = riskLevel;
            return exhaustiveRiskLevel;
        }
    }
};
const createToolMetadata = (options) => {
    const destructive = options.destructive ?? false;
    const readOnly = options.riskLevel === "read-only";
    return {
        title: options.title,
        annotations: {
            title: options.title,
            readOnlyHint: readOnly,
            destructiveHint: destructive,
            idempotentHint: options.idempotent ?? readOnly,
            openWorldHint: false
        },
        _meta: {
            routeledger: {
                riskLevel: options.riskLevel,
                highRisk: options.riskLevel === "high-risk",
                destructive,
                recommendedApprovalMode: options.recommendedApprovalMode ?? approvalModeForRisk(options.riskLevel)
            }
        }
    };
};
const withResponseLocaleInputSchema = (inputSchema) => {
    const properties = inputSchema.properties !== null && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : {};
    return {
        ...inputSchema,
        properties: {
            ...properties,
            responseLocale: responseLocaleSchema
        }
    };
};
const withExpectedRouteLedgerRootInputSchema = (inputSchema, riskLevel) => {
    if (riskLevel === "read-only") {
        return inputSchema;
    }
    const properties = inputSchema.properties !== null && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : {};
    return {
        ...inputSchema,
        properties: {
            ...properties,
            expectedRouteLedgerRoot: expectedRouteLedgerRootSchema
        }
    };
};
const formatToolNarrative = (narrative) => [
    narrative.what,
    narrative.when === undefined ? undefined : `When: ${narrative.when}.`,
    narrative.prerequisite === undefined
        ? undefined
        : `Needs: ${narrative.prerequisite}.`,
    narrative.parameter === undefined ? undefined : `Input: ${narrative.parameter}.`,
    narrative.warning === undefined ? undefined : `Warning: ${narrative.warning}.`
]
    .filter((part) => part !== undefined)
    .join(" ");
export const defineTool = (name, narrative, inputSchema, options, handler) => ({
    definition: {
        name,
        description: formatToolNarrative(narrative),
        inputSchema: withResponseLocaleInputSchema(withExpectedRouteLedgerRootInputSchema(inputSchema, options.riskLevel)),
        ...(options.outputSchema === undefined
            ? {}
            : { outputSchema: options.outputSchema }),
        ...createToolMetadata(options)
    },
    toolKind: options.toolKind ??
        (options.riskLevel === "read-only" ? "read" : "write"),
    visibility: options.visibility ?? "default",
    handler
});
