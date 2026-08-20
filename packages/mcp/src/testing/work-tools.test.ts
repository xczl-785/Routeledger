import { describe, expect, it } from "vitest";

import { createWorkTools } from "../capabilities/work-tools.js";
import { validateToolOutput } from "../stdio-server.js";

describe("work tool registrations", () => {
  it("preserves the ordered Todo, Deferred, and Constraint capability surface", () => {
    const tools = createWorkTools({
      service: {} as never,
      actor: {} as never,
      appendDebugLog: async () => undefined,
      summarizeTodoForAgent: () => ({}),
      summarizeDeferredForAgent: () => ({}),
      summarizeConstraintForAgent: () => ({})
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "create_todo",
      "close_todo",
      "defer_work",
      "review_deferred",
      "record_constraint",
      "retire_constraint"
    ]);
    expect(tools.every((tool) => tool.definition._meta.routeledger.riskLevel === "write")).toBe(
      true
    );
    expect(tools.every((tool) => tool.definition.annotations.idempotentHint)).toBe(true);
    expect(
      tools
        .filter((tool) => tool.definition.annotations.destructiveHint)
        .map((tool) => tool.definition.name)
    ).toEqual(["close_todo", "review_deferred", "retire_constraint"]);
    for (const tool of tools) {
      expect(
        (tool.definition.inputSchema as { required?: string[] }).required,
        tool.definition.name
      ).toContain("idempotencyKey");
    }
  });

  it("accepts exact work output, rejects drift, and returns a schema-safe recovery error", () => {
    const tools = createWorkTools({
      service: {} as never,
      actor: {} as never,
      appendDebugLog: async () => undefined,
      summarizeTodoForAgent: () => ({}),
      summarizeDeferredForAgent: () => ({}),
      summarizeConstraintForAgent: () => ({})
    });
    const definition = tools.find(
      (tool) => tool.definition.name === "record_constraint"
    )!.definition;
    const validOutput = {
      ok: true,
      data: {
        constraint: {
          id: "constraint",
          projectId: "project",
          rule: "Keep the route stable.",
          rationale: "Compatibility",
          scope: { type: "project" },
          status: "active",
          createdBy: { id: "agent", type: "agent" },
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
          retiredAt: null,
          retireReason: null,
          retireNote: null
        },
        idempotency: {
          protected: true,
          receiptId: "receipt",
          replayed: false,
          resultScope: "original_commit",
          originalCommittedAt: "2026-08-18T00:00:00.000Z",
          currentStateRefreshed: true
        }
      }
    };

    expect(validateToolOutput(definition, validOutput)).toBeNull();

    const recovery = validateToolOutput(definition, {
      ...validOutput,
      data: {
        ...validOutput.data,
        unexpected: true
      }
    });
    expect(recovery).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_TOOL_OUTPUT",
        details: { path: "$.data.unexpected" }
      }
    });
    expect(validateToolOutput(definition, recovery!)).toBeNull();
  });
});
