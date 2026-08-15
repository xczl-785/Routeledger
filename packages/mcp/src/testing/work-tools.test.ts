import { describe, expect, it } from "vitest";

import { createWorkTools } from "../capabilities/work-tools.js";

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
});
