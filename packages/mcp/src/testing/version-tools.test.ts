import { describe, expect, it, vi } from "vitest";

import {
  createVersionMutationTools,
  createVersionWorkflowTools
} from "../capabilities/version-tools.js";

const actor = { id: "agent", type: "agent" as const };

describe("version tool registrations", () => {
  it("preserves the two ordered version capability segments", () => {
    const dependencies = {
      service: {} as never,
      actor,
      appendDebugLog: async () => undefined
    };

    const workflowTools = createVersionWorkflowTools(dependencies);
    const mutationTools = createVersionMutationTools(dependencies);

    expect(workflowTools.map((tool) => tool.definition.name)).toEqual([
      "batch_create_versions",
      "transition_version",
      "advance_to_version",
      "close_version",
      "shutdown_version"
    ]);
    expect(mutationTools.map((tool) => tool.definition.name)).toEqual([
      "prepare_version",
      "mark_version_complete",
      "create_version",
      "insert_version",
      "create_child_version",
      "reorder_versions"
    ]);
    expect(
      workflowTools.find((tool) => tool.definition.name === "shutdown_version")
        ?.definition._meta.routeledger.riskLevel
    ).toBe("high-risk");
  });

  it("delegates one workflow and one mutation handler with the registry actor", async () => {
    const transitionVersion = vi.fn().mockResolvedValue({ status: "ready" });
    const prepareVersion = vi.fn().mockResolvedValue({ state: "ready" });
    const dependencies = {
      service: { transitionVersion, prepareVersion } as never,
      actor,
      appendDebugLog: async () => undefined
    };
    const workflowTools = createVersionWorkflowTools(dependencies);
    const mutationTools = createVersionMutationTools(dependencies);

    await workflowTools
      .find((tool) => tool.definition.name === "transition_version")!
      .handler({ projectId: "project", versionId: "version", mode: "dry_run" });
    await mutationTools
      .find((tool) => tool.definition.name === "prepare_version")!
      .handler({ projectId: "project", versionId: "version" });

    expect(transitionVersion).toHaveBeenCalledWith({
      projectId: "project",
      versionId: "version",
      mode: "dry_run",
      reason: undefined,
      actor
    });
    expect(prepareVersion).toHaveBeenCalledWith({
      projectId: "project",
      versionId: "version",
      actor
    });
  });
});
