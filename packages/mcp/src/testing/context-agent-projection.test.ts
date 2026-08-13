import { describe, expect, it } from "vitest";

import {
  sanitizeDocDriftForAgent,
  sanitizeVersionStructureForAgent
} from "../capabilities/context-agent-projection.js";

describe("context agent projection", () => {
  it("projects legacy version blockers without exposing Undo records", () => {
    const projected = sanitizeVersionStructureForAgent({
      legalOperations: [
        {
          actionType: "close_version",
          blockers: [{ code: "OPEN_UNDOS", recordIds: ["undo-1"] }]
        }
      ],
      openUndos: {
        owned: [{ id: "undo-1" }],
        origin: [],
        preferredResolution: []
      }
    });

    expect(projected).not.toHaveProperty("openUndos");
    expect(projected).toMatchObject({
      legacyAudit: { required: true, recordCount: 1 },
      legalOperations: [
        {
          actionType: "close_version",
          blockers: [
            { code: "LEGACY_WORK_REQUIRES_AUDIT", recordCount: 1 }
          ]
        },
        { actionType: "review_context", allowed: true }
      ]
    });
  });

  it("projects doc drift legacy risk without exposing openUndoCount", () => {
    const projected = sanitizeDocDriftForAgent({
      routeTruth: { openUndoCount: 2, statusRiskCodes: [] },
      warnings: [],
      summaryText:
        "Route truth shows 1 open todos, 2 open undos, and 3 pending proposals on the current route."
    });

    expect(projected).toMatchObject({
      routeTruth: {
        legacyBlockerCount: 2,
        statusRiskCodes: ["LEGACY_BLOCKERS_REQUIRE_AUDIT"]
      },
      legacyAudit: { required: true }
    });
    expect(projected.routeTruth).not.toHaveProperty("openUndoCount");
    expect(projected.summaryText).toBe(
      "Route truth shows 1 open todos and 3 pending proposals on the current route."
    );
  });
});
