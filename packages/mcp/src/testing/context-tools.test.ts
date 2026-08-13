import { describe, expect, it } from "vitest";

import { createContextTools } from "../capabilities/context-tools.js";

describe("context tool registrations", () => {
  it("preserves the ordered read-only capability surface", () => {
    const tools = createContextTools({
      service: {} as never,
      actor: {} as never,
      appendDebugLog: async () => undefined,
      withCurrentRuntimeContextMeta: () => ({})
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "get_current_context",
      "next_action",
      "check_doc_drift",
      "summarize_version_closeout",
      "plan_version_closeout",
      "list_versions_window",
      "list_versions",
      "check_start_gate",
      "check_close_gate",
      "get_version_structure",
      "get_version_transition_guide"
    ]);
    expect(tools.every((tool) => tool.definition._meta.routeledger.riskLevel === "read-only")).toBe(
      true
    );
  });
});
