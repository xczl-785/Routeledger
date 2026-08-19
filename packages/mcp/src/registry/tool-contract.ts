export type RouteLedgerToolRiskLevel = "read-only" | "write" | "high-risk";
export type RouteLedgerApprovalMode = "auto" | "prompt" | "approve";

export type RouteLedgerBindingToolKind =
  | "diagnostic"
  | "discovery"
  | "planning"
  | "bootstrap"
  | "read"
  | "write";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolMeta {
  routeledger: {
    riskLevel: RouteLedgerToolRiskLevel;
    highRisk: boolean;
    destructive: boolean;
    recommendedApprovalMode: RouteLedgerApprovalMode;
  };
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  _meta: ToolMeta;
}

/**
 * Tool descriptions are intentionally compact. Shared operating discipline belongs in
 * server instructions and multi-step procedures belong in the operator Skill.
 */
export interface ToolNarrative {
  what: string;
  when?: string;
  prerequisite?: string;
  parameter?: string;
  warning?: string;
}

export interface ToolResponse {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
}

export type ToolHandler = (input: Record<string, any>) => Promise<ToolResponse>;

export type ToolRegistration = {
  definition: ToolDefinition;
  toolKind: RouteLedgerBindingToolKind;
  visibility: "default" | "source-only";
  handler: ToolHandler;
};

export interface DefineToolOptions {
  title: string;
  riskLevel: RouteLedgerToolRiskLevel;
  toolKind?: RouteLedgerBindingToolKind;
  destructive?: boolean;
  idempotent?: boolean;
  recommendedApprovalMode?: RouteLedgerApprovalMode;
  visibility?: "default" | "source-only";
  outputSchema?: Record<string, unknown>;
}

const expectedRouteLedgerRootSchema = {
  type: "string",
  description:
    "Runtime-required absolute routeledgerRoot assertion for write/high-risk tools, including dry_run previews. It must exactly match the MCP server routeledgerRoot."
};

const approvalModeForRisk = (
  riskLevel: RouteLedgerToolRiskLevel
): RouteLedgerApprovalMode => {
  switch (riskLevel) {
    case "read-only":
      return "auto";
    case "write":
    case "high-risk":
      return "prompt";
    default: {
      const exhaustiveRiskLevel: never = riskLevel;
      return exhaustiveRiskLevel;
    }
  }
};

const createToolMetadata = (
  options: DefineToolOptions
): Pick<ToolDefinition, "title" | "annotations" | "_meta"> => {
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
        recommendedApprovalMode:
          options.recommendedApprovalMode ?? approvalModeForRisk(options.riskLevel)
      }
    }
  };
};

const withExpectedRouteLedgerRootInputSchema = (
  inputSchema: Record<string, unknown>,
  riskLevel: RouteLedgerToolRiskLevel
): Record<string, unknown> => {
  if (riskLevel === "read-only") {
    return inputSchema;
  }

  const properties =
    inputSchema.properties !== null && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : {};

  return {
    ...inputSchema,
    properties: {
      ...properties,
      expectedRouteLedgerRoot: expectedRouteLedgerRootSchema
    }
  };
};

const formatToolNarrative = (narrative: ToolNarrative): string =>
  [
    narrative.what,
    narrative.when === undefined ? undefined : `When: ${narrative.when}.`,
    narrative.prerequisite === undefined
      ? undefined
      : `Needs: ${narrative.prerequisite}.`,
    narrative.parameter === undefined ? undefined : `Input: ${narrative.parameter}.`,
    narrative.warning === undefined ? undefined : `Warning: ${narrative.warning}.`
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");

export const defineTool = (
  name: string,
  narrative: ToolNarrative,
  inputSchema: Record<string, unknown>,
  options: DefineToolOptions,
  handler: ToolHandler
): ToolRegistration => ({
  definition: {
    name,
    description: formatToolNarrative(narrative),
    inputSchema: withExpectedRouteLedgerRootInputSchema(inputSchema, options.riskLevel),
    ...(options.outputSchema === undefined
      ? {}
      : { outputSchema: options.outputSchema }),
    ...createToolMetadata(options)
  },
  toolKind:
    options.toolKind ??
    (options.riskLevel === "read-only" ? "read" : "write"),
  visibility: options.visibility ?? "default",
  handler
});
