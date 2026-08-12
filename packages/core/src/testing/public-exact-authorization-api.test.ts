import { describe, expect, it } from "vitest";

import * as core from "../index.js";

describe("public exact authorization API", () => {
  it("does not export the reusable grant kernel", () => {
    for (const removed of [
      "L3AuthorizationScope",
      "L3AuthorizationGrantStore",
      "MemoryL3AuthorizationGrantStore"
    ]) {
      expect(core).not.toHaveProperty(removed);
    }
    expect(core).toHaveProperty("MemoryExactAuthorizationStore");
    expect(core).toHaveProperty("GENERIC_EXACT_DECISION_INPUT_SCHEMA");
  });
});
