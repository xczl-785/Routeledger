import { spawn, type ChildProcessByStdio } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { readRegistry } from "../server/launcher.js";

const tempRoots: string[] = [];
const testFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFilePath), "../../../..");
const uiCliPath = path.join(repoRoot, "packages", "ui", "src", "server", "cli.ts");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const canonicalFixtureRoot = path.join(repoRoot, "packages", "json", "src", "testing", "fixtures", "canonical");

type CliProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }>;
};

const createTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-ui-process-"));
  tempRoots.push(directory);
  return directory;
};

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async <T>(description: string, getValue: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getValue();
    if (value !== null) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

const runUiCli = (args: string[], environment: NodeJS.ProcessEnv): CliProcess => {
  const child = spawn(process.execPath, [tsxCliPath, uiCliPath, ...args], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
  return { child, result };
};

const stopProcess = async (cliProcess: CliProcess): Promise<void> => {
  if (cliProcess.child.exitCode !== null) return;
  cliProcess.child.kill();
  await Promise.race([cliProcess.result.then(() => undefined), delay(5_000)]);
  if (cliProcess.child.exitCode === null) {
    cliProcess.child.kill("SIGKILL");
    await cliProcess.result;
  }
};

const createCanonicalProject = (stateHome: string): { routeledgerRoot: string; workspaceRoot: string } => {
  const workspaceRoot = path.join(stateHome, "workspace");
  const routeledgerRoot = path.join(workspaceRoot, "routeledger-data");
  fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
  fs.cpSync(path.join(canonicalFixtureRoot, ".routeledger"), path.join(routeledgerRoot, ".routeledger"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, ".routeledger", "config.json"),
    JSON.stringify({ version: 1, dataDir: "routeledger-data" }),
    "utf8"
  );
  return { workspaceRoot, routeledgerRoot };
};

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("@routeledger/ui process boundary", () => {
  it("runs an authenticated headless Hub lifecycle and clears its isolated registry", async () => {
    const stateHome = createTempDir();
    const { workspaceRoot, routeledgerRoot } = createCanonicalProject(stateHome);
    const registryPath = path.join(stateHome, "routeledger", "ui", "hub.json");
    const environment = { ...process.env, XDG_STATE_HOME: stateHome };
    const cliProcess = runUiCli([
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--routeledger-root",
      routeledgerRoot,
      "--dev-build"
    ], environment);

    try {
      const registry = await waitFor("Hub registry", async () => {
        const candidate = await readRegistry(registryPath);
        return candidate.hub === null ? null : candidate;
      });
      const hub = registry.hub!;

      expect((await fetch(`${hub.url}/api/health`)).status).toBe(403);
      expect((await fetch(`${hub.url}/api/health`, {
        headers: { "x-routeledger-ui-token": "incorrect-token" }
      })).status).toBe(403);

      const healthResponse = await fetch(`${hub.url}/api/health`, {
        headers: { "x-routeledger-ui-token": hub.accessToken }
      });
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toMatchObject({
        ok: true,
        instanceId: hub.id,
        pid: hub.pid,
        runtimeIdentity: hub.runtimeIdentity
      });

      const shutdownResponse = await fetch(`${hub.url}/api/shutdown`, {
        method: "POST",
        headers: {
          "x-routeledger-ui-client": "1",
          "x-routeledger-ui-token": hub.accessToken
        }
      });
      expect(shutdownResponse.status).toBe(202);
      await expect(cliProcess.result).resolves.toMatchObject({ code: 0, signal: null });
      await waitFor("cleared Hub registry", async () => (await readRegistry(registryPath)).hub === null ? true : null);
    } finally {
      await stopProcess(cliProcess);
    }
  }, 30_000);

  it("reports a missing isolated Hub through the real status CLI", async () => {
    const stateHome = createTempDir();
    const cliProcess = runUiCli(["status"], { ...process.env, XDG_STATE_HOME: stateHome });
    const result = await cliProcess.result;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      hub: null,
      healthy: false,
      projects: []
    });
  });
});
