import fs from "node:fs/promises";
import path from "node:path";

export interface CodexActorConfig {
  id: string;
  displayName: string;
}

export interface CodexWorkspaceSource {
  kind: "workspace";
  routeLedgerWorkspaceRoot: string;
  command?: string;
  packageFilter?: string;
  entryScript?: string;
}

export interface CodexInstalledPackageSource {
  kind: "installed-package";
  installRoot: string;
  binPath: string;
  command?: string;
}

export type CodexRuntimeSource =
  | CodexWorkspaceSource
  | CodexInstalledPackageSource;

export interface CodexProjectConfigInput {
  workspaceRoot: string;
  routeledgerRoot: string;
  source: CodexRuntimeSource;
  serverName?: string;
  hostProfile?: string;
  actor?: CodexActorConfig;
  approver?: CodexActorConfig;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
}

export interface WriteCodexProjectConfigOptions
  extends CodexProjectConfigInput {
  outputPath?: string;
  existingConfigStrategy?: "write-fragment" | "overwrite" | "error";
}

export interface WriteCodexProjectConfigResult {
  path: string;
  kind: "project-config" | "fragment";
  created: boolean;
  content: string;
  warnings: string[];
}

export interface PlanCodexProjectConfigWriteResult {
  path: string;
  kind: "project-config" | "fragment";
  content: string;
  warnings: string[];
}

export interface CodexGlobalConfigInput {
  source: CodexRuntimeSource;
  serverName?: string;
  hostProfile?: string;
  actor?: CodexActorConfig;
  approver?: CodexActorConfig;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
}

export class CodexProjectConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexProjectConfigError";
    this.code = code;
  }
}

const DEFAULT_SERVER_NAME = "routeledger";
const DEFAULT_PROFILE = "codex";
const DEFAULT_ACTOR: CodexActorConfig = {
  id: "codex-agent",
  displayName: "Codex"
};
const DEFAULT_APPROVER: CodexActorConfig = {
  id: "routeledger-approver",
  displayName: "RouteLedger Approver"
};
const DEFAULT_STARTUP_TIMEOUT_SEC = 20;
const DEFAULT_TOOL_TIMEOUT_SEC = 60;
const DEFAULT_APPROVAL_MODE = "prompt";
const DEFAULT_MCP_PACKAGE_FILTER = "@routeledger/mcp";
const DEFAULT_MCP_ENTRY_SCRIPT = "src/bin.ts";
const DEFAULT_FRAGMENT_SUFFIX = ".fragment.toml";

const AUTO_APPROVAL_TOOLS = [
  "get_current_context",
  "get_runtime_context",
  "discover_routeledger_roots",
  "plan_routeledger_binding",
  "render_host_binding_config",
  "next_action",
  "list_versions_window",
  "list_versions",
  "check_start_gate",
  "check_close_gate",
  "list_l3_proposals",
  "get_l3_proposal"
] as const;

const PROMPT_APPROVAL_TOOLS = [
  "activate_routeledger_binding",
  "write_host_binding_config",
  "approve_l3_operation",
  "reject_l3_operation"
] as const;

const APPROVE_APPROVAL_TOOLS = ["commit_l3_operation"] as const;

const assertAbsolutePath = (value: string, fieldName: string): string => {
  if (value.trim().length === 0) {
    throw new CodexProjectConfigError(
      "EMPTY_PATH",
      `${fieldName} must be a non-empty absolute path.`
    );
  }

  if (!path.isAbsolute(value)) {
    throw new CodexProjectConfigError(
      "ABSOLUTE_PATH_REQUIRED",
      `${fieldName} must be an absolute path. Received: ${value}`
    );
  }

  return path.normalize(value);
};

const assertNonEmpty = (value: string, fieldName: string): string => {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new CodexProjectConfigError(
      "EMPTY_VALUE",
      `${fieldName} must be a non-empty string.`
    );
  }

  return trimmed;
};

const assertServerName = (serverName: string): string => {
  const normalized = assertNonEmpty(serverName, "serverName");

  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new CodexProjectConfigError(
      "INVALID_SERVER_NAME",
      "serverName may only contain letters, digits, underscore, or hyphen."
    );
  }

  return normalized;
};

const toForwardSlashes = (value: string): string => value.replace(/\\/gu, "/");

const quoteTomlString = (value: string): string => JSON.stringify(value);

const renderArray = (values: readonly string[]): string =>
  values.map((value) => `  ${quoteTomlString(value)},`).join("\n");

const renderToolApprovalSections = (serverName: string): string => {
  const sections: string[] = [];

  for (const toolName of AUTO_APPROVAL_TOOLS) {
    sections.push(
      [
        `[mcp_servers.${serverName}.tools.${toolName}]`,
        'approval_mode = "auto"'
      ].join("\n")
    );
  }

  for (const toolName of PROMPT_APPROVAL_TOOLS) {
    sections.push(
      [
        `[mcp_servers.${serverName}.tools.${toolName}]`,
        'approval_mode = "prompt"'
      ].join("\n")
    );
  }

  for (const toolName of APPROVE_APPROVAL_TOOLS) {
    sections.push(
      [
        `[mcp_servers.${serverName}.tools.${toolName}]`,
        'approval_mode = "approve"'
      ].join("\n")
    );
  }

  return sections.join("\n\n");
};

interface NormalizedCodexProjectConfigInput {
  workspaceRoot: string;
  routeledgerRoot: string;
  source: CodexRuntimeSource;
  serverName: string;
  hostProfile: string;
  actor: CodexActorConfig;
  approver: CodexActorConfig;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  defaultToolsApprovalMode: "auto" | "prompt" | "approve";
}

interface NormalizedCodexGlobalConfigInput {
  source: CodexRuntimeSource;
  serverName: string;
  hostProfile: string;
  actor: CodexActorConfig;
  approver: CodexActorConfig;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  defaultToolsApprovalMode: "auto" | "prompt" | "approve";
}

const normalizeInput = (
  input: CodexProjectConfigInput
): NormalizedCodexProjectConfigInput => {
  const workspaceRoot = assertAbsolutePath(input.workspaceRoot, "workspaceRoot");
  const routeledgerRoot = assertAbsolutePath(
    input.routeledgerRoot,
    "routeledgerRoot"
  );
  const serverName = assertServerName(input.serverName ?? DEFAULT_SERVER_NAME);
  const hostProfile = assertNonEmpty(
    input.hostProfile ?? DEFAULT_PROFILE,
    "hostProfile"
  );
  const actor = {
    id: assertNonEmpty(input.actor?.id ?? DEFAULT_ACTOR.id, "actor.id"),
    displayName: assertNonEmpty(
      input.actor?.displayName ?? DEFAULT_ACTOR.displayName,
      "actor.displayName"
    )
  };
  const approver = {
    id: assertNonEmpty(
      input.approver?.id ?? DEFAULT_APPROVER.id,
      "approver.id"
    ),
    displayName: assertNonEmpty(
      input.approver?.displayName ?? DEFAULT_APPROVER.displayName,
      "approver.displayName"
    )
  };
  const startupTimeoutSec =
    input.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC;
  const toolTimeoutSec = input.toolTimeoutSec ?? DEFAULT_TOOL_TIMEOUT_SEC;
  const defaultToolsApprovalMode =
    input.defaultToolsApprovalMode ?? DEFAULT_APPROVAL_MODE;

  if (
    !Number.isInteger(startupTimeoutSec) ||
    startupTimeoutSec <= 0 ||
    !Number.isInteger(toolTimeoutSec) ||
    toolTimeoutSec <= 0
  ) {
    throw new CodexProjectConfigError(
      "INVALID_TIMEOUT",
      "startupTimeoutSec and toolTimeoutSec must be positive integers."
    );
  }

  const relativeRouteLedgerRoot = path.relative(workspaceRoot, routeledgerRoot);

  if (
    relativeRouteLedgerRoot.length > 0 &&
    (relativeRouteLedgerRoot.startsWith("..") || path.isAbsolute(relativeRouteLedgerRoot))
  ) {
    throw new CodexProjectConfigError(
      "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
      "routeledgerRoot must stay within workspaceRoot."
    );
  }

  let source: CodexRuntimeSource;

  if (input.source.kind === "workspace") {
    source = {
      kind: "workspace",
      routeLedgerWorkspaceRoot: assertAbsolutePath(
        input.source.routeLedgerWorkspaceRoot,
        "source.routeLedgerWorkspaceRoot"
      ),
      command: assertNonEmpty(
        input.source.command ?? "pnpm",
        "source.command"
      ),
      packageFilter: assertNonEmpty(
        input.source.packageFilter ?? DEFAULT_MCP_PACKAGE_FILTER,
        "source.packageFilter"
      ),
      entryScript: assertNonEmpty(
        input.source.entryScript ?? DEFAULT_MCP_ENTRY_SCRIPT,
        "source.entryScript"
      )
    };
  } else {
    source = {
      kind: "installed-package",
      installRoot: assertAbsolutePath(
        input.source.installRoot,
        "source.installRoot"
      ),
      binPath: assertAbsolutePath(input.source.binPath, "source.binPath"),
      command: assertNonEmpty(
        input.source.command ?? "node",
        "source.command"
      )
    };
  }

  return {
    workspaceRoot,
    routeledgerRoot,
    source,
    serverName,
    hostProfile,
    actor,
    approver,
    startupTimeoutSec,
    toolTimeoutSec,
    defaultToolsApprovalMode
  };
};

const normalizeGlobalInput = (
  input: CodexGlobalConfigInput
): NormalizedCodexGlobalConfigInput => {
  const normalizedProjectInput = normalizeInput({
    workspaceRoot: "/tmp/routeledger-bootstrap-workspace",
    routeledgerRoot: "/tmp/routeledger-bootstrap-workspace",
    ...input
  });

  return {
    source: normalizedProjectInput.source,
    serverName: normalizedProjectInput.serverName,
    hostProfile: normalizedProjectInput.hostProfile,
    actor: normalizedProjectInput.actor,
    approver: normalizedProjectInput.approver,
    startupTimeoutSec: normalizedProjectInput.startupTimeoutSec,
    toolTimeoutSec: normalizedProjectInput.toolTimeoutSec,
    defaultToolsApprovalMode: normalizedProjectInput.defaultToolsApprovalMode
  };
};

const buildCommandShape = (
  input: NormalizedCodexProjectConfigInput
): {
  command: string;
  args: string[];
  cwd: string;
} => {
  const sharedArgs = [
    "--workspace-root",
    toForwardSlashes(input.workspaceRoot),
    "--routeledger-root",
    toForwardSlashes(input.routeledgerRoot),
    "--profile",
    input.hostProfile,
    "--actor-id",
    input.actor.id,
    "--actor-name",
    input.actor.displayName,
    "--approver-id",
    input.approver.id,
    "--approver-name",
    input.approver.displayName
  ];

  if (input.source.kind === "workspace") {
    return {
      command: input.source.command ?? "pnpm",
      cwd: toForwardSlashes(input.source.routeLedgerWorkspaceRoot),
      args: [
        "--filter",
        input.source.packageFilter ?? DEFAULT_MCP_PACKAGE_FILTER,
        "exec",
        "tsx",
        toForwardSlashes(input.source.entryScript ?? DEFAULT_MCP_ENTRY_SCRIPT),
        ...sharedArgs
      ]
    };
  }

  return {
    command: input.source.command ?? "node",
    cwd: toForwardSlashes(input.source.installRoot),
    args: [toForwardSlashes(input.source.binPath), ...sharedArgs]
  };
};

export const renderCodexProjectConfig = (
  input: CodexProjectConfigInput
): string => {
  const normalized = normalizeInput(input);
  const commandShape = buildCommandShape(normalized);
  const headerLines = [
    "# Generated by @routeledger/codex.",
    "# Fallback/bootstrap config for one explicit workspaceRoot + routeledgerRoot binding.",
    "# Keep both binding flags explicit. Do not rely on fallback behavior."
  ];

  return [
    ...headerLines,
    "",
    `[mcp_servers.${normalized.serverName}]`,
    `command = ${quoteTomlString(commandShape.command)}`,
    "args = [",
    renderArray(commandShape.args),
    "]",
    `cwd = ${quoteTomlString(commandShape.cwd)}`,
    "enabled = true",
    "required = false",
    `startup_timeout_sec = ${normalized.startupTimeoutSec}`,
    `tool_timeout_sec = ${normalized.toolTimeoutSec}`,
    `default_tools_approval_mode = ${quoteTomlString(
      normalized.defaultToolsApprovalMode
    )}`,
    "",
    `[mcp_servers.${normalized.serverName}.env]`,
    `ROUTELEDGER_MCP_PROFILE = ${quoteTomlString(normalized.hostProfile)}`,
    "",
    renderToolApprovalSections(normalized.serverName),
    ""
  ].join("\n");
};

export const renderCodexGlobalConfig = (
  input: CodexGlobalConfigInput
): string => {
  const normalized = normalizeGlobalInput(input);
  const commandShape = buildCommandShape({
    ...normalized,
    workspaceRoot: "/tmp/routeledger-bootstrap-workspace",
    routeledgerRoot: "/tmp/routeledger-bootstrap-workspace"
  });
  const filteredArgs = commandShape.args.filter(
    (value, index, array) =>
      !(
        (value === "--workspace-root" || value === "--routeledger-root") &&
        index + 1 < array.length
      ) &&
      !(
        index > 0 &&
        (array[index - 1] === "--workspace-root" || array[index - 1] === "--routeledger-root")
      )
  );

  return [
    "# Generated by @routeledger/codex.",
    "# Agent-neutral global RouteLedger MCP entry.",
    "# Workspace binding comes from MCP roots/rootUri first, then explicit host fallback flags if needed.",
    "",
    `[mcp_servers.${normalized.serverName}]`,
    `command = ${quoteTomlString(commandShape.command)}`,
    "args = [",
    renderArray(filteredArgs),
    "]",
    `cwd = ${quoteTomlString(commandShape.cwd)}`,
    "enabled = true",
    "required = false",
    `startup_timeout_sec = ${normalized.startupTimeoutSec}`,
    `tool_timeout_sec = ${normalized.toolTimeoutSec}`,
    `default_tools_approval_mode = ${quoteTomlString(
      normalized.defaultToolsApprovalMode
    )}`,
    "",
    `[mcp_servers.${normalized.serverName}.env]`,
    `ROUTELEDGER_MCP_PROFILE = ${quoteTomlString(normalized.hostProfile)}`,
    "",
    renderToolApprovalSections(normalized.serverName),
    ""
  ].join("\n");
};

const readFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
};

const writeFileIfChanged = async (
  filePath: string,
  content: string,
  overwrite: boolean
): Promise<boolean> => {
  const existing = await readFileIfExists(filePath);

  if (existing === content) {
    return false;
  }

  if (existing !== null && !overwrite) {
    throw new CodexProjectConfigError(
      "CONFIG_FILE_EXISTS",
      `Refusing to overwrite existing file without explicit permission: ${filePath}`
    );
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return true;
};

const detectWriteKind = (filePath: string): "project-config" | "fragment" =>
  path.basename(filePath) === "config.toml" ? "project-config" : "fragment";

const getDefaultFragmentPath = (
  workspaceRoot: string,
  serverName: string
): string =>
  path.join(workspaceRoot, ".codex", `${serverName}${DEFAULT_FRAGMENT_SUFFIX}`);

export const writeCodexProjectConfig = async (
  input: WriteCodexProjectConfigOptions
): Promise<WriteCodexProjectConfigResult> => {
  const normalized = normalizeInput(input);
  const content = renderCodexProjectConfig(normalized);
  const explicitOutputPath =
    input.outputPath === undefined
      ? undefined
      : assertAbsolutePath(input.outputPath, "outputPath");
  const strategy = input.existingConfigStrategy ?? "write-fragment";
  const defaultConfigPath = path.join(
    normalized.workspaceRoot,
    ".codex",
    "config.toml"
  );

  if (explicitOutputPath !== undefined) {
    const created = await writeFileIfChanged(
      explicitOutputPath,
      content,
      strategy === "overwrite"
    );

    return {
      path: explicitOutputPath,
      kind: detectWriteKind(explicitOutputPath),
      created,
      content,
      warnings: []
    };
  }

  const existingConfig = await readFileIfExists(defaultConfigPath);

  if (existingConfig === null || strategy === "overwrite") {
    const created = await writeFileIfChanged(
      defaultConfigPath,
      content,
      strategy === "overwrite"
    );

    return {
      path: defaultConfigPath,
      kind: "project-config",
      created,
      content,
      warnings: []
    };
  }

  if (strategy === "error") {
    throw new CodexProjectConfigError(
      "CONFIG_FILE_EXISTS",
      `Codex project config already exists: ${defaultConfigPath}`
    );
  }

  const fragmentPath = getDefaultFragmentPath(
    normalized.workspaceRoot,
    normalized.serverName
  );
  const created = await writeFileIfChanged(fragmentPath, content, false);

  return {
    path: fragmentPath,
    kind: "fragment",
    created,
    content,
      warnings: [
        `Existing ${toForwardSlashes(path.relative(normalized.workspaceRoot, defaultConfigPath))} was left untouched.`,
      "Merge the generated fragment into .codex/config.toml only when explicit workspace fallback/bootstrap is still needed."
    ]
  };
};

export const planCodexProjectConfigWrite = async (
  input: WriteCodexProjectConfigOptions
): Promise<PlanCodexProjectConfigWriteResult> => {
  const normalized = normalizeInput(input);
  const content = renderCodexProjectConfig(normalized);
  const explicitOutputPath =
    input.outputPath === undefined
      ? undefined
      : assertAbsolutePath(input.outputPath, "outputPath");
  const strategy = input.existingConfigStrategy ?? "write-fragment";
  const defaultConfigPath = path.join(
    normalized.workspaceRoot,
    ".codex",
    "config.toml"
  );

  if (explicitOutputPath !== undefined) {
    return {
      path: explicitOutputPath,
      kind: detectWriteKind(explicitOutputPath),
      content,
      warnings: []
    };
  }

  const existingConfig = await readFileIfExists(defaultConfigPath);

  if (existingConfig === null || strategy === "overwrite") {
    return {
      path: defaultConfigPath,
      kind: "project-config",
      content,
      warnings: []
    };
  }

  if (strategy === "error") {
    throw new CodexProjectConfigError(
      "CONFIG_FILE_EXISTS",
      `Codex project config already exists: ${defaultConfigPath}`
    );
  }

  return {
    path: getDefaultFragmentPath(normalized.workspaceRoot, normalized.serverName),
    kind: "fragment",
    content,
    warnings: [
      `Existing ${toForwardSlashes(path.relative(normalized.workspaceRoot, defaultConfigPath))} was left untouched.`,
      "Merge the generated fragment into .codex/config.toml before expecting Codex to load it."
    ]
  };
};
