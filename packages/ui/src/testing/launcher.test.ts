import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getRegistryPath,
  parseLauncherArgs,
  readRegistry,
  writeRegistry
} from "../server/launcher.js";

const tempRoots: string[] = [];

const createTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-ui-"));
  tempRoots.push(directory);
  return directory;
};

afterEach(() => {
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

  it("round-trips an empty registry and tolerates malformed files", async () => {
    const root = createTempDir();
    const registryPath = path.join(root, "hub.json");

    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 2,
      hub: null,
      projects: []
    });

    await writeRegistry(registryPath, []);
    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 2,
      hub: null,
      projects: []
    });

    fs.writeFileSync(registryPath, "{not-json", "utf8");
    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 2,
      hub: null,
      projects: []
    });
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
    expect(migrated.schemaVersion).toBe(2);
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
});
