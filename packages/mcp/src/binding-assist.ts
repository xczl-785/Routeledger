import fs from "node:fs/promises";
import path from "node:path";

import type {
  PlanCodexProjectConfigWriteResult,
  WriteCodexProjectConfigResult,
  WriteCodexProjectConfigOptions
} from "@routeledger/codex";
import {
  planCodexProjectConfigWrite,
  renderCodexProjectConfig,
  writeCodexProjectConfig
} from "@routeledger/codex";

import {
  JsonFirstStorageAdapter,
  type RuntimeBindingActiveProject,
  type RuntimeBindingInspection,
  type RuntimeBindingStorageMode
} from "./json-first-storage.js";
import {
  resolveRouteLedgerBinding,
  type RouteLedgerBindingSummary
} from "./binding.js";
import type { RouteLedgerRecommendedNextAction } from "./binding-preflight.js";
import {
  WORKSPACE_CONFIG_FILENAME,
  getWorkspaceConfigPath,
  resolveDefaultRouteLedgerDataDir,
  resolveWorkspaceConfigSync
} from "./workspace-config.js";
import {
  arePhysicalPathsEqualSync,
  isPhysicalPathContainedWithinSync
} from "./physical-path.js";

export type RouteLedgerDiscoveryStatus =
  | "blocked"
  | "none_found"
  | "single_candidate"
  | "ambiguous";

export interface RouteLedgerBindingAssistRisk {
  code: string;
  severity: "warning" | "error";
  message: string;
  details?: Record<string, unknown> | null;
}

export interface RouteLedgerRootCandidate {
  id: string;
  routeledgerRoot: string;
  workspaceConfigPath: string;
  dataRoot: string | null;
  routeledgerDir: string | null;
  lastModified: string | null;
  storage: {
    mode: RuntimeBindingStorageMode;
    hasCanonicalJson: boolean;
    hasSqlite: boolean;
  };
  activeProject: RuntimeBindingActiveProject | null;
  risks: RouteLedgerBindingAssistRisk[];
}

export interface DiscoverRouteLedgerRootsResult {
  workspaceRoot: string | null;
  status: RouteLedgerDiscoveryStatus;
  candidates: RouteLedgerRootCandidate[];
  recommendedBinding: {
    workspaceRoot: string;
    routeledgerRoot: string;
    requiresUserDecision: boolean;
  } | null;
  reasons: RouteLedgerBindingAssistRisk[];
  recommendedNextActions: RouteLedgerRecommendedNextAction[];
}

export type RouteLedgerBindingPlanStatus =
  | "ready"
  | "needs_init"
  | "needs_user_decision"
  | "blocked";

export interface RouteLedgerBindingPlanCheck {
  code: string;
  status: "ok" | "warning" | "blocked";
  message: string;
}

export interface RouteLedgerBindingPlanResult {
  status: RouteLedgerBindingPlanStatus;
  workspaceRoot: string;
  source:
    | "explicit_root"
    | "current_binding"
    | "discovered_single_candidate"
    | "needs_explicit_workspace"
    | "none_found"
    | "ambiguous";
  currentBinding: {
    status: RouteLedgerBindingSummary["status"];
    workspaceRoot: string | null;
    routeledgerRoot: string | null;
    workspaceConfigPath: string | null;
    dataRoot: string | null;
    routeledgerDir: string | null;
    jsonProjectPath: string | null;
    sqliteDbPath: string | null;
  };
  targetBinding: {
    workspaceRoot: string;
    routeledgerRoot: string;
    dataRoot?: string | null;
    routeledgerDir: string;
    workspaceConfigPath?: string | null;
    jsonProjectPath?: string | null;
    sqliteDbPath?: string | null;
  } | null;
  selectedCandidate: RouteLedgerRootCandidate | null;
  checks: RouteLedgerBindingPlanCheck[];
  risks: RouteLedgerBindingAssistRisk[];
  requiresUserDecision: boolean;
  requiresInit: boolean;
  /** Legacy mirror of persistentHostBinding.requiresHostConfigUpdate. */
  requiresHostConfigUpdate: boolean;
  /** Legacy mirror of persistentHostBinding.requiresServerRestart. */
  requiresServerRestart: boolean;
  sessionActivation: {
    available: boolean;
    required: boolean;
    action: "activate_routeledger_binding" | null;
  };
  persistentHostBinding: {
    requiredForFutureSessions: boolean;
    requiresHostConfigUpdate: boolean;
    requiresServerRestart: boolean;
  };
  recommendedNextActions: RouteLedgerRecommendedNextAction[];
}

export interface RenderHostBindingConfigResult {
  hostProfile: "codex";
  status: "ready" | "blocked";
  launcherRequirement?: {
    code: "STABLE_RUNTIME_LAUNCHER_REQUIRED";
    message: string;
  };
  bindingPlan: RouteLedgerBindingPlanResult;
  renderedConfig: {
    format: "toml";
    content: string;
  } | null;
  writePlan: PlanCodexProjectConfigWriteResult | null;
}

export interface WriteHostBindingConfigResult {
  hostProfile: "codex";
  status: "ready" | "blocked";
  launcherRequirement?: {
    code: "STABLE_RUNTIME_LAUNCHER_REQUIRED";
    message: string;
  };
  bindingPlan: RouteLedgerBindingPlanResult;
  writeResult: WriteCodexProjectConfigResult | null;
}

const DISCOVERY_IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store"
]);

const describeCandidateRisks = (
  inspection: Pick<
    RuntimeBindingInspection,
    "storageMode" | "conflict" | "jsonError" | "sqliteError" | "writeLock"
  >
): RouteLedgerBindingAssistRisk[] => {
  const risks: RouteLedgerBindingAssistRisk[] = [];

  if (inspection.storageMode === "json_invalid" && inspection.jsonError !== null) {
    risks.push({
      code:
        typeof inspection.jsonError.code === "string"
          ? inspection.jsonError.code
          : "JSON_SOURCE_INVALID",
      severity: "error",
      message:
        typeof inspection.jsonError.message === "string"
          ? inspection.jsonError.message
          : "Canonical RouteLedger JSON is invalid.",
      details:
        inspection.jsonError.details !== null &&
        typeof inspection.jsonError.details === "object"
          ? (inspection.jsonError.details as Record<string, unknown>)
          : null
    });
  }

  if (inspection.conflict !== null) {
    risks.push({
      code:
        typeof inspection.conflict.code === "string"
          ? inspection.conflict.code
          : "JSON_SQLITE_CONFLICT",
      severity: "error",
      message:
        typeof inspection.conflict.message === "string"
          ? inspection.conflict.message
          : "Canonical JSON and SQLite disagree for this RouteLedger root.",
      details:
        inspection.conflict.details !== null &&
        typeof inspection.conflict.details === "object"
          ? (inspection.conflict.details as Record<string, unknown>)
          : null
    });
  }

  if (inspection.storageMode === "sqlite_unavailable" && inspection.sqliteError !== null) {
    risks.push({
      code: "SQLITE_UNAVAILABLE",
      severity: "warning",
      message: "SQLite read model is unavailable for this RouteLedger root.",
      details: inspection.sqliteError
    });
  }

  if (inspection.storageMode === "write_in_progress") {
    risks.push({
      code: "WRITE_IN_PROGRESS",
      severity: "warning",
      message: "A canonical JSON write is already in progress for this RouteLedger root.",
      details: inspection.writeLock === null ? null : { ...inspection.writeLock }
    });
  }

  return risks;
};

const inspectResolvedBindingCandidate = async (
  workspaceRoot: string,
  routeledgerRoot: string
): Promise<RouteLedgerRootCandidate> => {
  const workspaceConfig = resolveWorkspaceConfigSync({
    projectRoot: workspaceRoot,
    autoCreate: false
  });

  if (workspaceConfig.status !== "ready") {
    const configTimestamp =
      workspaceConfig.status === "missing"
        ? null
        : (await fs.stat(workspaceConfig.workspaceConfigPath)).mtime.toISOString();

    return {
      id: `candidate_${Buffer.from(routeledgerRoot).toString("base64url").slice(0, 12)}`,
      routeledgerRoot,
      workspaceConfigPath: workspaceConfig.workspaceConfigPath,
      dataRoot: workspaceConfig.status === "missing" ? null : workspaceConfig.dataRoot,
      routeledgerDir:
        workspaceConfig.status === "missing" ? null : workspaceConfig.routeledgerDir,
      lastModified: configTimestamp,
      storage: {
        mode: "uninitialized",
        hasCanonicalJson: false,
        hasSqlite: false
      },
      activeProject: null,
      risks: workspaceConfig.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message
      }))
    };
  }

  const storage = new JsonFirstStorageAdapter({
    workspaceRoot,
    routeledgerRoot,
    autoCreateWorkspaceConfig: false
  });

  try {
    const [inspection, routeledgerStat] = await Promise.all([
      storage.inspectRuntimeBinding(),
      fs.stat(workspaceConfig.workspaceConfigPath)
    ]);

    return {
      id: `candidate_${Buffer.from(routeledgerRoot).toString("base64url").slice(0, 12)}`,
      routeledgerRoot,
      workspaceConfigPath: workspaceConfig.workspaceConfigPath,
      dataRoot: workspaceConfig.dataRoot,
      routeledgerDir: workspaceConfig.routeledgerDir,
      lastModified: routeledgerStat.mtime.toISOString(),
      storage: {
        mode: inspection.storageMode,
        hasCanonicalJson: inspection.hasCanonicalJson,
        hasSqlite: inspection.hasSqlite
      },
      activeProject: inspection.activeProject,
      risks: describeCandidateRisks(inspection)
    };
  } finally {
    storage.close();
  }
};

const inspectCandidate = async (
  candidateWorkspaceRoot: string
): Promise<RouteLedgerRootCandidate> => {
  const workspaceConfig = resolveWorkspaceConfigSync({
    projectRoot: candidateWorkspaceRoot,
    autoCreate: false
  });

  if (workspaceConfig.status !== "ready") {
    const configTimestamp =
      workspaceConfig.status === "missing"
        ? null
        : (await fs.stat(workspaceConfig.workspaceConfigPath)).mtime.toISOString();

    return {
      id: `candidate_${Buffer.from(candidateWorkspaceRoot).toString("base64url").slice(0, 12)}`,
      routeledgerRoot: candidateWorkspaceRoot,
      workspaceConfigPath: workspaceConfig.workspaceConfigPath,
      dataRoot: workspaceConfig.status === "missing" ? null : workspaceConfig.dataRoot,
      routeledgerDir:
        workspaceConfig.status === "missing" ? null : workspaceConfig.routeledgerDir,
      lastModified: configTimestamp,
      storage: {
        mode: "uninitialized",
        hasCanonicalJson: false,
        hasSqlite: false
      },
      activeProject: null,
      risks: workspaceConfig.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message
      }))
    };
  }

  return inspectResolvedBindingCandidate(
    candidateWorkspaceRoot,
    workspaceConfig.dataRoot
  );
};

const compareCandidates = (
  left: RouteLedgerRootCandidate,
  right: RouteLedgerRootCandidate
): number =>
  left.routeledgerRoot.localeCompare(right.routeledgerRoot, "en");

const buildDiscoverActions = (
  status: RouteLedgerDiscoveryStatus,
  workspaceRoot: string,
  candidate: RouteLedgerRootCandidate | null
): RouteLedgerRecommendedNextAction[] => {
  if (status === "none_found") {
    return [
      {
        type: "initialize_at_workspace_root",
        tool: "plan_routeledger_binding",
        routeledgerRoot: workspaceRoot,
        description: "Plan a new binding rooted at workspaceRoot before creating .routeledger."
      }
    ];
  }

  if (status === "single_candidate" && candidate !== null) {
    return [
      {
        type: "plan_binding",
        tool: "plan_routeledger_binding",
        routeledgerRoot: candidate.routeledgerRoot,
        description: "Generate a binding plan for the discovered RouteLedger root."
      },
      {
        type: "render_codex_config",
        tool: "render_host_binding_config",
        routeledgerRoot: candidate.routeledgerRoot,
        description: "Render a Codex config fragment for the discovered RouteLedger root."
      }
    ];
  }

  return [
    {
      type: "ask_user_for_binding_root",
      description:
        "Multiple RouteLedger roots were found. Choose one before rendering host config or restarting the MCP server."
    }
  ];
};

export const discoverRouteLedgerRoots = async (options: {
  workspaceRoot?: string;
}): Promise<DiscoverRouteLedgerRootsResult> => {
  if (typeof options.workspaceRoot !== "string" || !path.isAbsolute(options.workspaceRoot)) {
    return {
      workspaceRoot: null,
      status: "blocked",
      candidates: [],
      recommendedBinding: null,
      reasons: [
        {
          code: "NEEDS_EXPLICIT_WORKSPACE_ROOT",
          severity: "warning",
          message:
            "workspaceRoot must be an absolute path. Do not scan an untrusted MCP process cwd."
        }
      ],
      recommendedNextActions: [
        {
          type: "provide_explicit_workspace_root",
          tool: "activate_routeledger_binding",
          field: "workspaceRoot",
          description:
            "Pass the host project absolute workspaceRoot to activate_routeledger_binding."
        }
      ]
    };
  }
  const workspaceRoot = options.workspaceRoot;
  const routeledgerRoots = new Set<string>();

  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);

      if (entry.name === ".routeledger") {
        try {
          const configStat = await fs.stat(path.join(entryPath, WORKSPACE_CONFIG_FILENAME));
          if (configStat.isFile()) {
            routeledgerRoots.add(directory);
          }
        } catch {
          // Ignore directories named .routeledger that are not workspace config entries.
        }
        continue;
      }

      if (DISCOVERY_IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      await visit(entryPath);
    }
  };

  await visit(workspaceRoot);

  const candidates = await Promise.all(
    [...routeledgerRoots]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((candidateWorkspaceRoot) => inspectCandidate(candidateWorkspaceRoot))
  );
  candidates.sort(compareCandidates);

  if (candidates.length === 0) {
    return {
      workspaceRoot,
      status: "none_found",
      candidates,
      recommendedBinding: null,
      reasons: [
        {
          code: "NO_ROUTELEDGER_ROOTS_FOUND",
          severity: "warning",
          message: "No .routeledger/config.json entrypoints were found within workspaceRoot."
        }
      ],
      recommendedNextActions: buildDiscoverActions("none_found", workspaceRoot, null)
    };
  }

  if (candidates.length === 1) {
    const [candidate] = candidates;
    const hasBlockingRisk = candidate!.risks.some((risk) => risk.severity === "error");

    return {
      workspaceRoot,
      status: "single_candidate",
      candidates,
      recommendedBinding: {
        workspaceRoot,
        routeledgerRoot: candidate!.routeledgerRoot,
        requiresUserDecision: hasBlockingRisk
      },
      reasons: candidate!.risks,
      recommendedNextActions: buildDiscoverActions(
        "single_candidate",
        workspaceRoot,
        candidate!
      )
    };
  }

  return {
    workspaceRoot,
    status: "ambiguous",
    candidates,
    recommendedBinding: null,
    reasons: [
      {
        code: "MULTIPLE_ROUTELEDGER_ROOTS_FOUND",
        severity: "warning",
        message:
          "Multiple .routeledger/config.json entrypoints were found within workspaceRoot. Selecting automatically may bind the wrong state root."
      }
    ],
    recommendedNextActions: buildDiscoverActions("ambiguous", workspaceRoot, null)
  };
};

const buildPlanAction = (
  type: string,
  description: string,
  extra: Partial<RouteLedgerRecommendedNextAction> = {}
): RouteLedgerRecommendedNextAction => ({
  type,
  description,
  ...extra
});

const unavailableSessionActivation = {
  available: false,
  required: false,
  action: null
} as const;

const noPersistentHostBinding = {
  requiredForFutureSessions: false,
  requiresHostConfigUpdate: false,
  requiresServerRestart: false
} as const;

const createPersistentHostBinding = (requiredForFutureSessions: boolean) => ({
  requiredForFutureSessions,
  requiresHostConfigUpdate: requiredForFutureSessions,
  requiresServerRestart: requiredForFutureSessions
});

const createSessionActivation = (options: {
  hostProfile?: "generic" | "codex" | "claude-code" | "cursor";
  binding: RouteLedgerBindingSummary;
  targetWorkspaceRoot: string;
  targetRouteledgerRoot: string;
  targetStatus: "ready" | "needs_init" | "blocked";
}) => {
  const targetDiffersFromEstablishedBinding =
    options.binding.workspaceRoot === null ||
    options.binding.routeledgerRoot === null ||
    !arePhysicalPathsEqualSync(options.binding.workspaceRoot, options.targetWorkspaceRoot) ||
    !arePhysicalPathsEqualSync(options.binding.routeledgerRoot, options.targetRouteledgerRoot);
  const requiresActivation =
    options.hostProfile === "codex" &&
    ((options.binding.status === "unbound" ||
      options.binding.status === "invalid" ||
      options.binding.workspaceRootConfidence === "low" ||
      options.binding.workspaceRootConfidence === "none") ||
      targetDiffersFromEstablishedBinding) &&
    (options.targetStatus === "ready" || options.targetStatus === "needs_init");

  return requiresActivation
    ? {
        available: true,
        required: true,
        action: "activate_routeledger_binding" as const
      }
    : unavailableSessionActivation;
};

export const planRouteLedgerBinding = async (options: {
  binding: RouteLedgerBindingSummary;
  workspaceRoot?: string;
  routeledgerRoot?: string;
  hostProfile?: "generic" | "codex" | "claude-code" | "cursor";
}): Promise<RouteLedgerBindingPlanResult> => {
  const currentBinding = {
    status: options.binding.status,
    workspaceRoot: options.binding.workspaceRoot,
    routeledgerRoot: options.binding.routeledgerRoot,
    workspaceConfigPath: options.binding.workspaceConfigPath,
    dataRoot: options.binding.dataRoot,
    routeledgerDir: options.binding.routeledgerDir,
    jsonProjectPath: options.binding.jsonProjectPath,
    sqliteDbPath: options.binding.sqliteDbPath
  };
  const requestedWorkspaceRoot = options.workspaceRoot;
  const fallbackWorkspaceRoot = options.binding.workspaceRoot;
  const workspaceRoot =
    typeof requestedWorkspaceRoot === "string" && path.isAbsolute(requestedWorkspaceRoot)
      ? requestedWorkspaceRoot
      : fallbackWorkspaceRoot;
  const needsExplicitWorkspace =
    requestedWorkspaceRoot === undefined &&
    (options.binding.workspaceRootConfidence === "low" ||
      options.binding.workspaceRootConfidence === "none" ||
      fallbackWorkspaceRoot === null);
  if (
    (requestedWorkspaceRoot !== undefined &&
      (typeof requestedWorkspaceRoot !== "string" || !path.isAbsolute(requestedWorkspaceRoot))) ||
    needsExplicitWorkspace ||
    workspaceRoot === null
  ) {
    return {
      status: "blocked",
      workspaceRoot: workspaceRoot ?? options.binding.processCwd,
      source: "needs_explicit_workspace",
      currentBinding,
      targetBinding: null,
      selectedCandidate: null,
      checks: [
        {
          code:
            requestedWorkspaceRoot !== undefined
              ? "ABSOLUTE_PATH_REQUIRED"
              : "NEEDS_EXPLICIT_WORKSPACE_ROOT",
          status: "blocked",
          message:
            requestedWorkspaceRoot !== undefined
              ? "workspaceRoot must be an absolute path."
              : "Current MCP binding has no trusted workspaceRoot. Pass the host project absolute workspaceRoot."
        }
      ],
      risks: [],
      requiresUserDecision: true,
      requiresInit: false,
      requiresHostConfigUpdate: false,
      requiresServerRestart: false,
      sessionActivation: unavailableSessionActivation,
      persistentHostBinding: noPersistentHostBinding,
      recommendedNextActions: [
        buildPlanAction(
          "provide_explicit_workspace_root",
          "Retry with the host project absolute workspaceRoot; do not use the MCP process cwd.",
          { tool: "activate_routeledger_binding" }
        )
      ]
    };
  }
  const checks: RouteLedgerBindingPlanCheck[] = [];
  const risks: RouteLedgerBindingAssistRisk[] = [];

  let source: RouteLedgerBindingPlanResult["source"] = "current_binding";
  let selectedRouteLedgerRoot: string | null = null;
  let selectedCandidate: RouteLedgerRootCandidate | null = null;

  if (typeof options.routeledgerRoot === "string") {
    source = "explicit_root";

    if (!path.isAbsolute(options.routeledgerRoot)) {
      checks.push({
        code: "ABSOLUTE_PATH_REQUIRED",
        status: "blocked",
        message: "routeledgerRoot must be an absolute path."
      });

      return {
        status: "blocked",
        workspaceRoot,
        source,
        currentBinding,
        targetBinding: null,
        selectedCandidate: null,
        checks,
        risks,
        requiresUserDecision: false,
        requiresInit: false,
        requiresHostConfigUpdate: false,
        requiresServerRestart: false,
        sessionActivation: unavailableSessionActivation,
        persistentHostBinding: noPersistentHostBinding,
        recommendedNextActions: [
          buildPlanAction(
            "retry_with_absolute_root",
            "Retry plan_routeledger_binding with an absolute routeledgerRoot."
          )
        ]
      };
    }

    selectedRouteLedgerRoot = options.routeledgerRoot;
  } else if (options.binding.routeledgerRoot !== null && options.binding.status !== "invalid") {
    selectedRouteLedgerRoot = options.binding.routeledgerRoot;
  } else {
    const discovery = await discoverRouteLedgerRoots({ workspaceRoot });

    if (discovery.status === "none_found") {
      return {
        status: "needs_user_decision",
        workspaceRoot,
        source: "none_found",
        currentBinding,
        targetBinding: null,
        selectedCandidate: null,
        checks: [
          {
            code: "NO_ROUTELEDGER_ROOTS_FOUND",
            status: "warning",
            message: "No RouteLedger roots were discovered in workspaceRoot."
          }
        ],
        risks: discovery.reasons,
        requiresUserDecision: true,
        requiresInit: false,
        requiresHostConfigUpdate: false,
        requiresServerRestart: false,
        sessionActivation: unavailableSessionActivation,
        persistentHostBinding: noPersistentHostBinding,
        recommendedNextActions: [
          buildPlanAction(
            "plan_init_at_workspace_root",
            "Retry with an explicit routeledgerRoot if you intend to initialize a new RouteLedger root.",
            {
              tool: "plan_routeledger_binding",
              routeledgerRoot: workspaceRoot
            }
          )
        ]
      };
    }

    if (discovery.status === "ambiguous") {
      return {
        status: "needs_user_decision",
        workspaceRoot,
        source: "ambiguous",
        currentBinding,
        targetBinding: null,
        selectedCandidate: null,
        checks: [
          {
            code: "MULTIPLE_ROUTELEDGER_ROOTS_FOUND",
            status: "warning",
            message: "Multiple RouteLedger roots were discovered in workspaceRoot."
          }
        ],
        risks: discovery.reasons,
        requiresUserDecision: true,
        requiresInit: false,
        requiresHostConfigUpdate: false,
        requiresServerRestart: false,
        sessionActivation: unavailableSessionActivation,
        persistentHostBinding: noPersistentHostBinding,
        recommendedNextActions: discovery.recommendedNextActions
      };
    }

    source = "discovered_single_candidate";
    selectedCandidate = discovery.candidates[0] ?? null;
    selectedRouteLedgerRoot = selectedCandidate?.routeledgerRoot ?? null;
  }

  if (selectedRouteLedgerRoot === null) {
    return {
      status: "blocked",
      workspaceRoot,
      source,
      currentBinding,
      targetBinding: null,
      selectedCandidate: null,
      checks,
      risks,
      requiresUserDecision: false,
      requiresInit: false,
      requiresHostConfigUpdate: false,
      requiresServerRestart: false,
      sessionActivation: unavailableSessionActivation,
      persistentHostBinding: noPersistentHostBinding,
      recommendedNextActions: []
    };
  }

  if (!isPhysicalPathContainedWithinSync(workspaceRoot, selectedRouteLedgerRoot)) {
    checks.push({
      code: "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
      status: "blocked",
      message: "routeledgerRoot must stay within workspaceRoot."
    });

    return {
      status: "blocked",
      workspaceRoot,
      source,
      currentBinding,
      targetBinding: null,
      selectedCandidate,
      checks,
      risks,
      requiresUserDecision: false,
      requiresInit: false,
      requiresHostConfigUpdate: false,
      requiresServerRestart: false,
      sessionActivation: unavailableSessionActivation,
      persistentHostBinding: noPersistentHostBinding,
      recommendedNextActions: [
        buildPlanAction(
          "choose_in_workspace_root",
          "Pick a routeledgerRoot that stays within workspaceRoot."
        )
      ]
    };
  }

  const targetBinding = resolveRouteLedgerBinding({
    workspaceRoot,
    routeledgerRoot: selectedRouteLedgerRoot,
    processCwd: options.binding.processCwd
  }, {
    autoCreateWorkspaceConfig: false
  });
  const requiresHostConfigUpdate =
    currentBinding.workspaceRoot !== workspaceRoot ||
    currentBinding.routeledgerRoot !== selectedRouteLedgerRoot;
  const requiresServerRestart = requiresHostConfigUpdate;
  const persistentHostBinding = createPersistentHostBinding(requiresHostConfigUpdate);

  const workspaceConfig = resolveWorkspaceConfigSync({
    projectRoot: workspaceRoot,
    autoCreate: false
  });

  checks.push({
    code: "WORKSPACE_ROOT_VALID",
    status: "ok",
    message: "workspaceRoot is available for binding planning."
  });
  checks.push({
    code: "ROUTELEDGER_ROOT_WITHIN_WORKSPACE",
    status: "ok",
    message: "routeledgerRoot stays within workspaceRoot."
  });

  if (workspaceConfig.status === "missing" || targetBinding.status === "uninitialized") {
    const sessionActivation = createSessionActivation({
      hostProfile: options.hostProfile,
      binding: options.binding,
      targetWorkspaceRoot: workspaceRoot,
      targetRouteledgerRoot: selectedRouteLedgerRoot,
      targetStatus: "needs_init"
    });
    checks.push({
      code:
        workspaceConfig.status === "missing"
          ? "WORKSPACE_CONFIG_NOT_FOUND"
          : "ROUTELEDGER_STATE_NOT_INITIALIZED",
      status: "warning",
      message:
        workspaceConfig.status === "missing"
          ? "No .routeledger/config.json exists at the target workspaceRoot yet."
          : "The target workspace config is present, but RouteLedger state has not been initialized."
    });

    return {
      status: "needs_init",
      workspaceRoot,
      source,
      currentBinding,
      targetBinding: {
        workspaceRoot,
        routeledgerRoot: selectedRouteLedgerRoot,
        workspaceConfigPath:
          targetBinding.workspaceConfigPath ??
          getWorkspaceConfigPath(workspaceRoot),
        dataRoot:
          targetBinding.dataRoot ??
          (workspaceConfig.status === "missing"
            ? selectedRouteLedgerRoot
            : resolveDefaultRouteLedgerDataDir(workspaceRoot)),
        routeledgerDir:
          targetBinding.routeledgerDir ??
          path.join(
            targetBinding.dataRoot ??
              (workspaceConfig.status === "missing"
                ? selectedRouteLedgerRoot
                : resolveDefaultRouteLedgerDataDir(workspaceRoot)),
            ".routeledger"
          ),
        jsonProjectPath: targetBinding.jsonProjectPath,
        sqliteDbPath: targetBinding.sqliteDbPath
      },
      selectedCandidate,
      checks,
      risks: (workspaceConfig.status === "missing"
        ? workspaceConfig.diagnostics
        : targetBinding.diagnostics
      ).map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message
      })),
      requiresUserDecision: true,
      requiresInit: true,
      requiresHostConfigUpdate,
      requiresServerRestart,
      sessionActivation,
      persistentHostBinding,
      recommendedNextActions: sessionActivation.required
        ? [
            buildPlanAction(
              "activate_session_binding",
              "Activate this MCP session at the planned RouteLedger root.",
              {
                tool: "activate_routeledger_binding",
                routeledgerRoot: selectedRouteLedgerRoot,
                requiresUserDecision: requiresHostConfigUpdate,
                toolInput: {
                  workspaceRoot,
                  routeledgerRoot: selectedRouteLedgerRoot,
                  ...(requiresHostConfigUpdate ? { confirmProjectSwitch: true } : {})
                }
              }
            ),
            buildPlanAction(
              "initialize_routeledger",
              "After activation, initialize RouteLedger at the planned root.",
              {
                tool: "init_project",
                routeledgerRoot: selectedRouteLedgerRoot,
                requiresUserDecision: true
              }
            ),
            buildPlanAction(
              "render_codex_config",
              "Optionally persist this binding for future Codex sessions.",
              {
                tool: "render_host_binding_config",
                routeledgerRoot: selectedRouteLedgerRoot
              }
            )
          ]
        : requiresHostConfigUpdate
          ? [
              buildPlanAction(
                "render_codex_config",
                "Persist this alternate binding for future Codex sessions.",
                {
                  tool: "render_host_binding_config",
                  routeledgerRoot: selectedRouteLedgerRoot
                }
              )
            ]
          : [
              buildPlanAction(
                "initialize_routeledger",
                "Initialize RouteLedger at the current bound root.",
                {
                  tool: "init_project",
                  routeledgerRoot: selectedRouteLedgerRoot,
                  requiresUserDecision: true
                }
              )
            ]
    };
  }

  if (targetBinding.status === "invalid") {
    return {
      status: "blocked",
      workspaceRoot,
      source,
      currentBinding,
      targetBinding: null,
      selectedCandidate,
      checks: checks.concat({
        code: "WORKSPACE_CONFIG_INVALID",
        status: "blocked",
        message: "The target routeledgerRoot has an invalid workspace config or dataDir."
      }),
      risks: targetBinding.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message
      })),
      requiresUserDecision: true,
      requiresInit: false,
      requiresHostConfigUpdate: false,
      requiresServerRestart: false,
      sessionActivation: unavailableSessionActivation,
      persistentHostBinding: noPersistentHostBinding,
      recommendedNextActions: [
        buildPlanAction(
          "inspect_workspace_config",
          "Fix .routeledger/config.json or the configured dataDir before updating host config."
        )
      ]
    };
  }

  selectedCandidate ??= await inspectResolvedBindingCandidate(
    workspaceRoot,
    selectedRouteLedgerRoot
  );
  risks.push(...selectedCandidate.risks);

  if (selectedCandidate.risks.some((risk) => risk.severity === "error")) {
    checks.push({
      code: "TARGET_ROUTELEDGER_ROOT_HAS_BLOCKING_RISKS",
      status: "blocked",
      message: "The target RouteLedger root has blocking storage or canonical JSON risks."
    });

    return {
      status: "blocked",
      workspaceRoot,
      source,
      currentBinding,
      targetBinding: {
        workspaceRoot,
        routeledgerRoot: selectedRouteLedgerRoot,
        workspaceConfigPath: targetBinding.workspaceConfigPath,
        dataRoot: targetBinding.dataRoot,
        routeledgerDir: targetBinding.routeledgerDir!,
        jsonProjectPath: targetBinding.jsonProjectPath,
        sqliteDbPath: targetBinding.sqliteDbPath
      },
      selectedCandidate,
      checks,
      risks,
      requiresUserDecision: true,
      requiresInit: false,
      requiresHostConfigUpdate,
      requiresServerRestart,
      sessionActivation: unavailableSessionActivation,
      persistentHostBinding,
      recommendedNextActions: [
        buildPlanAction(
          "inspect_workspace",
          "Review discovered RouteLedger roots before updating host config.",
          {
            tool: "discover_routeledger_roots"
          }
        )
      ]
    };
  }

  checks.push({
    code: "TARGET_ROUTELEDGER_ROOT_READY",
    status: selectedCandidate.risks.length > 0 ? "warning" : "ok",
    message:
      selectedCandidate.risks.length > 0
        ? "The target RouteLedger root is usable but has non-blocking risks."
        : "The target RouteLedger root is ready for binding."
  });

  const sessionActivation = createSessionActivation({
    hostProfile: options.hostProfile,
    binding: options.binding,
    targetWorkspaceRoot: workspaceRoot,
    targetRouteledgerRoot: selectedRouteLedgerRoot,
    targetStatus: "ready"
  });

  return {
    status: "ready",
    workspaceRoot,
    source,
    currentBinding,
    targetBinding: {
      workspaceRoot,
      routeledgerRoot: selectedRouteLedgerRoot,
      workspaceConfigPath: targetBinding.workspaceConfigPath,
      dataRoot: targetBinding.dataRoot,
      routeledgerDir: targetBinding.routeledgerDir!,
      jsonProjectPath: targetBinding.jsonProjectPath,
      sqliteDbPath: targetBinding.sqliteDbPath
    },
    selectedCandidate,
    checks,
    risks,
    requiresUserDecision: false,
    requiresInit: false,
    requiresHostConfigUpdate,
    requiresServerRestart,
    sessionActivation,
    persistentHostBinding,
    recommendedNextActions: sessionActivation.required
      ? [
          buildPlanAction(
            "activate_session_binding",
            "Activate this MCP session at the planned RouteLedger root.",
            {
              tool: "activate_routeledger_binding",
              routeledgerRoot: selectedRouteLedgerRoot,
              requiresUserDecision: requiresHostConfigUpdate,
              toolInput: {
                workspaceRoot,
                routeledgerRoot: selectedRouteLedgerRoot,
                ...(requiresHostConfigUpdate ? { confirmProjectSwitch: true } : {})
              }
            }
          ),
          buildPlanAction(
            "render_codex_config",
            "Optionally persist this binding for future Codex sessions.",
            {
              tool: "render_host_binding_config",
              routeledgerRoot: selectedRouteLedgerRoot
            }
          )
        ]
      : requiresHostConfigUpdate
        ? [
            buildPlanAction(
              "render_codex_config",
              "Persist this alternate binding for future Codex sessions.",
              {
                tool: "render_host_binding_config",
                routeledgerRoot: selectedRouteLedgerRoot
              }
            )
          ]
        : []
  };
};

export const renderHostBindingConfig = async (options: {
  binding: RouteLedgerBindingSummary;
  workspaceRoot?: string;
  routeledgerRoot?: string;
  routeLedgerWorkspaceRoot?: string;
  serverName?: string;
  existingConfigStrategy?: WriteCodexProjectConfigOptions["existingConfigStrategy"];
}): Promise<RenderHostBindingConfigResult> => {
  const bindingPlan = await planRouteLedgerBinding({
    binding: options.binding,
    workspaceRoot: options.workspaceRoot,
    routeledgerRoot: options.routeledgerRoot,
    hostProfile: "codex"
  });

  if (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") {
    return {
      hostProfile: "codex",
      status: "blocked",
      bindingPlan,
      renderedConfig: null,
      writePlan: null
    };
  }

  if (typeof options.routeLedgerWorkspaceRoot !== "string" || options.routeLedgerWorkspaceRoot.length === 0) {
    return {
      hostProfile: "codex",
      status: "blocked",
      launcherRequirement: {
        code: "STABLE_RUNTIME_LAUNCHER_REQUIRED",
        message:
          "A stable, user-owned RouteLedger source launcher is required. Installed plugin cache paths are not valid project config launchers."
      },
      bindingPlan,
      renderedConfig: null,
      writePlan: null
    };
  }

  const targetBinding = bindingPlan.targetBinding!;
  const codexInput: WriteCodexProjectConfigOptions = {
    workspaceRoot: targetBinding.workspaceRoot,
    routeledgerRoot: targetBinding.routeledgerRoot,
    source: {
      kind: "workspace",
      routeLedgerWorkspaceRoot: options.routeLedgerWorkspaceRoot
    },
    serverName: options.serverName,
    existingConfigStrategy: options.existingConfigStrategy
  };

  return {
    hostProfile: "codex",
    status: "ready",
    bindingPlan,
    renderedConfig: {
      format: "toml",
      content: renderCodexProjectConfig(codexInput)
    },
    writePlan: await planCodexProjectConfigWrite(codexInput)
  };
};

export const writeHostBindingConfig = async (options: {
  binding: RouteLedgerBindingSummary;
  workspaceRoot?: string;
  routeledgerRoot?: string;
  routeLedgerWorkspaceRoot?: string;
  serverName?: string;
  outputPath?: string;
  existingConfigStrategy?: WriteCodexProjectConfigOptions["existingConfigStrategy"];
}): Promise<WriteHostBindingConfigResult> => {
  const bindingPlan = await planRouteLedgerBinding({
    binding: options.binding,
    workspaceRoot: options.workspaceRoot,
    routeledgerRoot: options.routeledgerRoot,
    hostProfile: "codex"
  });

  if (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") {
    return {
      hostProfile: "codex",
      status: "blocked",
      bindingPlan,
      writeResult: null
    };
  }

  if (typeof options.routeLedgerWorkspaceRoot !== "string" || options.routeLedgerWorkspaceRoot.length === 0) {
    return {
      hostProfile: "codex",
      status: "blocked",
      launcherRequirement: {
        code: "STABLE_RUNTIME_LAUNCHER_REQUIRED",
        message:
          "A stable, user-owned RouteLedger source launcher is required. Installed plugin cache paths are not valid project config launchers."
      },
      bindingPlan,
      writeResult: null
    };
  }

  const targetBinding = bindingPlan.targetBinding!;
  const codexInput: WriteCodexProjectConfigOptions = {
    workspaceRoot: targetBinding.workspaceRoot,
    routeledgerRoot: targetBinding.routeledgerRoot,
    source: {
      kind: "workspace",
      routeLedgerWorkspaceRoot: options.routeLedgerWorkspaceRoot
    },
    serverName: options.serverName,
    outputPath: options.outputPath,
    existingConfigStrategy: options.existingConfigStrategy
  };

  return {
    hostProfile: "codex",
    status: "ready",
    bindingPlan,
    writeResult: await writeCodexProjectConfig(codexInput)
  };
};
