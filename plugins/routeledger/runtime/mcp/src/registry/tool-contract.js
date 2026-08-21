const expectedRouteLedgerRootSchema = {
    type: "string",
    description: "Runtime-required absolute routeledgerRoot assertion for write/high-risk tools, including dry_run previews. It must exactly match the MCP server routeledgerRoot."
};
const responseDetailSchema = {
    type: "string",
    enum: ["compact", "standard", "audit"],
    description: "Response detail: compact for agent action loops, standard for the compatibility response, or audit for complete diagnostic and authorization material. Defaults to standard."
};
const withResponseDetailInputSchema = (inputSchema) => {
    const properties = inputSchema.properties !== null && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : null;
    const oneOf = Array.isArray(inputSchema.oneOf)
        ? inputSchema.oneOf.map((branch) => branch !== null && typeof branch === "object" && !Array.isArray(branch)
            ? withResponseDetailInputSchema(branch)
            : branch)
        : undefined;
    if (properties === null) {
        return { ...inputSchema, ...(oneOf === undefined ? {} : { oneOf }) };
    }
    const existing = properties.detail !== null && typeof properties.detail === "object"
        ? properties.detail
        : null;
    const existingEnum = Array.isArray(existing?.enum)
        ? existing.enum.filter((value) => typeof value === "string")
        : [];
    return {
        ...inputSchema,
        ...(oneOf === undefined ? {} : { oneOf }),
        properties: {
            ...properties,
            detail: existing === null
                ? responseDetailSchema
                : {
                    ...existing,
                    enum: [...new Set([...existingEnum, ...responseDetailSchema.enum])]
                }
        }
    };
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
        inputSchema: withExpectedRouteLedgerRootInputSchema(withResponseDetailInputSchema(inputSchema), options.riskLevel),
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
