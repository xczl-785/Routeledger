import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRegistryPath,
  getMissionControlStatus,
  parseLauncherArgs,
  readRegistry,
  removeMissionControlProject,
  resolveBrowserOpenCommand,
  resolveMissionControlProjectPath,
  writeRegistry
} from "../server/launcher.js";

const tempRoots: string[] = [];

const createTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-ui-"));
  tempRoots.push(directory);
  return directory;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("@routeledger/ui launcher", () => {
  it("parses kebab-case launch flags and resolves roots", () => {
    const args = parseLauncherArgs([
      "--workspace-root",
      "ws",
      "--routeledger-root",
      "ws/docs",
      "--dev-build"
    ]);

    expect(args.workspaceRoot).toBe(path.resolve("ws"));
    expect(args.routeledgerRoot).toBe(path.resolve("ws/docs"));
    expect(args.devBuild).toBe(true);
  });

  it("rejects launch args that omit either root flag", () => {
    expect(() =>
      parseLauncherArgs(["--workspace-root", "ws"])
    ).toThrow(/workspace-root/i);
  });

  it("round-trips split Hub/project state and fails closed on malformed files", async () => {
    const root = createTempDir();
    const registryPath = path.join(root, "hub.json");

    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 3,
      hub: null,
      projects: []
    });

    await writeRegistry(registryPath, []);
    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 3,
      hub: null,
      projects: []
    });

    fs.writeFileSync(registryPath, "{not-json", "utf8");
    await expect(readRegistry(registryPath)).rejects.toThrow(/已保留原文件/);
  });

  it("migrates legacy per-project instances into the shared Hub registry", async () => {
    const root = createTempDir();
    const registryPath = path.join(root, "hub.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      instances: [
        {
          projectId: "project-a",
          workspaceRoot: path.join(root, "workspace-a"),
          routeledgerRoot: path.join(root, "workspace-a"),
          updatedAt: "2026-08-14T00:00:00.000Z"
        }
      ]
    }), "utf8");

    const migrated = await readRegistry(registryPath);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.hub).toBeNull();
    expect(migrated.projects).toHaveLength(1);
    expect(migrated.projects[0]).toMatchObject({
      projectId: "project-a",
      projectName: "workspace-a",
      lastOpenedAt: "2026-08-14T00:00:00.000Z"
    });
  });

  it("returns a stable default registry path on the user home", () => {
    const originalStateHome = process.env.XDG_STATE_HOME;

    try {
      delete process.env.XDG_STATE_HOME;
      expect(getRegistryPath()).toBe(
        path.join(os.homedir(), ".routeledger", "ui", "hub.json")
      );
    } finally {
      if (originalStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = originalStateHome;
      }
    }
  });

  it("resolves a workspace-relative dataDir without changing project files", () => {
    const workspaceRoot = createTempDir();
    const dataRoot = path.join(workspaceRoot, "route-data");
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".routeledger", "config.json"), JSON.stringify({ version: 1, dataDir: "route-data" }), "utf8");
    const projectPath = path.join(dataRoot, ".routeledger", "project.json");
    fs.writeFileSync(projectPath, "{}", "utf8");
    const before = fs.readFileSync(projectPath, "utf8");

    const expectedRoots = {
      workspaceRoot: fs.realpathSync.native(workspaceRoot),
      routeledgerRoot: fs.realpathSync.native(dataRoot)
    };
    const expectSamePhysicalRoots = (actual: typeof expectedRoots) => {
      expect(fs.realpathSync.native(actual.workspaceRoot)).toBe(expectedRoots.workspaceRoot);
      expect(fs.realpathSync.native(actual.routeledgerRoot)).toBe(expectedRoots.routeledgerRoot);
    };

    expectSamePhysicalRoots(resolveMissionControlProjectPath(workspaceRoot));
    expectSamePhysicalRoots(resolveMissionControlProjectPath(dataRoot));
    expect(fs.readFileSync(projectPath, "utf8")).toBe(before);
  });

  it("canonicalizes symlink spellings to the same project roots", () => {
    if (process.platform === "win32") return;
    const workspaceRoot = createTempDir();
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".routeledger", "config.json"), JSON.stringify({ version: 1, dataDir: "." }), "utf8");
    fs.writeFileSync(path.join(workspaceRoot, ".routeledger", "project.json"), "{}", "utf8");
    const parent = createTempDir();
    const linkedRoot = path.join(parent, "linked-workspace");
    fs.symlinkSync(workspaceRoot, linkedRoot, "dir");

    expect(resolveMissionControlProjectPath(linkedRoot)).toEqual(resolveMissionControlProjectPath(workspaceRoot));
  });

  it("removes only the UI registry bookmark", async () => {
    const root = createTempDir();
    const registryPath = path.join(root, "hub.json");
    await writeRegistry(registryPath, [{
      id: "project-a",
      projectId: "canonical-a",
      projectName: "Project A",
      workspaceRoot: root,
      routeledgerRoot: root,
      addedAt: "2026-08-14T00:00:00.000Z",
      lastOpenedAt: "2026-08-14T00:00:00.000Z"
    }]);

    await expect(removeMissionControlProject("project-a", registryPath)).resolves.toMatchObject({ removed: true });
    expect((await readRegistry(registryPath)).projects).toEqual([]);
    await expect(removeMissionControlProject("project-a", registryPath)).resolves.toMatchObject({ removed: false });
  });

  it("reports physical project registration, runtime compatibility, and an authenticated access URL", async () => {
    const root = createTempDir();
    const registryPath = path.join(root, "hub.json");
    const runtimeIdentity = {
      runtimePackageVersion: "0.9.2",
      runtimeProfile: "json-only",
      artifactKind: "plugin",
      pluginVersion: "0.9.2",
      runtimePayloadDigest: "payload-1"
    };
    const hub = {
      id: "hub-1",
      pid: 123,
      port: 3210,
      url: "http://127.0.0.1:3210",
      startedAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      protocolVersion: 1,
      runtimeIdentity,
      accessToken: "secret-token"
    };
    await writeRegistry(registryPath, {
      schemaVersion: 3,
      hub,
      projects: [{
        id: "project-a",
        projectId: "canonical-a",
        projectName: "Project A",
        workspaceRoot: root,
        routeledgerRoot: root,
        addedAt: "2026-08-15T00:00:00.000Z",
        lastOpenedAt: "2026-08-15T00:00:00.000Z"
      }]
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
        ok: true,
        instanceId: hub.id,
        pid: hub.pid,
        projectCount: 1,
        startedAt: hub.startedAt,
        lastActivityAt: hub.updatedAt,
        protocolVersion: hub.protocolVersion,
        runtimeIdentity
      }), { status: 200 }));

    const status = await getMissionControlStatus({
      workspaceRoot: root,
      routeledgerRoot: root,
      registryPath,
      expectedRuntimeIdentity: runtimeIdentity
    });
    expect(status).toMatchObject({
      healthy: true,
      runtimeCompatible: true,
      projectId: "canonical-a",
      matchingProject: { id: "project-a" },
      accessUrl: "http://127.0.0.1:3210/?project=project-a#token=secret-token"
    });
    expect(status.hub).not.toHaveProperty("accessToken");

    const unregisteredRoot = createTempDir();
    await expect(getMissionControlStatus({
      workspaceRoot: unregisteredRoot,
      routeledgerRoot: unregisteredRoot,
      registryPath,
      expectedRuntimeIdentity: runtimeIdentity
    })).resolves.toMatchObject({
      healthy: true,
      runtimeCompatible: true,
      projectId: null,
      matchingProject: null,
      accessUrl: null
    });

    await expect(getMissionControlStatus({
      workspaceRoot: root,
      routeledgerRoot: root,
      registryPath,
      expectedRuntimeIdentity: { ...runtimeIdentity, runtimePayloadDigest: "payload-2" }
    })).resolves.toMatchObject({
      healthy: true,
      runtimeCompatible: false,
      accessUrl: null
    });
  });

  it("uses native browser launch commands without shell interpolation", () => {
    const url = "http://127.0.0.1:1234/?project=a#token=b";
    expect(resolveBrowserOpenCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(resolveBrowserOpenCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(resolveBrowserOpenCommand(url, "win32")).toEqual({ command: "cmd", args: ["/d", "/s", "/c", "start", "", url] });
  });
});
