import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../../../cli/src/index.js";
import { RouteLedgerService } from "../../../core/src/index.js";
import { createTestDependencies } from "../../../core/src/testing/builders.js";
import {
  acquireRouteLedgerJsonWriteLock,
  loadValidatedProjectAggregateFromJsonDirectory,
  readRouteLedgerJsonDocuments,
  replaceRouteLedgerJsonDocuments
} from "../../../json/src/index.js";
import {
  ROUTELEDGER_DIRECTORY,
  ROUTELEDGER_DB_DIRECTORY,
  ROUTELEDGER_DB_FILENAME,
  SQLiteStorageAdapter
} from "../../../sqlite/src/index.js";
import {
  MCP_PROTOCOL_VERSION,
  createRouteLedgerMcpRegistry,
  type RouteLedgerMcpRegistryOptions,
  type ToolResponse
} from "../index.js";
import {
  createRouteLedgerStdioServer,
  runRouteLedgerStdioServer,
  type JsonRpcMessage,
  type JsonRpcResponse
} from "../stdio-server.js";
import {
  getWorkspaceConfigPath,
  resolveDefaultRouteLedgerDataDir,
  resolveWorkspaceConfigSync
} from "../workspace-config.js";
import { resolveRouteLedgerBinding } from "../binding.js";
import { isPhysicalPathContainedWithinSync } from "../physical-path.js";
import { planRouteLedgerBinding } from "../binding-assist.js";

type ToolListResult = {
  result: {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      annotations: Record<string, unknown>;
      _meta: {
        routeledger: {
          riskLevel: string;
          highRisk: boolean;
          destructive: boolean;
          recommendedApprovalMode: string;
        };
      };
    }>;
  };
};

const WRITE_TOOL_NAMES = new Set([
  "write_host_binding_config",
  "init_project",
  "batch_create_versions",
  "transition_version",
  "close_version",
  "shutdown_version",
  "create_todo",
  "close_todo",
  "defer_work",
  "review_deferred",
  "record_constraint",
  "retire_constraint",
  "create_undo",
  "reassign_undo",
  "carry_forward_undo",
  "resolve_undo_as_downstream_input",
  "close_undo",
  "prepare_version",
  "mark_version_complete",
  "create_version",
  "insert_version",
  "create_child_version",
  "reorder_versions",
  "propose_l3_operation",
  "approve_l3_operation",
  "commit_l3_operation",
  "reject_l3_operation"
]);

const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-mcp-"));

const ensureDefaultWorkspaceConfig = (projectRoot: string): void => {
  resolveWorkspaceConfigSync({
    projectRoot,
    autoCreate: true
  });
};

const getDefaultDataRoot = (projectRoot: string): string =>
  resolveDefaultRouteLedgerDataDir(projectRoot);

const getDefaultWorkspaceConfigPath = (projectRoot: string): string =>
  getWorkspaceConfigPath(projectRoot);

const getDefaultCanonicalJsonRoot = (projectRoot: string): string =>
  path.join(getDefaultDataRoot(projectRoot), ".routeledger");

const getDefaultJsonProjectPath = (projectRoot: string): string =>
  path.join(getDefaultCanonicalJsonRoot(projectRoot), "project.json");

const getDefaultSqliteDbPath = (projectRoot: string): string =>
  path.join(getDefaultDataRoot(projectRoot), ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME);

const createMismatchedExpectedRouteLedgerRoot = (projectRoot: string): string =>
  path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-other`);

const resolveTestRouteLedgerRoot = (
  projectRoot: string,
  extraOptions: Record<string, unknown>
): string =>
  typeof extraOptions.routeledgerRoot === "string"
    ? extraOptions.routeledgerRoot
    : projectRoot;

const createBindingRegistry = (options: RouteLedgerMcpRegistryOptions) => {
  const routeledgerRoot = options.routeledgerRoot;
  const registry = createRouteLedgerMcpRegistry(options);
  const originalInvoke = registry.invoke.bind(registry);

  return {
    ...registry,
    invoke: (toolName: string, input: Record<string, unknown>) =>
      originalInvoke(
        toolName,
        typeof routeledgerRoot === "string" &&
          WRITE_TOOL_NAMES.has(toolName) &&
          !Object.prototype.hasOwnProperty.call(input ?? {}, "expectedRouteLedgerRoot")
          ? {
              ...(input ?? {}),
              expectedRouteLedgerRoot: routeledgerRoot
            }
          : input
      )
  };
};

const createRegistry = (
  projectRoot: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const registry = createBindingRegistry({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    ...extraOptions
  });

  return {
    ...registry,
    invoke: registry.invoke
  };
};

const createProcessCwdRegistry = (
  processCwd: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const previousCwd = process.cwd();
  process.chdir(processCwd);
  const registry = createBindingRegistry({
    ...extraOptions
  });

  return {
    ...registry,
    restore: () => {
      process.chdir(previousCwd);
    }
  };
};

const createServer = (
  projectRoot: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const routeledgerRoot = resolveTestRouteLedgerRoot(projectRoot, extraOptions);

  return Object.assign(
    createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      ...extraOptions
    }),
    {
      __routeledgerRoot: routeledgerRoot
    }
  );
};

const createCapturedServer = (
  options: Record<string, unknown> = {}
): {
  server: ReturnType<typeof createRouteLedgerStdioServer>;
  outboundMessages: JsonRpcMessage[];
} => {
  const outboundMessages: JsonRpcMessage[] = [];
  const server = createRouteLedgerStdioServer({
    ...options,
    sendMessage: (message) => {
      outboundMessages.push(message);
    }
  });

  return {
    server,
    outboundMessages
  };
};

const cleanupProjectRoot = (projectRoot: string): void => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
};

const collectJsonlFiles = (rootPath: string): string[] => {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  return fs.readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      return collectJsonlFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
  });
};

const readDebugLogRecords = (projectRoot: string): Array<Record<string, unknown>> =>
  collectJsonlFiles(path.join(projectRoot, ROUTELEDGER_DIRECTORY, "runtime", "debug", "mcp"))
    .flatMap((filePath) => fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject
  };
};

const removeSqliteFiles = (projectRoot: string): void => {
  const databasePath = getDefaultSqliteDbPath(projectRoot);

  for (const candidatePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ]) {
    fs.rmSync(candidatePath, { force: true });
  }
};

const createSqliteOnlyProject = async (
  projectRoot: string
): Promise<{ projectId: string; initialVersionId: string }> => {
  ensureDefaultWorkspaceConfig(projectRoot);
  const storage = new SQLiteStorageAdapter({ projectRoot: getDefaultDataRoot(projectRoot) });
  const service = new RouteLedgerService({
    storage,
    deps: createTestDependencies()
  });

  try {
    const created = await service.initProject({
      name: "SQLite Only Project",
      description: "",
      actor: {
        id: "sqlite-only-agent",
        type: "agent",
        displayName: "sqlite-only-agent"
      }
    });

    return {
      projectId: created.project.id,
      initialVersionId: created.initialVersion.id
    };
  } finally {
    storage.close();
  }
};

const initializeCanonicalProjectAtRoot = async (
  projectRoot: string,
  name: string
): Promise<void> => {
  const registry = createRegistry(projectRoot);

  try {
    const response = await registry.invoke("init_project", {
      name
    });

    expect(response).toMatchObject({
      ok: true
    });
  } finally {
    registry.close();
  }
};

const initializeServer = async (
  projectRoot: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const server = createServer(projectRoot, {
    hostProfile: "codex",
    actor: {
      id: "codex-agent",
      displayName: "Codex"
    },
    approver: {
      id: "routeledger-approver",
      displayName: "RouteLedger approver"
    },
    ...extraOptions
  });
  const initializeResponse = (await server.handleMessage({
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
  })) as JsonRpcResponse;

  const initializedResponse = await server.handleMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });

  expect(initializeResponse).toMatchObject({
    jsonrpc: "2.0",
    id: "initialize",
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "routeledger",
        title: "RouteLedger MCP"
      }
    }
  });
  expect(
    (initializeResponse as { result: { instructions: string } }).result.instructions
  ).toContain("Current host profile: Codex");
  expect(initializedResponse).toBeNull();

  return server;
};

const callTool = async (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  id: string,
  name: string,
  args: Record<string, unknown>
 ) => {
  const routeledgerRoot = (server as unknown as { __routeledgerRoot?: string }).__routeledgerRoot;
  const toolArgs =
    routeledgerRoot !== undefined &&
    WRITE_TOOL_NAMES.has(name) &&
    !Object.prototype.hasOwnProperty.call(args, "expectedRouteLedgerRoot")
      ? {
          ...args,
          expectedRouteLedgerRoot: routeledgerRoot
        }
      : args;

  return (await server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: toolArgs
    }
  })) as JsonRpcResponse;
};

const getStructuredData = <T>(
  response: JsonRpcResponse
): T =>
  (
    response as {
      result: {
        structuredContent: {
          data: T;
        };
      };
    }
  ).result.structuredContent.data;

const getStructuredErrorDetails = <T>(
  response: JsonRpcResponse
): T =>
  (
    response as {
      result: {
        structuredContent: {
          error: {
            details: T;
          };
        };
      };
    }
  ).result.structuredContent.error.details;

const expectSingleRootsListRequest = (messages: JsonRpcMessage[]): JsonRpcMessage & {
  id: string | number;
  method: "roots/list";
} => {
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    jsonrpc: "2.0",
    method: "roots/list"
  });

  return messages[0] as JsonRpcMessage & {
    id: string | number;
    method: "roots/list";
  };
};

const expectRouteLedgerRootGuardError = (
  response: ToolResponse,
  code: "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID" | "MCP_ROUTELEDGER_ROOT_MISMATCH",
  projectRoot: string,
  toolName: string
): void => {
  expect(response).toMatchObject({
    ok: false,
    error: {
      code,
      details: {
        toolName,
        binding: {
          routeledgerRoot: projectRoot
        }
      }
    }
  });
};

const createAndCommitVersion = async (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  projectId: string,
  title: string
): Promise<string> => {
  const routeledgerRoot = (server as unknown as { __routeledgerRoot?: string }).__routeledgerRoot;
  const createVersionResponse = await callTool(server, `create-${title}`, "create_version", {
    projectId,
    title,
    expectedRouteLedgerRoot: routeledgerRoot
  });

  expect(createVersionResponse).toMatchObject({
    result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      }
    }
  });

  const createVersionDetails = getStructuredErrorDetails<{
    pendingOperationId: string;
    proposal: { targetId: string };
  }>(createVersionResponse);
  const approveResponse = await callTool(server, `approve-${title}`, "approve_l3_operation", {
    projectId,
    pendingOperationId: createVersionDetails.pendingOperationId,
    expectedRouteLedgerRoot: routeledgerRoot
  });
  const approvalArtifact = getStructuredData<{ id: string }>(approveResponse);

  await callTool(server, `commit-${title}`, "commit_l3_operation", {
    projectId,
    pendingOperationId: createVersionDetails.pendingOperationId,
    approvalArtifactId: approvalArtifact.id,
    expectedRouteLedgerRoot: routeledgerRoot
  });

  return createVersionDetails.proposal.targetId;
};

const createApprovedVersionProposal = async (
  registry: ReturnType<typeof createRouteLedgerMcpRegistry>,
  projectId: string,
  title: string,
  routeledgerRoot: string
): Promise<{ pendingOperationId: string; approvalArtifactId: string }> => {
  const createResponse = await registry.invoke("create_version", {
    projectId,
    title,
    expectedRouteLedgerRoot: routeledgerRoot
  });

  expect(createResponse).toMatchObject({
    ok: false,
    error: {
      code: "CONFIRMATION_REQUIRED"
    }
  });

  const pendingOperationId = (
    createResponse.error?.details as {
      pendingOperationId: string;
    }
  ).pendingOperationId;
  const approveResponse = await registry.invoke("approve_l3_operation", {
    projectId,
    pendingOperationId,
    expectedRouteLedgerRoot: routeledgerRoot
  });

  expect(approveResponse.ok).toBe(true);

  return {
    pendingOperationId,
    approvalArtifactId: (approveResponse.data as { id: string }).id
  };
};

const expectCanonicalJsonValid = async (projectRoot: string): Promise<void> => {
  const loaded = await loadValidatedProjectAggregateFromJsonDirectory(getDefaultDataRoot(projectRoot));
  expect(loaded.documentCount).toBeGreaterThan(0);
};

const setCurrentVersionWithApproval = async (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  projectId: string,
  versionId: string
): Promise<void> => {
  const routeledgerRoot = (server as unknown as { __routeledgerRoot?: string }).__routeledgerRoot;
  const response = await callTool(server, `set-current-${versionId}`, "propose_l3_operation", {
    projectId,
    actionType: "set_current_version",
    targetId: versionId,
    reason: "move current version for window contract test",
    expectedRouteLedgerRoot: routeledgerRoot
  });

  expect(response).toMatchObject({
    result: {
      structuredContent: {
        ok: true,
        data: {
          id: expect.any(String)
        }
      }
    }
  });

  const details = getStructuredData<{
    id: string;
  }>(response);
  const approveResponse = await callTool(
    server,
    `approve-set-current-${versionId}`,
    "approve_l3_operation",
    {
      projectId,
      pendingOperationId: details.id,
      expectedRouteLedgerRoot: routeledgerRoot
    }
  );
  const approvalArtifact = getStructuredData<{ id: string }>(approveResponse);

  await callTool(server, `commit-set-current-${versionId}`, "commit_l3_operation", {
    projectId,
    pendingOperationId: details.id,
    approvalArtifactId: approvalArtifact.id,
    expectedRouteLedgerRoot: routeledgerRoot
  });
};

const runTranscript = async (
  projectRoot: string,
  lines: string[]
): Promise<{ responses: JsonRpcResponse[]; stderr: string }> => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  output.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  errorOutput.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const runPromise = runRouteLedgerStdioServer({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    hostProfile: "codex",
    input,
    output,
    errorOutput
  });

  input.end(`${lines.join("\n")}\n`);
  await runPromise;

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const responses =
    stdout.length === 0
      ? []
      : stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as JsonRpcResponse);

  return {
    responses,
    stderr: Buffer.concat(stderrChunks).toString("utf8")
  };
};

describe("routeledger mcp registry", () => {
  it("tools/list uses standard annotations and host policy metadata", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list",
        params: {}
      })) as JsonRpcResponse;

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: expect.any(Array)
        }
      });

      const tools = (response as ToolListResult).result.tools;
      const readOnlyTools = tools.filter(
        (tool) => tool._meta.routeledger.riskLevel === "read-only"
      );
      const writeTools = tools.filter((tool) => tool._meta.routeledger.riskLevel === "write");
      const highRiskTools = tools.filter(
        (tool) => tool._meta.routeledger.riskLevel === "high-risk"
      );
      const runtimeContextTool = tools.find((tool) => tool.name === "get_runtime_context");
      const openMissionControlTool = tools.find((tool) => tool.name === "open_mission_control");
      const writeHostBindingConfigTool = tools.find(
        (tool) => tool.name === "write_host_binding_config"
      );
      const missionControlStatusTool = tools.find(
        (tool) => tool.name === "get_mission_control_status"
      );
      const contextTool = tools.find((tool) => tool.name === "get_current_context");
      const nextActionTool = tools.find((tool) => tool.name === "next_action");
      const checkDocDriftTool = tools.find((tool) => tool.name === "check_doc_drift");
      const summarizeVersionCloseoutTool = tools.find(
        (tool) => tool.name === "summarize_version_closeout"
      );
      const planVersionCloseoutTool = tools.find((tool) => tool.name === "plan_version_closeout");
      const listVersionsWindowTool = tools.find((tool) => tool.name === "list_versions_window");
      const getVersionStructureTool = tools.find((tool) => tool.name === "get_version_structure");
      const getVersionTransitionGuideTool = tools.find(
        (tool) => tool.name === "get_version_transition_guide"
      );
      const transitionVersionTool = tools.find((tool) => tool.name === "transition_version");
      const closeVersionTool = tools.find((tool) => tool.name === "close_version");
      const shutdownVersionTool = tools.find((tool) => tool.name === "shutdown_version");
      const carryForwardUndoTool = tools.find((tool) => tool.name === "carry_forward_undo");
      const approveTool = tools.find((tool) => tool.name === "approve_l3_operation");
      const rejectTool = tools.find((tool) => tool.name === "reject_l3_operation");
      const commitTool = tools.find((tool) => tool.name === "commit_l3_operation");
      const createVersionTool = tools.find((tool) => tool.name === "create_version");
      const insertVersionTool = tools.find((tool) => tool.name === "insert_version");
      const createChildVersionTool = tools.find((tool) => tool.name === "create_child_version");
      const reorderVersionsTool = tools.find((tool) => tool.name === "reorder_versions");

      expect(runtimeContextTool?.annotations.readOnlyHint).toBe(true);
      expect(runtimeContextTool?.annotations.idempotentHint).toBe(true);
      expect(runtimeContextTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(runtimeContextTool?._meta.routeledger.recommendedApprovalMode).toBe("auto");
      expect(openMissionControlTool?.annotations.readOnlyHint).toBe(true);
      expect(openMissionControlTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(openMissionControlTool?.inputSchema.properties).toMatchObject({
        workspaceRoot: expect.objectContaining({ type: "string" }),
        routeledgerRoot: expect.objectContaining({ type: "string" }),
        devBuild: expect.objectContaining({ type: "boolean" })
      });
      expect(missionControlStatusTool?.annotations.readOnlyHint).toBe(true);
      expect(missionControlStatusTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(missionControlStatusTool?.inputSchema.properties).toMatchObject({
        workspaceRoot: expect.objectContaining({ type: "string" }),
        routeledgerRoot: expect.objectContaining({ type: "string" })
      });
      expect(contextTool?.annotations.readOnlyHint).toBe(true);
      expect(contextTool?.annotations.idempotentHint).toBe(true);
      expect(writeHostBindingConfigTool?.annotations.readOnlyHint).toBe(false);
      expect(writeHostBindingConfigTool?._meta.routeledger).toMatchObject({
        riskLevel: "write",
        recommendedApprovalMode: "prompt"
      });
      expect(writeHostBindingConfigTool?.inputSchema.properties).toMatchObject({
        routeledgerRoot: expect.objectContaining({ type: "string" }),
        outputPath: expect.objectContaining({ type: "string" }),
        expectedRouteLedgerRoot: expect.objectContaining({ type: "string" })
      });
      expect(writeTools).toHaveLength(19);
      expect(highRiskTools).toHaveLength(4);
      for (const tool of [...writeTools, ...highRiskTools]) {
        expect(tool.inputSchema.properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(tool.inputSchema.required ?? []).not.toContain("expectedRouteLedgerRoot");
      }
      for (const tool of readOnlyTools) {
        expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("expectedRouteLedgerRoot");
      }
      expect(nextActionTool?.annotations.readOnlyHint).toBe(true);
      expect(nextActionTool?.annotations.idempotentHint).toBe(true);
      expect(checkDocDriftTool?.annotations.readOnlyHint).toBe(true);
      expect(checkDocDriftTool?.annotations.idempotentHint).toBe(true);
      expect(checkDocDriftTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(checkDocDriftTool?.description).toBe(
        "Compare selected entry docs with RouteLedger truth. Input: entryFiles."
      );
      expect(summarizeVersionCloseoutTool?.annotations.readOnlyHint).toBe(true);
      expect(summarizeVersionCloseoutTool?.annotations.idempotentHint).toBe(true);
      expect(summarizeVersionCloseoutTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(summarizeVersionCloseoutTool?.description).toBe(
        "Summarize a version's closeout blockers and evidence."
      );
      expect(planVersionCloseoutTool?.annotations.readOnlyHint).toBe(true);
      expect(planVersionCloseoutTool?.annotations.idempotentHint).toBe(true);
      expect(planVersionCloseoutTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(planVersionCloseoutTool?.description).toBe(
        "Plan concrete steps to clear a version closeout."
      );
      expect(listVersionsWindowTool?.annotations.readOnlyHint).toBe(true);
      expect(listVersionsWindowTool?.annotations.idempotentHint).toBe(true);
      expect(getVersionStructureTool?.annotations.readOnlyHint).toBe(true);
      expect(getVersionStructureTool?.annotations.idempotentHint).toBe(true);
      expect(getVersionTransitionGuideTool?.annotations.readOnlyHint).toBe(true);
      expect(getVersionTransitionGuideTool?.annotations.idempotentHint).toBe(true);
      expect(transitionVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(closeVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(shutdownVersionTool?._meta.routeledger.riskLevel).toBe("high-risk");
      expect(carryForwardUndoTool).toBeUndefined();
      for (const legacyToolName of [
        "create_undo",
        "reassign_undo",
        "carry_forward_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(tools.find((tool) => tool.name === legacyToolName)).toBeUndefined();
      }
      expect(approveTool?._meta.routeledger).toMatchObject({
        riskLevel: "high-risk",
        highRisk: true,
        destructive: false,
        recommendedApprovalMode: "prompt"
      });
      expect(rejectTool?._meta.routeledger).toMatchObject({
        riskLevel: "high-risk",
        highRisk: true,
        destructive: false,
        recommendedApprovalMode: "prompt"
      });
      expect(commitTool?.annotations.destructiveHint).toBe(true);
      expect(commitTool?._meta.routeledger).toMatchObject({
        destructive: true,
        recommendedApprovalMode: "approve"
      });
      expect(createVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(insertVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(createChildVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(reorderVersionsTool?._meta.routeledger.riskLevel).toBe("write");

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("tools/call validates inputSchema at the MCP boundary as tool-level errors", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const badDecisionRefResponse = await callTool(
        server,
        "bad-decision-ref",
        "approve_l3_operation",
        {
          projectId: "missing-project",
          pendingOperationId: "pending-operation",
          decisionRef: 42
        }
      );
      const extraFieldResponse = await callTool(server, "extra-field", "init_project", {
        name: "RouteLedger",
        unexpected: true
      });
      const missingRequiredResponse = await callTool(
        server,
        "missing-required",
        "list_versions",
        {}
      );

      expect(badDecisionRefResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-decision-ref",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.decisionRef"
              }
            }
          }
        }
      });
      expect(
        (
          badDecisionRefResponse as {
            result: {
              structuredContent: {
                error: {
                  details: {
                    issues: Array<{ path: string; message: string }>;
                  };
                };
              };
            };
          }
        ).result.structuredContent.error.details.issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.decisionRef",
            message: expect.stringContaining("Expected string")
          })
        ])
      );
      expect(extraFieldResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "extra-field",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.unexpected"
              }
            }
          }
        }
      });
      expect(missingRequiredResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-required",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.projectId"
              }
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("write tools reject invalid relative expectedRouteLedgerRoot before mutating state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: "relative/path"
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID",
        projectRoot,
        "init_project"
      );
      expect(response.error?.details).toMatchObject({
        expectedRouteLedgerRoot: "relative/path",
        receivedType: "string",
        receivedValue: "relative/path"
      });
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("matched expectedRouteLedgerRoot allows write tools to proceed", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(response.ok).toBe(true);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("debug log is disabled by default and writes structured JSONL only when enabled", async () => {
    const defaultProjectRoot = createTempProjectRoot();
    const enabledProjectRoot = createTempProjectRoot();
    const defaultRegistry = createRegistry(defaultProjectRoot);
    const enabledRegistry = createRegistry(enabledProjectRoot, {
      hostProfile: "codex",
      actor: {
        id: "debug-agent",
        displayName: "Debug Agent"
      },
      debugLog: {
        enabled: true
      }
    });

    try {
      const defaultInitResponse = await defaultRegistry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: defaultProjectRoot
      });
      expect(defaultInitResponse.ok).toBe(true);
      const defaultProjectId = (defaultInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      }).project.id;
      const defaultVersionId = (defaultInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      }).initialVersion.id;

      const defaultGateResponse = await defaultRegistry.invoke("check_start_gate", {
        projectId: defaultProjectId,
        versionId: defaultVersionId
      });
      expect(defaultGateResponse.ok).toBe(true);
      expect(readDebugLogRecords(defaultProjectRoot)).toEqual([]);

      const enabledInitResponse = await enabledRegistry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: enabledProjectRoot
      });
      expect(enabledInitResponse.ok).toBe(true);
      const enabledData = enabledInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      const enabledGateResponse = await enabledRegistry.invoke("check_start_gate", {
        projectId: enabledData.project.id,
        versionId: enabledData.initialVersion.id
      });
      expect(enabledGateResponse.ok).toBe(true);
      const failureResponse = await enabledRegistry.invoke("get_current_context", {
        projectId: "missing-project"
      });
      expect(failureResponse.ok).toBe(false);

      expect(readDebugLogRecords(enabledProjectRoot)).toEqual([
        expect.objectContaining({
          type: "gate.start",
          toolName: "check_start_gate",
          projectId: enabledData.project.id,
          versionId: enabledData.initialVersion.id,
          actorId: "debug-agent",
          actorDisplayName: "Debug Agent",
          hostProfile: "codex",
          payload: expect.objectContaining({
            allowed: expect.any(Boolean),
            blockerCodes: expect.any(Array)
          })
        }),
        expect.objectContaining({
          type: "tool.failure",
          toolName: "get_current_context",
          projectId: "missing-project",
          actorId: "debug-agent",
          actorDisplayName: "Debug Agent",
          hostProfile: "codex",
          payload: expect.objectContaining({
            error: expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String)
            }),
            inputKeys: ["projectId"]
          })
        })
      ]);
    } finally {
      defaultRegistry.close();
      enabledRegistry.close();
      cleanupProjectRoot(defaultProjectRoot);
      cleanupProjectRoot(enabledProjectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks init_project before creating canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "init_project"
      );
      expect(response.error?.details).toMatchObject({
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks create_todo without changing canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };
      const baselineDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));

      const response = await registry.invoke("create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "write docs",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "create_todo"
      );
      const updatedDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));
      expect(updatedDocuments).toEqual(baselineDocuments);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks create_version without creating pending proposals", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const response = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "create_version"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks commit_l3_operation without consuming approval artifacts", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };
      const approvedProposal = await createApprovedVersionProposal(
        registry,
        initData.project.id,
        "Version 2",
        projectRoot
      );

      const response = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: approvedProposal.pendingOperationId,
        approvalArtifactId: approvedProposal.approvalArtifactId,
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "commit_l3_operation"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: approvedProposal.pendingOperationId,
          status: "pending"
        })
      ]);

      const retryResponse = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: approvedProposal.pendingOperationId,
        approvalArtifactId: approvedProposal.approvalArtifactId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(retryResponse.ok).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks approve_l3_operation while proposal stays pending", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const response = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "approve_l3_operation"
      );
      expect(response.ok).toBe(false);
      expect(response.data).toBeUndefined();
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: pendingOperationId,
          status: "pending"
        })
      ]);

      const retryResponse = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(retryResponse.ok).toBe(true);
      expect(retryResponse.data).toEqual(
        expect.objectContaining({
          id: expect.any(String)
        })
      );
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks reject_l3_operation while proposal stays pending", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const response = await registry.invoke("reject_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        reason: "reject after mismatch guard test",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "reject_l3_operation"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: pendingOperationId,
          status: "pending"
        })
      ]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks batch_create_versions without creating pending proposals", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      const response = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        anchor: {
          afterVersionId: initData.initialVersion.id
        },
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ],
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "batch_create_versions"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("split-root synthetic acceptance keeps binding, storage paths, and write guards aligned to routeledgerRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(workspaceRoot, {
        routeledgerRoot
      });

      const runtimeBeforeInit = await callTool(server, "runtime-before-init", "get_runtime_context", {});
      expect(runtimeBeforeInit).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                routeledgerRoot,
                workspaceConfigPath: path.join(workspaceRoot, ".routeledger", "config.json"),
                dataRoot: routeledgerRoot,
                routeledgerDir: path.join(routeledgerRoot, ".routeledger")
              },
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

      const blockedRead = await callTool(server, "blocked-read", "get_current_context", {
        projectId: "split-root-project"
      });
      expect(blockedRead).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "ROUTELEDGER_NOT_INITIALIZED"
            }
          }
        }
      });

      const mismatchedInit = await callTool(server, "mismatched-init", "init_project", {
        name: "Split Root",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expectRouteLedgerRootGuardError(
        (mismatchedInit as { result: { structuredContent: ToolResponse } }).result
          .structuredContent,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        routeledgerRoot,
        "init_project"
      );
      expect(fs.existsSync(path.join(routeledgerRoot, ".routeledger", "project.json"))).toBe(false);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "config.json"))).toBe(true);

      const initResponse = await callTool(server, "init-split-root", "init_project", {
        name: "Split Root",
        expectedRouteLedgerRoot: routeledgerRoot
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      expect(fs.existsSync(path.join(routeledgerRoot, ".routeledger", "project.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3"))
      ).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(false);

      const mismatchedCreateTodo = await callTool(server, "mismatched-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "blocked by root mismatch",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expectRouteLedgerRootGuardError(
        (mismatchedCreateTodo as { result: { structuredContent: ToolResponse } }).result
          .structuredContent,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        routeledgerRoot,
        "create_todo"
      );

      const createTodoResponse = await callTool(server, "matched-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "docs follow routeledger root",
        expectedRouteLedgerRoot: routeledgerRoot
      });
      expect(createTodoResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true
          }
        }
      });

      const canonicalDocuments = await readRouteLedgerJsonDocuments(routeledgerRoot);
      expect(canonicalDocuments.some((document) => document.path === ".routeledger/project.json")).toBe(
        true
      );
      expect(
        canonicalDocuments.some((document) =>
          document.path.includes(".routeledger/todos/")
        )
      ).toBe(true);

      const writeLock = await acquireRouteLedgerJsonWriteLock(routeledgerRoot, {
        ownerId: "split-root-writer",
        retryAfterMs: 400,
        staleAfterMs: 30_000
      });

      try {
        const blockedDuringWrite = await callTool(server, "busy-context", "get_current_context", {
          projectId: initData.project.id
        });
        expect(blockedDuringWrite).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              ok: false,
              error: {
                code: "WRITE_IN_PROGRESS",
                details: {
                  routeledgerRoot
                }
              }
            }
          }
        });

        const runtimeDuringWrite = await callTool(
          server,
          "runtime-during-write",
          "get_runtime_context",
          {}
        );
        expect(runtimeDuringWrite).toMatchObject({
          result: {
            structuredContent: {
              ok: true,
              data: {
                binding: {
                  status: "bound",
                  workspaceRoot,
                  routeledgerRoot
                },
                storage: {
                  mode: "write_in_progress",
                  writeLock: {
                    projectRoot: routeledgerRoot,
                    lockPath: path.join(
                      routeledgerRoot,
                      ".routeledger",
                      ".write-lock"
                    )
                  }
                }
              }
            }
          }
        });
      } finally {
        await writeLock.release();
      }
    } finally {
      server?.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("tools/call uses params.arguments and returns structured success content", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });

      expect(initResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "init-project",
        result: {
          structuredContent: {
            ok: true
          },
          content: [
            {
              type: "text"
            }
          ]
        }
      });

      const projectId = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: {
                  id: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.data.project.id;
      const contextResponse = await callTool(
        server,
        "get-context",
        "get_current_context",
        {
          projectId
        }
      );
      const nextActionResponse = await callTool(server, "next-action", "next_action", {
        projectId
      });
      const summarizeVersionCloseoutResponse = await callTool(
        server,
        "summarize-closeout",
        "summarize_version_closeout",
        {
          projectId
        }
      );
      const planVersionCloseoutResponse = await callTool(
        server,
        "plan-closeout",
        "plan_version_closeout",
        {
          projectId
        }
      );
      const listVersionsWindowResponse = await callTool(
        server,
        "list-versions-window",
        "list_versions_window",
        {
          projectId
        }
      );

      expect(contextResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "get-context",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              }
            },
            meta: {
              budgetBytes: expect.any(Number),
              versionWindow: {
                aroundVersionId: expect.any(String),
                totalCount: 1,
                includedCount: 1,
                omittedBeforeCount: 0,
                omittedAfterCount: 0,
                before: 3,
                after: 3,
                includeAllVersions: false
              },
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });
      expect(nextActionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "next-action",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              },
              nextAction: {
                actionType: "prepare_version"
              },
              statusRisks: expect.any(Array)
            },
            meta: {
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });
      expect(summarizeVersionCloseoutResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "summarize-closeout",
        result: {
          structuredContent: {
            ok: true,
            data: {
              projectId,
              version: {
                id: expect.any(String),
                state: "wait",
                isCurrent: true
              },
              closeGate: {
                ok: false
              },
              nextAction: {
                actionType: "none"
              }
            },
            meta: {
              eventLimit: 10,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              },
              runtimeContext: {
                projectId,
                projectName: null,
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });
      expect(planVersionCloseoutResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "plan-closeout",
        result: {
          structuredContent: {
            ok: true,
            data: {
              projectId,
              status: "planned",
              summary: {
                canClose: false,
                version: {
                  state: "wait"
                }
              },
              steps: [expect.objectContaining({ kind: "no_op" })]
            },
            meta: {
              eventLimit: 10,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              },
              runtimeContext: {
                projectId,
                projectName: null,
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });
      expect(listVersionsWindowResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "list-versions-window",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              },
              aroundVersionId: expect.any(String),
              versions: expect.any(Array)
            },
            meta: {
              versionWindow: {
                totalCount: 1,
                includedCount: 1,
                omittedBeforeCount: 0,
                omittedAfterCount: 0
              },
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
              }
            }
          }
        }
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("check_doc_drift returns structured warnings and unreadable files", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const nextVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Doc Drift Current"
      );

      await setCurrentVersionWithApproval(server, initData.project.id, nextVersionId);

      const legacyRegistry = createRegistry(projectRoot);
      const legacyUndo = await legacyRegistry.invoke("create_undo", {
        projectId: initData.project.id,
        versionId: nextVersionId,
        originVersionId: nextVersionId,
        preferredResolutionVersionId: nextVersionId,
        title: "Legacy doc-drift audit record",
        reason: "verify default response sanitization"
      });
      expect(legacyUndo.ok).toBe(true);
      legacyRegistry.close();

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        ["# RouteLedger", "", "Current docs still mention Initial Version.", "current line is stale."].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        "# Entry\n旧 QA 路径：docs/qa/legacy-checklist.md\n",
        "utf8"
      );

      const response = await callTool(server, "check-doc-drift", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "check-doc-drift",
        result: {
          structuredContent: {
            ok: true,
            data: {
              routeTruth: {
                currentVersion: {
                  id: nextVersionId,
                  title: "Doc Drift Current"
                }
              }
            }
          }
        }
      });

      const data = getStructuredData<{
        routeTruth: Record<string, unknown>;
        legacyAudit: {
          required: boolean;
          guidance: string;
        };
        unreadableFiles: Array<{ path: string; code: string }>;
        warnings: Array<{ code: string; file: string | null; expected?: string }>;
        summaryText: string;
      }>(response);

      expect(data.routeTruth).not.toHaveProperty("openUndoCount");
      expect(data.routeTruth).toMatchObject({
        legacyBlockerCount: 1,
        statusRiskCodes: expect.arrayContaining([
          "LEGACY_BLOCKERS_REQUIRE_AUDIT"
        ])
      });
      expect(
        (data.routeTruth.statusRiskCodes as string[]).includes(
          "OPEN_UNDOS_BLOCK_CLOSE"
        )
      ).toBe(false);
      expect(data.legacyAudit).toMatchObject({
        required: true
      });
      expect(data.legacyAudit.guidance).toContain("includeLegacyUndo=true");
      expect(data.summaryText).not.toContain("open undos");
      expect(data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
            file: null
          })
        ])
      );
      expect(data.unreadableFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "docs/missing.md",
            code: "ENOENT"
          })
        ])
      );
      expect(data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_CURRENT_VERSION",
            file: "README.md"
          }),
          expect.objectContaining({
            code: "MISSING_EXPECTED_POINTER",
            file: null,
            expected: "docs/qa/current-checklist.md"
          })
        ])
      );

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("check_doc_drift keeps workspaceRoot as the entry-file boundary in split-root mode", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(workspaceRoot, {
        routeledgerRoot
      });
      const initResponse = await callTool(server, "init-split-doc-drift", "init_project", {
        name: "Split Root"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const nextVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Doc Drift Current"
      );

      await setCurrentVersionWithApproval(server, initData.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(workspaceRoot, "README.md"),
        ["# Workspace entry", "", "Current docs still mention Initial Version.", "current pointer is stale."].join(
          "\n"
        ),
        "utf8"
      );
      fs.writeFileSync(
        path.join(routeledgerRoot, "README.md"),
        [
          "# Docs root",
          "",
          `Current version: Doc Drift Current (${nextVersionId})`,
          ".routeledger/refs/current.json"
        ].join("\n"),
        "utf8"
      );

      const response = await callTool(server, "split-doc-drift", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["README.md", "docs/README.md"]
      });
      const data = getStructuredData<{
        routeTruth: Record<string, unknown>;
        checkedFiles: Array<{ path: string }>;
        warnings: Array<{ code: string; file: string | null }>;
        unreadableFiles: Array<{ path: string }>;
        summaryText: string;
      }>(response);

      expect(data.routeTruth).not.toHaveProperty("openUndoCount");
      expect(data.routeTruth).toMatchObject({
        legacyBlockerCount: 0
      });
      expect(data).not.toHaveProperty("legacyAudit");
      expect(data.summaryText).not.toContain("open undos");
      expect(data.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_BLOCKERS_REQUIRE_AUDIT"
          })
        ])
      );
      expect(data.checkedFiles.map((file) => file.path)).toEqual([
        "README.md",
        "docs/README.md"
      ]);
      expect(data.unreadableFiles).toEqual([]);
      expect(data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_CURRENT_VERSION",
            file: "README.md"
          })
        ])
      );
      expect(
        data.warnings.some(
          (warning) =>
            warning.code === "STALE_CURRENT_VERSION" && warning.file === "docs/README.md"
        )
      ).toBe(false);
    } finally {
      server?.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("check_doc_drift rejects invalid entry file paths as tool-level errors", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const response = await callTool(server, "bad-doc-path", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["../README.md"]
      });

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-doc-path",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_ASSET_PATH",
              details: {
                field: "entryFiles[0]",
                path: "../README.md"
              }
            }
          }
        }
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP context/version tools honor default window vs explicit full-version contracts", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = projectData.project.id;
      const createdVersionIds = [projectData.initialVersion.id];

      for (const title of [
        "Version 2",
        "Version 3",
        "Version 4",
        "Version 5",
        "Version 6",
        "Version 7",
        "Version 8"
      ]) {
        createdVersionIds.push(await createAndCommitVersion(server, projectId, title));
      }

      await setCurrentVersionWithApproval(server, projectId, createdVersionIds[3]!);

      const defaultContextResponse = await callTool(
        server,
        "default-context",
        "get_current_context",
        {
          projectId
        }
      );
      const fullContextResponse = await callTool(server, "full-context", "get_current_context", {
        projectId,
        includeAllVersions: true
      });
      const listVersionsResponse = await callTool(server, "list-versions", "list_versions", {
        projectId
      });
      const listVersionsWindowResponse = await callTool(
        server,
        "list-versions-window-default",
        "list_versions_window",
        {
          projectId
        }
      );

      const defaultContextData = getStructuredData<{
        versions: Array<{ id: string }>;
      }>(defaultContextResponse);
      const defaultContextMeta = (
        defaultContextResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  aroundVersionId: string | null;
                  includeAllVersions: boolean;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;
      const fullContextData = getStructuredData<{
        versions: Array<{ id: string }>;
      }>(fullContextResponse);
      const fullContextMeta = (
        fullContextResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  includeAllVersions: boolean;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;
      const listVersionsData = getStructuredData<Array<{ id: string }>>(listVersionsResponse);
      const listVersionsWindowData = getStructuredData<{
        aroundVersionId: string | null;
        versions: Array<{ id: string }>;
      }>(listVersionsWindowResponse);
      const listVersionsWindowMeta = (
        listVersionsWindowResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;

      expect(defaultContextData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(0, 7)
      );
      expect(defaultContextMeta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[3],
        includeAllVersions: false,
        totalCount: 8,
        includedCount: 7,
        omittedBeforeCount: 0,
        omittedAfterCount: 1
      });

      expect(fullContextData.versions.map((version) => version.id)).toEqual(createdVersionIds);
      expect(fullContextMeta.versionWindow).toMatchObject({
        includeAllVersions: true,
        totalCount: 8,
        includedCount: 8,
        omittedBeforeCount: 0,
        omittedAfterCount: 0
      });

      expect(listVersionsData.map((version) => version.id)).toEqual(createdVersionIds);
      expect(listVersionsWindowData.aroundVersionId).toBe(createdVersionIds[3]);
      expect(listVersionsWindowData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(0, 7)
      );
      expect(listVersionsWindowMeta.versionWindow).toMatchObject({
        totalCount: 8,
        includedCount: 7,
        omittedBeforeCount: 0,
        omittedAfterCount: 1
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP list_versions_window 覆盖尾部 anchor 边界，并在 invalid aroundVersionId 上返回 VERSION_NOT_FOUND", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project-tail-window", "init_project", {
        name: "RouteLedger"
      });
      const projectData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = projectData.project.id;
      const createdVersionIds = [projectData.initialVersion.id];

      for (const title of [
        "Version 2",
        "Version 3",
        "Version 4",
        "Version 5",
        "Version 6",
        "Version 7",
        "Version 8"
      ]) {
        createdVersionIds.push(await createAndCommitVersion(server, projectId, title));
      }

      const tailWindowResponse = await callTool(
        server,
        "tail-window",
        "list_versions_window",
        {
          projectId,
          aroundVersionId: createdVersionIds[7],
          before: 2,
          after: 3
        }
      );
      const invalidWindowResponse = await callTool(
        server,
        "invalid-window",
        "list_versions_window",
        {
          projectId,
          aroundVersionId: "version-missing",
          before: 2,
          after: 3
        }
      );

      const tailWindowData = getStructuredData<{
        aroundVersionId: string | null;
        versions: Array<{ id: string }>;
      }>(tailWindowResponse);
      const tailWindowMeta = (
        tailWindowResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  aroundVersionId: string | null;
                  before: number;
                  after: number;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;

      expect(tailWindowData.aroundVersionId).toBe(createdVersionIds[7]);
      expect(tailWindowData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(5, 8)
      );
      expect(tailWindowMeta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[7],
        before: 2,
        after: 3,
        totalCount: 8,
        includedCount: 3,
        omittedBeforeCount: 5,
        omittedAfterCount: 0
      });

      expect(invalidWindowResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "invalid-window",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "VERSION_NOT_FOUND"
            }
          }
        }
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP runtimeContext reports invalid binding when workspaceRoot or routeledgerRoot are relative", async () => {
    const absoluteProjectRoot = createTempProjectRoot();
    const relativeProjectRoot = path.relative(process.cwd(), absoluteProjectRoot);
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: relativeProjectRoot,
      routeledgerRoot: relativeProjectRoot
    });

    try {
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid",
            workspaceRoot: expect.any(String),
            routeledgerRoot: null
          }
        }
      });
      expect(
        path.isAbsolute(
          (response.data as { binding: { workspaceRoot: string } }).binding
            .workspaceRoot
        )
      ).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(absoluteProjectRoot);
    }
  });

  it("discover_routeledger_roots blocks an unbound process cwd until the host supplies workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          workspaceRoot: null,
          status: "blocked",
          candidates: [],
          recommendedBinding: null,
          recommendedNextActions: [
            expect.objectContaining({
              type: "provide_explicit_workspace_root",
              tool: "activate_routeledger_binding"
            })
          ]
        }
      });
      const explicitResponse = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });
      expect(explicitResponse).toMatchObject({
        ok: true,
        data: { workspaceRoot: resolvedWorkspaceRoot, status: "none_found" }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("Codex no-roots session activates an explicit workspace without scanning cache cwd", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(cacheCwd);
    const server = createRouteLedgerStdioServer({ hostProfile: "codex" });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "codex-0.144.1-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "codex-mcp-client", version: "0.144.1" }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      expect(getStructuredData<{ status: string }>(
        await callTool(server, "cache-discover", "discover_routeledger_roots", {})
      )).toMatchObject({ status: "blocked" });
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "cache-plan", "plan_routeledger_binding", {})
      )).toMatchObject({ status: "blocked" });
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "explicit-readonly-plan", "plan_routeledger_binding", {
          workspaceRoot,
          routeledgerRoot: workspaceRoot
        })
      )).toMatchObject({ status: "needs_init" });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(false);
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "outside-plan", "plan_routeledger_binding", {
          workspaceRoot,
          routeledgerRoot: outsideRoot
        })
      )).toMatchObject({ status: "blocked" });

      const activation = await callTool(
        server,
        "activate-explicit-workspace",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      const activationData = getStructuredData<{
        status: string;
        rebound: boolean;
        activeBinding: Record<string, unknown>;
      }>(activation);
      expect(activationData).toMatchObject({
        status: "activated",
        rebound: true
      });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(false);

      const postActivationContext = getStructuredData<{
        binding: Record<string, unknown>;
      }>(
        await callTool(server, "post-activate-context", "get_runtime_context", {})
      );
      expect(postActivationContext).toMatchObject({
        binding: {
          workspaceRoot,
          status: "uninitialized"
        }
      });
      expect(activationData.activeBinding).toEqual(
        (activation as {
          result: { structuredContent: { meta: { runtimeContext: { binding: unknown } } } };
        }).result.structuredContent.meta.runtimeContext.binding
      );
      expect(activationData.activeBinding).toEqual(postActivationContext.binding);

      const initialized = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(await callTool(server, "activate-init", "init_project", {
        name: "Activated RouteLedger",
        expectedRouteLedgerRoot: workspaceRoot
      }));
      const todo = getStructuredData<{ todo: { id: string } }>(
        await callTool(server, "activate-create-todo", "create_todo", {
          projectId: initialized.project.id,
          versionId: initialized.initialVersion.id,
          title: "session binding proof",
          expectedRouteLedgerRoot: workspaceRoot
        })
      );
      expect(getStructuredData<unknown>(
        await callTool(server, "activate-close-todo", "close_todo", {
          projectId: initialized.project.id,
          todoId: todo.todo.id,
          reason: "verified",
          note: "session rebind uses the new service",
          expectedRouteLedgerRoot: workspaceRoot
        })
      )).toBeTruthy();

      const switchAttempt = getStructuredData<{ status: string; code: string }>(
        await callTool(server, "reject-bound-switch", "activate_routeledger_binding", {
          workspaceRoot: outsideRoot
        })
      );
      expect(switchAttempt).toMatchObject({
        status: "blocked",
        code: "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED"
      });
    } finally {
      server.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("direct activation returns the swapped registry binding in its own response", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(cacheCwd, { hostProfile: "codex" });

    try {
      const activation = await registry.invoke("activate_routeledger_binding", { workspaceRoot });
      expect(activation).toMatchObject({
        ok: true,
        data: {
          status: "activated",
          rebound: true,
          activeBinding: {
            workspaceRoot,
            status: "uninitialized"
          }
        },
        meta: {
          runtimeContext: {
            binding: {
              workspaceRoot,
              status: "uninitialized"
            }
          }
        }
      });
      const context = await registry.invoke("get_runtime_context", {});
      expect((activation.data as { activeBinding: unknown }).activeBinding).toEqual(
        (context.data as { binding: unknown }).binding
      );
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("uses physical containment for links, missing in-workspace children, and workspace dataDir", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const insideRoot = path.join(workspaceRoot, "inside");
    const outsideLink = path.join(workspaceRoot, "outside-link");
    const insideLink = path.join(workspaceRoot, "inside-link");
    fs.mkdirSync(insideRoot, { recursive: true });

    try {
      fs.symlinkSync(
        outsideRoot,
        outsideLink,
        process.platform === "win32" ? "junction" : "dir"
      );
      fs.symlinkSync(
        insideRoot,
        insideLink,
        process.platform === "win32" ? "junction" : "dir"
      );

      expect(isPhysicalPathContainedWithinSync(workspaceRoot, outsideLink)).toBe(false);
      expect(
        isPhysicalPathContainedWithinSync(
          workspaceRoot,
          `${outsideLink}${path.sep}..${path.sep}escaped-child`
        )
      ).toBe(false);
      expect(isPhysicalPathContainedWithinSync(workspaceRoot, insideLink)).toBe(true);
      expect(
        isPhysicalPathContainedWithinSync(
          workspaceRoot,
          path.join(workspaceRoot, "missing", "child")
        )
      ).toBe(true);
      const missingChild = path.join(workspaceRoot, "missing", "child");
      await expect(
        planRouteLedgerBinding({
          binding: resolveRouteLedgerBinding({}, { autoCreateWorkspaceConfig: false }),
          workspaceRoot,
          routeledgerRoot: missingChild
        })
      ).resolves.toMatchObject({ status: "needs_init" });
      expect(
        resolveRouteLedgerBinding(
          { workspaceRoot, routeledgerRoot: outsideLink },
          { autoCreateWorkspaceConfig: false }
        ).status
      ).toBe("invalid");
      expect(
        resolveRouteLedgerBinding(
          {
            workspaceRoot,
            routeledgerRoot: `${outsideLink}${path.sep}..${path.sep}escaped-child`
          },
          { autoCreateWorkspaceConfig: false }
        ).status
      ).toBe("invalid");

      fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
      fs.writeFileSync(
        getDefaultWorkspaceConfigPath(workspaceRoot),
        `${JSON.stringify({ version: 1, dataDir: "outside-link" })}\n`,
        "utf8"
      );
      expect(
        resolveWorkspaceConfigSync({ projectRoot: workspaceRoot, autoCreate: false })
      ).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({
            code: "WORKSPACE_CONFIG_DATA_DIR_OUTSIDE_WORKSPACE"
          })
        ]
      });
      fs.writeFileSync(
        getDefaultWorkspaceConfigPath(workspaceRoot),
        `${JSON.stringify({ version: 1, dataDir: "inside-link" })}\n`,
        "utf8"
      );
      expect(
        resolveRouteLedgerBinding(
          { workspaceRoot, routeledgerRoot: insideRoot },
          { autoCreateWorkspaceConfig: false }
        )
      ).toMatchObject({ status: "uninitialized", routeledgerRoot: insideLink });
    } finally {
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("keeps the executing registry on session-rebind construction failure and close failure", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(cacheCwd);
    let buildCount = 0;
    let closeAttempted = false;
    let failNextBoundRegistryConstruction = true;
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex",
      registryFactory: (options: RouteLedgerMcpRegistryOptions) => {
        if (
          options.workspaceRoot === workspaceRoot &&
          failNextBoundRegistryConstruction
        ) {
          failNextBoundRegistryConstruction = false;
          throw new Error("injected registry construction failure");
        }
        buildCount += 1;
        const registry = createRouteLedgerMcpRegistry(options);
        if (buildCount !== 2) {
          return registry;
        }
        return {
          ...registry,
          close: () => {
            closeAttempted = true;
            registry.close();
            throw new Error("injected old registry close failure");
          }
        };
      }
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "rebind-failure-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.144.1" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const failedActivation = await callTool(
        server,
        "injected-rebind-failure",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      expect(failedActivation).toMatchObject({
        result: {
          isError: true,
          structuredContent: { ok: false, error: { code: "SESSION_REBIND_FAILED" } },
          _meta: { routeledger: { toolName: "activate_routeledger_binding" } }
        }
      });
      expect(JSON.stringify(failedActivation)).not.toContain('"activated"');
      expect(JSON.stringify(failedActivation)).not.toContain('"rebound":true');
      expect(getStructuredData<{ binding: { status: string } }>(
        await callTool(server, "rebind-failure-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { status: "unbound" } });

      // The pending request survives the failed construction. A subsequent
      // explicit activation builds the new registry, and an old close failure
      // cannot invalidate its already formed response.
      const successfulActivation = await callTool(
        server,
        "rebind-close-failure",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      expect(successfulActivation).toMatchObject({
        result: {
          structuredContent: { ok: true, data: { status: "activated", rebound: true } }
        }
      });
      expect(closeAttempted).toBe(true);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "rebind-close-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot } });
    } finally {
      server.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("open_mission_control returns INVALID_TOOL_INPUT when neither binding nor input provides routeledgerRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(workspaceRoot, { hostProfile: "codex" });

    try {
      const response = await registry.invoke("open_mission_control", {});

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.routeledgerRoot"
          }
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("open_mission_control rejects routeledgerRoot outside workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const response = await registry.invoke("open_mission_control", {
        routeledgerRoot: outsideRoot
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.routeledgerRoot",
            expected: "routeledgerRoot inside workspaceRoot"
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("discover_routeledger_roots returns a single candidate with active project summary", async () => {
    const workspaceRoot = createTempProjectRoot();
    const candidateRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(candidateRoot, { recursive: true });
    await initializeCanonicalProjectAtRoot(candidateRoot, "RouteLedger Docs");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedCandidateRoot = fs.realpathSync.native(candidateRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        workspaceRoot: resolvedWorkspaceRoot,
        status: "single_candidate",
        recommendedBinding: {
          workspaceRoot: resolvedWorkspaceRoot,
          routeledgerRoot: resolvedCandidateRoot,
          requiresUserDecision: false
        }
      });
      const discoveredCandidate = (
        response.data as { candidates: Array<Record<string, unknown>> }
      ).candidates[0]!;
      expect(discoveredCandidate).toMatchObject({
        routeledgerRoot: resolvedCandidateRoot,
        routeledgerDir: path.join(resolvedCandidateRoot, ".routeledger"),
        activeProject: {
          name: "RouteLedger Docs"
        },
        storage: expect.objectContaining({
          hasCanonicalJson: true
        })
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots and plan_routeledger_binding recognize split-root workspace config targets", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const bootstrapRegistry = createBindingRegistry({
      workspaceRoot,
      routeledgerRoot
    });
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const initResponse = await bootstrapRegistry.invoke("init_project", {
        name: "Split Root Discovery"
      });
      expect(initResponse.ok).toBe(true);

      const discoverResponse = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot
      });
      expect(discoverResponse).toMatchObject({
        ok: true,
        data: {
          workspaceRoot,
          status: "single_candidate",
          recommendedBinding: {
            workspaceRoot,
            routeledgerRoot,
            requiresUserDecision: false
          },
          candidates: [
            expect.objectContaining({
              routeledgerRoot,
              dataRoot: routeledgerRoot,
              routeledgerDir: path.join(routeledgerRoot, ".routeledger"),
              workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot)
            })
          ]
        }
      });

      const planResponse = await registry.invoke("plan_routeledger_binding", { workspaceRoot });
      expect(planResponse).toMatchObject({
        ok: true,
        data: {
          status: "ready",
          targetBinding: {
            workspaceRoot,
            routeledgerRoot,
            dataRoot: routeledgerRoot,
            routeledgerDir: path.join(routeledgerRoot, ".routeledger"),
            workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot)
          }
        }
      });
    } finally {
      bootstrapRegistry.close();
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots returns ambiguous when multiple candidates exist", async () => {
    const workspaceRoot = createTempProjectRoot();
    const docsRoot = path.join(workspaceRoot, "docs");
    const codeRoot = path.join(workspaceRoot, "code");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.mkdirSync(codeRoot, { recursive: true });
    await initializeCanonicalProjectAtRoot(docsRoot, "Docs RouteLedger");
    await initializeCanonicalProjectAtRoot(codeRoot, "Code RouteLedger");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedDocsRoot = fs.realpathSync.native(docsRoot);
    const resolvedCodeRoot = fs.realpathSync.native(codeRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          workspaceRoot: resolvedWorkspaceRoot,
          status: "ambiguous",
          recommendedBinding: null,
          candidates: [
            expect.objectContaining({
              routeledgerRoot: resolvedCodeRoot
            }),
            expect.objectContaining({
              routeledgerRoot: resolvedDocsRoot
            })
          ],
          recommendedNextActions: [
            expect.objectContaining({
              type: "ask_user_for_binding_root"
            })
          ]
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots surfaces malformed workspace config candidates as risky", async () => {
    const workspaceRoot = createTempProjectRoot();
    const candidateRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(path.join(candidateRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(candidateRoot),
      '{"version":1,"dataDir":',
      "utf8"
    );
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedCandidateRoot = fs.realpathSync.native(candidateRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: fs.realpathSync.native(workspaceRoot)
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        status: "single_candidate"
      });
      const discoveredCandidate = (
        response.data as { candidates: Array<Record<string, unknown>> }
      ).candidates[0]!;
      expect(discoveredCandidate).toMatchObject({
        routeledgerRoot: resolvedCandidateRoot,
        storage: {
          mode: "uninitialized"
        },
        risks: [
          expect.objectContaining({
            code: "WORKSPACE_CONFIG_MALFORMED_JSON",
            severity: "error"
          })
        ]
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("plan_routeledger_binding returns needs_init for an in-workspace root without .routeledger", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const registry = createProcessCwdRegistry(workspaceRoot, { hostProfile: "codex" });
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);

    try {
      const response = await registry.invoke("plan_routeledger_binding", {
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "needs_init",
          targetBinding: {
            workspaceRoot: resolvedWorkspaceRoot,
            routeledgerRoot: resolvedRouteledgerRoot,
            dataRoot: resolvedRouteledgerRoot,
            routeledgerDir: path.join(resolvedRouteledgerRoot, ".routeledger")
          },
          requiresInit: true,
          requiresHostConfigUpdate: true,
          requiresServerRestart: true,
          sessionActivation: {
            available: true,
            required: true,
            action: "activate_routeledger_binding"
          },
          persistentHostBinding: {
            requiredForFutureSessions: true,
            requiresHostConfigUpdate: true,
            requiresServerRestart: true
          },
          recommendedNextActions: [
            expect.objectContaining({
              type: "activate_session_binding",
              tool: "activate_routeledger_binding"
            }),
            expect.objectContaining({
              type: "initialize_routeledger",
              tool: "init_project"
            }),
            expect.objectContaining({
              type: "render_codex_config",
              tool: "render_host_binding_config"
            })
          ]
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("plan_routeledger_binding blocks roots outside workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const response = await registry.invoke("plan_routeledger_binding", {
        routeledgerRoot: outsideRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "blocked",
          targetBinding: null,
          checks: [
            expect.objectContaining({
              code: "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
              status: "blocked"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("plan_routeledger_binding separates Codex session activation from future-session config", async () => {
    const cacheCwd = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    await initializeCanonicalProjectAtRoot(targetRoot, "Planned target");
    const unboundRegistry = createProcessCwdRegistry(cacheCwd, { hostProfile: "codex" });
    const boundWorkspaceRoot = createTempProjectRoot();
    await initializeCanonicalProjectAtRoot(boundWorkspaceRoot, "Established binding");
    const boundRegistry = createRegistry(boundWorkspaceRoot, { hostProfile: "codex" });

    try {
      const unboundPlan = await unboundRegistry.invoke("plan_routeledger_binding", {
        workspaceRoot: targetRoot,
        routeledgerRoot: targetRoot
      });
      expect(unboundPlan).toMatchObject({
        ok: true,
        data: {
          status: "ready",
          requiresHostConfigUpdate: true,
          requiresServerRestart: true,
          sessionActivation: {
            available: true,
            required: true,
            action: "activate_routeledger_binding"
          },
          persistentHostBinding: {
            requiredForFutureSessions: true,
            requiresHostConfigUpdate: true,
            requiresServerRestart: true
          },
          recommendedNextActions: [
            expect.objectContaining({ tool: "activate_routeledger_binding" }),
            expect.objectContaining({ tool: "render_host_binding_config" })
          ]
        }
      });

      const establishedPlan = await boundRegistry.invoke("plan_routeledger_binding", {
        workspaceRoot: boundWorkspaceRoot,
        routeledgerRoot: boundWorkspaceRoot
      });
      expect(establishedPlan).toMatchObject({
        ok: true,
        data: {
          currentBinding: { status: "bound" },
          sessionActivation: {
            available: false,
            required: false,
            action: null
          },
          persistentHostBinding: {
            requiredForFutureSessions: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false
          },
          recommendedNextActions: []
        }
      });
      expect(
        (
          establishedPlan.data as {
            recommendedNextActions: Array<{ tool?: string }>;
          }
        ).recommendedNextActions.some((action) => action.tool === "activate_routeledger_binding")
      ).toBe(false);
    } finally {
      unboundRegistry.close();
      unboundRegistry.restore();
      boundRegistry.close();
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(targetRoot);
      cleanupProjectRoot(boundWorkspaceRoot);
    }
  });

  it("render_host_binding_config returns Codex config content and fragment plan without writing files", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, ".codex", "config.toml"),
      'existing = "keep-me"\n',
      "utf8"
    );
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);

    try {
      const blockedWithoutLauncher = await registry.invoke("render_host_binding_config", {
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });
      expect(blockedWithoutLauncher).toMatchObject({
        ok: true,
        data: {
          status: "blocked",
          launcherRequirement: {
            code: "STABLE_RUNTIME_LAUNCHER_REQUIRED"
          },
          renderedConfig: null,
          writePlan: null
        }
      });
      const response = await registry.invoke("render_host_binding_config", {
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot,
        routeLedgerWorkspaceRoot: process.cwd()
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          hostProfile: "codex",
          status: "ready",
          bindingPlan: {
            status: "needs_init",
            targetBinding: {
              routeledgerRoot: resolvedRouteledgerRoot
            }
          },
          renderedConfig: {
            format: "toml",
            content: expect.stringContaining('"--routeledger-root"')
          },
          writePlan: {
            kind: "fragment",
            path: path.join(resolvedWorkspaceRoot, ".codex", "routeledger.fragment.toml")
          }
        }
      });
      expect(
        fs.readFileSync(path.join(workspaceRoot, ".codex", "config.toml"), "utf8")
      ).toBe('existing = "keep-me"\n');
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("write_host_binding_config writes a project-level Codex config when none exists", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const configPath = path.join(workspaceRoot, ".codex", "config.toml");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);
    const resolvedConfigPath = path.join(resolvedWorkspaceRoot, ".codex", "config.toml");

    try {
      const response = await registry.invoke("write_host_binding_config", {
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot,
        routeLedgerWorkspaceRoot: process.cwd()
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          hostProfile: "codex",
          status: "ready",
          bindingPlan: {
            status: "needs_init",
            targetBinding: {
              workspaceRoot: resolvedWorkspaceRoot,
              routeledgerRoot: resolvedRouteledgerRoot
            }
          },
          writeResult: {
            kind: "project-config",
            path: resolvedConfigPath,
            created: true,
            warnings: []
          }
        }
      });
      expect(fs.readFileSync(configPath, "utf8")).toContain('"--workspace-root"');
      expect(fs.readFileSync(configPath, "utf8")).toContain(`"${resolvedWorkspaceRoot}"`);
      expect(fs.readFileSync(configPath, "utf8")).toContain('"--routeledger-root"');
      expect(fs.readFileSync(configPath, "utf8")).toContain(`"${resolvedRouteledgerRoot}"`);
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context and blocked write preflight now recommend discover/plan before init or host updates", async () => {
    const uninitializedRoot = createTempProjectRoot();
    const uninitializedRegistry = createBindingRegistry({
      workspaceRoot: uninitializedRoot,
      routeledgerRoot: uninitializedRoot
    });
    const unboundRoot = createTempProjectRoot();
    const unboundRegistry = createProcessCwdRegistry(unboundRoot);

    try {
      const runtimeResponse = await uninitializedRegistry.invoke("get_runtime_context", {});
      expect(runtimeResponse).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized"
          },
          recommendedNextActions: [
            expect.objectContaining({
              type: "inspect_runtime",
              tool: "get_runtime_context"
            }),
            expect.objectContaining({
              type: "inspect_workspace",
              tool: "discover_routeledger_roots"
            }),
            expect.objectContaining({
              type: "plan_binding",
              tool: "plan_routeledger_binding"
            }),
            expect.objectContaining({
              type: "initialize_routeledger",
              tool: "init_project"
            })
          ]
        }
      });

      const blockedWrite = await unboundRegistry.invoke("create_todo", {
        projectId: "project-1",
        versionId: "version-1",
        title: "todo"
      });
      expect(blockedWrite).toMatchObject({
        ok: false,
        error: {
          code: "ROUTELEDGER_BINDING_REQUIRED",
          details: {
            recommendedNextActions: expect.arrayContaining([
            expect.objectContaining({
              type: "activate_explicit_workspace_binding",
              tool: "activate_routeledger_binding"
            })
            ])
          }
        }
      });
    } finally {
      uninitializedRegistry.close();
      unboundRegistry.close();
      unboundRegistry.restore();
      cleanupProjectRoot(uninitializedRoot);
      cleanupProjectRoot(unboundRoot);
    }
  });

  it("migrated read-tool adapters preserve success data/meta contracts and keep runtimeContext aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex"
    });
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const projectId = initData.project.id;

      const nextVersionId = await createAndCommitVersion(server, projectId, "Doc Drift Current");
      await setCurrentVersionWithApproval(server, projectId, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        ["# RouteLedger", "", "Current docs still mention Initial Version.", "current line is stale."].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        "# Entry\n旧 QA 路径：docs/qa/legacy-checklist.md\n",
        "utf8"
      );

      const registryContextResponse = await registry.invoke("get_current_context", {
        projectId,
        unknownField: "still-ignored"
      } as any);
      const serverContextResponse = await callTool(
        server,
        "stdio-context",
        "get_current_context",
        {
          projectId
        }
      );
      const registryWindowResponse = await registry.invoke("list_versions_window", {
        projectId,
        extraField: "still-ignored"
      } as any);
      const serverWindowResponse = await callTool(
        server,
        "stdio-window",
        "list_versions_window",
        {
          projectId
        }
      );
      const registryDocDriftResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });
      const serverDocDriftResponse = await callTool(
        server,
        "stdio-doc-drift",
        "check_doc_drift",
        {
          projectId,
          entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
          expectedPointers: [
            {
              kind: "qa",
              path: "docs/qa/current-checklist.md"
            }
          ]
        }
      );

      const serverContextStructured = (
        serverContextResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;
      const serverWindowStructured = (
        serverWindowResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;
      const serverDocDriftStructured = (
        serverDocDriftResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;

      expect(Object.keys(registryContextResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryContextResponse).toEqual({
        ok: true,
        data: serverContextStructured.data,
        meta: serverContextStructured.meta
      });
      expect(registryContextResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });

      expect(Object.keys(registryWindowResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryWindowResponse).toEqual({
        ok: true,
        data: serverWindowStructured.data,
        meta: serverWindowStructured.meta
      });
      expect(registryWindowResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });

      expect(Object.keys(registryDocDriftResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryDocDriftResponse).toEqual({
        ok: true,
        data: serverDocDriftStructured.data,
        meta: serverDocDriftStructured.meta
      });
      expect(registryDocDriftResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });
      expect(registryDocDriftResponse.data).toMatchObject({
        routeTruth: {
          currentVersion: {
            id: nextVersionId,
            title: "Doc Drift Current"
          }
        }
      });

    } finally {
      server?.close();
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("registry.invoke returns tool-level INVALID_TOOL_INPUT for migrated read-tool adapters", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const projectId = (initResponse.data as { project: { id: string } }).project.id;

      const invalidContextResponse = await registry.invoke("get_current_context", {
        projectId: 123
      });
      const invalidRootResponse = await registry.invoke("get_current_context", null as any);
      const invalidDocDriftResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: "README.md"
      });
      const invalidDocDriftNestedResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: ["README.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md",
            required: "yes"
          }
        ]
      });
      const invalidWindowResponse = await registry.invoke("list_versions_window", {
        projectId,
        before: "2"
      });
      const permissiveContextResponse = await registry.invoke("get_current_context", {
        projectId,
        unknownField: "pilot-boundary"
      } as any);

      expect(invalidContextResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "get_current_context",
            path: "$.projectId"
          }
        }
      });
      expect(invalidRootResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "get_current_context",
            path: "$.projectId"
          }
        }
      });
      expect(invalidDocDriftResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "check_doc_drift",
            path: "$.entryFiles"
          }
        }
      });
      expect(invalidDocDriftNestedResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "check_doc_drift",
            path: "$.expectedPointers[0].required"
          }
        }
      });
      expect(invalidWindowResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "list_versions_window",
            path: "$.before"
          }
        }
      });
      expect(permissiveContextResponse.ok).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context reports uninitialized bindings without requiring projectId", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized",
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot,
            workspaceConfigPath: getDefaultWorkspaceConfigPath(projectRoot),
            dataRoot: getDefaultDataRoot(projectRoot),
            routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot)
          },
          processCwd: process.cwd(),
          diagnostics: [],
          storage: {
            mode: "uninitialized",
            hasCanonicalJson: false,
            hasSqlite: false,
            jsonProjectPath: getDefaultJsonProjectPath(projectRoot),
            sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
          },
          activeProject: null,
          hostProfile: "generic",
          actor: {
            id: "mcp-agent",
            displayName: "routeledger-mcp"
          },
          approver: {
            id: "mcp-user",
            displayName: "routeledger-mcp-user"
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context stays unbound on process.cwd fallback and does not auto-create workspace config", async () => {
    const workspaceRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(workspaceRoot);
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const response = await registry.invoke("get_runtime_context", {});
      const cwdAfterChdir = process.cwd();

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "unbound",
            workspaceRoot: cwdAfterChdir,
            workspaceRootSource: "process_cwd",
            workspaceRootConfidence: "low",
            routeledgerRoot: null
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_ROOT_UNTRUSTED"
            })
          ]
        }
      });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(false);
    } finally {
      registry.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("initialize rootUri binds workspaceRoot from MCP roots and resolves routeledgerRoot from workspace config", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex"
    });

    try {
      const initializeResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {},
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize"
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const response = await callTool(server, "runtime-context", "get_runtime_context", {});

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                workspaceRootConfidence: "high",
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("roots/list after initialized binds workspaceRoot when initialize omitted rootUri and roots", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      const initializeResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });

      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const rootsListRequest = expectSingleRootsListRequest(outboundMessages);

      const listResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: rootsListRequest.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(workspaceRoot).href
            }
          ]
        }
      });

      expect(listResponse).toBeNull();

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-list",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                workspaceRootConfidence: "high",
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("delayed Roots rebuild retains the old registry on construction failure and survives old close failure", async () => {
    const workspaceA = createTempProjectRoot();
    const workspaceB = createTempProjectRoot();
    let failWorkspaceBOnce = true;
    let oldWorkspaceACloseAttempted = false;
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex",
      registryFactory: (options: RouteLedgerMcpRegistryOptions) => {
        const roots = options.mcpRoots ?? [];
        if (roots.includes(workspaceB) && failWorkspaceBOnce) {
          failWorkspaceBOnce = false;
          throw new Error("injected delayed Roots construction failure");
        }
        const registry = createRouteLedgerMcpRegistry(options);
        if (!roots.includes(workspaceA)) {
          return registry;
        }
        return {
          ...registry,
          close: () => {
            oldWorkspaceACloseAttempted = true;
            registry.close();
            throw new Error("injected delayed Roots old close failure");
          }
        };
      }
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "delayed-roots-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: {} },
          clientInfo: { name: "vitest", version: "0.0.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const rootsRequestA = expectSingleRootsListRequest(outboundMessages);
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestA.id,
          result: { roots: [{ uri: pathToFileURL(workspaceA).href }] }
        })
      ).toBeNull();
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-a-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceA } });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });
      const rootsRequestBFailure = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestBFailure.id,
          result: { roots: [{ uri: pathToFileURL(workspaceB).href }] }
        })
      ).toBeNull();
      expect(oldWorkspaceACloseAttempted).toBe(false);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-a-survives-failure", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceA } });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });
      const rootsRequestBSuccess = outboundMessages[2] as JsonRpcMessage & {
        id: string | number;
      };
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestBSuccess.id,
          result: { roots: [{ uri: pathToFileURL(workspaceB).href }] }
        })
      ).toBeNull();
      expect(oldWorkspaceACloseAttempted).toBe(true);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-b-after-close-failure", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceB } });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceA);
      cleanupProjectRoot(workspaceB);
    }
  });

  it("roots/list errors do not crash and initialize rootUri binding remains authoritative", async () => {
    const workspaceRoot = createTempProjectRoot();
    const alternateWorkspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const rootsListRequest = expectSingleRootsListRequest(outboundMessages);

      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsListRequest.id,
          error: {
            code: -32601,
            message: "Method not found"
          }
        })
      ).toBeNull();

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-rooturi-survives-error",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      expect(outboundMessages).toHaveLength(2);
      const refreshRequest = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(refreshRequest).toMatchObject({
        jsonrpc: "2.0",
        method: "roots/list"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: refreshRequest.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(alternateWorkspaceRoot).href
            }
          ]
        }
      });

      const runtimeContextAfterRefresh = await callTool(
        server,
        "runtime-context-rooturi-survives-refresh",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextAfterRefresh).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(alternateWorkspaceRoot);
    }
  });

  it("roots/list_changed empty or invalid roots do not clear the last valid listed root binding", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const firstRequest = expectSingleRootsListRequest(outboundMessages);
      await server.handleMessage({
        jsonrpc: "2.0",
        id: firstRequest.id,
        result: {
          roots: [{ uri: pathToFileURL(workspaceRoot).href }]
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const emptyRequest = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      await server.handleMessage({
        jsonrpc: "2.0",
        id: emptyRequest.id,
        result: {
          roots: []
        }
      });

      let runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-empty-preserves-binding",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const invalidRequest = outboundMessages[2] as JsonRpcMessage & {
        id: string | number;
      };
      await server.handleMessage({
        jsonrpc: "2.0",
        id: invalidRequest.id,
        result: {
          roots: [
            { uri: "https://example.com/not-a-file-root" },
            { uri: "not-a-uri" },
            {}
          ]
        }
      });

      runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-invalid-preserves-binding",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("latest roots/list response wins when earlier request returns after a newer refresh", async () => {
    const oldWorkspaceRoot = createTempProjectRoot();
    const newWorkspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(newWorkspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(newWorkspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(newWorkspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const requestA = expectSingleRootsListRequest(outboundMessages);

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const requestB = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(requestB).toMatchObject({
        jsonrpc: "2.0",
        method: "roots/list"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: requestB.id,
        result: {
          roots: [{ uri: pathToFileURL(newWorkspaceRoot).href }]
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: requestA.id,
        result: {
          roots: [{ uri: pathToFileURL(oldWorkspaceRoot).href }]
        }
      });

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-latest-roots-list-wins",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot: newWorkspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      const malformedResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: requestB.id,
        result: undefined,
        error: {
          code: -32600,
          message: "should fail validation"
        }
      });
      expect(malformedResponse).toMatchObject({
        jsonrpc: "2.0",
        id: requestB.id,
        error: {
          code: -32600
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(oldWorkspaceRoot);
      cleanupProjectRoot(newWorkspaceRoot);
    }
  });

  it("initialize rootUri on a fresh workspace bootstraps default config and allows init_project", async () => {
    const workspaceRoot = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {},
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-fresh-rooturi",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot: workspaceRoot,
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                dataRoot: workspaceRoot
              }
            }
          }
        }
      });

      const initResponse = await callTool(server, "init-project-fresh-rooturi", "init_project", {
        name: "Fresh RootUri Workspace",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expect(
        getStructuredData<{
          project: { name: string };
        }>(initResponse)
      ).toMatchObject({
        project: {
          name: "Fresh RootUri Workspace"
        }
      });

      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(true);
      expect(
        fs.readFileSync(getDefaultWorkspaceConfigPath(workspaceRoot), "utf8")
      ).toContain('"dataDir": "."');
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(true);
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context does not create an empty SQLite file and keeps data/meta binding status aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      expect(fs.existsSync(getDefaultSqliteDbPath(projectRoot))).toBe(false);

      const response = await registry.invoke("get_runtime_context", {});

      expect(response.ok).toBe(true);
      expect(fs.existsSync(getDefaultSqliteDbPath(projectRoot))).toBe(false);
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized"
          }
        },
        meta: {
          runtimeContext: {
            binding: {
              status: "uninitialized"
            }
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("malformed workspace config does not crash registry and returns structured invalid diagnostics", async () => {
    const projectRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(projectRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(getDefaultWorkspaceConfigPath(projectRoot), '{"version":1,"dataDir":', "utf8");

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const runtimeResponse = await registry.invoke("get_runtime_context", {});
      const discoverResponse = await registry.invoke("discover_routeledger_roots", {});
      const planResponse = await registry.invoke("plan_routeledger_binding", {});
      const initResponse = await registry.invoke("init_project", {
        name: "Broken Config",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(runtimeResponse).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_MALFORMED_JSON"
            })
          ]
        }
      });
      expect(discoverResponse.ok).toBe(true);
      expect(planResponse.ok).toBe(true);
      expect(initResponse).toMatchObject({
        ok: false,
        error: {
          code: "ROUTELEDGER_BINDING_INVALID"
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("absolute workspace dataDir is rejected as invalid", async () => {
    const workspaceRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "/tmp/routeledger-data" }, null, 2)}\n`,
      "utf8"
    );

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot: workspaceRoot
    });

    try {
      const response = await registry.invoke("get_runtime_context", {});
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_DATA_DIR_ABSOLUTE"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("workspace-outside dataDir is rejected as invalid", async () => {
    const workspaceRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "../elsewhere" }, null, 2)}\n`,
      "utf8"
    );

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot: workspaceRoot
    });

    try {
      const response = await registry.invoke("get_runtime_context", {});
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_DATA_DIR_OUTSIDE_WORKSPACE"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context reports canonical JSON binding for initialized projects", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger Runtime Context",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);

      const initData = initResponse.data as {
        project: { id: string; name: string; currentVersionId: string | null };
      };
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "bound",
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          },
          storage: {
            mode: "json+sqlite",
            hasCanonicalJson: true,
            hasSqlite: true
          },
          activeProject: {
            source: "canonical_json",
            id: initData.project.id,
            name: initData.project.name,
            currentVersionId: initData.project.currentVersionId
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context does not clean up interrupted canonical replacement state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger Runtime Context",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);

      const replacementRoot = path.join(getDefaultCanonicalJsonRoot(projectRoot), ".canonical-replace");
      fs.mkdirSync(path.join(replacementRoot, "next", "todos", "xx"), { recursive: true });
      fs.writeFileSync(
        path.join(replacementRoot, "next", "todos", "xx", "staged.json"),
        "{}",
        "utf8"
      );

      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          storage: {
            mode: "json+sqlite",
            hasCanonicalJson: true
          }
        }
      });
      expect(fs.existsSync(replacementRoot)).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context reports SQLite-only fallback without materializing canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const seeded = await createSqliteOnlyProject(projectRoot);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);

      const registry = createRegistry(projectRoot);

      try {
        const response = await registry.invoke("get_runtime_context", {});

        expect(response).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "sqlite",
              hasCanonicalJson: false,
              hasSqlite: true
            },
            activeProject: {
              source: "sqlite",
              id: seeded.projectId,
              name: "SQLite Only Project",
              currentVersionId: seeded.initialVersionId
            }
          }
        });
        expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("SQLite-disabled runtime ignores legacy SQLite and writes only canonical JSON", async () => {
    const legacyProjectRoot = createTempProjectRoot();
    const jsonProjectRoot = createTempProjectRoot();

    try {
      await createSqliteOnlyProject(legacyProjectRoot);
      const legacyRegistry = createRegistry(legacyProjectRoot, {
        sqliteReadModel: "disabled"
      });

      try {
        const response = await legacyRegistry.invoke("get_runtime_context", {});

        expect(response).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "uninitialized",
              sqliteReadModel: "disabled",
              hasCanonicalJson: false,
              hasSqlite: true,
              sqliteError: null
            },
            activeProject: null
          }
        });
      } finally {
        legacyRegistry.close();
      }

      const jsonRegistry = createRegistry(jsonProjectRoot, {
        sqliteReadModel: "disabled"
      });

      try {
        const initResponse = await jsonRegistry.invoke("init_project", {
          name: "JSON Only Runtime",
          expectedRouteLedgerRoot: jsonProjectRoot
        });
        expect(initResponse.ok).toBe(true);

        const contextResponse = await jsonRegistry.invoke("get_runtime_context", {});
        expect(contextResponse).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "json",
              sqliteReadModel: "disabled",
              hasCanonicalJson: true,
              hasSqlite: false,
              sqliteError: null
            },
            activeProject: {
              source: "canonical_json",
              name: "JSON Only Runtime"
            }
          }
        });
        const initData = initResponse.data as { project: { id: string } };
        const currentContextResponse = await jsonRegistry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        expect(currentContextResponse.ok).toBe(true);
        expect(fs.existsSync(getDefaultSqliteDbPath(jsonProjectRoot))).toBe(false);
      } finally {
        jsonRegistry.close();
      }
    } finally {
      cleanupProjectRoot(legacyProjectRoot);
      cleanupProjectRoot(jsonProjectRoot);
    }
  });

  it("get_runtime_context reports unreadable SQLite files as sqlite_unavailable", async () => {
    const projectRoot = createTempProjectRoot();
    ensureDefaultWorkspaceConfig(projectRoot);
    const databasePath = getDefaultSqliteDbPath(projectRoot);

    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a sqlite database", "utf8");

    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          storage: {
            mode: "sqlite_unavailable",
            hasCanonicalJson: false,
            hasSqlite: true
          },
          activeProject: null
        }
      });
      expect(
        (response.data as { storage?: { sqliteError?: unknown } }).storage?.sqliteError
      ).not.toBeNull();
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context exposes both process cwd and server project root when they differ", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});
      const data = response.data as {
        processCwd: string;
        binding: {
          workspaceRoot: string;
          routeledgerRoot: string;
        };
      };

      expect(response.ok).toBe(true);
      expect(data.processCwd).toBe(process.cwd());
      expect(data.binding.workspaceRoot).toBe(projectRoot);
      expect(data.binding.routeledgerRoot).toBe(projectRoot);
      expect(data.processCwd).not.toBe(projectRoot);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP read tools recover from canonical JSON when SQLite is missing", async () => {
    const projectRoot = createTempProjectRoot();
    const initialRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await initialRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      initialRegistry.close();
      removeSqliteFiles(projectRoot);

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        const versionsWindowResponse = await registry.invoke("list_versions_window", {
          projectId: initData.project.id
        });
        const proposalsResponse = await registry.invoke("list_l3_proposals", {
          projectId: initData.project.id
        });
        const nextActionResponse = await registry.invoke("next_action", {
          projectId: initData.project.id
        });
        const batchPreflightResponse = await registry.invoke("batch_create_versions", {
          projectId: initData.project.id,
          mode: "preflight",
          items: [
            {
              clientKey: "version-2",
              title: "Version 2",
              description: "json-only preflight",
              initialTodos: []
            }
          ]
        });

        expect(contextResponse.ok).toBe(true);
        expect(versionsWindowResponse.ok).toBe(true);
        expect(proposalsResponse.ok).toBe(true);
        expect(nextActionResponse.ok).toBe(true);
        expect(batchPreflightResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(
          initData.project.id
        );
        expect(
          (
            batchPreflightResponse.data as {
              headRevision: string;
            }
          ).headRevision
        ).toHaveLength(64);
        expect(
          (versionsWindowResponse.data as { versions: Array<{ id: string }> }).versions.map(
            (version) => version.id
          )
        ).toEqual([initData.initialVersion.id]);
        expect(proposalsResponse.data).toEqual([]);
        expect(
          fs.existsSync(getDefaultSqliteDbPath(projectRoot))
        ).toBe(true);
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP returns WRITE_IN_PROGRESS in structuredContent while a writer lock is active", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: {
                  id: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const writeLock = await acquireRouteLedgerJsonWriteLock(getDefaultDataRoot(projectRoot), {
        ownerId: "busy-writer",
        retryAfterMs: 450,
        staleAfterMs: 30_000
      });

      try {
        const contextResponse = await callTool(server, "context-busy", "get_current_context", {
          projectId: projectData.project.id
        });

        expect(contextResponse).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              ok: false,
              error: {
                code: "WRITE_IN_PROGRESS",
                details: {
                  projectRoot: path.resolve(getDefaultDataRoot(projectRoot)),
                  retryAfterMs: 450,
                  staleAfterMs: 30_000
                }
              }
            }
          }
        });
      } finally {
        await writeLock.release();
      }

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP recovers a stale writer lock instead of staying permanently busy", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const registry = createRegistry(projectRoot);
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const writeLock = await acquireRouteLedgerJsonWriteLock(getDefaultDataRoot(projectRoot), {
        ownerId: "stale-writer",
        retryAfterMs: 100,
        staleAfterMs: 5
      });
      const metadataPath = path.join(writeLock.lockPath, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        updatedAt: string;
      };
      metadata.updatedAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const contextResponse = await registry.invoke("get_current_context", {
        projectId
      });
      expect(contextResponse.ok).toBe(true);

      const prepareResponse = await registry.invoke("prepare_version", {
        projectId,
        versionId: (initResponse.data as { initialVersion: { id: string } }).initialVersion.id
      });
      expect(prepareResponse.ok).toBe(true);
      expect(fs.existsSync(writeLock.lockPath)).toBe(false);

      registry.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP falls back to canonical JSON when SQLite file is corrupted", async () => {
    const projectRoot = createTempProjectRoot();
    const initialRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await initialRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      initialRegistry.close();

      const databasePath = getDefaultSqliteDbPath(projectRoot);
      fs.writeFileSync(databasePath, "not-a-valid-sqlite-database", "utf8");
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        const proposalsResponse = await registry.invoke("list_l3_proposals", {
          projectId: initData.project.id
        });

        expect(contextResponse.ok).toBe(true);
        expect(proposalsResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(
          initData.project.id
        );
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP write operations update canonical JSON and survive SQLite deletion across restart", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };
      const baselineDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2"
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const approveResponse = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId
      });
      expect(approveResponse.ok).toBe(true);
      const approvalArtifactId = (approveResponse.data as { id: string }).id;

      const commitResponse = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        approvalArtifactId
      });
      expect(commitResponse.ok).toBe(true);

      const updatedDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));
      expect(updatedDocuments.length).toBeGreaterThan(baselineDocuments.length);
      expect(updatedDocuments.some((document) => document.content.includes('"title": "Version 2"'))).toBe(
        true
      );

      registry.close();
      removeSqliteFiles(projectRoot);

      const restartedRegistry = createRegistry(projectRoot);

      try {
        const versionsWindowResponse = await restartedRegistry.invoke("list_versions_window", {
          projectId: initData.project.id,
          before: 5,
          after: 5
        });
        expect(versionsWindowResponse.ok).toBe(true);
        expect(
          (versionsWindowResponse.data as { versions: Array<{ title: string }> }).versions.map(
            (version) => version.title
          )
        ).toEqual(["Initial Version", "Version 2"]);
      } finally {
        restartedRegistry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions propose returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const firstPromise = firstRegistry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        items: [
          {
            clientKey: "plan-b",
            title: "Plan B",
            description: "batch item B",
            initialTodos: []
          }
        ]
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true,
        data: {
          ok: true,
          pendingOperationId: expect.any(String)
        }
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
      const proposals = await secondRegistry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposals.ok).toBe(true);
      expect((proposals.data as Array<{ id: string }>)).toHaveLength(1);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("commit_l3_operation same proposal returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const proposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Same Proposal",
        projectRoot
      );
      const firstPromise = firstRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: proposal.pendingOperationId,
        approvalArtifactId: proposal.approvalArtifactId
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: proposal.pendingOperationId,
        approvalArtifactId: proposal.approvalArtifactId
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("commit_l3_operation different proposals returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const firstProposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Proposal A",
        projectRoot
      );
      const secondProposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Proposal B",
        projectRoot
      );
      const firstPromise = firstRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: firstProposal.pendingOperationId,
        approvalArtifactId: firstProposal.approvalArtifactId
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: secondProposal.pendingOperationId,
        approvalArtifactId: secondProposal.approvalArtifactId
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON/SQLite project mismatch returns a clear conflict instead of silently overwriting", async () => {
    const sqliteRoot = createTempProjectRoot();
    const jsonRoot = createTempProjectRoot();

    try {
      const sqliteRegistry = createRegistry(sqliteRoot);
      const jsonRegistry = createRegistry(jsonRoot);

      const sqliteInit = await sqliteRegistry.invoke("init_project", {
        name: "SQLite Project"
      });
      const jsonInit = await jsonRegistry.invoke("init_project", {
        name: "JSON Project"
      });

      expect(sqliteInit.ok).toBe(true);
      expect(jsonInit.ok).toBe(true);

      const sqliteProjectId = (sqliteInit.data as { project: { id: string } }).project.id;
      const jsonProjectId = (jsonInit.data as { project: { id: string } }).project.id;
      const jsonDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(jsonRoot));

      await replaceRouteLedgerJsonDocuments({
        outputRoot: getDefaultDataRoot(sqliteRoot),
        documents: jsonDocuments
      });

      sqliteRegistry.close();
      jsonRegistry.close();

      const conflictRegistry = createRegistry(sqliteRoot);

      try {
        const response = await conflictRegistry.invoke("get_current_context", {
          projectId: jsonProjectId
        });

        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "JSON_SQLITE_CONFLICT"
          }
        });
        expect(response.error?.details).toMatchObject({
          canonicalProjectId: jsonProjectId,
          sqliteProjectId: sqliteProjectId
        });
      } finally {
        conflictRegistry.close();
      }
    } finally {
      cleanupProjectRoot(sqliteRoot);
      cleanupProjectRoot(jsonRoot);
    }
  });

  it("config-backed SQLite-only projects still load, and the first MCP write materializes canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const seeded = await createSqliteOnlyProject(projectRoot);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: seeded.projectId
        });
        expect(contextResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(seeded.projectId);

        const prepareResponse = await registry.invoke("prepare_version", {
          projectId: seeded.projectId,
          versionId: seeded.initialVersionId
        });
        expect(prepareResponse.ok).toBe(true);
      } finally {
        registry.close();
      }

      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(true);

      removeSqliteFiles(projectRoot);

      const restartedRegistry = createRegistry(projectRoot);

      try {
        const contextResponse = await restartedRegistry.invoke("get_current_context", {
          projectId: seeded.projectId
        });
        expect(contextResponse.ok).toBe(true);
      } finally {
        restartedRegistry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("business failures stay in CallToolResult isError instead of protocol errors", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: {
                  id: string;
                };
                initialVersion: {
                  id: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.data;

      await callTool(server, "prepare-version", "prepare_version", {
        projectId: projectData.project.id,
        versionId: projectData.initialVersion.id
      });

      const proposalResponse = await callTool(server, "proposal", "propose_l3_operation", {
        projectId: projectData.project.id,
        actionType: "start_version",
        targetId: projectData.initialVersion.id,
        reason: "start current version"
      });
      const pendingOperationId = (
        proposalResponse as {
          result: {
            structuredContent: {
              data: {
                id: string;
              };
            };
          };
        }
      ).result.structuredContent.data.id;

      const commitResponse = await callTool(server, "commit", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId,
        approvalArtifactId: ""
      });

      expect(commitResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "commit",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions tool schema exposes mode/items/setCurrentTo", () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const tool = registry.getTool("batch_create_versions");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: ["projectId", "mode", "items"],
        properties: {
          mode: {
            enum: ["preflight", "propose"]
          },
          items: {
            type: "array"
          },
          setCurrentTo: {
            type: "string"
          }
        }
      });
      expect(
        (
          tool?.inputSchema as {
            properties: {
              items: {
                items: {
                  required: string[];
                };
              };
            };
          }
        ).properties.items.items.required
      ).toEqual(["clientKey", "title", "description", "initialTodos"]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions returns structured preflight/propose results", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidPreflight = await callTool(server, "batch-invalid", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "preflight",
        partialAllowed: true,
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const validPropose = await callTool(server, "batch-propose", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        anchor: {
          afterVersionId: initData.initialVersion.id
        },
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: ["write docs"]
          }
        ]
      });

      expect(invalidPreflight).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-invalid",
        result: {
          structuredContent: {
            ok: true,
            data: {
              ok: false,
              code: "BATCH_VERSION_PLAN_INVALID"
            }
          }
        }
      });
      expect(validPropose).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-propose",
        result: {
          structuredContent: {
            ok: true,
            data: {
              ok: true,
              pendingOperationId: expect.any(String)
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 非法 mode 在 MCP 协议层被拒绝，且不会创建 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidMode = await callTool(server, "batch-bad-mode", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await callTool(server, "context-after-bad-mode", "get_current_context", {
        projectId: initData.project.id
      });
      const contextData = getStructuredData<{
        pendingL3Proposals: Array<unknown>;
        versions: Array<{ id: string }>;
      }>(contextResponse);

      expect(invalidMode).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-bad-mode",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.mode"
              }
            }
          }
        }
      });
      expect(contextData.pendingL3Proposals).toEqual([]);
      expect(contextData.versions).toHaveLength(1);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 非法 mode 在 registry.invoke 运行时被拒绝，且不会创建 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const invalidMode = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await registry.invoke("get_current_context", {
        projectId: initData.project.id
      });

      expect(invalidMode).toMatchObject({
        ok: false,
        error: {
          code: "BATCH_CREATE_VERSIONS_MODE_INVALID",
          details: {
            receivedMode: "typo",
            allowedModes: ["preflight", "propose"]
          }
        }
      });
      expect(contextResponse.data).toMatchObject({
        pendingL3Proposals: []
      });
      expect(
        (contextResponse.data as {
          versions: Array<{ id: string }>;
        }).versions
      ).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 非法 previousCurrentPolicy 在 MCP 协议层被拒绝，且不会创建 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidPolicy = await callTool(server, "batch-bad-policy", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        previousCurrentPolicy: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await callTool(server, "context-after-bad-policy", "get_current_context", {
        projectId: initData.project.id
      });
      const contextData = getStructuredData<{
        pendingL3Proposals: Array<unknown>;
        versions: Array<{ id: string }>;
      }>(contextResponse);

      expect(invalidPolicy).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-bad-policy",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.previousCurrentPolicy"
              }
            }
          }
        }
      });
      expect(contextData.pendingL3Proposals).toEqual([]);
      expect(contextData.versions).toHaveLength(1);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 非法 previousCurrentPolicy 在 registry.invoke 运行时被拒绝，且不会创建 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const invalidPolicy = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        previousCurrentPolicy: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await registry.invoke("get_current_context", {
        projectId: initData.project.id
      });

      expect(invalidPolicy).toMatchObject({
        ok: false,
        error: {
          code: "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
          details: {
            receivedPreviousCurrentPolicy: "typo",
            allowedPreviousCurrentPolicies: ["leave_as_is", "require_complete_or_close"]
          }
        }
      });
      expect(contextResponse.data).toMatchObject({
        pendingL3Proposals: []
      });
      expect(
        (contextResponse.data as {
          versions: Array<{ id: string }>;
        }).versions
      ).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("transition_version tool follows live state and only proposes the next actionable L3 step", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const targetVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Next Version"
      );

      await callTool(server, "prepare-target", "prepare_version", {
        projectId: initData.project.id,
        versionId: targetVersionId
      });

      const dryRunBeforeSwitch = await callTool(
        server,
        "transition-dry-run-1",
        "transition_version",
        {
          projectId: initData.project.id,
          versionId: targetVersionId
        }
      );

      expect(getStructuredData<{
        nextActionType: string;
        stepsRemaining: string[];
      }>(dryRunBeforeSwitch)).toMatchObject({
        nextActionType: "set_current_version",
        stepsRemaining: ["set_current_version", "start_version"]
      });

      const proposeSwitch = await callTool(server, "transition-propose-1", "transition_version", {
        projectId: initData.project.id,
        versionId: targetVersionId,
        mode: "propose"
      });
      const switchData = getStructuredData<{
        pendingOperationId: string;
        proposedActionType: string;
      }>(proposeSwitch);

      expect(switchData).toMatchObject({
        proposedActionType: "set_current_version",
        pendingOperationId: expect.any(String)
      });

      const approveSwitch = await callTool(server, "approve-switch", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: switchData.pendingOperationId
      });
      const approveSwitchData = getStructuredData<{ id: string }>(approveSwitch);

      await callTool(server, "commit-switch", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: switchData.pendingOperationId,
        approvalArtifactId: approveSwitchData.id
      });

      const dryRunAfterSwitch = await callTool(
        server,
        "transition-dry-run-2",
        "transition_version",
        {
          projectId: initData.project.id,
          versionId: targetVersionId
        }
      );

      expect(getStructuredData<{
        nextActionType: string;
        stepsRemaining: string[];
      }>(dryRunAfterSwitch)).toMatchObject({
        nextActionType: "start_version",
        stepsRemaining: ["start_version"]
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("close_version / carry_forward_undo / get_version_structure tools preserve block-first and downstream-undo semantics", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;

      await callTool(server, "prepare-initial", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-initial", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });

      const blockedClose = await callTool(server, "blocked-close", "close_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose"
      });
      const blockedCloseData = getStructuredData<{
        status: string;
        blockers: Array<{ code: string }>;
      }>(blockedClose);
      const proposalList = await callTool(server, "proposal-list", "list_l3_proposals", {
        projectId: initData.project.id
      });
      const proposalListData = getStructuredData<Array<{ status: string }>>(proposalList);
      const downstreamVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Downstream"
      );
      const legacyRegistry = createRegistry(projectRoot);
      const createdUndo = await legacyRegistry.invoke("create_undo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: initData.initialVersion.id,
        title: "route later",
        reason: "defer downstream"
      });
      const createdUndoData = createdUndo.data as {
        undo: { id: string };
      };
      const blockingStructureResponse = await callTool(
        server,
        "blocking-structure",
        "get_version_structure",
        {
          projectId: initData.project.id,
          versionId: initData.initialVersion.id
        }
      );
      const blockingStructureData = getStructuredData<{
        legalOperations: Array<Record<string, any>>;
      }>(blockingStructureResponse);
      const carryForward = await legacyRegistry.invoke("carry_forward_undo", {
        projectId: initData.project.id,
        undoId: createdUndoData.undo.id,
        preferredResolutionVersionId: downstreamVersionId,
        reason: "route to downstream",
        note: "keep as undo"
      });
      const carryForwardData = carryForward.data as {
        status: string;
        preferredResolutionVersionId: string;
      };
      legacyRegistry.close();
      const structure = await callTool(server, "structure", "get_version_structure", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const structureData = getStructuredData<{
        legacyAudit: {
          required: boolean;
          recordCount: number;
          guidance: string;
        };
        legalOperations: Array<{ actionType: string }>;
      }>(structure);

      expect(blockedCloseData).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
      });
      expect(proposalListData.filter((proposal) => proposal.status === "pending")).toEqual([]);
      expect(carryForwardData).toMatchObject({
        status: "reassigned",
        preferredResolutionVersionId: downstreamVersionId
      });
      expect(structureData).not.toHaveProperty("openUndos");
      expect(structureData.legacyAudit).toMatchObject({
        required: true,
        recordCount: 1
      });
      expect(structureData.legacyAudit.guidance).toContain(
        "includeLegacyUndo=true"
      );
      expect(structureData.legalOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionType: "close_version" }),
          expect.objectContaining({ actionType: "review_context" })
        ])
      );
      expect(
        structureData.legalOperations.filter(
          (operation) => operation.actionType === "review_context"
        )
      ).toHaveLength(1);
      const closeOperation = blockingStructureData.legalOperations.find(
        (operation) => operation.actionType === "close_version"
      )!;
      const shutdownOperation = blockingStructureData.legalOperations.find(
        (operation) => operation.actionType === "shutdown_version"
      )!;
      expect(closeOperation).toMatchObject({
        allowed: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_WORK_REQUIRES_AUDIT",
            recordCount: 1
          })
        ]),
        details: {
          legacyBlockerCount: 1
        }
      });
      expect(shutdownOperation).toMatchObject({
        details: {
          ordinaryCloseGate: {
            allowed: false,
            legacyBlockerCount: 1,
            blockerCodes: expect.arrayContaining([
              "LEGACY_WORK_REQUIRES_AUDIT"
            ])
          }
        }
      });
      const serializedStructure = JSON.stringify(blockingStructureData);
      expect(serializedStructure).not.toContain("unresolvedUndoIds");
      expect(serializedStructure).not.toContain("OPEN_UNDOS");
      expect(serializedStructure).not.toContain("create_undo");
      expect(serializedStructure).not.toContain("carry_forward_undo");

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_version_transition_guide tool stays read-only, returns metadata, and does not create pending proposals", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const targetVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Next Version"
      );

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-current", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      await callTool(server, "prepare-target", "prepare_version", {
        projectId: initData.project.id,
        versionId: targetVersionId
      });

      const guideResponse = await callTool(
        server,
        "transition-guide",
        "get_version_transition_guide",
        {
          projectId: initData.project.id,
          targetVersionId
        }
      );
      const guideData = getStructuredData<{
        status: string;
        closeGate: { blockers: Array<{ code: string }> };
        recommendedSteps: Array<{ stepId: string; status: string }>;
      }>(guideResponse);
      const proposalList = await callTool(server, "proposal-list-after-guide", "list_l3_proposals", {
        projectId: initData.project.id
      });
      const proposalListData = getStructuredData<Array<{ status: string }>>(proposalList);

      expect(guideResponse).toMatchObject({
        result: {
          structuredContent: {
            meta: {
              runtimeContext: {
                projectId: initData.project.id,
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              },
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            }
          }
        }
      });
      expect(guideData).toMatchObject({
        status: "blocked",
        closeGate: {
          blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
        }
      });
      expect(guideData.recommendedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "close-from-version",
            status: "blocked"
          })
        ])
      );
      expect(proposalListData.filter((proposal) => proposal.status === "pending")).toEqual([]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("plan_version_closeout tool returns no_op for a closed version and keeps summary.canClose=false", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-current", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const closeProposal = await callTool(server, "close-proposal", "close_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose",
        residualAudit: [
          {
            kind: "debt",
            summary: "none",
            destination: "close"
          }
        ]
      });
      const closeProposalData = getStructuredData<{ pendingOperationId: string }>(closeProposal);
      const approveClose = await callTool(server, "approve-close", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: closeProposalData.pendingOperationId
      });
      const approveCloseData = getStructuredData<{ id: string }>(approveClose);
      await callTool(server, "commit-close", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: closeProposalData.pendingOperationId,
        approvalArtifactId: approveCloseData.id
      });

      const planResponse = await callTool(server, "plan-closeout-closed", "plan_version_closeout", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const planData = getStructuredData<{
        status: string;
        summary: {
          canClose: boolean;
          version: { state: string };
        };
        steps: Array<{ kind: string }>;
      }>(planResponse);

      expect(planResponse).toMatchObject({
        result: {
          structuredContent: {
            meta: {
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            }
          }
        }
      });
      expect(planData).toMatchObject({
        status: "no_op",
        summary: {
          canClose: false,
          version: {
            state: "close"
          }
        }
      });
      expect(planData.steps).toEqual([expect.objectContaining({ kind: "no_op" })]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Agent-facing Deferred and Constraint tools stay product-simple, persist, and keep legacy tools audit-only", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;
    let registry: ReturnType<typeof createRegistry> | null = null;

    try {
      server = await initializeServer(projectRoot, {
        debugLog: {
          enabled: true
        }
      });
      registry = createRegistry(projectRoot);
      const listedToolNames = registry.tools.map((tool) => tool.name);
      expect(listedToolNames).toEqual(
        expect.arrayContaining([
          "defer_work",
          "review_deferred",
          "record_constraint",
          "retire_constraint"
        ])
      );
      expect(
        listedToolNames.filter((name) => name.includes("undo"))
      ).toEqual([]);
      expect(registry.getTool("create_undo")).toBeUndefined();

      const initResponse = await callTool(server, "agent-init", "init_project", {
        name: "Agent Semantics"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = initData.project.id;
      const downstreamVersionId = await createAndCommitVersion(
        server,
        projectId,
        "Deferred Review"
      );
      const laterVersionId = await createAndCommitVersion(
        server,
        projectId,
        "Later Review"
      );
      const emptyLegacyStructure = await registry.invoke(
        "get_version_structure",
        {
          projectId,
          versionId: initData.initialVersion.id
        }
      );
      const emptyLegacyOperations = (
        emptyLegacyStructure.data as {
          legalOperations: Array<{ actionType: string }>;
        }
      ).legalOperations;
      expect(
        emptyLegacyOperations.some(
          (operation) => operation.actionType === "review_context"
        )
      ).toBe(false);
      expect(
        emptyLegacyOperations.some((operation) =>
          [
            "create_undo",
            "reassign_undo",
            "carry_forward_undo",
            "resolve_undo_as_downstream_input",
            "close_undo"
          ].includes(operation.actionType)
        )
      ).toBe(false);

      const badDefer = await registry.invoke("defer_work", {
        mode: "new",
        projectId,
        currentVersionId: initData.initialVersion.id,
        targetReviewVersionId: downstreamVersionId,
        reason: "missing title"
      });
      expect(badDefer).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.title"
          }
        }
      });

      const todoResponse = await callTool(server, "agent-todo", "create_todo", {
        projectId,
        versionId: initData.initialVersion.id,
        title: "Existing work to defer"
      });
      const todoId = getStructuredData<{ todo: { id: string } }>(todoResponse).todo.id;
      const deferredTodoResponse = await callTool(
        server,
        "agent-defer-todo",
        "defer_work",
        {
          mode: "todo",
          projectId,
          todoId,
          targetReviewVersionId: downstreamVersionId,
          reason: "Not needed in the current version",
          note: "Route this Todo to future review"
        }
      );
      const deferredTodoData = getStructuredData<Record<string, any>>(
        deferredTodoResponse
      );
      expect(deferredTodoData).toMatchObject({
        mode: "todo",
        todo: {
          id: todoId,
          status: "converted"
        },
        deferred: {
          status: "pending",
          targetReviewVersionId: downstreamVersionId
        }
      });
      expect(JSON.stringify(deferredTodoData)).not.toContain("workItemId");
      const resolvedTodoDeferred = await callTool(
        server,
        "agent-resolve-todo-deferred",
        "review_deferred",
        {
          projectId,
          deferredId: deferredTodoData.deferred.id,
          action: "resolve",
          outcome: "superseded",
          reason: "A newer product path replaced it",
          note: "No longer needs activation"
        }
      );
      expect(
        getStructuredData<{ deferred: { status: string } }>(
          resolvedTodoDeferred
        ).deferred.status
      ).toBe("resolved");

      const deferredResponse = await callTool(
        server,
        "agent-defer",
        "defer_work",
        {
          mode: "new",
          projectId,
          currentVersionId: initData.initialVersion.id,
          targetReviewVersionId: downstreamVersionId,
          title: "Review product boundary",
          description: "Keep this visible without internal records.",
          reason: "Review after the first delivery"
        }
      );
      const deferredData = getStructuredData<{
        mode: "new";
        deferred: {
          id: string;
          targetReviewVersionId: string;
          workItemId?: string;
          originVersionId?: string;
        };
      }>(deferredResponse);
      expect(deferredData.deferred).toMatchObject({
        targetReviewVersionId: downstreamVersionId
      });
      expect(deferredData.deferred).not.toHaveProperty("workItemId");
      expect(deferredData.deferred).not.toHaveProperty("originVersionId");
      const rejectedWithoutDecision = await registry.invoke("review_deferred", {
        projectId,
        deferredId: deferredData.deferred.id,
        action: "resolve",
        outcome: "rejected",
        reason: "No decision reference"
      });
      expect(rejectedWithoutDecision).toMatchObject({
        ok: false,
        error: {
          code: "MISSING_REQUIRED_FIELD"
        }
      });

      const constraintResponse = await callTool(
        server,
        "agent-constraint",
        "record_constraint",
        {
          projectId,
          rule: "Do not mutate real project data during feature development.",
          rationale: "Migration requires an explicit stop-write window.",
          scopeType: "project"
        }
      );
      const constraintData = getStructuredData<{
        constraint: { id: string; status: string };
      }>(constraintResponse);
      expect(constraintData.constraint.status).toBe("active");
      const badVersionConstraint = await registry.invoke("record_constraint", {
        projectId,
        rule: "Version-only rule",
        rationale: "Missing version ID must fail",
        scopeType: "version"
      });
      expect(badVersionConstraint).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.versionId"
          }
        }
      });

      await setCurrentVersionWithApproval(server, projectId, downstreamVersionId);
      await callTool(server, "prepare-review", "prepare_version", {
        projectId,
        versionId: downstreamVersionId
      });
      const dueContextResponse = await callTool(
        server,
        "due-context",
        "get_current_context",
        { projectId }
      );
      const dueContext = getStructuredData<Record<string, any>>(dueContextResponse);
      expect(dueContext.todos).toEqual([]);
      expect(dueContext.deferred).toEqual([
        expect.objectContaining({ id: deferredData.deferred.id })
      ]);
      expect(dueContext.constraints).toEqual([
        expect.objectContaining({ id: constraintData.constraint.id })
      ]);
      expect(dueContext.dueDeferred).toEqual([
        expect.objectContaining({ id: deferredData.deferred.id })
      ]);
      expect(dueContext.nextAction).toMatchObject({
        actionType: "review_deferred",
        targetId: deferredData.deferred.id
      });
      expect(dueContext).not.toHaveProperty("openUndos");
      expect(dueContext).not.toHaveProperty("legacyUndo");
      expect(JSON.stringify(dueContext)).not.toContain("workItemId");
      await callTool(
        server,
        "agent-large-constraint",
        "record_constraint",
        {
          projectId,
          rule: "Keep a deliberately large audit rationale within the context budget.",
          rationale: "evidence ".repeat(2_000),
          scopeType: "project"
        }
      );
      const budgetedContextResponse = await callTool(
        server,
        "agent-budgeted-context",
        "get_current_context",
        {
          projectId,
          budgetBytes: 8192
        }
      );
      const budgetedContext = (
        budgetedContextResponse as {
          result: {
            structuredContent: {
              data: Record<string, any>;
              meta: {
                truncated: boolean;
                truncatedFields: string[];
              };
            };
          };
        }
      ).result.structuredContent;
      expect(budgetedContext.meta).toMatchObject({
        truncated: true,
        truncatedFields: expect.arrayContaining(["constraints.rationale"])
      });
      expect(JSON.stringify(budgetedContext.data)).not.toContain(
        "evidence evidence evidence"
      );

      const deferredAgainResponse = await callTool(
        server,
        "agent-defer-again",
        "review_deferred",
        {
          projectId,
          deferredId: deferredData.deferred.id,
          action: "defer_again",
          targetReviewVersionId: laterVersionId,
          reason: "Needs one more version of evidence",
          note: "reviewed and routed later",
          reviewTrigger: "Later version reaches ready"
        }
      );
      expect(
        getStructuredData<{ deferred: { targetReviewVersionId: string } }>(
          deferredAgainResponse
        ).deferred.targetReviewVersionId
      ).toBe(laterVersionId);

      const activatedResponse = await callTool(
        server,
        "agent-activate",
        "review_deferred",
        {
          projectId,
          deferredId: deferredData.deferred.id,
          action: "activate",
          targetVersionId: laterVersionId,
          reason: "Evidence is available",
          note: "activate as current work"
        }
      );
      const activatedData = getStructuredData<Record<string, any>>(activatedResponse);
      expect(activatedData).toMatchObject({
        action: "activate",
        deferred: {
          status: "activated"
        },
        todo: {
          versionId: laterVersionId
        }
      });
      expect(JSON.stringify(activatedData)).not.toContain("workItemId");

      const retiredResponse = await callTool(
        server,
        "agent-retire-constraint",
        "retire_constraint",
        {
          projectId,
          constraintId: constraintData.constraint.id,
          reason: "Feature window ended",
          note: "Retired after the relevant delivery"
        }
      );
      expect(
        getStructuredData<{ constraint: { status: string } }>(retiredResponse)
          .constraint.status
      ).toBe("retired");
      const productDebugRecords = readDebugLogRecords(projectRoot).filter(
        (record) =>
          typeof record.type === "string" &&
          (record.type.startsWith("deferred.") ||
            record.type.startsWith("constraint."))
      );
      expect(productDebugRecords.map((record) => record.type)).toEqual(
        expect.arrayContaining([
          "deferred.created",
          "deferred.resolve",
          "deferred.defer_again",
          "deferred.activate",
          "constraint.recorded",
          "constraint.retired"
        ])
      );
      expect(JSON.stringify(productDebugRecords)).not.toContain("workItem");

      const mismatchResponse = await registry.invoke("record_constraint", {
        projectId,
        rule: "blocked",
        rationale: "wrong root",
        scopeType: "project",
        expectedRouteLedgerRoot: createMismatchedExpectedRouteLedgerRoot(projectRoot)
      });
      expect(mismatchResponse).toMatchObject({
        ok: false,
        error: {
          code: "MCP_ROUTELEDGER_ROOT_MISMATCH"
        }
      });

      const legacyCreate = await registry.invoke("create_undo", {
        projectId,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: downstreamVersionId,
        title: "Legacy audit record",
        reason: "compatibility fixture"
      });
      expect(legacyCreate.ok).toBe(true);
      expect(registry.getTool("create_undo")).toBeUndefined();

      const compatibilityUndo = await registry.invoke("create_undo", {
        projectId,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: initData.initialVersion.id,
        title: "Legacy direct invoke chain",
        reason: "exercise hidden handlers"
      });
      const compatibilityUndoId = (
        compatibilityUndo.data as { undo: { id: string } }
      ).undo.id;
      const reassignedUndo = await registry.invoke("reassign_undo", {
        projectId,
        undoId: compatibilityUndoId,
        preferredResolutionVersionId: laterVersionId,
        reason: "reassign compatibility",
        note: "direct hidden handler"
      });
      expect(reassignedUndo).toMatchObject({
        ok: true,
        data: {
          undo: {
            preferredResolutionVersionId: laterVersionId
          }
        }
      });
      const resolvedAsDownstream = await registry.invoke(
        "resolve_undo_as_downstream_input",
        {
          projectId,
          undoId: compatibilityUndoId,
          preferredResolutionVersionId: downstreamVersionId,
          reason: "alias compatibility",
          note: "route through alias"
        }
      );
      expect(resolvedAsDownstream).toMatchObject({
        ok: true,
        data: {
          preferredResolutionVersionId: downstreamVersionId
        }
      });
      const closedCompatibilityUndo = await registry.invoke("close_undo", {
        projectId,
        undoId: compatibilityUndoId,
        reason: "close compatibility fixture",
        note: "hidden direct handler remains callable"
      });
      expect(closedCompatibilityUndo).toMatchObject({
        ok: true,
        data: {
          undo: {
            status: "closed"
          }
        }
      });
      for (const hiddenName of [
        "reassign_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(registry.getTool(hiddenName)).toBeUndefined();
      }

      const legacyRecommendationUndo = await registry.invoke("create_undo", {
        projectId,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: initData.initialVersion.id,
        title: "User text close_undo must remain verbatim",
        reason: "exercise default read sanitization"
      });
      expect(legacyRecommendationUndo.ok).toBe(true);
      const defaultReadResponses = await Promise.all([
        registry.invoke("get_version_structure", {
          projectId,
          versionId: initData.initialVersion.id
        }),
        registry.invoke("summarize_version_closeout", {
          projectId,
          versionId: initData.initialVersion.id
        }),
        registry.invoke("plan_version_closeout", {
          projectId,
          versionId: initData.initialVersion.id
        })
      ]);
      const structureRead = defaultReadResponses[0]!.data as Record<string, any>;
      const summaryRead = defaultReadResponses[1]!.data as Record<string, any>;
      const planRead = defaultReadResponses[2]!.data as Record<string, any>;
      expect(structureRead).not.toHaveProperty("openUndos");
      expect(structureRead.legacyAudit).toMatchObject({
        required: true,
        recordCount: 2
      });
      const recommendationValues = [
        ...structureRead.legalOperations.map(
          (operation: Record<string, unknown>) => operation.actionType
        ),
        summaryRead.nextAction.actionType,
        summaryRead.nextAction.recommendedTool,
        ...summaryRead.selfReferentialUndos.flatMap(
          (entry: Record<string, any>) => [
            entry.recommendedResolution,
            ...entry.alternatives.flatMap(
              (alternative: Record<string, unknown>) => [
                alternative.actionType,
                alternative.recommendedTool
              ]
            )
          ]
        ),
        ...planRead.steps.flatMap((step: Record<string, any>) => [
          step.kind,
          step.recommendedTool,
          ...(step.unlockPaths ?? []).flatMap(
            (unlockPath: Record<string, unknown>) => [
              unlockPath.actionType,
              unlockPath.recommendedTool
            ]
          ),
          ...(step.alternatives ?? []).flatMap(
            (alternative: Record<string, unknown>) => [
              alternative.actionType,
              alternative.recommendedTool
            ]
          )
        ])
      ].filter((value): value is string => typeof value === "string");
      for (const hiddenName of [
        "create_undo",
        "reassign_undo",
        "carry_forward_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(
          recommendationValues.some((value) => value.includes(hiddenName))
        ).toBe(false);
      }
      expect(recommendationValues).toContain("review_context");
      expect(
        structureRead.legalOperations.map(
          (operation: Record<string, unknown>) => operation.actionType
        )
      ).toEqual([
        ...new Set(
          structureRead.legalOperations.map(
            (operation: Record<string, unknown>) => operation.actionType
          )
        )
      ]);
      expect(
        summaryRead.openUndos.map(
          (undo: Record<string, unknown>) => undo.title
        )
      ).toContain("User text close_undo must remain verbatim");
      const expectedLegacyAuditInputs = [
        {
          field: "projectId",
          value: projectId
        },
        {
          field: "includeLegacyUndo",
          value: true
        }
      ];
      const mappedLegacySteps = planRead.steps.filter(
        (step: Record<string, unknown>) =>
          step.kind === "review_self_referential_undo" &&
          step.recommendedTool === "get_current_context"
      );
      expect(mappedLegacySteps.length).toBeGreaterThan(0);
      for (const step of mappedLegacySteps) {
        expect(step.requiredInputs).toEqual(expectedLegacyAuditInputs);
      }
      const mappedLegacyUnlockPaths = planRead.steps.flatMap(
        (step: Record<string, any>) =>
          (step.unlockPaths ?? []).filter(
            (unlockPath: Record<string, unknown>) =>
              unlockPath.actionType === "review_context" &&
              unlockPath.recommendedTool === "get_current_context"
          )
      );
      expect(mappedLegacyUnlockPaths.length).toBeGreaterThan(0);
      for (const unlockPath of mappedLegacyUnlockPaths) {
        expect(unlockPath.requiredInputs).toEqual(
          expectedLegacyAuditInputs
        );
      }

      const defaultContext = await registry.invoke("get_current_context", {
        projectId
      });
      expect(defaultContext.ok).toBe(true);
      expect(defaultContext.data).not.toHaveProperty("legacyUndo");
      expect(defaultContext.data).not.toHaveProperty("openUndos");
      expect(defaultContext.data).toMatchObject({
        gates: {
          start: {
            allowed: false,
            blockers: [
              expect.objectContaining({
                code: "LEGACY_WORK_REQUIRES_AUDIT"
              })
            ]
          }
        },
        statusRisks: expect.arrayContaining([
          expect.objectContaining({
            code: "START_GATE_BLOCKED"
          })
        ]),
        nextAction: {
          actionType: "review_context",
          targetId: downstreamVersionId,
          blockingRiskCodes: ["START_GATE_BLOCKED"]
        }
      });
      const auditContext = await registry.invoke("get_current_context", {
        projectId,
        includeLegacyUndo: true
      });
      expect(auditContext.data).toMatchObject({
        legacyUndo: expect.arrayContaining([
          expect.objectContaining({
            title: "Legacy audit record"
          }),
          expect.objectContaining({
            title: "User text close_undo must remain verbatim"
          })
        ]),
        nextAction: {
          actionType: "review_context",
          targetId: downstreamVersionId
        }
      });

      const closeVersionSchema = registry.tools.find(
        (tool) => tool.name === "close_version"
      )!.inputSchema;
      expect(JSON.stringify(closeVersionSchema)).not.toContain("create_undo");
      expect(JSON.stringify(closeVersionSchema)).toContain("defer_work");
      expect(JSON.stringify(closeVersionSchema)).toContain("record_constraint");

      server.close();
      server = null;
      registry.close();
      registry = null;
      const reloadedRegistry = createRegistry(projectRoot);
      const reloadedContext = await reloadedRegistry.invoke("get_current_context", {
        projectId
      });
      expect(reloadedContext.ok).toBe(true);
      expect((reloadedContext.data as Record<string, any>).todos).toEqual([
        expect.objectContaining({ versionId: laterVersionId })
      ]);
      reloadedRegistry.close();

      const sqlite = new SQLiteStorageAdapter({
        projectRoot: getDefaultDataRoot(projectRoot)
      });
      const sqliteSnapshot = await sqlite.loadProjectAggregate(projectId);
      expect(sqliteSnapshot?.deferredItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: deferredData.deferred.id,
            status: "activated"
          })
        ])
      );
      expect(sqliteSnapshot?.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: constraintData.constraint.id,
            status: "retired"
          })
        ])
      );
      sqlite.close();
    } finally {
      server?.close();
      registry?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("protocol errors cover invalid params and unknown methods", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = createRouteLedgerStdioServer({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      const beforeInitResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "too-early",
        method: "tools/list",
        params: {}
      })) as JsonRpcResponse;

      expect(beforeInitResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "too-early",
        error: {
          code: -32002
        }
      });

      const initializeResponse = await server.handleMessage({
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
      });
      const initializedResponse = await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION
        }
      });
      expect(initializedResponse).toBeNull();

      const invalidParamsResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "bad-call",
        method: "tools/call",
        params: {
          name: "get_current_context",
          arguments: "nope"
        }
      })) as JsonRpcResponse;
      const unknownMethodResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "unknown-method",
        method: "tools/mutate",
        params: {}
      })) as JsonRpcResponse;

      expect(invalidParamsResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-call",
        error: {
          code: -32602
        }
      });
      expect(unknownMethodResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "unknown-method",
        error: {
          code: -32601
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("initialize requires capabilities and clientInfo.version", async () => {
    const missingCapabilitiesRoot = createTempProjectRoot();
    const missingVersionRoot = createTempProjectRoot();

    try {
      const missingCapabilitiesServer = createServer(missingCapabilitiesRoot);
      const missingVersionServer = createServer(missingVersionRoot);

      const missingCapabilitiesResponse = (await missingCapabilitiesServer.handleMessage({
        jsonrpc: "2.0",
        id: "missing-capabilities",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      })) as JsonRpcResponse;
      const missingVersionResponse = (await missingVersionServer.handleMessage({
        jsonrpc: "2.0",
        id: "missing-version",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "vitest"
          }
        }
      })) as JsonRpcResponse;

      expect(missingCapabilitiesResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-capabilities",
        error: {
          code: -32602,
          message: expect.stringContaining("capabilities")
        }
      });
      expect(missingVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-version",
        error: {
          code: -32602,
          message: expect.stringContaining("version")
        }
      });

      missingCapabilitiesServer.close();
      missingVersionServer.close();
    } finally {
      cleanupProjectRoot(missingCapabilitiesRoot);
      cleanupProjectRoot(missingVersionRoot);
    }
  });

  it("CLI/MCP same scenario still reaches the same final RouteLedger state", async () => {
    const cliRoot = createTempProjectRoot();
    const mcpRoot = createTempProjectRoot();

    const runCliJson = async (projectRoot: string, argv: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli({
        argv,
        projectRoot,
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
      const cliInit = await runCliJson(cliRoot, ["init_project", "--name", "RouteLedger"]);
      const cliProjectId = cliInit.stdoutJson.data.project.id as string;
      const cliVersionId = cliInit.stdoutJson.data.initialVersion.id as string;
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
      await runCliJson(cliRoot, [
        "l3",
        "commit",
        "--project-id",
        cliProjectId,
        "--pending-operation-id",
        cliPendingOperationId,
        "--approval-artifact-id",
        cliApprove.stdoutJson.data.id
      ]);
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
        initialVersion: {
          id: string;
        };
      };
      const mcpProjectId = mcpInitData.project.id;
      const mcpVersionId = mcpInitData.initialVersion.id;
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

  it("version tree direct MCP tools 可创建 proposal 并经 approve/commit 生效", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;

      const createVersionResponse = await callTool(server, "create-version", "create_version", {
        projectId: projectData.project.id,
        title: "Version 2"
      });
      expect(createVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "create-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const createVersionDetails = (
        createVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const createVersionApprove = await callTool(server, "approve-create", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: createVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-create", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: createVersionDetails.pendingOperationId,
        approvalArtifactId: (
          createVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const insertVersionResponse = await callTool(server, "insert-version", "insert_version", {
        projectId: projectData.project.id,
        title: "Version 1.5",
        afterVersionId: projectData.initialVersion.id
      });
      expect(insertVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "insert-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const insertVersionDetails = (
        insertVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const insertVersionApprove = await callTool(server, "approve-insert", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: insertVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-insert", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: insertVersionDetails.pendingOperationId,
        approvalArtifactId: (
          insertVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const childVersionResponse = await callTool(
        server,
        "create-child-version",
        "create_child_version",
        {
          projectId: projectData.project.id,
          parentVersionId: projectData.initialVersion.id,
          title: "Child 1"
        }
      );
      expect(childVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "create-child-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const childVersionDetails = (
        childVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const childVersionApprove = await callTool(server, "approve-child", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: childVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-child", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: childVersionDetails.pendingOperationId,
        approvalArtifactId: (
          childVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const reorderResponse = await callTool(server, "reorder-version", "reorder_versions", {
        projectId: projectData.project.id,
        versionId: createVersionDetails.proposal.targetId,
        beforeVersionId: insertVersionDetails.proposal.targetId
      });
      expect(reorderResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "reorder-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const reorderDetails = (
        reorderResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const reorderApprove = await callTool(server, "approve-reorder", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: reorderDetails.pendingOperationId
      });
      const reorderCommit = await callTool(server, "commit-reorder", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: reorderDetails.pendingOperationId,
        approvalArtifactId: (
          reorderApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      expect(reorderCommit).toMatchObject({
        jsonrpc: "2.0",
        id: "commit-reorder",
        result: {
          structuredContent: {
            ok: true
          }
        }
      });

      const versionsResponse = await callTool(server, "list-versions", "list_versions", {
        projectId: projectData.project.id
      });
      const versionIds = (
        versionsResponse as {
          result: {
            structuredContent: {
              data: Array<{ id: string }>;
            };
          };
        }
      ).result.structuredContent.data.map((version) => version.id);

      expect(versionIds).toEqual([
        projectData.initialVersion.id,
        childVersionDetails.proposal.targetId,
        createVersionDetails.proposal.targetId,
        insertVersionDetails.proposal.targetId
      ]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("runRouteLedgerStdioServer emits parse errors and skips initialized notifications", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const { responses, stderr } = await runTranscript(projectRoot, [
        "{not-json",
        JSON.stringify({
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
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "tools-list",
          method: "tools/list",
          params: {}
        })
      ]);

      expect(stderr).toBe("");
      expect(responses).toHaveLength(3);
      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700
        }
      });
      expect(responses[1]).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION
        }
      });
      expect(responses[2]).toMatchObject({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: expect.any(Array)
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
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

      expect(tools.map((tool) => tool.name)).not.toContain("open_mission_control");
      expect(tools.map((tool) => tool.name)).not.toContain("get_mission_control_status");

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
          stdio: ["pipe", "pipe", "pipe"]
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
          protocolVersion: MCP_PROTOCOL_VERSION
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
        stdio: ["ignore", "pipe", "pipe"]
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

  it("shutdown_version tool creates a forced proposal chain and surfaces shutdown state in reads", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-current", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const startApproval = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const startApprovalData = getStructuredData<{ id: string }>(startApproval);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: startApprovalData.id
      });
      await callTool(server, "create-open-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "still open"
      });

      const shutdownProposal = await callTool(server, "shutdown-proposal", "shutdown_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose",
        shutdownReason: "emergency_stop",
        reason: "force close after runtime failure"
      });
      const shutdownProposalData = getStructuredData<{
        status: string;
        forced: boolean;
        shutdownStateReason: string;
        pendingOperationId: string;
        ordinaryCloseGate: { blockers: Array<{ code: string }> };
      }>(shutdownProposal);

      expect(shutdownProposalData).toMatchObject({
        status: "ready",
        forced: true,
        shutdownStateReason: "shutdown:emergency_stop"
      });
      expect(shutdownProposalData.ordinaryCloseGate.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "TARGET_VERSION_NOT_COMPLETE" })])
      );

      const shutdownApproval = await callTool(server, "approve-shutdown", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: shutdownProposalData.pendingOperationId
      });
      const shutdownApprovalData = getStructuredData<{ id: string }>(shutdownApproval);
      await callTool(server, "commit-shutdown", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: shutdownProposalData.pendingOperationId,
        approvalArtifactId: shutdownApprovalData.id
      });

      const structure = await callTool(server, "structure-after-shutdown", "get_version_structure", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const structureData = getStructuredData<{
        focusVersion: {
          state: string;
          displayState: string;
          isShutdown: boolean;
          stateReason: string | null;
        };
        legalOperations: Array<{ actionType: string }>;
      }>(structure);
      const closeoutPlan = await callTool(server, "plan-after-shutdown", "plan_version_closeout", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const closeoutPlanData = getStructuredData<{
        version: {
          displayState: string;
          isShutdown: boolean;
          stateReason: string | null;
        };
        steps: Array<{ kind: string }>;
      }>(closeoutPlan);

      expect(structureData.focusVersion).toMatchObject({
        state: "close",
        displayState: "shutdown",
        isShutdown: true,
        stateReason: "shutdown:emergency_stop"
      });
      expect(structureData.legalOperations).toEqual(
        expect.arrayContaining([expect.objectContaining({ actionType: "shutdown_version" })])
      );
      expect(closeoutPlanData.version).toMatchObject({
        displayState: "shutdown",
        isShutdown: true,
        stateReason: "shutdown:emergency_stop"
      });
      expect(closeoutPlanData.steps[0]).toMatchObject({ kind: "no_op" });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});
