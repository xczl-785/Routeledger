import { describe, expect, it } from "vitest";

import {
  APPROVE_APPROVAL_TOOLS,
  AUTO_APPROVAL_TOOLS,
  PROMPT_APPROVAL_TOOLS
} from "@routeledger/codex";
import {
  createRouteLedgerMcpRegistry,
  type ToolDefinition
} from "../index.js";

const buildToolApprovalMap = (): Map<string, string> => {
  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot: "C:/routeledger/workspace",
    routeledgerRoot: "C:/routeledger/workspace"
  });
  const map = new Map<string, string>();
  const collect = (tools: readonly ToolDefinition[]): void => {
    for (const tool of tools) {
      map.set(tool.name, tool._meta.routeledger.recommendedApprovalMode);
    }
  };
  collect(registry.tools);
  registry.close();
  return map;
};

describe("@routeledger/codex approval list vs MCP registry", () => {
  const approvalByTool = buildToolApprovalMap();
  const expectedAutoTools = [
    "inspect_runtime",
    "inspect_route_progress",
    "inspect_versions",
    "inspect_l3_route_operations"
  ];
  const expectedPromptTools = [
    "configure_binding",
    "configure_project",
    "manage_todo",
    "manage_deferred",
    "manage_constraint",
    "propose_version_lifecycle_change",
    "propose_version_structure_change",
    "propose_l3_route_change",
    "set_version_state",
    "manage_mission_control"
  ];
  const expectedApproveTools = ["execute_route_change"];

  it("renders auto approval only for read-only MCP tools", () => {
    expect([...AUTO_APPROVAL_TOOLS]).toEqual(expectedAutoTools);
    for (const toolName of AUTO_APPROVAL_TOOLS) {
      expect(approvalByTool.has(toolName), `unknown tool ${toolName}`).toBe(true);
      expect(approvalByTool.get(toolName), `${toolName} is not auto`).toBe("auto");
    }
  });

  it("renders prompt approval only for write MCP tools", () => {
    expect([...PROMPT_APPROVAL_TOOLS]).toEqual(expectedPromptTools);
    for (const toolName of PROMPT_APPROVAL_TOOLS) {
      expect(approvalByTool.has(toolName), `unknown tool ${toolName}`).toBe(true);
      expect(approvalByTool.get(toolName), `${toolName} is not prompt`).toBe("prompt");
    }
  });

  it("renders explicit approve only for high-risk MCP tools", () => {
    expect([...APPROVE_APPROVAL_TOOLS]).toEqual(expectedApproveTools);
    for (const toolName of APPROVE_APPROVAL_TOOLS) {
      expect(approvalByTool.has(toolName), `unknown tool ${toolName}`).toBe(true);
      expect(approvalByTool.get(toolName), `${toolName} is not approve`).toBe("approve");
    }
  });

  it("covers every registered tool so the codex list cannot drift", () => {
    const covered = new Set<string>([
      ...AUTO_APPROVAL_TOOLS,
      ...PROMPT_APPROVAL_TOOLS,
      ...APPROVE_APPROVAL_TOOLS
    ]);

    for (const [toolName] of approvalByTool) {
      expect(covered.has(toolName), `${toolName} not in codex approval lists`).toBe(true);
    }
  });
});
