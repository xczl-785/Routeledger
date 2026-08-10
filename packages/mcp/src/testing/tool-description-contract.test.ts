import { describe, expect, it } from "vitest";

import { createRouteLedgerMcpRegistry, type ToolDefinition } from "../index.js";

const REMOVED_LEGACY_TOOLS = [
  "create_undo",
  "reassign_undo",
  "carry_forward_undo",
  "resolve_undo_as_downstream_input",
  "close_undo"
];

const getTool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool ${name}.`);
  }
  return tool;
};

describe("MCP tool description contract", () => {
  it("keeps the public tool budget, risk shape, and binding assertion intact", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const tools = registry.tools;
      const readOnly = tools.filter((tool) => tool._meta.routeledger.riskLevel === "read-only");
      const writes = tools.filter((tool) => tool._meta.routeledger.riskLevel === "write");
      const highRisk = tools.filter((tool) => tool._meta.routeledger.riskLevel === "high-risk");

      expect(tools).toHaveLength(45);
      expect(readOnly).toHaveLength(20);
      expect(writes).toHaveLength(21);
      expect(highRisk).toHaveLength(4);
      expect(writes.concat(highRisk)).toHaveLength(25);
      for (const tool of writes.concat(highRisk)) {
        const required = (tool.inputSchema.required ?? []) as string[];
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        expect(properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(required).not.toContain("expectedRouteLedgerRoot");
      }
      for (const name of ["transition_version", "close_version", "shutdown_version"]) {
        const tool = getTool(tools, name);
        const properties = (tool.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >;
        const mode = properties.mode;
        const rootAssertion = properties.expectedRouteLedgerRoot;

        expect(tool.description).toContain("Binding-sensitive");
        expect(mode?.description).toContain("dry_run is a binding-sensitive preview");
        expect(mode?.description).toContain("expectedRouteLedgerRoot");
        expect(rootAssertion?.description).toContain("including dry_run previews");
      }
      for (const removedTool of REMOVED_LEGACY_TOOLS) {
        expect(tools.find((tool) => tool.name === removedTool)).toBeUndefined();
      }
    } finally {
      registry.close();
    }
  });

  it("keeps descriptions compact, specific, and free of repeated public boilerplate", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const descriptions = registry.tools.map((tool) => tool.description);
      expect(descriptions.reduce((total, description) => total + description.length, 0)).toBeLessThanOrEqual(3200);
      for (const description of descriptions) {
        expect(description.length).toBeLessThanOrEqual(150);
      }

      const repeatedLongSentences = new Map<string, number>();
      for (const description of descriptions) {
        for (const sentence of description.split(/(?<=[.!?])\s+/)) {
          const normalized = sentence.trim();
          if (normalized.length >= 80) {
            repeatedLongSentences.set(
              normalized,
              (repeatedLongSentences.get(normalized) ?? 0) + 1
            );
          }
        }
      }
      expect([...repeatedLongSentences.values()].every((count) => count === 1)).toBe(true);
    } finally {
      registry.close();
    }
  });

  it("keeps close residual-audit schemas free of the removed legacy create_undo routing", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const closeVersion = getTool(registry.tools, "close_version");
      const properties = closeVersion.inputSchema.properties as Record<string, Record<string, unknown>>;
      const residualAudit = properties.residualAudit;
      const alternatives = residualAudit?.anyOf as Array<Record<string, unknown>>;
      const legacyArray = alternatives.find((candidate) => candidate.type === "array");
      if (legacyArray === undefined) {
        throw new Error("Missing legacy residual audit array schema.");
      }
      const itemProperties = (legacyArray.items as { properties: Record<string, Record<string, unknown>> })
        .properties;
      const destinationEnums = (itemProperties.destination?.anyOf as Array<Record<string, unknown>>)
        .flatMap((candidate) =>
          Array.isArray(candidate.enum) ? (candidate.enum as string[]) : []
        );

      expect(destinationEnums).not.toContain("create_undo");
      expect(itemProperties).not.toHaveProperty("preferredResolutionVersionId");
    } finally {
      registry.close();
    }
  });

  it("snapshots representative descriptions and keeps shared discipline in instructions", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      expect(
        Object.fromEntries(
          [
            "activate_routeledger_binding",
            "get_current_context",
            "close_version",
            "defer_work",
            "create_version",
            "commit_l3_operation"
          ].map((name) => [name, getTool(registry.tools, name).description])
        )
      ).toMatchInlineSnapshot(`
        {
          "activate_routeledger_binding": "Activate an explicit MCP binding. Input: workspaceRoot. Warning: writes config only; cannot switch an established binding.",
          "close_version": "Binding-sensitive close preview or proposal. Input: mode and versionId. Warning: proposal needs a passing gate.",
          "commit_l3_operation": "Commit an approved L3 proposal. Input: pendingOperationId and approvalArtifactId. Warning: consumes once; exact retries replay.",
          "create_version": "Propose a top-level version, including append-only continuation after a closed top-level tail. Warning: returns a pending L3 operation.",
          "defer_work": "Create Deferred work for a future review. Input: mode, targetReviewVersionId, and Todo or new-work fields.",
          "get_current_context": "Read current project, route, work, and gate context.",
        }
      `);
      expect(registry.instructions).toContain("CONFIRMATION_REQUIRED");
      expect(registry.instructions).toContain(
        "approve_l3_operation consumes a bound policy grant or requests structured host elicitation"
      );
      expect(registry.instructions).toContain("fails closed without trusted policy or host elicitation");
    } finally {
      registry.close();
    }
  });
});
