import { describe, expect, it } from "vitest";

import { createCompositeTool } from "../index.js";
import { defineTool } from "../registry/tool-contract.js";
import { validateValueAgainstSchema } from "../schema-validation.js";

describe("MCP tool contract construction", () => {
  it("keeps the shared schema validator strict for unsupported JSON Schema types", () => {
    expect(validateValueAgainstSchema({ type: "number" }, 1)).toEqual([
      { path: "$", message: "Unsupported schema type 'number'." }
    ]);
  });

  it("rejects a selected capability response that violates its output schema", async () => {
    const internalTool = defineTool(
      "internal_fixture",
      { what: "Return an invalid fixture response." },
      { type: "object", properties: {}, additionalProperties: false },
      {
        title: "Internal Fixture",
        riskLevel: "read-only",
        outputSchema: {
          type: "object",
          properties: { ok: { const: true }, data: { type: "string" } },
          required: ["ok", "data"],
          additionalProperties: false
        }
      },
      async () => ({ ok: true, data: 42 })
    );
    const composite = createCompositeTool(
      "public_fixture",
      "Public Fixture",
      "Exercise selected capability output validation.",
      [{ action: "run", tool: internalTool }],
      { title: "Public Fixture", riskLevel: "read-only" }
    );

    await expect(composite.handler({ operation: "run" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_OUTPUT", details: { path: "$.data" } }
    });
  });

  it("decorates write tools without changing their handler or base schema", async () => {
    const handler = async () => ({ ok: true as const, data: { accepted: true } });
    const registration = defineTool(
      "sample_write",
      {
        what: "Write a sample record.",
        when: "the contract boundary is under test",
        prerequisite: "a bound project",
        parameter: "value",
        warning: "This is only a fixture"
      },
      {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      {
        title: "Sample Write",
        riskLevel: "write"
      },
      handler
    );

    expect(registration.definition).toEqual({
      name: "sample_write",
      title: "Sample Write",
      description:
        "Write a sample record. When: the contract boundary is under test. Needs: a bound project. Input: value. Warning: This is only a fixture.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
          detail: {
            type: "string",
            enum: ["compact", "standard", "audit"],
            description:
              "Response detail: compact for agent action loops, standard for the compatibility response, or audit for complete diagnostic and authorization material. Defaults to standard."
          },
          expectedRouteLedgerRoot: {
            type: "string",
            description:
              "Runtime-required absolute routeledgerRoot assertion for write/high-risk tools, including dry_run previews. It must exactly match the MCP server routeledgerRoot."
          }
        },
        required: ["value"],
        additionalProperties: false
      },
      annotations: {
        title: "Sample Write",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        routeledger: {
          riskLevel: "write",
          highRisk: false,
          destructive: false,
          recommendedApprovalMode: "prompt"
        }
      }
    });
    expect(registration.toolKind).toBe("write");
    expect(registration.visibility).toBe("default");
    await expect(registration.handler({ value: "x" })).resolves.toEqual({
      ok: true,
      data: { accepted: true }
    });
  });

  it("adds response detail to every composite branch", () => {
    const internalTool = defineTool(
      "internal_read",
      { what: "Read a fixture." },
      { type: "object", properties: {}, additionalProperties: false },
      { title: "Internal Read", riskLevel: "read-only" },
      async () => ({ ok: true, data: { id: "fixture-1" } })
    );
    const composite = createCompositeTool(
      "public_read",
      "Public Read",
      "Read a public fixture.",
      [{ action: "read", tool: internalTool }],
      { title: "Public Read", riskLevel: "read-only" }
    );

    expect(composite.definition.inputSchema).toMatchObject({
      oneOf: [
        {
          properties: {
            operation: { const: "read" },
            detail: { enum: ["compact", "standard", "audit"] }
          }
        }
      ]
    });
  });
});
