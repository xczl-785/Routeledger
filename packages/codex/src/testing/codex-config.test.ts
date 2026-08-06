import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexProjectConfigError,
  planCodexProjectConfigWrite,
  renderCodexGlobalConfig,
  renderCodexProjectConfig,
  writeCodexProjectConfig
} from "../index.js";

const tempDirs: string[] = [];

const createTempDir = async (prefix: string): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MCP_PROTOCOL_VERSION = "2025-11-25";

const extractArgsBlock = (config: string): string => {
  const marker = "args = [\n";
  const start = config.indexOf(marker);

  if (start === -1) {
    throw new Error("args block missing from rendered config");
  }

  const end = config.indexOf("\n]", start);

  if (end === -1) {
    throw new Error("args block terminator missing from rendered config");
  }

  return config.slice(start + marker.length, end);
};

const extractQuotedTomlValue = (config: string, key: string): string => {
  const line = config
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key} = `));

  if (line === undefined) {
    throw new Error(`${key} line missing from rendered config`);
  }

  return JSON.parse(line.slice(`${key} = `.length));
};

const extractCommandShape = (
  config: string
): { command: string; args: string[]; cwd: string } => ({
  command: extractQuotedTomlValue(config, "command"),
  args: extractArgsBlock(config)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line.replace(/,$/u, ""))),
  cwd: extractQuotedTomlValue(config, "cwd")
});

const runRuntimeContextSmoke = async (config: string) => {
  const commandShape = extractCommandShape(config);
  const child = spawn(commandShape.command, commandShape.args, {
    cwd: commandShape.cwd
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "vitest",
          version: "0.0.0"
        }
      }
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "runtime-context",
      method: "tools/call",
      params: {
        name: "get_runtime_context",
        arguments: {}
      }
    })}\n`
  );
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();

  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdoutLines:
      stdout.length === 0
        ? []
        : stdout
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("@routeledger/codex", () => {
  it("renders a workspace-backed project config with explicit workspaceRoot/routeledgerRoot and repo cwd", () => {
    const config = renderCodexProjectConfig({
      workspaceRoot: "/projects/alpha",
      routeledgerRoot: "/projects/alpha/docs",
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(config).toContain('[mcp_servers.routeledger]');
    expect(config).toContain('command = "pnpm"');
    expect(config).toContain('cwd = "/tools/RouteLedger"');
    expect(config).toContain('"--workspace-root"');
    expect(config).toContain('"/projects/alpha"');
    expect(config).toContain('"--routeledger-root"');
    expect(config).toContain('"/projects/alpha/docs"');
    expect(config).toContain('"--profile"');
    expect(config).toContain('"codex"');
    expect(config).toContain('"--actor-id"');
    expect(config).toContain('"codex-agent"');
    expect(config).not.toContain('cwd = "/projects/alpha"');
    expect(config).toContain(
      "[mcp_servers.routeledger.tools.get_runtime_context]\napproval_mode = \"auto\""
    );
    expect(config).toContain(
      "[mcp_servers.routeledger.tools.discover_routeledger_roots]\napproval_mode = \"auto\""
    );
  });

  it("renders an agent-neutral global config without project binding flags", () => {
    const config = renderCodexGlobalConfig({
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(config).toContain("# Agent-neutral global RouteLedger MCP entry.");
    expect(config).toContain('command = "pnpm"');
    expect(config).toContain('cwd = "/tools/RouteLedger"');
    expect(config).not.toContain('"--workspace-root"');
    expect(config).not.toContain('"--routeledger-root"');
    expect(config).toContain('"--profile"');
  });

  it("renders different project roots without falling back to cwd", () => {
    const alpha = renderCodexProjectConfig({
      workspaceRoot: "/projects/alpha",
      routeledgerRoot: "/projects/alpha/docs",
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });
    const beta = renderCodexProjectConfig({
      workspaceRoot: "/projects/beta",
      routeledgerRoot: "/projects/beta/docs",
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(alpha).toContain('"/projects/alpha"');
    expect(beta).toContain('"/projects/beta"');
    expect(alpha).not.toEqual(beta);
    expect(alpha).toContain('cwd = "/tools/RouteLedger"');
    expect(beta).toContain('cwd = "/tools/RouteLedger"');
  });

  it("keeps workspace cwd and managed project --project-root on distinct paths", () => {
    const routeLedgerWorkspaceRoot = "/tools/RouteLedger";
    const workspaceRoot = "/projects/customer-alpha";
    const routeledgerRoot = "/projects/customer-alpha/docs";
    const config = renderCodexProjectConfig({
      workspaceRoot,
      routeledgerRoot,
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot
      }
    });
    const argsBlock = extractArgsBlock(config);

    expect(config).toContain(`cwd = "${routeLedgerWorkspaceRoot}"`);
    expect(argsBlock).toContain('"--workspace-root"');
    expect(argsBlock).toContain(`"${workspaceRoot}"`);
    expect(argsBlock).toContain('"--routeledger-root"');
    expect(argsBlock).toContain(`"${routeledgerRoot}"`);
    expect(argsBlock).not.toContain(`"${routeLedgerWorkspaceRoot}"`);
    expect(config).not.toContain(`cwd = "${workspaceRoot}"`);
  });

  it("renders an installed-package config with explicit node bin and install cwd", () => {
    const config = renderCodexProjectConfig({
      workspaceRoot: "/projects/alpha",
      routeledgerRoot: "/projects/alpha",
      source: {
        kind: "installed-package",
        installRoot: "/tools/routeledger-mcp-tools",
        binPath: "/tools/routeledger-mcp-tools/node_modules/@routeledger/mcp/bin.js"
      },
      serverName: "routeledger_alpha"
    });

    expect(config).toContain('[mcp_servers.routeledger_alpha]');
    expect(config).toContain('command = "node"');
    expect(config).toContain(
      '"/tools/routeledger-mcp-tools/node_modules/@routeledger/mcp/bin.js"'
    );
    expect(config).toContain('cwd = "/tools/routeledger-mcp-tools"');
    expect(config).toContain('"/projects/alpha"');
  });

  it("rejects relative project roots", () => {
    expect(() =>
      renderCodexProjectConfig({
        workspaceRoot: "./relative-project",
        routeledgerRoot: "./relative-project",
        source: {
          kind: "workspace",
          routeLedgerWorkspaceRoot: "/tools/RouteLedger"
        }
      })
    ).toThrowError(CodexProjectConfigError);

    expect(() =>
      renderCodexProjectConfig({
        workspaceRoot: "./relative-project",
        routeledgerRoot: "./relative-project",
        source: {
          kind: "workspace",
          routeLedgerWorkspaceRoot: "/tools/RouteLedger"
        }
      })
    ).toThrow(/absolute path/i);
  });

  it("safe-writes a fragment when .codex/config.toml already exists", async () => {
    const workspaceRoot = await createTempDir(
      "routeledger-codex-config-existing-"
    );
    const codexDir = path.join(workspaceRoot, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    const existingConfigPath = path.join(codexDir, "config.toml");
    await fs.writeFile(existingConfigPath, 'existing = "keep-me"\n', "utf8");

    const result = await writeCodexProjectConfig({
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(result.kind).toBe("fragment");
    expect(result.path).toBe(path.join(codexDir, "routeledger.fragment.toml"));
    expect(result.warnings[0]).toContain(".codex/config.toml");
    expect(await fs.readFile(existingConfigPath, "utf8")).toBe(
      'existing = "keep-me"\n'
    );
    expect(await fs.readFile(result.path, "utf8")).toContain(
      `"${workspaceRoot}"`
    );
  });

  it("writes .codex/config.toml when the project has no existing Codex config", async () => {
    const workspaceRoot = await createTempDir(
      "routeledger-codex-config-new-"
    );

    const result = await writeCodexProjectConfig({
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(result.kind).toBe("project-config");
    expect(result.path).toBe(
      path.join(workspaceRoot, ".codex", "config.toml")
    );
    expect(await fs.readFile(result.path, "utf8")).toBe(result.content);
  });

  it("plans a fragment write without touching an existing Codex config", async () => {
    const workspaceRoot = await createTempDir(
      "routeledger-codex-config-plan-existing-"
    );
    const codexDir = path.join(workspaceRoot, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    const existingConfigPath = path.join(codexDir, "config.toml");
    await fs.writeFile(existingConfigPath, 'existing = "keep-me"\n', "utf8");

    const result = await planCodexProjectConfigWrite({
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: "/tools/RouteLedger"
      }
    });

    expect(result.kind).toBe("fragment");
    expect(result.path).toBe(path.join(codexDir, "routeledger.fragment.toml"));
    expect(result.warnings[0]).toContain(".codex/config.toml");
    expect(await fs.readFile(existingConfigPath, "utf8")).toBe(
      'existing = "keep-me"\n'
    );
  });

  it("writeCodexProjectConfig emits split-root flags that boot an MCP runtime with the same binding", async () => {
    const workspaceRoot = await createTempDir(
      "routeledger-codex-config-split-root-"
    );
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    await fs.mkdir(routeledgerRoot, { recursive: true });

    const result = await writeCodexProjectConfig({
      workspaceRoot,
      routeledgerRoot,
      source: {
        kind: "workspace",
        routeLedgerWorkspaceRoot: repoRoot
      }
    });

    expect(result.content).toContain('"--workspace-root"');
    expect(result.content).toContain(`"${workspaceRoot}"`);
    expect(result.content).toContain('"--routeledger-root"');
    expect(result.content).toContain(`"${routeledgerRoot}"`);

    const smoke = await runRuntimeContextSmoke(result.content);

    expect(smoke.stderr).toBe("");
    expect(smoke.exitCode).toBe(0);
    expect(smoke.stdoutLines).toHaveLength(2);
    expect(smoke.stdoutLines[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "initialize",
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION
      }
    });
    expect(smoke.stdoutLines[1]).toMatchObject({
      jsonrpc: "2.0",
      id: "runtime-context",
      result: {
        structuredContent: {
          data: {
            binding: {
              status: "uninitialized",
              workspaceRoot,
              routeledgerRoot,
              workspaceConfigPath: path.join(workspaceRoot, ".routeledger", "config.json"),
              dataRoot: routeledgerRoot,
              routeledgerDir: path.join(routeledgerRoot, ".routeledger")
            },
            processCwd: path.join(repoRoot, "packages", "mcp"),
            storage: {
              mode: "uninitialized",
              dataRoot: routeledgerRoot,
              jsonProjectPath: path.join(routeledgerRoot, ".routeledger", "project.json"),
              sqliteDbPath: path.join(
                routeledgerRoot,
                ".routeledger",
                "db",
                "routeledger.sqlite3"
              )
            }
          }
        }
      }
    });
  });
});
