import { describe, expect, it, vi } from "vitest";

import { createMissionControlTools } from "../capabilities/mission-control-tools.js";

describe("Mission Control tool registrations", () => {
  it("exposes portable UI Hub tools and delegates through the runtime seam", async () => {
    const runtimeIdentity = {
      runtimePackageVersion: "0.10.0",
      runtimeProfile: "json-only",
      artifactKind: "plugin",
      pluginVersion: "0.10.0",
      runtimePayloadDigest: "digest-1"
    };
    const readBinding = vi.fn(() => ({ marker: "binding" }));
    const resolveRoots = vi.fn(() => ({
      workspaceRoot: "C:/workspace",
      routeledgerRoot: "C:/workspace/ledger"
    }));
    const openMissionControlSource = vi.fn(async () => ({
      url: "http://127.0.0.1:3210",
      projectKey: "project-key-1",
      projectId: "project-1",
      pid: 123,
      port: 3210,
      reused: false,
      registryPath: "C:/registry.json",
      workspaceRoot: "C:/workspace",
      routeledgerRoot: "C:/workspace/ledger",
      browserOpened: true,
      browserError: null,
      runtimeIdentity
    }));
    const getMissionControlStatus = vi.fn(async () => ({
      registryPath: "C:/registry.json",
      projectId: null,
      hub: null,
      healthy: false,
      projects: [],
      matchingProject: null
    }));
    const stopMissionControlHub = vi.fn(async () => ({
      registryPath: "C:/registry.json",
      stopped: true,
      pid: 123
    }));
    const loadSourceModule = vi.fn(async () => ({
      openMissionControlSource,
      getMissionControlStatus,
      stopMissionControlHub
    }));
    const withCurrentRuntimeContextMeta = vi.fn(({ data }) => ({
      runtimeContext: data
    }));

    const tools = createMissionControlTools({
      readBinding,
      resolveRoots,
      loadSourceModule,
      runtimeIdentity,
      withCurrentRuntimeContextMeta
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "open_mission_control",
      "get_mission_control_status",
      "stop_mission_control"
    ]);
    expect(tools.every((tool) => tool.visibility === "default")).toBe(true);

    const open = await tools[0]!.handler({ devBuild: true });
    expect(openMissionControlSource).toHaveBeenCalledWith({
      workspaceRoot: "C:/workspace",
      routeledgerRoot: "C:/workspace/ledger",
      devBuild: true,
      openBrowser: true,
      runtimeIdentity
    });
    expect(open.meta).toEqual({ runtimeContext: { project: { id: "project-1" } } });

    const status = await tools[1]!.handler({});
    expect(getMissionControlStatus).toHaveBeenCalledWith({
      workspaceRoot: "C:/workspace",
      routeledgerRoot: "C:/workspace/ledger"
    });
    expect(status.meta).toEqual({ runtimeContext: { project: null } });
    const stop = await tools[2]!.handler({});
    expect(stopMissionControlHub).toHaveBeenCalledTimes(1);
    expect(stop.meta).toEqual({ runtimeContext: null });
    expect(readBinding).toHaveBeenCalledTimes(2);
    expect(resolveRoots).toHaveBeenCalledTimes(2);
    expect(loadSourceModule).toHaveBeenCalledTimes(3);
  });
});
