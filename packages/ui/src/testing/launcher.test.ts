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
    const registryPath = path.join(root, "instances.json");

    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 1,
      instances: []
    });

    await writeRegistry(registryPath, []);
    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 1,
      instances: []
    });

    fs.writeFileSync(registryPath, "{not-json", "utf8");
    expect(await readRegistry(registryPath)).toEqual({
      schemaVersion: 1,
      instances: []
    });
  });

  it("returns a stable default registry path on the user home", () => {
    const originalStateHome = process.env.XDG_STATE_HOME;

    try {
      delete process.env.XDG_STATE_HOME;
      expect(getRegistryPath()).toBe(
        path.join(os.homedir(), ".routeledger", "ui", "instances.json")
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
