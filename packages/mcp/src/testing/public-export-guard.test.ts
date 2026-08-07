import { describe, expect, it } from "vitest";

import * as mcp from "../index.js";

describe("@routeledger/mcp public export surface", () => {
  it("does not leak registry test fixtures or helpers", () => {
    for (const leakedName of [
      "createRouteLedgerMcpTestServer",
      "createMockStorageAdapter",
      "TestActor",
      "buildMcpTestContext"
    ]) {
      expect(mcp).not.toHaveProperty(leakedName);
    }
  });

  it("keeps runtime profile constants and the public registry factory exported", () => {
    expect(typeof mcp.createRouteLedgerMcpRegistry).toBe("function");
    expect(mcp.MCP_PROTOCOL_VERSION).toBe("2025-11-25");
  });
});
