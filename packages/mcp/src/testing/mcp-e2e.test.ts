import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it, describe } from "vitest";

import { MemoryExactAuthorizationStore } from "@routeledger/core";
import { runCli } from "../../../cli/src/index.js";
import { MCP_PROTOCOL_VERSION, createRouteLedgerMcpRegistry } from "../index.js";
import { type JsonRpcResponse } from "../stdio-server.js";

import { createTempProjectRoot, getDefaultDataRoot, getDefaultWorkspaceConfigPath, getDefaultCanonicalJsonRoot, getDefaultJsonProjectPath, getDefaultSqliteDbPath, createRegistry, cleanupProjectRoot, initializeServer, type ToolListResult } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("CLI/MCP same scenario still reaches the same final RouteLedger state", async () => {
    const cliRoot = createTempProjectRoot();
    const mcpRoot = createTempProjectRoot();

    const cliExactStore = new MemoryExactAuthorizationStore();

    const runCliJson = async (projectRoot: string, argv: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli({
        argv,
        projectRoot,
        l3Authorization: {
          requestAuthorization: async (proposal) => ({
            approved: true,
            decisionId: `mcp-e2e-${proposal.id}`
          }),

          exactStore: cliExactStore,
          hostKind: "mcp-e2e",
          clientId: "vitest"
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      });

      return {
        exitCode,
        stdoutJson: stdout.length === 0 ? null : JSON.parse(stdout.at(-1)!),
        stderrJson: stderr.length === 0 ? null : JSON.parse(stderr.at(-1)!)
      };
    };

    try {
      const cliInit = await runCliJson(cliRoot, [
        "init_project",
        "--name",
        "RouteLedger",
        "--content-locale",
        "en",
        "--first-version",
        JSON.stringify({
          title: "Initial Version",
          description: "Project bootstrap version",
          initialTodos: []
        })
      ]);
      const cliProjectId = cliInit.stdoutJson.data.project.id as string;
      const cliVersionId = cliInit.stdoutJson.data.firstVersion!.id as string;
      await runCliJson(cliRoot, [
        "version",
        "prepare",
        "--project-id",
        cliProjectId,
        "--version-id",
        cliVersionId
      ]);
      const cliBareStart = await runCliJson(cliRoot, [
        "version",
        "start",
        "--project-id",
        cliProjectId,
        "--version-id",
        cliVersionId
      ]);
      const cliPendingOperationId = cliBareStart.stderrJson.error.details.pendingOperationId as string;
      const cliApprove = await runCliJson(cliRoot, [
        "l3",
        "approve",
        "--project-id",
        cliProjectId,
        "--pending-operation-id",
        cliPendingOperationId
      ]);
      const cliCommit = await runCliJson(cliRoot, [
        "l3",
        "commit",
        "--project-id",
        cliProjectId,
        "--pending-operation-id",
        cliPendingOperationId,
        "--approval-artifact-id",
        cliApprove.stdoutJson.data.artifactId
      ]);
      expect(cliCommit.exitCode, JSON.stringify(cliCommit.stderrJson)).toBe(0);
      const cliContext = await runCliJson(cliRoot, [
        "context",
        "--json",
        "--project-id",
        cliProjectId
      ]);

      const registry = createRegistry(mcpRoot);
      const mcpInit = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      const mcpInitData = mcpInit.data as {
        project: {
          id: string;
        };
        firstVersion: {
          id: string;
        };
      };
      const mcpProjectId = mcpInitData.project.id;
      const mcpVersionId = mcpInitData.firstVersion!.id;
      await registry.invoke("prepare_version", {
        projectId: mcpProjectId,
        versionId: mcpVersionId
      });
      const mcpProposal = await registry.invoke("propose_l3_operation", {
        projectId: mcpProjectId,
        actionType: "start_version",
        targetId: mcpVersionId,
        reason: "start current version"
      });
      const mcpProposalData = mcpProposal.data as {
        id: string;
      };
      const mcpApprove = await registry.invoke("approve_l3_operation", {
        projectId: mcpProjectId,
        pendingOperationId: mcpProposalData.id
      });
      const mcpApproveData = mcpApprove.data as {
        id: string;
      };
      await registry.invoke("commit_l3_operation", {
        projectId: mcpProjectId,
        pendingOperationId: mcpProposalData.id,
        approvalArtifactId: mcpApproveData.id
      });
      const mcpContext = await registry.invoke("get_current_context", {
        projectId: mcpProjectId
      });
      const mcpContextData = mcpContext.data as {
        currentVersion: {
          state: string;
        };
        pendingL3Proposals: unknown[];
      };

      expect(cliContext.stdoutJson.data.currentVersion.state).toBe("running");
      expect(mcpContextData.currentVersion.state).toBe("running");
      expect(cliContext.stdoutJson.data.pendingL3Proposals).toHaveLength(0);
      expect(mcpContextData.pendingL3Proposals).toHaveLength(0);

      const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
      const cliSource = fs.readFileSync(
        path.resolve(repoRoot, "packages/cli/src/index.ts"),
        "utf8"
      );
      const mcpSource = fs.readFileSync(
        path.resolve(repoRoot, "packages/mcp/src/index.ts"),
        "utf8"
      );

      expect(cliSource).toContain("RouteLedgerService");
      expect(mcpSource).toContain("RouteLedgerService");
      expect(cliSource).not.toContain("/src/sqlite-storage-adapter");
      expect(cliSource).not.toContain("/src/database");
      expect(mcpSource).not.toContain("/src/sqlite-storage-adapter");
      expect(mcpSource).not.toContain("/src/database");

      registry.close();
    } finally {
      cleanupProjectRoot(cliRoot);
      cleanupProjectRoot(mcpRoot);
    }
  });

  it("json-only runtime profile does not register Mission Control source tools", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot, { runtimeProfile: "json-only" });
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "json-only-tools-list",
        method: "tools/list",
        params: {}
      })) as JsonRpcResponse;
      const tools = (response as ToolListResult).result.tools;
      const toolNames = tools.map((tool) => tool.name);

      expect(tools).toHaveLength(46);
      expect(toolNames).not.toContain("open_mission_control");
      expect(toolNames).not.toContain("get_mission_control_status");
      expect(toolNames).toContain("get_runtime_context");
      expect(toolNames).toContain("write_host_binding_config");

      const registry = createRouteLedgerMcpRegistry({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot,
        runtimeProfile: "json-only"
      });
      const directInvoke = await registry.invoke("open_mission_control", {});
      expect(directInvoke).toMatchObject({
        ok: false,
        error: {
          code: "ACTION_NOT_IMPLEMENTED"
        }
      });

      registry.close();
      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("stdio bin entry runs initialize plus tools/list without leaking stderr", async () => {
    const projectRoot = createTempProjectRoot();
    const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

    try {
      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@routeledger/mcp",
          "exec",
          "tsx",
          "src/bin.ts",
          "--workspace-root",
          projectRoot,
          "--routeledger-root",
          projectRoot,
          "--sqlite-read-model",
          "disabled",
          "--profile",
          "codex",
          "--actor-id",
          "codex-agent",
          "--actor-name",
          "Codex",
          "--approver-id",
          "routeledger-user",
          "--approver-name",
          "RouteLedger User"
        ],
        {
          cwd: repoRoot,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32"
        }
      );

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
          id: "tools-list",
          method: "tools/list",
          params: {}
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

      const stdoutLines = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonRpcResponse);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdoutLines).toHaveLength(3);
      expect(stdoutLines[0]).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            version: "0.0.0-package-prep",
            runtimeIdentity: {
              artifactKind: "source",
              pluginVersion: null,
              releaseTag: null,
              runtimeProfile: "full"
            }
          }
        }
      });
      expect(stdoutLines[1]).toMatchObject({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: expect.any(Array)
        }
      });
      expect(stdoutLines[2]).toMatchObject({
        jsonrpc: "2.0",
        id: "runtime-context",
        result: {
          structuredContent: {
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot: projectRoot,
                routeledgerRoot: projectRoot,
                workspaceConfigPath: getDefaultWorkspaceConfigPath(projectRoot),
                dataRoot: getDefaultDataRoot(projectRoot),
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot)
              },
              processCwd: path.join(repoRoot, "packages/mcp"),
              runtimeIdentity: {
                runtimePackageVersion: "0.0.0-package-prep",
                runtimeProfile: "full",
                artifactKind: "source",
                pluginVersion: null,
                releaseTag: null,
                sourceTreeState: "unavailable",
                buildCommit: null,
                artifactDigest: null,
                runtimePayloadDigest: null
              },
              diagnostics: [],
              storage: {
                mode: "uninitialized",
                sqliteReadModel: "disabled",
                hasCanonicalJson: false,
                hasSqlite: false,
                jsonProjectPath: getDefaultJsonProjectPath(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("stdio bin rejects invalid SQLite read-model settings before starting the server", async () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@routeledger/mcp",
        "exec",
        "tsx",
        "src/bin.ts",
        "--sqlite-read-model",
        "legacy"
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32"
      }
    );
    const stderrChunks: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });

    expect(exitCode).not.toBe(0);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain(
      "Invalid SQLite read-model setting"
    );
  });

});
