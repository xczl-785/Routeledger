import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { expect } from "vitest";

import { loadValidatedProjectAggregateFromJsonDirectory } from "../../../json/src/index.js";
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
import {
  MemoryL3AuthorizationGrantStore,
  MemoryExactAuthorizationStore,
  RouteLedgerService
} from "../../../core/src/index.js";
import { createTestDependencies } from "../../../core/src/testing/builders.js";

export type ToolListResult = {
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

const trustedGrantStores = new Map<string, MemoryL3AuthorizationGrantStore>();
const trustedExactStores = new Map<string, MemoryExactAuthorizationStore>();

const getTrustedGrantStore = (projectRoot: string): MemoryL3AuthorizationGrantStore => {
  const existing = trustedGrantStores.get(projectRoot);
  if (existing !== undefined) return existing;
  const created = new MemoryL3AuthorizationGrantStore();
  trustedGrantStores.set(projectRoot, created);
  return created;
};

const getTrustedExactStore = (projectRoot: string): MemoryExactAuthorizationStore => {
  const existing = trustedExactStores.get(projectRoot);
  if (existing !== undefined) return existing;
  const created = new MemoryExactAuthorizationStore();
  trustedExactStores.set(projectRoot, created);
  return created;
};

export const WRITE_TOOL_NAMES = new Set([
  "write_host_binding_config",
  "init_project",
  "set_project_content_locale",
  "batch_create_versions",
  "transition_version",
  "advance_to_version",
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
  "execute_l3_operation",
  "approve_l3_operation",
  "commit_l3_operation",
  "reject_l3_operation"
]);

export const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-mcp-"));

export const toForwardSlashes = (value: string): string => value.replace(/\\/gu, "/");

export const ensureDefaultWorkspaceConfig = (projectRoot: string): void => {
  resolveWorkspaceConfigSync({
    projectRoot,
    autoCreate: true
  });
};

export const getDefaultDataRoot = (projectRoot: string): string =>
  resolveDefaultRouteLedgerDataDir(projectRoot);

export const getDefaultWorkspaceConfigPath = (projectRoot: string): string =>
  getWorkspaceConfigPath(projectRoot);

export const getDefaultCanonicalJsonRoot = (projectRoot: string): string =>
  path.join(getDefaultDataRoot(projectRoot), ".routeledger");

export const getDefaultJsonProjectPath = (projectRoot: string): string =>
  path.join(getDefaultCanonicalJsonRoot(projectRoot), "project.json");

export const getDefaultSqliteDbPath = (projectRoot: string): string =>
  path.join(getDefaultDataRoot(projectRoot), ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME);

export const createMismatchedExpectedRouteLedgerRoot = (projectRoot: string): string =>
  path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-other`);

export const resolveTestRouteLedgerRoot = (
  projectRoot: string,
  extraOptions: Record<string, unknown>
): string =>
  typeof extraOptions.routeledgerRoot === "string"
    ? extraOptions.routeledgerRoot
    : projectRoot;

export const createBindingRegistry = (options: RouteLedgerMcpRegistryOptions) => {
  const routeledgerRoot = options.routeledgerRoot;
  const registry = createRouteLedgerMcpRegistry({
    ...options,
    l3Authorization:
      options.l3Authorization ?? {
        grantStore: new MemoryL3AuthorizationGrantStore(),
        interaction: {
          requestAuthorization: async () => ({
            action: "accept" as const,
            content: { approve: true }
          })
        },
        sessionId: "vitest-session",
        trustedClientId: "vitest"
      }
  });
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
              ...(toolName === "init_project" &&
              !Object.prototype.hasOwnProperty.call(input ?? {}, "contentLocale")
                ? { contentLocale: "en" }
                : {}),
              ...(toolName === "init_project" &&
              !Object.prototype.hasOwnProperty.call(input ?? {}, "firstVersion")
                ? {
                    firstVersion: {
                      title: "Initial Version",
                      description: "Project bootstrap version",
                      initialTodos: []
                    }
                  }
                : {}),
              expectedRouteLedgerRoot: routeledgerRoot
            }
          : toolName === "init_project" &&
              !Object.prototype.hasOwnProperty.call(input ?? {}, "contentLocale")
            ? {
                ...(input ?? {}),
                contentLocale: "en",
                firstVersion: {
                  title: "Initial Version",
                  description: "Project bootstrap version",
                  initialTodos: []
                }
              }
            : input
      )
  };
};

export const createRegistry = (
  projectRoot: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const registry = createBindingRegistry({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    l3Authorization: {
      grantStore: getTrustedGrantStore(projectRoot),
      exactStore: getTrustedExactStore(projectRoot),
      interaction: {
        requestAuthorization: async () => ({
          action: "accept" as const,
          content: { approve: true }
        })
      },
      sessionId: "vitest-session",
      trustedClientId: "vitest"
    },
    ...extraOptions
  });

  return {
    ...registry,
    invoke: registry.invoke
  };
};

export const createProcessCwdRegistry = (
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

export const createServer = (
  projectRoot: string,
  extraOptions: Record<string, unknown> = {}
) => {
  const routeledgerRoot = resolveTestRouteLedgerRoot(projectRoot, extraOptions);

  return Object.assign(
    createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      l3Authorization: {
        grantStore: new MemoryL3AuthorizationGrantStore(),
        interaction: {
          requestAuthorization: async () => ({
            action: "accept" as const,
            content: { approve: true }
          })
        },
        sessionId: "vitest-session",
        trustedClientId: "vitest"
      },
      ...extraOptions
    }),
    {
      __routeledgerRoot: routeledgerRoot
    }
  );
};

export const createCapturedServer = (
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

export const cleanupProjectRoot = (projectRoot: string): void => {
  trustedGrantStores.delete(projectRoot);
  trustedExactStores.delete(projectRoot);
  fs.rmSync(projectRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
};

export const collectJsonlFiles = (rootPath: string): string[] => {
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

export const readDebugLogRecords = (projectRoot: string): Array<Record<string, unknown>> =>
  collectJsonlFiles(path.join(projectRoot, ROUTELEDGER_DIRECTORY, "runtime", "debug", "mcp"))
    .flatMap((filePath) => fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

export const createDeferred = <T = void>() => {
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

export const removeSqliteFiles = (projectRoot: string): void => {
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

export const createSqliteOnlyProject = async (
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
      contentLocale: "en",
      name: "SQLite Only Project",
      description: "",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: {
        id: "sqlite-only-agent",
        type: "agent",
        displayName: "sqlite-only-agent"
      }
    });

    return {
      projectId: created.project.id,
      initialVersionId: created.firstVersion!.id
    };
  } finally {
    storage.close();
  }
};

export const initializeCanonicalProjectAtRoot = async (
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

export const initializeServer = async (
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
        title: "RouteLedger MCP",
        version: "0.0.0-package-prep",
        runtimeIdentity: {
          runtimePackageVersion: "0.0.0-package-prep",
          artifactKind: "source",
          pluginVersion: null,
          releaseTag: null,
          sourceTreeState: "unavailable",
          buildCommit: null,
          artifactDigest: null,
          runtimePayloadDigest: null
        }
      }
    }
  });
  expect(
    (initializeResponse as { result: { instructions: string } }).result.instructions
  ).toContain("Current host profile: Codex");
  expect(initializedResponse).toBeNull();

  return server;
};

export const callTool = async (
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
          ...(name === "init_project" &&
          !Object.prototype.hasOwnProperty.call(args, "contentLocale")
            ? { contentLocale: "en" }
            : {}),
          ...(name === "init_project" &&
          !Object.prototype.hasOwnProperty.call(args, "firstVersion")
            ? {
                firstVersion: {
                  title: "Initial Version",
                  description: "Project bootstrap version",
                  initialTodos: []
                }
              }
            : {}),
          expectedRouteLedgerRoot: routeledgerRoot
        }
      : name === "init_project" &&
          !Object.prototype.hasOwnProperty.call(args, "contentLocale")
        ? {
            ...args,
            contentLocale: "en",
            firstVersion: {
              title: "Initial Version",
              description: "Project bootstrap version",
              initialTodos: []
            }
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

export const getStructuredData = <T>(
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

export const getStructuredErrorDetails = <T>(
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

export const expectSingleRootsListRequest = (messages: JsonRpcMessage[]): JsonRpcMessage & {
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

export const expectRouteLedgerRootGuardError = (
  response: ToolResponse,
  code:
    | "ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED"
    | "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID"
    | "MCP_ROUTELEDGER_ROOT_MISMATCH",
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

export const createAndCommitVersion = async (
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

export const createApprovedVersionProposal = async (
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

export const expectCanonicalJsonValid = async (projectRoot: string): Promise<void> => {
  const loaded = await loadValidatedProjectAggregateFromJsonDirectory(getDefaultDataRoot(projectRoot));
  expect(loaded.documentCount).toBeGreaterThan(0);
};

export const setCurrentVersionWithApproval = async (
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

export const runTranscript = async (
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
