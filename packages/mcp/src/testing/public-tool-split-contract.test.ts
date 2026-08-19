import { describe, expect, it } from "vitest";

import {
  cleanupProjectRoot,
  createTempProjectRoot,
  initializeServer,
  type ToolListResult
} from "./mcp-test-helpers.js";

describe("public split tool surface", () => {
  it("publishes focused inspect/proposal tools while preserving one high-risk executor", async () => {
    const projectRoot = createTempProjectRoot();
    const server = await initializeServer(projectRoot);

    try {
      const response = await server.handleMessage({
        jsonrpc: "2.0",
        id: "split-tool-surface",
        method: "tools/list",
        params: {}
      });
      const tools = (response as ToolListResult).result.tools;
      const names = tools.map((tool) => tool.name);
      const byRisk = (riskLevel: string) =>
        tools
          .filter((tool) => tool._meta.routeledger.riskLevel === riskLevel)
          .map((tool) => tool.name)
          .sort();

      expect(names).toEqual(
        expect.arrayContaining([
          "inspect_route_progress",
          "inspect_versions",
          "inspect_l3_route_operations",
          "propose_version_lifecycle_change",
          "propose_version_structure_change",
          "propose_l3_route_change",
          "execute_route_change"
        ])
      );
      expect(names).not.toContain("inspect_route");
      expect(names).not.toContain("propose_route_change");
      expect(byRisk("high-risk")).toEqual(["execute_route_change"]);
      expect(byRisk("read-only")).toEqual(
        expect.arrayContaining([
          "inspect_runtime",
          "inspect_route_progress",
          "inspect_versions",
          "inspect_l3_route_operations"
        ])
      );
      expect(byRisk("write")).toEqual(
        expect.arrayContaining([
          "propose_version_lifecycle_change",
          "propose_version_structure_change",
          "propose_l3_route_change"
        ])
      );
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
