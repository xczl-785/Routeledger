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
      "preflight_or_propose_version_batch",
      "preview_or_propose_version_transition",
      "propose_version_advance",
      "preview_or_propose_version_close",
      "preview_or_propose_forced_version_shutdown"
    ]);
    expect(mutationTools.map((tool) => tool.definition.name)).toEqual([
      "prepare_version",
      "mark_version_complete",
      "propose_version_creation",
      "propose_version_insertion",
      "propose_child_version_creation",
      "propose_version_reorder"
    ]);
    expect(
      workflowTools.find(
        (tool) => tool.definition.name === "preview_or_propose_forced_version_shutdown"
      )
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
      .find(
        (tool) => tool.definition.name === "preview_or_propose_version_transition"
      )!
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
