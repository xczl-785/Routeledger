import { describe, expect, it } from "vitest";

import * as json from "../index.js";

describe("@routeledger/json public export surface", () => {
  it("does not leak test fixtures or builder helpers", () => {
    for (const leakedName of [
      "createJsonCodecSnapshot",
      "createJsonValidateSnapshot",
      "buildTestProjectAggregate",
      "MockRouteLedgerJsonFilesystem"
    ]) {
      expect(json).not.toHaveProperty(leakedName);
    }
  });

  it("exposes only the explicit filesystem test hook as a documented backdoor", () => {
    expect(typeof json.setRouteLedgerJsonFilesystemTestHooks).toBe("function");
    expect(typeof json.RouteLedgerJsonWriteError).toBe("function");
  });
});
