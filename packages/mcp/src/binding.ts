import fs from "node:fs";
import path from "node:path";

import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";

import {
  resolveWorkspaceConfigSync,
  type WorkspaceConfigDiagnostic
} from "./workspace-config.js";

export type RouteLedgerBindingStatus =
  | "bound"
  | "unbound"
  | "uninitialized"
  | "invalid";

export type WorkspaceRootSource =
  | "mcp_roots"
  | "explicit_arg"
  | "explicit_env"
  | "cwd_marker"
  | "process_cwd"
  | "unbound";

export type WorkspaceRootConfidence = "high" | "medium" | "low" | "none";

export interface RouteLedgerBindingDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface RouteLedgerBindingConfig {
  workspaceRoot?: string;
  workspaceRootSource?: "explicit_arg" | "explicit_env";
  routeledgerRoot?: string;
  processCwd?: string;
  mcpRoots?: string[];
}

export interface RouteLedgerBindingSummary {
  status: RouteLedgerBindingStatus;
  workspaceRoot: string | null;
  workspaceRootSource: WorkspaceRootSource;
  workspaceRootConfidence: WorkspaceRootConfidence;
  routeledgerRoot: string | null;
  workspaceConfigPath: string | null;
  dataRoot: string | null;
  routeledgerDir: string | null;
  jsonProjectPath: string | null;
  sqliteDbPath: string | null;
  processCwd: string;
  diagnostics: RouteLedgerBindingDiagnostic[];
}

export interface ResolveRouteLedgerBindingOptions {
  autoCreateWorkspaceConfig?: boolean;
}

const normalizeOptionalAbsolutePath = (
  value: string | undefined,
  fieldName: string,
  diagnostics: RouteLedgerBindingDiagnostic[]
): string | null => {
  if (value === undefined) {
    return null;
  }

  if (value.trim().length === 0) {
    diagnostics.push({
      code: "EMPTY_PATH",
      severity: "error",
      message: `${fieldName} must be a non-empty absolute path.`
    });
    return null;
  }

  if (!path.isAbsolute(value)) {
    diagnostics.push({
      code: "ABSOLUTE_PATH_REQUIRED",
      severity: "error",
      message: `${fieldName} must be an absolute path. Received: ${value}`
    });
    return null;
  }

  return path.resolve(value);
};

const isContainedWithin = (root: string, candidate: string): boolean => {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

const convertWorkspaceDiagnostics = (
  diagnostics: WorkspaceConfigDiagnostic[]
): RouteLedgerBindingDiagnostic[] => diagnostics.map((diagnostic) => ({ ...diagnostic }));

const findWorkspaceMarkerFromCwd = (processCwd: string): string | null => {
  let current = processCwd;

  while (true) {
    const configPath = path.join(current, ROUTELEDGER_DIRECTORY, "config.json");
    if (fs.existsSync(configPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
};

const buildSummary = (
  summary: Omit<RouteLedgerBindingSummary, "diagnostics"> & {
    diagnostics: RouteLedgerBindingDiagnostic[];
  }
): RouteLedgerBindingSummary => summary;

const toUnboundSummary = (options: {
  processCwd: string;
  workspaceRoot: string | null;
  workspaceRootSource: WorkspaceRootSource;
  workspaceRootConfidence: WorkspaceRootConfidence;
  diagnostics: RouteLedgerBindingDiagnostic[];
}): RouteLedgerBindingSummary =>
  buildSummary({
    status: "unbound",
    workspaceRoot: options.workspaceRoot,
    workspaceRootSource: options.workspaceRootSource,
    workspaceRootConfidence: options.workspaceRootConfidence,
    routeledgerRoot: null,
    workspaceConfigPath: null,
    dataRoot: null,
    routeledgerDir: null,
    jsonProjectPath: null,
    sqliteDbPath: null,
    processCwd: options.processCwd,
    diagnostics: options.diagnostics
  });

const toInvalidSummary = (options: {
  processCwd: string;
  workspaceRoot: string | null;
  workspaceRootSource: WorkspaceRootSource;
  workspaceRootConfidence: WorkspaceRootConfidence;
  routeledgerRoot: string | null;
  workspaceConfigPath: string | null;
  dataRoot: string | null;
  routeledgerDir: string | null;
  jsonProjectPath: string | null;
  sqliteDbPath: string | null;
  diagnostics: RouteLedgerBindingDiagnostic[];
}): RouteLedgerBindingSummary =>
  buildSummary({
    status: "invalid",
    workspaceRoot: options.workspaceRoot,
    workspaceRootSource: options.workspaceRootSource,
    workspaceRootConfidence: options.workspaceRootConfidence,
    routeledgerRoot: options.routeledgerRoot,
    workspaceConfigPath: options.workspaceConfigPath,
    dataRoot: options.dataRoot,
    routeledgerDir: options.routeledgerDir,
    jsonProjectPath: options.jsonProjectPath,
    sqliteDbPath: options.sqliteDbPath,
    processCwd: options.processCwd,
    diagnostics: options.diagnostics
  });

const isTrustedWorkspaceSource = (source: WorkspaceRootSource): boolean =>
  source === "mcp_roots" ||
  source === "explicit_arg" ||
  source === "explicit_env" ||
  source === "cwd_marker";

export const resolveRouteLedgerBinding = (
  config: RouteLedgerBindingConfig,
  options: ResolveRouteLedgerBindingOptions = {}
): RouteLedgerBindingSummary => {
  const processCwd = path.resolve(config.processCwd ?? process.cwd());
  const diagnostics: RouteLedgerBindingDiagnostic[] = [];
  const explicitWorkspaceRoot = normalizeOptionalAbsolutePath(
    config.workspaceRoot,
    "workspaceRoot",
    diagnostics
  );
  const explicitRouteLedgerRoot = normalizeOptionalAbsolutePath(
    config.routeledgerRoot,
    "routeledgerRoot",
    diagnostics
  );

  const normalizedMcpRoots = (config.mcpRoots ?? [])
    .map((candidate) => normalizeOptionalAbsolutePath(candidate, "mcpRoots[]", diagnostics))
    .filter((candidate): candidate is string => candidate !== null);

  if (normalizedMcpRoots.length > 1) {
    diagnostics.push({
      code: "MCP_ROOTS_AMBIGUOUS",
      severity: "error",
      message: "Multiple MCP roots were supplied. RouteLedger requires a single workspace root binding."
    });

    return toUnboundSummary({
      processCwd,
      workspaceRoot: null,
      workspaceRootSource: "unbound",
      workspaceRootConfidence: "none",
      diagnostics
    });
  }

  let workspaceRoot: string | null = null;
  let workspaceRootSource: WorkspaceRootSource = "unbound";
  let workspaceRootConfidence: WorkspaceRootConfidence = "none";

  if (normalizedMcpRoots.length === 1) {
    workspaceRoot = normalizedMcpRoots[0]!;
    workspaceRootSource = "mcp_roots";
    workspaceRootConfidence = "high";
  } else if (explicitWorkspaceRoot !== null) {
    workspaceRoot = explicitWorkspaceRoot;
    workspaceRootSource = config.workspaceRootSource ?? "explicit_arg";
    workspaceRootConfidence = "high";
  } else {
    const markerWorkspaceRoot = findWorkspaceMarkerFromCwd(processCwd);

    if (markerWorkspaceRoot !== null) {
      workspaceRoot = markerWorkspaceRoot;
      workspaceRootSource = "cwd_marker";
      workspaceRootConfidence = "medium";
    } else {
      workspaceRoot = processCwd;
      workspaceRootSource = "process_cwd";
      workspaceRootConfidence = "low";
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return toInvalidSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      routeledgerRoot: explicitRouteLedgerRoot,
      workspaceConfigPath:
        workspaceRoot === null ? null : path.join(workspaceRoot, ROUTELEDGER_DIRECTORY, "config.json"),
      dataRoot: explicitRouteLedgerRoot,
      routeledgerDir:
        explicitRouteLedgerRoot === null ? null : path.join(explicitRouteLedgerRoot, ROUTELEDGER_DIRECTORY),
      jsonProjectPath: null,
      sqliteDbPath: null,
      diagnostics
    });
  }

  if (workspaceRoot === null) {
    return toUnboundSummary({
      processCwd,
      workspaceRoot: null,
      workspaceRootSource,
      workspaceRootConfidence,
      diagnostics
    });
  }

  if (explicitRouteLedgerRoot !== null && !isContainedWithin(workspaceRoot, explicitRouteLedgerRoot)) {
    diagnostics.push({
      code: "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
      severity: "error",
      message: "routeledgerRoot must stay within workspaceRoot."
    });
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return toInvalidSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      routeledgerRoot: explicitRouteLedgerRoot,
      workspaceConfigPath: path.join(workspaceRoot, ROUTELEDGER_DIRECTORY, "config.json"),
      dataRoot: explicitRouteLedgerRoot,
      routeledgerDir:
        explicitRouteLedgerRoot === null ? null : path.join(explicitRouteLedgerRoot, ROUTELEDGER_DIRECTORY),
      jsonProjectPath: null,
      sqliteDbPath: null,
      diagnostics
    });
  }

  if (!isTrustedWorkspaceSource(workspaceRootSource)) {
    diagnostics.push({
      code: "WORKSPACE_ROOT_UNTRUSTED",
      severity: "warning",
      message:
        "No trusted workspace root was discovered. RouteLedger will not auto-create .routeledger/config.json from process.cwd()."
    });

    return toUnboundSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      diagnostics
    });
  }

  const shouldAutoCreateWorkspaceConfig = options.autoCreateWorkspaceConfig ?? true;

  if (
    shouldAutoCreateWorkspaceConfig &&
    explicitRouteLedgerRoot !== null &&
    !fs.existsSync(explicitRouteLedgerRoot)
  ) {
    fs.mkdirSync(explicitRouteLedgerRoot, { recursive: true });
  }

  const workspaceConfig = resolveWorkspaceConfigSync({
    projectRoot: workspaceRoot,
    autoCreate: shouldAutoCreateWorkspaceConfig,
    defaultDataDir:
      explicitRouteLedgerRoot === null
        ? "."
        : path.relative(workspaceRoot, explicitRouteLedgerRoot) || "."
  });

  if (workspaceConfig.status === "missing") {
    return toUnboundSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      diagnostics: diagnostics.concat(convertWorkspaceDiagnostics(workspaceConfig.diagnostics))
    });
  }

  if (workspaceConfig.status === "invalid") {
    return toInvalidSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      routeledgerRoot: explicitRouteLedgerRoot ?? workspaceConfig.dataRoot,
      workspaceConfigPath: workspaceConfig.workspaceConfigPath,
      dataRoot: workspaceConfig.dataRoot,
      routeledgerDir: workspaceConfig.routeledgerDir,
      jsonProjectPath: workspaceConfig.jsonProjectPath,
      sqliteDbPath: workspaceConfig.sqliteDbPath,
      diagnostics: diagnostics.concat(convertWorkspaceDiagnostics(workspaceConfig.diagnostics))
    });
  }

  const resolvedRouteLedgerRoot = workspaceConfig.dataRoot;

  if (
    explicitRouteLedgerRoot !== null &&
    path.resolve(explicitRouteLedgerRoot) !== path.resolve(resolvedRouteLedgerRoot)
  ) {
    diagnostics.push({
      code: "ROUTELEDGER_ROOT_CONFIG_MISMATCH",
      severity: "error",
      message: "Explicit routeledgerRoot does not match workspace config dataDir."
    });

    return toInvalidSummary({
      processCwd,
      workspaceRoot,
      workspaceRootSource,
      workspaceRootConfidence,
      routeledgerRoot: resolvedRouteLedgerRoot,
      workspaceConfigPath: workspaceConfig.workspaceConfigPath,
      dataRoot: workspaceConfig.dataRoot,
      routeledgerDir: workspaceConfig.routeledgerDir,
      jsonProjectPath: workspaceConfig.jsonProjectPath,
      sqliteDbPath: workspaceConfig.sqliteDbPath,
      diagnostics
    });
  }

  const hasCanonicalJson = fs.existsSync(workspaceConfig.jsonProjectPath);
  const hasSqlite = fs.existsSync(workspaceConfig.sqliteDbPath);
  const status: RouteLedgerBindingStatus =
    !hasCanonicalJson && !hasSqlite ? "uninitialized" : "bound";

  return buildSummary({
    status,
    workspaceRoot,
    workspaceRootSource,
    workspaceRootConfidence,
    routeledgerRoot: resolvedRouteLedgerRoot,
    workspaceConfigPath: workspaceConfig.workspaceConfigPath,
    dataRoot: workspaceConfig.dataRoot,
    routeledgerDir: workspaceConfig.routeledgerDir,
    jsonProjectPath: workspaceConfig.jsonProjectPath,
    sqliteDbPath: workspaceConfig.sqliteDbPath,
    processCwd,
    diagnostics
  });
};
