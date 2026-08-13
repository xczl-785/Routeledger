import { describe, expect, it } from "vitest";

import { residualAuditInputSchema } from "../registry/route-input-schemas.js";

describe("shared route input schemas", () => {
  it("preserves reviewed, legacy-array, and null residual audit variants", () => {
    expect(residualAuditInputSchema).toMatchObject({
      anyOf: [
        {
          type: "object",
          required: ["status", "items"],
          properties: {
            status: { type: "string", enum: ["reviewed"] },
            items: { type: "array" }
          }
        },
        { type: "array" },
        { type: "null" }
      ]
    });
  });
});
