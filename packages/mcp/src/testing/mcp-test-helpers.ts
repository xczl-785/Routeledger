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

const trustedExactStores = new Map<string, MemoryExactAuthorizationStore>();

const getTrustedExactStore = (projectRoot: string): MemoryExactAuthorizationStore => {
  const existing = trustedExactStores.get(projectRoot);
  if (existing !== undefined) return existing;
  const created = new MemoryExactAuthorizationStore();
  trustedExactStores.set(projectRoot, created);
  return created;
};

export const WRITE_TOOL_NAMES = new Set([
  "configure_binding",
  "configure_project",
  "manage_todo",
  "manage_deferred",
  "manage_constraint",
  "propose_version_lifecycle_change",
  "propose_version_structure_change",
  "propose_l3_route_change",
  "set_version_state",
  "execute_route_change",
  "manage_mission_control"
]);

const PUBLIC_TOOL_CALLS: Record<string, { name: string; action?: string }> = {
  get_runtime_context: { name: "inspect_runtime", action: "runtime" },
  discover_routeledger_roots: { name: "inspect_runtime", action: "discover_roots" },
  plan_routeledger_binding: { name: "inspect_runtime", action: "plan_binding" },
  get_mission_control_status: { name: "inspect_runtime", action: "mission_control_status" },
  activate_routeledger_binding: { name: "configure_binding" },
  init_project: { name: "configure_project", action: "initialize" },
  set_project_content_locale: { name: "configure_project", action: "set_content_locale" },
  open_mission_control: { name: "manage_mission_control", action: "open" },
  stop_mission_control: { name: "manage_mission_control", action: "stop" },
  create_todo: { name: "manage_todo", action: "create" },
  close_todo: { name: "manage_todo", action: "close" },
  defer_work: { name: "manage_deferred", action: "defer" },
  review_deferred: { name: "manage_deferred", action: "review" },
  record_constraint: { name: "manage_constraint", action: "record" },
  retire_constraint: { name: "manage_constraint", action: "retire" },
  prepare_version: { name: "set_version_state", action: "prepare" },
  mark_version_complete: { name: "set_version_state", action: "mark_complete" },
  preflight_or_propose_version_batch: { name: "propose_version_lifecycle_change", action: "preflight_or_propose_version_batch" },
  batch_create_versions: { name: "propose_version_lifecycle_change", action: "preflight_or_propose_version_batch" },
  preview_or_propose_version_transition: { name: "propose_version_lifecycle_change", action: "preview_or_propose_version_transition" },
  transition_version: { name: "propose_version_lifecycle_change", action: "preview_or_propose_version_transition" },
  propose_version_advance: { name: "propose_version_lifecycle_change", action: "propose_version_advance" },
  advance_to_version: { name: "propose_version_lifecycle_change", action: "propose_version_advance" },
  preview_or_propose_version_close: { name: "propose_version_lifecycle_change", action: "preview_or_propose_version_close" },
  close_version: { name: "propose_version_lifecycle_change", action: "preview_or_propose_version_close" },
  propose_version_creation: { name: "propose_version_structure_change", action: "propose_version_creation" },
  create_version: { name: "propose_version_structure_change", action: "propose_version_creation" },
  propose_version_insertion: { name: "propose_version_structure_change", action: "propose_version_insertion" },
  insert_version: { name: "propose_version_structure_change", action: "propose_version_insertion" },
  propose_child_version_creation: { name: "propose_version_structure_change", action: "propose_child_version_creation" },
  create_child_version: { name: "propose_version_structure_change", action: "propose_child_version_creation" },
  propose_version_reorder: { name: "propose_version_structure_change", action: "propose_version_reorder" },
  reorder_versions: { name: "propose_version_structure_change", action: "propose_version_reorder" },
  propose_l3_operation: { name: "propose_l3_route_change" },
  preview_or_propose_forced_version_shutdown: { name: "execute_route_change", action: "force_shutdown" },
  shutdown_version: { name: "execute_route_change", action: "force_shutdown" },
  execute_l3_operation: { name: "execute_route_change", action: "execute_l3_operation" },
  approve_l3_operation: { name: "execute_route_change", action: "approve_l3_operation" },
  commit_l3_operation: { name: "execute_route_change", action: "commit_l3_operation" },
  reject_l3_operation: { name: "execute_route_change", action: "reject_l3_operation" }
};

for (const name of [
  "get_current_context", "next_action", "check_doc_drift", "summarize_version_closeout",
  "plan_version_closeout"
]) {
  PUBLIC_TOOL_CALLS[name] = { name: "inspect_route_progress", action: name };
}

for (const name of [
  "list_versions_window", "list_versions", "check_start_gate",
  "check_close_gate", "get_version_structure", "get_version_transition_guide"
]) {
  PUBLIC_TOOL_CALLS[name] = { name: "inspect_versions", action: name };
}

for (const name of [
  "get_l3_authorization_status", "recommend_l3_authorization_profile",
  "recommend_l3_authorization_policy", "list_l3_proposals", "get_l3_proposal"
]) {
  PUBLIC_TOOL_CALLS[name] = { name: "inspect_l3_route_operations", action: name };
}

const adaptPublicToolCall = (toolName: string, input: Record<string, unknown>) => {
  const mapped = PUBLIC_TOOL_CALLS[toolName] ?? { name: toolName };
  return {
    name: mapped.name,
    input: mapped.action === undefined ? input : { operation: mapped.action, ...input }
  };
};

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
        exactStore: new MemoryExactAuthorizationStore(),
        interaction: {
          requestAuthorization: async () => ({
            action: "accept" as const,
            content: { approve: true }
          })
        },
        trustedClientId: "vitest"
      }
  });
  const originalInvoke = registry.invoke.bind(registry);

  return {
    ...registry,
    invoke: (toolName: string, input: Record<string, unknown>) => {
      const adapted = adaptPublicToolCall(toolName, input ?? {});
      return originalInvoke(
        adapted.name,
        typeof routeledgerRoot === "string" &&
          WRITE_TOOL_NAMES.has(adapted.name) &&
          !Object.prototype.hasOwnProperty.call(input ?? {}, "expectedRouteLedgerRoot")
          ? {
              ...adapted.input,
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
                ...adapted.input,
                contentLocale: "en",
                firstVersion: {
                  title: "Initial Version",
                  description: "Project bootstrap version",
                  initialTodos: []
                }
              }
            : adapted.input
      );
    }
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
      exactStore: getTrustedExactStore(projectRoot),
      interaction: {
        requestAuthorization: async () => ({
          action: "accept" as const,
          content: { approve: true }
        })
      },
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

        interaction: {
          requestAuthorization: async () => ({
            action: "accept" as const,
            content: { approve: true }
          })
        },

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
  const adapted = adaptPublicToolCall(name, args);
  const toolArgs =
    routeledgerRoot !== undefined &&
    WRITE_TOOL_NAMES.has(adapted.name) &&
    !Object.prototype.hasOwnProperty.call(args, "expectedRouteLedgerRoot")
      ? {
          ...adapted.input,
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
            ...adapted.input,
            contentLocale: "en",
            firstVersion: {
              title: "Initial Version",
              description: "Project bootstrap version",
              initialTodos: []
            }
          }
        : adapted.input;

  return (await server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: adapted.name,
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
  const reportedToolName =
    {
      init_project: "configure_project",
      set_project_content_locale: "configure_project",
      create_todo: "manage_todo",
      close_todo: "manage_todo",
      defer_work: "manage_deferred",
      review_deferred: "manage_deferred",
      record_constraint: "manage_constraint",
      retire_constraint: "manage_constraint",
      batch_create_versions: "propose_version_lifecycle_change",
      transition_version: "propose_version_lifecycle_change",
      advance_to_version: "propose_version_lifecycle_change",
      close_version: "propose_version_lifecycle_change",
      create_version: "propose_version_structure_change",
      insert_version: "propose_version_structure_change",
      create_child_version: "propose_version_structure_change",
      reorder_versions: "propose_version_structure_change",
      prepare_version: "set_version_state",
      mark_version_complete: "set_version_state",
      shutdown_version: "execute_route_change",
      execute_l3_operation: "execute_route_change",
      approve_l3_operation: "execute_route_change",
      commit_l3_operation: "execute_route_change",
      reject_l3_operation: "execute_route_change"
    }[toolName] ?? toolName;
  expect(response).toMatchObject({
    ok: false,
    error: {
      code,
      details: {
        toolName: reportedToolName,
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
      structuredContent: {
        ok: true,
        data: {
          status: "confirmation_required",
          pendingOperationId: expect.any(String),
          proposal: {
            targetId: expect.any(String)
          }
        }
      }
    }
  });

  const createVersionDetails = getStructuredData<{
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
    ok: true,
    data: {
      status: "confirmation_required",
      pendingOperationId: expect.any(String),
      proposal: {
        targetId: expect.any(String)
      }
    }
  });

  const pendingOperationId = (
    createResponse.data as {
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
