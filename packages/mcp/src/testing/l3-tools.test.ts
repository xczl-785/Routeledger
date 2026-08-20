import { describe, expect, it, vi } from "vitest";

import {
  createL3AuthorizationTools,
  createL3OperationTools,
  createL3ProposalTools
} from "../capabilities/l3-tools.js";

const actor = { id: "agent", type: "agent" as const };
const approver = { id: "approver", type: "user" as const };

const createDependencies = () => ({
  service: {} as never,
  actor,
  approver,
  hostProfile: "generic" as const,
  initialBinding: {
    workspaceRoot: "C:/workspace",
    routeledgerRoot: "C:/workspace/project"
  },
  options: {},
  usesCodexNativeToolAdmission: false,
  digestAuthorizationPath: (value: string) => `digest:${value}`,
  digestRouteLedgerRoot: (value: string) => `digest:${value}`,
  appendDebugLog: async () => undefined
});

describe("L3 tool registrations", () => {
  it("preserves the three ordered L3 capability segments", () => {
    const dependencies = createDependencies();

    expect(
      createL3AuthorizationTools(dependencies).map((tool) => tool.definition.name)
    ).toEqual([
      "get_l3_authorization_status",
      "recommend_l3_authorization_profile"
    ]);
    expect(
      createL3ProposalTools(dependencies).map((tool) => tool.definition.name)
    ).toEqual([
      "recommend_l3_authorization_policy",
      "list_l3_proposals",
      "get_l3_proposal"
    ]);
    expect(
      createL3OperationTools(dependencies).map((tool) => tool.definition.name)
    ).toEqual([
      "propose_l3_operation",
      "execute_l3_operation",
      "execute_admitted_proposal",
      "approve_l3_operation",
      "commit_l3_operation",
      "reject_l3_operation"
    ]);
  });

  it("preserves high-risk metadata for exact authorization operations", () => {
    const tools = createL3OperationTools(createDependencies());

    expect(
      tools.find((tool) => tool.definition.name === "execute_l3_operation")
        ?.definition._meta.routeledger
    ).toMatchObject({
      riskLevel: "high-risk",
      destructive: true,
      recommendedApprovalMode: "approve"
    });
    expect(
      tools.find((tool) => tool.definition.name === "execute_admitted_proposal")
        ?.definition._meta.routeledger
    ).toMatchObject({
      riskLevel: "high-risk",
      destructive: true,
      recommendedApprovalMode: "approve"
    });
    expect(
      tools.find((tool) => tool.definition.name === "commit_l3_operation")
        ?.definition._meta.routeledger
    ).toMatchObject({
      riskLevel: "high-risk",
      destructive: true,
      recommendedApprovalMode: "approve"
    });
  });

  it("delegates proposal reads and writes with the registry actor", async () => {
    const listL3Proposals = vi.fn().mockResolvedValue([]);
    const proposeL3Operation = vi.fn().mockResolvedValue({ id: "proposal" });
    const dependencies = {
      ...createDependencies(),
      service: { listL3Proposals, proposeL3Operation } as never
    };

    await createL3ProposalTools(dependencies)
      .find((tool) => tool.definition.name === "list_l3_proposals")!
      .handler({ projectId: "project" });
    await createL3OperationTools(dependencies)
      .find((tool) => tool.definition.name === "propose_l3_operation")!
      .handler({
        projectId: "project",
        actionType: "start_version",
        targetId: "version",
        reason: "begin"
      });

    expect(listL3Proposals).toHaveBeenCalledWith("project");
    expect(proposeL3Operation).toHaveBeenCalledWith({
      projectId: "project",
      actionType: "start_version",
      targetId: "version",
      reason: "begin",
      payload: {},
      actor
    });
  });
});
