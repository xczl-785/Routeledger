import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationError,
  BALANCED_ALWAYS_PROMPT_ACTIONS,
  BALANCED_AUTO_ACTIONS,
  BATCH_CREATE_VERSIONS_MODES,
  BATCH_PREVIOUS_CURRENT_POLICIES,
  DomainError,
  MemoryExactAuthorizationStore,
  type L3AuthorizationGrantStore,
  type ExactAuthorizationCandidate,
  type ExactAuthorizationStore,
  type ExactAuthorizationBinding,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationProfileV2,
  createExactProposalDecisionRequest,
  digestL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  orchestrateL3Operation,
  projectDecisionArtifact,
  ROUTE_OPERATION_WORKFLOW_MODES,
  RouteLedgerService,
  type Actor,
  type BatchCreateVersionsMode,
  type BatchPreviousCurrentPolicy,
  type Constraint,
  type DeferredItem,
  isBatchCreateVersionsMode,
  isBatchPreviousCurrentPolicy,
  isRouteOperationWorkflowMode,
  type L3ActionType,
  type PendingOperation,
  type ResidualAuditInput,
  type Todo
} from "@routeledger/core";

import {
  JsonFirstStorageAdapter,
  JsonFirstStorageError,
  type RuntimeBindingActiveProject,
  type SqliteReadModelMode,
  type JsonFirstStorageTestHooks
} from "./json-first-storage.js";
import {
  discoverRouteLedgerRoots,
  planRouteLedgerBinding,
  renderHostBindingConfig,
  writeHostBindingConfig,
  type RouteLedgerBindingPlanResult
} from "./binding-assist.js";
import {
  runBindingPreflight,
  getBindingRecommendedNextActions,
  isBindingToolKindAllowed,
  type RouteLedgerBindingToolKind
} from "./binding-preflight.js";
import { resolveRouteLedgerBinding, type RouteLedgerBindingSummary } from "./binding.js";
import {
  isPhysicalPathContainedWithinSync,
  resolvePhysicalPathForContainmentSync
} from "./physical-path.js";
import { RouteLedgerDebugLogger } from "./debug-log.js";
import {
  adaptCheckDocDriftInput,
  adaptDeferWorkInput,
  adaptGetCurrentContextInput,
  adaptListVersionsWindowInput,
  adaptRecordConstraintInput,
  adaptRetireConstraintInput,
  adaptReviewDeferredInput,
  type CheckDocDriftToolInput,
  type DeferWorkToolInput,
  type GetCurrentContextToolInput,
  InvalidToolInputError,
  type ListVersionsWindowToolInput,
  type RecordConstraintToolInput,
  type RetireConstraintToolInput,
  type ReviewDeferredToolInput
} from "./input-adapter.js";
import {
  resolveRuntimeIdentity,
  type RuntimeIdentity
} from "./runtime-identity.js";
import {
  localizeToolResponse,
  resolveResponseLocale,
  suggestContentLocale
} from "./locale.js";
import {
  ExistingL3DecisionAdapter,
  requireResolvedExistingL3Decision
} from "./existing-l3-decision-adapter.js";
import { CodexL3DecisionAdapter } from "./codex-l3-decision-adapter.js";

export * from "./local-l3-authorization.js";
export * from "./local-l3-authority-registry.js";
export * from "./local-l3-authority-broker.js";
export * from "./existing-l3-decision-adapter.js";
export * from "./codex-l3-decision-adapter.js";
export * from "./mcp-decision-input.js";
export * from "./mcp-request-state.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MRTR_PROTOCOL_VERSION = "2026-07-28";

export type RouteLedgerHostProfileName = "generic" | "codex" | "claude-code" | "cursor";
/**
 * Runtime packaging profile. This is separate from the MCP host profile: it
 * describes which locally-built runtime is executing the shared MCP source.
 */
export type RouteLedgerMcpRuntimeProfile = "full" | "json-only";
export type RouteLedgerToolRiskLevel = "read-only" | "write" | "high-risk";
export type RouteLedgerApprovalMode = "auto" | "prompt" | "approve";

export interface RouteLedgerMcpIdentityOverride {
  id?: string;
  displayName?: string;
}

export interface RouteLedgerMcpRegistryOptions {
  workspaceRoot?: string;
  workspaceRootSource?: "explicit_arg" | "explicit_env";
  routeledgerRoot?: string;
  mcpRoots?: string[];
  hostProfile?: RouteLedgerHostProfileName;
  runtimeProfile?: RouteLedgerMcpRuntimeProfile;
  /** Build/package-provided identity. Source execution uses the local default. */
  runtimeIdentity?: RuntimeIdentity;
  actor?: RouteLedgerMcpIdentityOverride;
  approver?: RouteLedgerMcpIdentityOverride;
  sqliteReadModel?: SqliteReadModelMode;
  storageTestHooks?: JsonFirstStorageTestHooks;
  debugLog?: {
    enabled?: boolean;
  };
  defaultResponseLocale?: string;
  hostPermissionContext?:
    | {
        status: "resolved";
        mode: "interactive" | "delegated" | "preauthorized";
        source: "codex_permission_profile" | "plugin_config";
        codexPermissionProfile: string | null;
        fallbackUsed: boolean;
      }
    | {
        status: "unavailable";
        code: string;
        codexPermissionProfile: string | null;
        reason: string;
      };
  /** Stdio owns the swap so a bootstrap response can be emitted before old resources close. */
  deferSessionRebind?: boolean;
  /** Trusted startup identity used to build candidates before a bound profile exists. */
  l3AuthorityCandidateIdentity?: {
    subjectId: string;
    trustedClientId: string | null;
  };
  l3Authorization?: {
    grantStore: L3AuthorizationGrantStore;
    exactStore?: ExactAuthorizationStore;
    interaction: RouteLedgerMcpAuthorizationInteraction;
    sessionId: string;
    /** Host-owned V2 profile selected from the verified project/root binding. */
    profile?: L3AuthorizationProfileV2;
    /** Trusted host identity injected at startup; never derived from MCP clientInfo. */
    trustedClientId?: string;
    delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
  };
}

export interface RouteLedgerMcpDelegatedAuthorizationRequest {
  authorityHandle: string;
  proposal: Readonly<PendingOperation>;
  context: Readonly<L3AuthorizationEvaluationContext>;
}

export type RouteLedgerMcpDelegatedAuthorizationResult =
  | { effect: "allow"; authorization: ExactAuthorizationCandidate }
  | {
      effect: "prompt" | "deny";
      code: string;
      policyId?: string;
      policyDigest?: string;
      matchedRuleId?: string;
    };

export interface RouteLedgerMcpDelegatedAuthorizationAuthority {
  /** Opaque host-owned handle. Policy evaluation and budget consumption must be atomic. */
  authorityHandle: string;
  requestExactDecision(
    request: RouteLedgerMcpDelegatedAuthorizationRequest
  ): Promise<RouteLedgerMcpDelegatedAuthorizationResult>;
}

export interface RouteLedgerMcpAuthorizationRequest {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface RouteLedgerMcpAuthorizationDecision {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
  /** Present only when a trusted host adapter attests an exact user decision. */
  trustedDecision?: {
    kind: "trusted_host_user";
    hostKind: string;
    decisionId: string;
  };
}

export interface RouteLedgerMcpAuthorizationInteraction {
  requestAuthorization(
    request: RouteLedgerMcpAuthorizationRequest
  ): Promise<RouteLedgerMcpAuthorizationDecision>;
}

export interface RouteLedgerServerInfo {
  name: string;
  title: string;
  version: string;
  description: string;
  runtimeIdentity: RuntimeIdentity;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolMeta {
  routeledger: {
    riskLevel: RouteLedgerToolRiskLevel;
    highRisk: boolean;
    destructive: boolean;
    recommendedApprovalMode: RouteLedgerApprovalMode;
  };
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  _meta: ToolMeta;
}

/**
 * Tool descriptions are intentionally compact. Shared operating discipline belongs in
 * server instructions and multi-step procedures belong in the operator Skill.
 */
interface ToolNarrative {
  what: string;
  when?: string;
  prerequisite?: string;
  parameter?: string;
  warning?: string;
}

export interface ToolResponse {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
}

export interface RouteLedgerPendingSessionRebind {
  workspaceRoot: string;
  routeledgerRoot: string;
  previousBinding: RouteLedgerBindingSummary;
  bindingPlan: RouteLedgerBindingPlanResult;
  requiresInit: boolean;
}

type ToolHandler = (input: Record<string, any>) => Promise<ToolResponse>;
type TypedToolHandler<TInput> = (input: TInput) => Promise<ToolResponse>;
type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  deferredId?: string;
  constraintId?: string;
  pendingOperationId?: string;
  payload?: unknown;
};

type ToolRegistration = {
  definition: ToolDefinition;
  toolKind: RouteLedgerBindingToolKind;
  visibility: "default" | "source-only";
  handler: ToolHandler;
};

type MissionControlOpenResult = {
  url: string;
  projectId: string | null;
  pid: number;
  port: number;
  reused: boolean;
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
};

type MissionControlStatusResult = {
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  projectId: string | null;
  matchingInstance: unknown;
  healthyInstances: unknown[];
  staleEntries: unknown[];
};

type MissionControlSourceModule = {
  openMissionControlSource: (options: {
    workspaceRoot: string;
    routeledgerRoot: string;
    devBuild?: boolean;
  }) => Promise<MissionControlOpenResult>;
  getMissionControlStatus: (options: {
    workspaceRoot: string;
    routeledgerRoot: string;
  }) => Promise<MissionControlStatusResult>;
};

export type RouteLedgerMcpRegistry = {
  readonly tools: ToolDefinition[];
  readonly serverInfo: RouteLedgerServerInfo;
  readonly serverCapabilities: {
    tools: {
      listChanged: boolean;
    };
  };
  readonly hostProfile: RouteLedgerHostProfileName;
  readonly runtimeProfile: RouteLedgerMcpRuntimeProfile;
  readonly runtimeIdentity: RuntimeIdentity;
  readonly instructions: string;
  getTool: (toolName: string) => ToolDefinition | undefined;
  invoke: (toolName: string, input: Record<string, any>) => Promise<ToolResponse>;
  /**
   * Read the current binding/storage-derived identity for an error envelope.
   * This deliberately never derives project identity from tool arguments.
   */
  getRuntimeContextMeta: () => Promise<Record<string, unknown>>;
  peekPendingSessionRebind: () => RouteLedgerPendingSessionRebind | null;
  clearPendingSessionRebind: () => void;
  createActivationSuccessResponse: (
    pendingRebind: RouteLedgerPendingSessionRebind
  ) => Promise<ToolResponse>;
  close: () => void;
};

const createServerInfo = (runtimeIdentity: RuntimeIdentity): RouteLedgerServerInfo => ({
  name: "routeledger",
  title: "RouteLedger MCP",
  // MCP's standard version field is the internal runtime package version,
  // never a plugin manifest version.
  version: runtimeIdentity.runtimePackageVersion,
  description: "Standard MCP stdio adapter for RouteLedger",
  runtimeIdentity
});

const HOST_PROFILE_LABELS: Record<RouteLedgerHostProfileName, string> = {
  generic: "generic MCP host",
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor"
};

const DEFAULT_ACTOR: Actor = {
  id: "mcp-agent",
  type: "agent",
  displayName: "routeledger-mcp"
};

const DEFAULT_APPROVER: Actor = {
  id: "mcp-user",
  type: "user",
  displayName: "routeledger-mcp-user"
};

const serverCapabilities = {
  tools: {
    listChanged: false
  }
} as const;

const stringSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "string",
  description,
  ...extra
});

const integerSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "integer",
  description,
  ...extra
});

const booleanSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "boolean",
  description,
  ...extra
});

const summarizeTodoForAgent = (todo: Todo) => ({
  id: todo.id,
  projectId: todo.projectId,
  versionId: todo.versionId,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  sourceType: todo.sourceType,
  sourceId: todo.sourceId,
  createdBy: todo.createdBy,
  createdAt: todo.createdAt,
  updatedAt: todo.updatedAt,
  closedAt: todo.closedAt,
  closeReason: todo.closeReason,
  closeNote: todo.closeNote
});

const summarizeDeferredForAgent = (deferred: DeferredItem) => ({
  id: deferred.id,
  projectId: deferred.projectId,
  targetReviewVersionId: deferred.targetReviewVersionId,
  title: deferred.title,
  description: deferred.description,
  status: deferred.status,
  reason: deferred.reason,
  reviewTrigger: deferred.reviewTrigger,
  resolutionOutcome: deferred.resolutionOutcome,
  resolutionReason: deferred.resolutionReason,
  resolutionNote: deferred.resolutionNote,
  decisionRef: deferred.decisionRef,
  activatedTodoId: deferred.activatedTodoId,
  createdBy: deferred.createdBy,
  createdAt: deferred.createdAt,
  updatedAt: deferred.updatedAt,
  reviewedAt: deferred.reviewedAt
});

const summarizeConstraintForAgent = (constraint: Constraint) => ({
  id: constraint.id,
  projectId: constraint.projectId,
  rule: constraint.rule,
  rationale: constraint.rationale,
  scope: constraint.scope,
  status: constraint.status,
  createdBy: constraint.createdBy,
  createdAt: constraint.createdAt,
  updatedAt: constraint.updatedAt,
  retiredAt: constraint.retiredAt,
  retireReason: constraint.retireReason,
  retireNote: constraint.retireNote
});

const sanitizeLegacyGateBlockersForAgent = (
  blockers: unknown
): Array<Record<string, unknown>> =>
  (Array.isArray(blockers) ? blockers : []).map(
    (blocker: Record<string, unknown>) => {
      if (
        typeof blocker.code !== "string" ||
        !blocker.code.includes("UNDO")
      ) {
        return blocker;
      }

      return {
        code: "LEGACY_WORK_REQUIRES_AUDIT",
        message:
          "Legacy work blocks this operation; use get_current_context(projectId, includeLegacyUndo=true) for audit details.",
        recordCount: Array.isArray(blocker.recordIds)
          ? blocker.recordIds.length
          : 0
      };
    }
  );

const sanitizeVersionStructureOperationForAgent = (
  operation: Record<string, any>
): Record<string, unknown> => {
  const sanitized = structuredClone(operation) as Record<string, any>;
  sanitized.blockers = sanitizeLegacyGateBlockersForAgent(
    sanitized.blockers
  );

  if (sanitized.details !== null && typeof sanitized.details === "object") {
    const details = sanitized.details as Record<string, any>;

    if (Array.isArray(details.unresolvedUndoIds)) {
      details.legacyBlockerCount = details.unresolvedUndoIds.length;
      delete details.unresolvedUndoIds;
    }

    if (
      details.ordinaryCloseGate !== null &&
      typeof details.ordinaryCloseGate === "object"
    ) {
      const ordinaryCloseGate = details.ordinaryCloseGate as Record<
        string,
        any
      >;

      if (Array.isArray(ordinaryCloseGate.unresolvedUndoIds)) {
        ordinaryCloseGate.legacyBlockerCount =
          ordinaryCloseGate.unresolvedUndoIds.length;
        delete ordinaryCloseGate.unresolvedUndoIds;
      }

      if (Array.isArray(ordinaryCloseGate.blockerCodes)) {
        ordinaryCloseGate.blockerCodes = [
          ...new Set(
            ordinaryCloseGate.blockerCodes.map((code: unknown) =>
              typeof code === "string" && code.includes("UNDO")
                ? "LEGACY_WORK_REQUIRES_AUDIT"
                : code
            )
          )
        ];
      }
    }
  }

  return sanitized;
};

const sanitizeVersionStructureForAgent = (
  structure: unknown
): Record<string, unknown> => {
  const sanitized = structuredClone(structure) as Record<string, any>;
  const operations = Array.isArray(sanitized.legalOperations)
    ? sanitized.legalOperations
    : [];
  const openUndos =
    sanitized.openUndos !== null &&
    typeof sanitized.openUndos === "object"
      ? (sanitized.openUndos as Record<string, unknown>)
      : {};
  const legacyRecordIds = new Set(
    ["owned", "origin", "preferredResolution"].flatMap((field) =>
      Array.isArray(openUndos[field])
        ? (openUndos[field] as Array<{ id?: unknown }>)
            .map((record) => record.id)
            .filter((id): id is string => typeof id === "string")
        : []
    )
  );
  delete sanitized.openUndos;
  sanitized.legalOperations = operations.map(sanitizeVersionStructureOperationForAgent);

  if (
    legacyRecordIds.size > 0 &&
    !sanitized.legalOperations.some(
      (operation: Record<string, unknown>) =>
        operation.actionType === "review_context"
    )
  ) {
    sanitized.legalOperations.push({
      actionType: "review_context",
      allowed: true,
      summary:
        "Review legacy audit records before choosing Todo, Deferred, Constraint, or a resolved outcome.",
      blockers: []
    });
  }

  if (legacyRecordIds.size > 0) {
    sanitized.legacyAudit = {
      required: true,
      recordCount: legacyRecordIds.size,
      guidance:
        "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
    };
  }

  return sanitized;
};

const sanitizeDocDriftForAgent = (
  result: unknown
): Record<string, unknown> => {
  const sanitized = structuredClone(result) as Record<string, any>;
  const routeTruth =
    sanitized.routeTruth !== null && typeof sanitized.routeTruth === "object"
      ? (sanitized.routeTruth as Record<string, unknown>)
      : {};
  const openUndoCount =
    typeof routeTruth.openUndoCount === "number"
      ? routeTruth.openUndoCount
      : 0;
  delete routeTruth.openUndoCount;
  routeTruth.legacyBlockerCount = openUndoCount;
  const hasLegacyRisk =
    openUndoCount > 0 ||
    (Array.isArray(routeTruth.statusRiskCodes) &&
      routeTruth.statusRiskCodes.includes("OPEN_UNDOS_BLOCK_CLOSE"));
  if (Array.isArray(routeTruth.statusRiskCodes)) {
    const statusRiskCodes = routeTruth.statusRiskCodes.map((code) =>
          code === "OPEN_UNDOS_BLOCK_CLOSE"
            ? "LEGACY_BLOCKERS_REQUIRE_AUDIT"
            : code
        );
    if (openUndoCount > 0) {
      statusRiskCodes.push("LEGACY_BLOCKERS_REQUIRE_AUDIT");
    }
    routeTruth.statusRiskCodes = [...new Set(statusRiskCodes)];
  }
  sanitized.routeTruth = routeTruth;

  if (Array.isArray(sanitized.warnings)) {
    sanitized.warnings = sanitized.warnings.map(
      (warning: Record<string, unknown>) =>
        warning.code === "OPEN_UNDOS_BLOCK_CLOSE"
          ? {
              ...warning,
              code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
              summary:
                "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
            }
          : warning
    );
  }

  if (hasLegacyRisk && Array.isArray(sanitized.warnings)) {
    const hasLegacyAuditWarning = sanitized.warnings.some(
      (warning: Record<string, unknown>) =>
        warning.code === "LEGACY_BLOCKERS_REQUIRE_AUDIT"
    );

    if (!hasLegacyAuditWarning) {
      sanitized.warnings.push({
        code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
        severity: "blocking",
        file: null,
        summary:
          "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
      });
    }
  }

  if (openUndoCount > 0 || hasLegacyRisk) {
    sanitized.legacyAudit = {
      required: true,
      guidance:
        "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
    };
  }

  if (typeof sanitized.summaryText === "string") {
    sanitized.summaryText = sanitized.summaryText.replace(
      /Route truth shows (\d+) open todos, \d+ open undos, and (\d+) pending proposals on the current route\./,
      "Route truth shows $1 open todos and $2 pending proposals on the current route."
    );
  }

  return sanitized;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  ...extra
});

const residualAuditItemSchema = objectSchema(
  {
    kind: {
      type: "string",
      enum: ["bug", "risk", "open_question", "debt"],
      description: "Residual item kind."
    },
    summary: stringSchema("Human-readable residual summary."),
    destination: {
      anyOf: [
        {
          type: "string",
          enum: [
            "close",
            "create_todo",
            "defer_work",
            "record_constraint"
          ]
        },
        {
          type: "null"
        }
      ],
      description: "How the residual item should be handled."
    },
    targetReviewVersionId: {
      anyOf: [
        stringSchema("Required downstream review version when destination is defer_work."),
        {
          type: "null"
        }
      ]
    }
  },
  ["kind", "summary", "destination"]
);

const residualAuditArraySchema: Record<string, unknown> = {
  type: "array",
  description: "Legacy residual-audit input. Only non-empty arrays assert review; use the reviewed declaration for an explicit empty audit.",
  items: residualAuditItemSchema
};

const reviewedResidualAuditSchema: Record<string, unknown> = objectSchema(
  {
    status: {
      type: "string",
      enum: ["reviewed"]
    },
    items: residualAuditArraySchema
  },
  ["status", "items"]
);

const residualAuditInputSchema: Record<string, unknown> = {
  anyOf: [
    reviewedResidualAuditSchema,
    residualAuditArraySchema,
    { type: "null" }
  ]
};

const payloadSchema = objectSchema(
  {
    currentVersionId: {
      anyOf: [
        stringSchema("Optional current version override."),
        {
          type: "null"
        }
      ]
    },
    fromVersionId: stringSchema("Expected current Version ID for advance_to_version."),
    residualAudit: {
      ...residualAuditInputSchema
    },
    title: stringSchema("Version title for create/insert/create-child proposals."),
    description: stringSchema("Optional version description for create/insert/create-child proposals."),
    parentVersionId: {
      anyOf: [
        stringSchema("Parent version ID used by create_child_version."),
        {
          type: "null"
        }
      ]
    },
    previousVersionId: {
      anyOf: [
        stringSchema("Previous sibling version ID anchor."),
        {
          type: "null"
        }
      ]
    },
    nextVersionId: {
      anyOf: [
        stringSchema("Next sibling version ID anchor."),
        {
          type: "null"
        }
      ]
    }
  },
  [],
  {
    description: "Optional payload captured in an L3 proposal."
  }
);

const batchCreateVersionsAnchorSchema = objectSchema({
  parentVersionId: {
    anyOf: [stringSchema("Optional parent version ID for child-chain creation."), { type: "null" }]
  },
  afterVersionId: {
    anyOf: [stringSchema("Optional sibling anchor inserted after this version."), { type: "null" }]
  },
  beforeVersionId: {
    anyOf: [stringSchema("Optional sibling anchor inserted before this version."), { type: "null" }]
  }
});

const batchCreateVersionsItemSchema = objectSchema(
  {
    clientKey: stringSchema("Stable client-side key for this planned version."),
    title: stringSchema("Version title."),
    description: stringSchema("Version description. Field is required; use an empty string when there is no extra detail."),
    initialTodos: {
      type: "array",
      description: "Initial todo titles created atomically with this version. Field is required and may be an empty array.",
      items: stringSchema("Todo title.")
    }
  },
  ["clientKey", "title", "description", "initialTodos"]
);

const firstVersionSchema = objectSchema(
  {
    title: stringSchema("Title of the first real Version."),
    description: stringSchema("Optional first Version description."),
    initialTodos: {
      type: "array",
      description: "Initial Todo titles. The field is required and may be an empty array.",
      items: stringSchema("Todo title.")
    }
  },
  ["title", "initialTodos"]
);

const docDriftExpectedPointerSchema = objectSchema(
  {
    kind: stringSchema("Pointer kind label used by the caller."),
    path: stringSchema("Expected repo-relative pointer path."),
    required: booleanSchema("Defaults to true. Set false to make this pointer advisory only.")
  },
  ["kind", "path"]
);

const approvalModeForRisk = (riskLevel: RouteLedgerToolRiskLevel): RouteLedgerApprovalMode => {
  switch (riskLevel) {
    case "read-only":
      return "auto";
    case "write":
    case "high-risk":
      return "prompt";
    default: {
      const exhaustiveRiskLevel: never = riskLevel;
      return exhaustiveRiskLevel;
    }
  }
};

const createToolMetadata = (options: {
  title: string;
  riskLevel: RouteLedgerToolRiskLevel;
  destructive?: boolean;
  idempotent?: boolean;
  recommendedApprovalMode?: RouteLedgerApprovalMode;
}): Pick<ToolDefinition, "title" | "annotations" | "_meta"> => {
  const destructive = options.destructive ?? false;
  const readOnly = options.riskLevel === "read-only";

  return {
    title: options.title,
    annotations: {
      title: options.title,
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: options.idempotent ?? readOnly,
      openWorldHint: false
    },
    _meta: {
      routeledger: {
        riskLevel: options.riskLevel,
        highRisk: options.riskLevel === "high-risk",
        destructive,
        recommendedApprovalMode:
          options.recommendedApprovalMode ?? approvalModeForRisk(options.riskLevel)
      }
    }
  };
};

const createInstructions = (options: {
  hostProfile: RouteLedgerHostProfileName;
  actor: Actor;
  approver: Actor;
}): string => {
  const hostLabel = HOST_PROFILE_LABELS[options.hostProfile];
  const actorLabel = options.actor.displayName ?? options.actor.id;
  const approverLabel = options.approver.displayName ?? options.approver.id;

  return [
    "RouteLedger exposes project state and route transitions through MCP tools.",
    "Before route operations, call get_runtime_context to verify workspaceRoot and routeledgerRoot.",
    "If binding is missing, invalid, or low-confidence, pass the host project absolute workspaceRoot to activate_routeledger_binding before route operations; never treat the MCP process cwd as an initialization target. When MCP Roots/rootUri are provided they remain the preferred binding source. Use discover_routeledger_roots and plan_routeledger_binding with explicit workspaceRoot only for read-only inspection/planning.",
    "Use read-only tools first to inspect current context, versions, gates, and pending L3 proposals.",
    "For day-to-day work, use Todo for work now, Deferred for work that must be reviewed by a future version, and Constraint for rules that must not be violated.",
    "Use defer_work to defer new work or an existing Todo, review_deferred to activate, defer again, or resolve Deferred work, record_constraint to record a rule, and retire_constraint when a rule no longer applies.",
    "Legacy Undo records are audit-only and are not part of default tool discovery. Use get_current_context(includeLegacyUndo=true) only when a legacy blocker requires explicit audit.",
    "Write tools update RouteLedger state through RouteLedgerService and never bypass the shared service boundary.",
    "Tool approval metadata is only a host-policy hint and never replaces binding or L3 authorization.",
    "L3 route changes are proposal-based: execute_l3_operation performs the proposal, decision, artifact, and commit chain with an idempotency key; the low-level propose, approve, reject, and commit tools remain available. Project files are never authorization authority.",
    "Business failures such as CONFIRMATION_REQUIRED are returned as tool-level isError results, not JSON-RPC protocol errors.",
    "High-risk tools are shutdown_version, execute_l3_operation, approve_l3_operation, reject_l3_operation, and commit_l3_operation. shutdown_version is an emergency forced-close proposal path; Codex gates high-risk calls before RouteLedger issues an exact single-use capability, while generic MCP hosts require trusted authority, preauthorization, or elicitation.",
    `Current host profile: ${hostLabel}. Default actor: ${actorLabel}. Default approver: ${approverLabel}.`
  ].join(" ");
};

const resolveActor = (
  baseActor: Actor,
  override: RouteLedgerMcpIdentityOverride | undefined
): Actor => ({
  ...baseActor,
  id: override?.id ?? baseActor.id,
  displayName: override?.displayName ?? baseActor.displayName
});

const digestAuthorizationPath = (candidate: string): string => {
  const physicalRoot = resolvePhysicalPathForContainmentSync(candidate);
  if (physicalRoot === null) {
    throw new Error("Authorization binding path cannot be physically resolved.");
  }
  return `sha256:${createHash("sha256").update(physicalRoot).digest("hex")}`;
};

export const digestRouteLedgerRoot = (routeledgerRoot: string): string =>
  digestAuthorizationPath(routeledgerRoot);

const canonicalizeExecutionInput = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeExecutionInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeExecutionInput(item)])
    );
  }
  return value;
};

const digestExecutionInput = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeExecutionInput(value)))
    .digest("hex")}`;

const compatibilityExactStores = new WeakMap<
  L3AuthorizationGrantStore,
  ExactAuthorizationStore
>();

const resolveExactStore = (authorization: {
  grantStore: L3AuthorizationGrantStore;
  exactStore?: ExactAuthorizationStore;
}): ExactAuthorizationStore => {
  if (authorization.exactStore !== undefined) return authorization.exactStore;
  const existing = compatibilityExactStores.get(authorization.grantStore);
  if (existing !== undefined) return existing;
  const created = new MemoryExactAuthorizationStore();
  compatibilityExactStores.set(authorization.grantStore, created);
  return created;
};

const createService = (
  workspaceRoot: string,
  routeledgerRoot: string,
  sqliteReadModel: SqliteReadModelMode,
  storageTestHooks?: JsonFirstStorageTestHooks,
  authorization?: {
    grantStore: L3AuthorizationGrantStore;
    exactStore?: ExactAuthorizationStore;
    sessionId: string;
    clientId?: string;
    subjectId: string;
    hostKind: string;
    profile?: L3AuthorizationProfileV2;
  }
): { service: RouteLedgerService; storage: JsonFirstStorageAdapter; close: () => void } => {
  const storage = new JsonFirstStorageAdapter({
    workspaceRoot,
    routeledgerRoot,
    sqliteReadModel,
    testHooks: storageTestHooks
  });
  const service = new RouteLedgerService({
    storage,
    projectRoot: workspaceRoot,
    ...(authorization === undefined
      ? {}
      : {
          l3Authorization: {
            grantStore: authorization.grantStore,
            exactStore: resolveExactStore(authorization),
            audience: "routeledger-core",
            subjectId: authorization.subjectId,
            routeledgerRootDigest: digestRouteLedgerRoot(routeledgerRoot),
            ...(authorization.profile === undefined
              ? {}
              : {
                  profileId: authorization.profile.profileId,
                  modeEpoch: authorization.profile.modeEpoch,
                  profileDigest: authorization.profile.profileDigest
                }),
            hostKind: authorization.hostKind,
            ...(authorization.clientId === undefined
              ? {}
              : { clientId: authorization.clientId }),
            sessionId: authorization.sessionId
          }
        }),
    deps: {
      clock: {
        now: () => new Date().toISOString()
      },
      idGenerator: {
        nextId: () => randomUUID()
      }
    }
  });

  return {
    service,
    storage,
    close: () => storage.close()
  };
};

const buildRuntimeContext = (options: {
  binding: RouteLedgerBindingSummary;
  hostProfile: RouteLedgerHostProfileName;
  runtimeIdentity: RuntimeIdentity;
  data: unknown;
  activeProject?: RuntimeBindingActiveProject | null;
}) => {
  const responseProject =
    options.data !== null &&
    typeof options.data === "object" &&
    "project" in options.data &&
    options.data.project !== null &&
    typeof options.data.project === "object"
      ? (options.data.project as { id?: string; name?: string })
      : null;
  // Success envelopes historically derive this compact summary from returned
  // data. Error envelopes pass a storage-inspected identity instead so a
  // request projectId can never become runtime truth.
  const activeProject = options.activeProject;
  const project =
    activeProject === undefined
      ? responseProject
      : activeProject === null
        ? null
        : activeProject;

  return {
    binding: summarizeRuntimeBinding(options.binding),
    dataRoot: options.binding.dataRoot,
    routeledgerDir: options.binding.routeledgerDir,
    workspaceConfigPath: options.binding.workspaceConfigPath,
    jsonProjectPath: options.binding.jsonProjectPath,
    sqliteDbPath: options.binding.sqliteDbPath,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    ...(activeProject === undefined ? {} : { activeProject }),
    hostProfile: options.hostProfile,
    runtimeIdentity: options.runtimeIdentity,
    serverWorkspaceRoot: options.binding.workspaceRoot,
    serverRouteLedgerRoot: options.binding.routeledgerRoot,
    processCwd: options.binding.processCwd
  };
};

const summarizeRuntimeBinding = (binding: RouteLedgerBindingSummary) => ({
  status: binding.status,
  workspaceRoot: binding.workspaceRoot,
  workspaceRootSource: binding.workspaceRootSource,
  workspaceRootConfidence: binding.workspaceRootConfidence,
  routeledgerRoot: binding.routeledgerRoot,
  workspaceConfigPath: binding.workspaceConfigPath,
  dataRoot: binding.dataRoot,
  routeledgerDir: binding.routeledgerDir,
  jsonProjectPath: binding.jsonProjectPath,
  sqliteDbPath: binding.sqliteDbPath
});

const withRuntimeContextMeta = (options: {
  meta?: Record<string, unknown>;
  data: unknown;
  binding: RouteLedgerBindingSummary;
  hostProfile: RouteLedgerHostProfileName;
  runtimeIdentity: RuntimeIdentity;
  activeProject?: RuntimeBindingActiveProject | null;
}): Record<string, unknown> => ({
  ...(options.meta ?? {}),
  runtimeContext: buildRuntimeContext({
    binding: options.binding,
    hostProfile: options.hostProfile,
    runtimeIdentity: options.runtimeIdentity,
    data: options.data,
    activeProject: options.activeProject
  }),
  runtimeIdentity: options.runtimeIdentity
});

const toToolError = (error: unknown): ToolResponse => {
  if (
    error instanceof ApplicationError ||
    error instanceof DomainError ||
    error instanceof InvalidToolInputError ||
    error instanceof JsonFirstStorageError
  ) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error)
    }
  };
};

export const createSessionRebindFailureResponse = (
  pendingRebind: RouteLedgerPendingSessionRebind,
  cause: unknown
): ToolResponse => ({
  ok: false,
  error: {
    code: "SESSION_REBIND_FAILED",
    message:
      "RouteLedger could not activate the requested session binding; the previous binding remains active.",
    details: {
      workspaceRoot: pendingRebind.workspaceRoot,
      routeledgerRoot: pendingRebind.routeledgerRoot,
      cause: cause instanceof Error ? cause.message : String(cause)
    }
  }
});

const readStringField = (input: Record<string, any> | null | undefined, key: string): string | undefined =>
  typeof input?.[key] === "string" ? input[key] : undefined;

const readDebugVersionId = (input: Record<string, any> | null | undefined): string | undefined =>
  readStringField(input, "versionId") ??
  readStringField(input, "targetVersionId") ??
  readStringField(input, "targetId") ??
  readStringField(input, "parentVersionId");

const readDebugPendingOperationId = (
  input: Record<string, any> | null | undefined
): string | undefined => readStringField(input, "pendingOperationId");

const parseBatchCreateVersionsMode = (value: unknown): BatchCreateVersionsMode => {
  if (isBatchCreateVersionsMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_MODE_INVALID",
    "batch_create_versions mode 仅支持 preflight 或 propose",
    {
      receivedMode: value ?? null,
      allowedModes: [...BATCH_CREATE_VERSIONS_MODES]
    }
  );
};

const parseBatchPreviousCurrentPolicy = (
  value: unknown
): BatchPreviousCurrentPolicy | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isBatchPreviousCurrentPolicy(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
    "batch_create_versions previousCurrentPolicy 仅支持 leave_as_is 或 require_complete_or_close",
    {
      receivedPreviousCurrentPolicy: value ?? null,
      allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    }
  );
};

const parseRouteOperationWorkflowMode = (
  value: unknown
): "dry_run" | "propose" | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isRouteOperationWorkflowMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "ROUTE_OPERATION_WORKFLOW_MODE_INVALID",
    "workflow mode 仅支持 dry_run 或 propose",
    {
      receivedMode: value ?? null,
      allowedModes: [...ROUTE_OPERATION_WORKFLOW_MODES]
    }
  );
};

const loadMissionControlSourceModule = async (): Promise<MissionControlSourceModule> =>
  (await import("../../ui/src/server/launcher.js")) as MissionControlSourceModule;

const resolveMissionControlRoots = (
  input: Record<string, any>,
  binding: RouteLedgerBindingSummary
): { workspaceRoot: string; routeledgerRoot: string } => {
  const workspaceRootInput =
    typeof input.workspaceRoot === "string" && input.workspaceRoot.length > 0
      ? input.workspaceRoot
      : binding.workspaceRoot ?? binding.processCwd;
  const routeledgerRootInput =
    typeof input.routeledgerRoot === "string" && input.routeledgerRoot.length > 0
      ? input.routeledgerRoot
      : binding.routeledgerRoot;

  if (typeof routeledgerRootInput !== "string" || routeledgerRootInput.length === 0) {
    throw new InvalidToolInputError(
      "Mission Control source tool 需要可解析的 routeledgerRoot；请先绑定当前 MCP server，或显式传入 routeledgerRoot。",
      {
        toolName: "mission_control_roots",
        path: "$.routeledgerRoot",
        expected: "absolute routeledgerRoot string or current MCP binding routeledgerRoot",
        bindingStatus: binding.status,
        workspaceRoot: workspaceRootInput,
        routeledgerRoot: binding.routeledgerRoot ?? null,
        receivedType: routeledgerRootInput === undefined ? "undefined" : typeof routeledgerRootInput,
        receivedValue: routeledgerRootInput ?? null
      }
    );
  }

  const workspaceRoot =
    resolvePhysicalPathForContainmentSync(workspaceRootInput) ?? workspaceRootInput;
  const routeledgerRoot =
    resolvePhysicalPathForContainmentSync(routeledgerRootInput) ?? routeledgerRootInput;
  const outsideWorkspace = !isPhysicalPathContainedWithinSync(
    workspaceRootInput,
    routeledgerRootInput
  );

  if (outsideWorkspace) {
    throw new InvalidToolInputError(
      "Mission Control source tool 要求 routeledgerRoot 位于 workspaceRoot 内。",
      {
        toolName: "mission_control_roots",
        path: "$.routeledgerRoot",
        expected: "routeledgerRoot inside workspaceRoot",
        workspaceRoot,
        routeledgerRoot,
        receivedType: "string",
        receivedValue: routeledgerRoot
      }
    );
  }

  return {
    workspaceRoot,
    routeledgerRoot
  };
};

const expectedRouteLedgerRootSchema = stringSchema(
  "Runtime-required absolute routeledgerRoot assertion for write/high-risk tools, including dry_run previews. It must exactly match the MCP server routeledgerRoot."
);

const responseLocaleSchema = stringSchema(
  "Optional BCP 47 locale for human-readable tool messages. It is not persisted as project content_locale."
);

const withResponseLocaleInputSchema = (
  inputSchema: Record<string, unknown>
): Record<string, unknown> => {
  const properties =
    inputSchema.properties !== null && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : {};

  return {
    ...inputSchema,
    properties: {
      ...properties,
      responseLocale: responseLocaleSchema
    }
  };
};

const withExpectedRouteLedgerRootInputSchema = (
  inputSchema: Record<string, unknown>,
  riskLevel: RouteLedgerToolRiskLevel
): Record<string, unknown> => {
  if (riskLevel === "read-only") {
    return inputSchema;
  }

  const properties =
    inputSchema.properties !== null && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : {};

  return {
    ...inputSchema,
    properties: {
      ...properties,
      expectedRouteLedgerRoot: expectedRouteLedgerRootSchema
    }
  };
};

const formatToolNarrative = (narrative: ToolNarrative): string =>
  [
    narrative.what,
    narrative.when === undefined ? undefined : `When: ${narrative.when}.`,
    narrative.prerequisite === undefined
      ? undefined
      : `Needs: ${narrative.prerequisite}.`,
    narrative.parameter === undefined ? undefined : `Input: ${narrative.parameter}.`,
    narrative.warning === undefined ? undefined : `Warning: ${narrative.warning}.`
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");

const defineTool = (
  name: string,
  narrative: ToolNarrative,
  inputSchema: Record<string, unknown>,
  options: {
    title: string;
    riskLevel: RouteLedgerToolRiskLevel;
    toolKind?: RouteLedgerBindingToolKind;
    destructive?: boolean;
    idempotent?: boolean;
    recommendedApprovalMode?: RouteLedgerApprovalMode;
    visibility?: "default" | "source-only";
  },
  handler: ToolHandler
): ToolRegistration => ({
  definition: {
    name,
    description: formatToolNarrative(narrative),
    inputSchema: withResponseLocaleInputSchema(
      withExpectedRouteLedgerRootInputSchema(inputSchema, options.riskLevel)
    ),
    ...createToolMetadata(options)
  },
  toolKind:
    options.toolKind ??
    (options.riskLevel === "read-only" ? "read" : "write"),
  visibility: options.visibility ?? "default",
  handler
});

const withInputAdapter = <TInput>(
  adapter: (input: Record<string, any>) => TInput,
  handler: TypedToolHandler<TInput>
): ToolHandler => async (input) => handler(adapter(input));

export const createRouteLedgerMcpRegistry = (
  options: RouteLedgerMcpRegistryOptions
): RouteLedgerMcpRegistry => {
  const bindingConfig = {
    workspaceRoot: options.workspaceRoot,
    workspaceRootSource: options.workspaceRootSource,
    routeledgerRoot: options.routeledgerRoot,
    mcpRoots: options.mcpRoots
  };
  const initialBinding = resolveRouteLedgerBinding(bindingConfig);
  const readBinding = (): RouteLedgerBindingSummary =>
    resolveRouteLedgerBinding(bindingConfig);
  const runtime =
    initialBinding.routeledgerRoot === null ||
    (initialBinding.status !== "bound" && initialBinding.status !== "uninitialized")
      ? null
      : createService(
          initialBinding.workspaceRoot ?? initialBinding.processCwd,
          initialBinding.routeledgerRoot,
          options.sqliteReadModel ?? "enabled",
          options.storageTestHooks,
          options.l3Authorization === undefined
            ? undefined
            : {
                grantStore: options.l3Authorization.grantStore,
                ...(options.l3Authorization.exactStore === undefined
                  ? {}
                  : { exactStore: options.l3Authorization.exactStore }),
                sessionId: options.l3Authorization.sessionId,
                ...(options.l3Authorization.profile === undefined
                  ? {}
                  : { profile: options.l3Authorization.profile }),
                ...(options.l3Authorization.trustedClientId === undefined
                  ? {}
                  : { clientId: options.l3Authorization.trustedClientId }),
                subjectId: resolveActor(DEFAULT_APPROVER, options.approver).id,
                hostKind: options.hostProfile ?? "generic"
              }
        );
  const service = runtime?.service ?? (null as unknown as RouteLedgerService);
  const storage = runtime?.storage ?? null;
  const close = runtime?.close ?? (() => undefined);
  const debugLogger =
    initialBinding.routeledgerRoot === null
      ? null
      : new RouteLedgerDebugLogger({
          projectRoot: initialBinding.routeledgerRoot,
          enabled: options.debugLog?.enabled
        });
  const actor = resolveActor(DEFAULT_ACTOR, options.actor);
  const approver = resolveActor(DEFAULT_APPROVER, options.approver);
  const hostProfile = options.hostProfile ?? "generic";
  const runtimeProfile = options.runtimeProfile ?? "full";
  const configuredRuntimeIdentity = options.runtimeIdentity ?? resolveRuntimeIdentity(runtimeProfile);
  const runtimeIdentity: RuntimeIdentity = {
    ...configuredRuntimeIdentity,
    // Caller-selected profile governs the executable capability surface; do not
    // let a stale injected identity misreport it after a direct registry call.
    runtimeProfile
  };
  const usesCodexNativeToolAdmission =
    hostProfile === "codex" &&
    options.hostPermissionContext !== undefined &&
    options.l3AuthorityCandidateIdentity === undefined &&
    options.l3Authorization?.profile === undefined &&
    options.l3Authorization?.delegatedAuthority === undefined;
  const serverInfo = createServerInfo(runtimeIdentity);
  const instructions = createInstructions({
    hostProfile,
    actor,
    approver
  });
  const appendDebugLog = async (toolName: string, draft: DebugLogDraft): Promise<void> => {
    if (debugLogger === null) {
      return;
    }

    try {
      await debugLogger.append({
        ...draft,
        toolName,
        actorId: actor.id,
        actorDisplayName: actor.displayName,
        hostProfile
      });
    } catch {
      // Debug logging is optional and must never change MCP tool semantics.
    }
  };
  const executionRequests = new Map<
    string,
    { fingerprint: string; proposalId: Promise<string>; inFlight?: Promise<ToolResponse> }
  >();
  const createL3DecisionAdapter = (proposal: Readonly<PendingOperation>) => {
    if (options.l3Authorization === undefined) {
      throw new ApplicationError(
        "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        "This MCP connection has no trusted L3 authorization control plane",
        { pendingOperationId: proposal.id }
      );
    }

    const l3Authorization = options.l3Authorization;
    const activeProfile = l3Authorization.profile;
    if (
      hostProfile === "codex" &&
      options.hostPermissionContext?.status === "resolved" &&
      activeProfile !== undefined &&
      activeProfile.mode !== options.hostPermissionContext.mode
    ) {
      throw new ApplicationError(
        "AUTHORIZATION_PROFILE_DISABLED",
        "The bound RouteLedger authorization profile does not match the effective Codex permission mode",
        {
          reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
          effectiveMode: options.hostPermissionContext.mode,
          configuredMode: activeProfile.mode,
          profileId: activeProfile.profileId
        }
      );
    }
    if (activeProfile?.status === "disabled") {
      throw new ApplicationError(
        "AUTHORIZATION_PROFILE_DISABLED",
        "The bound L3 authorization profile is disabled",
        { profileId: activeProfile.profileId, modeEpoch: activeProfile.modeEpoch }
      );
    }
    const authorizationContext = {
      audience: "routeledger-core",
      subjectId: approver.id,
      projectId: proposal.projectId,
      routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
      ...(activeProfile === undefined
        ? {}
        : {
            profileId: activeProfile.profileId,
            modeEpoch: activeProfile.modeEpoch,
            profileDigest: activeProfile.profileDigest
          }),
      actionType: proposal.actionType,
      targetId: proposal.targetId,
      operationDigest: proposal.digest.value,
      now: new Date().toISOString(),
      hostKind: hostProfile,
      ...(l3Authorization.trustedClientId === undefined
        ? {}
        : { clientId: l3Authorization.trustedClientId }),
      sessionId: l3Authorization.sessionId
    };

    if (usesCodexNativeToolAdmission) {
      return new CodexL3DecisionAdapter({
        authorizationContext,
        exactStore: resolveExactStore(l3Authorization)
      });
    }

    return new ExistingL3DecisionAdapter({
      proposal,
      authorizationContext,
      exactStore: resolveExactStore(l3Authorization),
      interaction: l3Authorization.interaction,
      hostProfile,
      ...(l3Authorization.trustedClientId === undefined
        ? {}
        : { trustedClientId: l3Authorization.trustedClientId }),
      ...(activeProfile === undefined ? {} : { profile: activeProfile }),
      ...(l3Authorization.delegatedAuthority === undefined
        ? {}
        : { delegatedAuthority: l3Authorization.delegatedAuthority }),
      getEvaluationContext: () =>
        service.getL3AuthorizationEvaluationContext({
          projectId: proposal.projectId,
          pendingOperationId: proposal.id,
          routeledgerRootDigest: authorizationContext.routeledgerRootDigest,
          ...(activeProfile === undefined
            ? {}
            : {
                profileId: activeProfile.profileId,
                modeEpoch: activeProfile.modeEpoch,
                profileDigest: activeProfile.profileDigest
              }),
          subjectId: approver.id,
          hostKind: hostProfile,
          ...(l3Authorization.trustedClientId === undefined
            ? {}
            : { clientId: l3Authorization.trustedClientId })
        })
    });
  };
  const executeExistingL3Proposal = async (
    proposal: Readonly<PendingOperation>,
    idempotencyKey: string
  ): Promise<ToolResponse> => {
    if (proposal.status === "committed" && proposal.approvalArtifactId !== null) {
      const committed = await service.commitL3Operation({
        projectId: proposal.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: proposal.approvalArtifactId,
        actor
      });
      return {
        ok: true,
        data: {
          status: "committed",
          proposalId: proposal.id,
          decisionArtifact: projectDecisionArtifact(committed.approvalArtifact),
          commit: committed
        }
      };
    }
    if (proposal.status === "rejected") {
      return {
        ok: true,
        data: {
          status: "denied",
          proposalId: proposal.id,
          code: "PREVIOUSLY_REJECTED",
          reason: proposal.rejectionReason,
          rejection: proposal
        }
      };
    }

    const result = await orchestrateL3Operation({
      proposal,
      adapter: createL3DecisionAdapter(proposal),
      port: {
        authorize: async (_proposal, decision) => {
          if (decision.authorizationGrantId === undefined) {
            throw new ApplicationError(
              "AUTHORIZATION_GRANT_REJECTED",
              "The resolved L3 decision has no exact authorization grant",
              { pendingOperationId: proposal.id, reason: "AUTHORIZATION_GRANT_ID_REQUIRED" }
            );
          }
          return service.authorizeL3Operation({
            projectId: proposal.projectId,
            pendingOperationId: proposal.id,
            grantId: decision.authorizationGrantId,
            actor
          });
        },
        commit: (_proposal, artifact) =>
          service.commitL3Operation({
            projectId: proposal.projectId,
            pendingOperationId: proposal.id,
            approvalArtifactId: artifact.id,
            actor
          }),
        reject: (_proposal, denial) =>
          service.rejectL3Operation({
            projectId: proposal.projectId,
            pendingOperationId: proposal.id,
            reason: `${denial.code}: ${denial.reason}`,
            actor
          })
      }
    });

    if (result.status === "committed") {
      await appendDebugLog("execute_l3_operation", {
        type: "l3.commit",
        projectId: proposal.projectId,
        versionId: proposal.targetId,
        pendingOperationId: proposal.id,
        payload: {
          actionType: proposal.actionType,
          approvalArtifactId: result.approvalArtifact.id,
          replayed: result.commit.replayed,
          idempotencyKey
        }
      });
    }

    return {
      ok: true,
      data:
        result.status === "committed"
          ? {
              status: result.status,
              proposalId: result.proposalId,
              decision: result.decision,
              decisionArtifact: projectDecisionArtifact(result.approvalArtifact),
              commit: result.commit
            }
          : result
    };
  };
  let toolDefinitions: ToolDefinition[] = [];
  let guardedTools: Array<ToolRegistration> = [];
  let pendingSessionRebind: RouteLedgerPendingSessionRebind | null = null;
  const withCurrentRuntimeContextMeta = (options: {
    meta?: Record<string, unknown>;
    data: unknown;
  }): Record<string, unknown> =>
    withRuntimeContextMeta({
      ...options,
      binding: readBinding(),
      hostProfile,
      runtimeIdentity
    });
  const getBlockedTools = (binding: RouteLedgerBindingSummary): string[] => {
    return guardedTools
      .filter(
        (tool) =>
          (tool.visibility === "default" ||
            (tool.visibility === "source-only" && runtimeProfile === "full")) &&
          !isBindingToolKindAllowed(binding, tool.toolKind)
      )
      .map((tool) => tool.definition.name);
  };
  const getRuntimeContextData = async (
    binding: RouteLedgerBindingSummary = readBinding(),
    requestedResponseLocale?: unknown
  ) => {
    const storageInspection = storage === null ? null : await storage.inspectRuntimeBinding();
    const activeProject = storageInspection?.activeProject ?? null;
    const resolvedResponseLocale = resolveResponseLocale(
      requestedResponseLocale,
      options.defaultResponseLocale
    );
    const suggestedContentLocale = suggestContentLocale(
      resolvedResponseLocale.requested ?? resolvedResponseLocale.resolved
    );
    const contentLocaleEffectiveScopes = [
      "project_setting",
      "agent_content_default",
      "write_integrity_gate"
    ] as const;
    const contentLocale =
      activeProject?.contentLocale !== null && activeProject?.contentLocale !== undefined
        ? {
            status: "configured" as const,
            configuredValue: activeProject.contentLocale,
            suggestedValue: null,
            suggestionSource: null,
            requiresUserDecision: false,
            effectiveScopes: contentLocaleEffectiveScopes
          }
        : binding.status === "uninitialized" || activeProject !== null
          ? {
              status: "confirmation_required" as const,
              configuredValue: null,
              suggestedValue: suggestedContentLocale,
              suggestionSource:
                suggestedContentLocale === null ? null : "response_locale",
              requiresUserDecision: true,
              effectiveScopes: contentLocaleEffectiveScopes
            }
          : {
              status: "unavailable" as const,
              configuredValue: null,
              suggestedValue: null,
              suggestionSource: null,
              requiresUserDecision: false,
              effectiveScopes: contentLocaleEffectiveScopes
            };
    const bindingActions =
      binding.status === "bound" ? [] : getBindingRecommendedNextActions(binding);
    const localeBlockedTools =
      activeProject?.contentLocale === null
        ? guardedTools
            .filter(
              (tool) =>
                tool.definition.name !== "set_project_content_locale" &&
                (tool.toolKind === "write" || tool.toolKind === "bootstrap")
            )
            .map((tool) => tool.definition.name)
        : [];
    const recommendedNextActions =
      contentLocale.status !== "confirmation_required"
        ? bindingActions
        : activeProject === null
          ? [
              {
                type: "confirm_content_locale",
                proposedValue: suggestedContentLocale,
                description:
                  "Confirm a concrete project content_locale with the user before initialization.",
                requiresUserDecision: true
              },
              ...bindingActions.map((action) =>
                action.type === "initialize_routeledger"
                  ? {
                      ...action,
                      requiredFields: ["name", "contentLocale"],
                      blockedBy: ["content_locale_confirmation"]
                    }
                  : action
              )
            ]
          : [
              {
                type: "set_project_content_locale",
                tool: "set_project_content_locale",
                proposedValue: suggestedContentLocale,
                description:
                  "Set the existing project to the concrete content_locale confirmed by the user.",
                requiresUserDecision: true
              }
            ];

    return {
      binding: summarizeRuntimeBinding(binding),
      processCwd: binding.processCwd,
      hostProfile,
      runtimeProfile,
      runtimeIdentity,
      actor: {
        id: actor.id,
        displayName: actor.displayName ?? actor.id
      },
      approver: {
        id: approver.id,
        displayName: approver.displayName ?? approver.id
      },
      diagnostics: binding.diagnostics,
      storage: {
        sqliteReadModel: options.sqliteReadModel ?? "enabled",
        mode:
          binding.status === "unbound" || binding.status === "invalid"
            ? binding.status
            : (storageInspection?.storageMode ?? "uninitialized"),
        hasCanonicalJson: storageInspection?.hasCanonicalJson ?? false,
        hasSqlite: storageInspection?.hasSqlite ?? false,
        dataRoot: storageInspection?.dataRoot ?? binding.dataRoot ?? null,
        jsonProjectPath: storageInspection?.jsonProjectPath ?? null,
        sqliteDbPath: storageInspection?.sqliteDbPath ?? null,
        conflict: storageInspection?.conflict ?? null,
        jsonError: storageInspection?.jsonError ?? null,
        sqliteError: storageInspection?.sqliteError ?? null,
        writeLock: storageInspection?.writeLock ?? null
      },
      activeProject,
      contentLocale,
      blockedTools: [...new Set([...getBlockedTools(binding), ...localeBlockedTools])],
      recommendedNextActions
    };
  };
  const getRuntimeContextMeta = async (): Promise<Record<string, unknown>> => {
    const binding = readBinding();
    let activeProject: RuntimeBindingActiveProject | null = null;

    // Error reporting is best-effort: an inspection failure must not mask the
    // original tool error. When it does succeed, its identity is the only
    // source used for error runtimeContext.
    try {
      activeProject = (await storage?.inspectRuntimeBinding())?.activeProject ?? null;
    } catch {
      activeProject = null;
    }

    return withRuntimeContextMeta({
      data: null,
      binding,
      hostProfile,
      runtimeIdentity,
      activeProject
    });
  };
  const attachRuntimeContextToError = async (response: ToolResponse): Promise<ToolResponse> => {
    if (response.ok) {
      return response;
    }

    return {
      ...response,
      meta: {
        ...(response.meta ?? {}),
        ...(await getRuntimeContextMeta())
      }
    };
  };
  const tools: ToolRegistration[] = [
    defineTool(
      "get_runtime_context",
      { what: "Inspect MCP binding, active project, and storage state." },
      objectSchema({}),
      {
        title: "Get Runtime Context",
        riskLevel: "read-only",
        toolKind: "diagnostic"
      },
      async (input) => {
        const binding = readBinding();
        const runtimeContext = await getRuntimeContextData(binding, input.responseLocale);

        return {
          ok: true,
          data: runtimeContext,
          meta: withRuntimeContextMeta({
            data:
              runtimeContext.activeProject === null
                ? null
                : {
                    project: {
                      id: runtimeContext.activeProject.id,
                      name: runtimeContext.activeProject.name
                    }
                  },
            binding,
            hostProfile,
            runtimeIdentity
          })
        };
      }
    ),
    defineTool(
      "get_l3_authorization_status",
      { what: "Inspect active L3 authorization." },
      objectSchema({
        detail: {
          type: "string",
          enum: ["summary", "internal"],
          description: "Use internal only for host diagnostics; summary is the product default."
        }
      }),
      {
        title: "Get L3 Authorization Status",
        riskLevel: "read-only"
      },
      async (input) => {
        const profile = options.l3Authorization?.profile;
        const profileCompatible =
          options.hostPermissionContext?.status === "resolved" && profile !== undefined
            ? profile.mode === options.hostPermissionContext.mode
            : null;
        const effectiveMode =
          options.hostPermissionContext?.status === "resolved"
            ? {
                mode: options.hostPermissionContext.mode,
                source: options.hostPermissionContext.source,
                codexPermissionProfile:
                  options.hostPermissionContext.codexPermissionProfile,
                fallbackUsed: options.hostPermissionContext.fallbackUsed,
                profileCompatible
              }
            : usesCodexNativeToolAdmission
              ? {
                  status: "host_managed",
                  mode: null,
                  source: "codex_native_tool_admission",
                  codexPermissionProfile: null,
                  fallbackUsed: false,
                  profileCompatible,
                  reason:
                    "Codex enforces the active task permission before this high-risk tool call reaches RouteLedger."
                }
              : options.hostPermissionContext ?? null;
        const compatibilityBackend =
          options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
            ? "host_authority_broker_v2"
            : usesCodexNativeToolAdmission
              ? "exact_grant_receipt"
              : options.l3Authorization === undefined
              ? "unavailable"
              : "v1_compatibility";
        const controlPlane =
          options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
            ? "host_authority_broker_v2"
            : usesCodexNativeToolAdmission
              ? "codex_native_tool_admission_v2"
              : compatibilityBackend;
        return {
          ok: true,
          data:
            profile === undefined
              ? {
                  controlPlane,
                  authorizationBackend: compatibilityBackend,
                  profile: null,
                  profileCompatible,
                  effectiveMode,
                  management: "host_only",
                  recommendedNextActions: []
                }
              : {
                  controlPlane: "host_authority_broker_v2",
                  authorizationBackend: "host_authority_broker_v2",
                  effectiveMode,
                  profileCompatible,
                  profile: {
                    status: profile.status,
                    mode: profile.mode,
                    limits: profile.limits,
                    delegatedPolicy:
                      profile.delegatedPolicy === null
                        ? null
                        : {
                            policyId: profile.delegatedPolicy.policyId,
                            policyDigest: digestL3AuthorizationPolicy(profile.delegatedPolicy),
                            defaultEffect: profile.delegatedPolicy.defaultEffect,
                            ruleCount: profile.delegatedPolicy.rules.length,
                            alwaysPrompt: profile.delegatedPolicy.alwaysPrompt
                          },
                    ...(input.detail === "internal"
                      ? {
                          internal: {
                            profileId: profile.profileId,
                            modeEpoch: profile.modeEpoch,
                            profileRevision: profile.profileRevision,
                            profileDigest: profile.profileDigest
                          }
                        }
                      : {})
                  },
                  management: "host_only",
                  trustedUserDecisionProvenance: "required"
                }
        };
      }
    ),
    defineTool(
      "recommend_l3_authorization_profile",
      {
        what: "Build a conservative V3 profile candidate.",
        warning: "candidate only"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          mode: {
            type: "string",
            enum: ["interactive", "delegated", "preauthorized"],
            description: "Requested mutually exclusive authorization mode."
          },
          expiresInHours: integerSchema("Delegated policy lifetime in hours. Defaults to 24.", {
            minimum: 1,
            maximum: 168
          }),
          maxUses: integerSchema("Maximum delegated policy uses and profile grant uses. Defaults to 16.", {
            minimum: 1,
            maximum: 100
          }),
          maxAuthorizationTtlSeconds: integerSchema("Maximum grant TTL. Defaults to 3600 seconds.", {
            minimum: 30,
            maximum: 86400
          })
        },
        ["projectId", "mode"]
      ),
      {
        title: "Recommend L3 Authorization Profile",
        riskLevel: "read-only"
      },
      async (input) => {
        const mode = input.mode as L3AuthorizationProfileV2["mode"];
        const now = new Date();
        const maxUses = input.maxUses ?? 16;
        const binding = {
          projectId: input.projectId,
          workspaceRootDigest: digestAuthorizationPath(initialBinding.workspaceRoot!),
          routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
          subjectId: options.l3AuthorityCandidateIdentity?.subjectId ?? approver.id,
          hostKind: hostProfile,
          trustedClientId:
            options.l3AuthorityCandidateIdentity?.trustedClientId ??
            options.l3Authorization?.trustedClientId ??
            null
        };
        const delegatedPolicy =
          mode === "delegated"
            ? await service.recommendBalancedL3AuthorizationPolicy({
                projectId: input.projectId,
                policyId: `balanced-${input.projectId}-${Date.now()}`,
                routeledgerRootDigest: binding.routeledgerRootDigest,
                expiresAt: new Date(
                  now.getTime() + (input.expiresInHours ?? 24) * 60 * 60 * 1000
                ).toISOString(),
                maxUses,
                subjectId: approver.id,
                hostKind: hostProfile,
                ...(binding.trustedClientId === null
                  ? {}
                  : { clientId: binding.trustedClientId })
              })
            : null;
        const profileBase: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
          schemaVersion: 3,
          profileId: `profile-${input.projectId}-${randomUUID()}`,
          status: "active",
          binding,
          mode,
          modeEpoch: 1,
          profileRevision: 1,
          delegatedPolicy,
          limits: {
            maxAuthorizationTtlSeconds: input.maxAuthorizationTtlSeconds ?? 3600
          },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        };
        return {
          ok: true,
          data: {
            candidateOnly: true,
            profile: {
              ...profileBase,
              profileDigest: digestL3AuthorizationProfile(profileBase)
            },
            recommendedChecklist: [
              "Verify project, workspace-root, RouteLedger-root, subject, host, and trusted-client bindings.",
              "Keep target IDs explicit; do not add wildcard targets.",
              "Keep TTL and use budgets finite.",
              "Treat mode or scope expansion as a new trusted-host user decision.",
              "Install only through the host authority broker; project files and MCP tools are not authority."
            ]
          }
        };
      }
    ),
    defineTool(
      "discover_routeledger_roots",
      { what: "Find .routeledger candidates under a workspace.", when: "inspecting an unbound workspace", parameter: "workspaceRoot" },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd."
        )
      }),
      {
        title: "Discover RouteLedger Roots",
        riskLevel: "read-only",
        toolKind: "discovery"
      },
      async (input) => ({
        ok: true,
        data: await discoverRouteLedgerRoots({
          workspaceRoot:
            input.workspaceRoot ??
            (readBinding().workspaceRootConfidence === "low" ||
            readBinding().workspaceRootConfidence === "none"
              ? undefined
              : readBinding().workspaceRoot ?? undefined)
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "plan_routeledger_binding",
      { what: "Plan a RouteLedger binding without activating it.", parameter: "workspaceRoot and routeledgerRoot" },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to plan. When omitted, the tool uses the current binding or a discovered single candidate."
        )
      }),
      {
        title: "Plan RouteLedger Binding",
        riskLevel: "read-only",
        toolKind: "planning"
      },
      async (input) => ({
        ok: true,
        data: await planRouteLedgerBinding({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          hostProfile
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "activate_routeledger_binding",
      {
        what: "Activate an explicit MCP binding.",
        parameter: "workspaceRoot",
        warning: "switching an established Codex session requires confirmProjectSwitch=true"
      },
      objectSchema(
        {
          workspaceRoot: stringSchema("Required absolute host workspaceRoot."),
          routeledgerRoot: stringSchema(
            "Optional absolute RouteLedger root inside workspaceRoot. Defaults to workspaceRoot."
          ),
          confirmProjectSwitch: booleanSchema(
            "Set true only after the user explicitly confirms replacing an established Codex session binding."
          )
        },
        ["workspaceRoot"]
      ),
      {
        title: "Activate RouteLedger Binding",
        riskLevel: "write",
        toolKind: "planning",
        recommendedApprovalMode: "prompt"
      },
      async (input) => {
        const previousBinding = readBinding();
        const canBootstrap =
          previousBinding.status === "unbound" ||
          previousBinding.status === "invalid" ||
          previousBinding.workspaceRootConfidence === "low" ||
          previousBinding.workspaceRootConfidence === "none";
        const canConfirmCodexSwitch =
          hostProfile === "codex" && input.confirmProjectSwitch === true;
        if (!canBootstrap && !canConfirmCodexSwitch) {
          return {
            ok: true,
            data: {
              status: "blocked",
              code:
                previousBinding.status === "bound" &&
                previousBinding.workspaceRootConfidence === "high"
                  ? "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED"
                  : "BINDING_BOOTSTRAP_NOT_ALLOWED",
              message:
                "An established project binding requires an explicit Codex session switch confirmation.",
              previousBinding,
              recommendedNextActions: [
                {
                  type: "confirm_session_binding_switch",
                  tool: "activate_routeledger_binding",
                  description:
                    "After explicit user confirmation, retry with the exact target roots and confirmProjectSwitch=true.",
                  requiredFields: [
                    "workspaceRoot",
                    "routeledgerRoot",
                    "confirmProjectSwitch"
                  ],
                  requiresUserDecision: true,
                  toolInput: {
                    workspaceRoot: input.workspaceRoot,
                    routeledgerRoot: input.routeledgerRoot ?? input.workspaceRoot,
                    confirmProjectSwitch: true
                  }
                }
              ]
            },
            meta: withCurrentRuntimeContextMeta({ data: null })
          };
        }

        const bindingPlan = await planRouteLedgerBinding({
          binding: previousBinding,
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot ?? input.workspaceRoot,
          hostProfile
        });
        if (
          (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") ||
          bindingPlan.targetBinding === null
        ) {
          return {
            ok: true,
            data: { status: "blocked", bindingPlan },
            meta: withCurrentRuntimeContextMeta({ data: null })
          };
        }

        pendingSessionRebind = {
          workspaceRoot: bindingPlan.targetBinding.workspaceRoot,
          routeledgerRoot: bindingPlan.targetBinding.routeledgerRoot,
          previousBinding,
          bindingPlan,
          requiresInit: bindingPlan.requiresInit
        };
        return {
          ok: true,
          data: {
            status: "pending_session_rebind",
            previousBinding,
            requiresInit: bindingPlan.requiresInit,
            bindingPlan
          }
        };
      }
    ),
    defineTool(
      "render_host_binding_config",
      { what: "Render a Codex binding config or fragment." },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to render. When omitted, the tool uses the current binding or a discovered single candidate."
        ),
        routeLedgerWorkspaceRoot: stringSchema(
          "Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."
        ),
        serverName: stringSchema("Optional MCP server name override."),
        existingConfigStrategy: {
          type: "string",
          enum: ["write-fragment", "overwrite", "error"],
          description:
            "How Codex should plan the target path when .codex/config.toml already exists. The tool only renders and plans; it never writes."
        }
      }),
      {
        title: "Render Host Binding Config",
        riskLevel: "read-only",
        toolKind: "planning"
      },
      async (input) => ({
        ok: true,
        data: await renderHostBindingConfig({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          routeLedgerWorkspaceRoot:
            typeof input.routeLedgerWorkspaceRoot === "string" &&
            input.routeLedgerWorkspaceRoot.length > 0
              ? input.routeLedgerWorkspaceRoot
              : undefined,
          serverName: input.serverName,
          existingConfigStrategy: input.existingConfigStrategy
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "write_host_binding_config",
      { what: "Write a Codex binding config or fragment.", prerequisite: "a planned binding" },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to write. When omitted, the tool uses the current binding or a discovered single candidate."
        ),
        routeLedgerWorkspaceRoot: stringSchema(
          "Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."
        ),
        serverName: stringSchema("Optional MCP server name override."),
        outputPath: stringSchema(
          "Optional absolute output path. Defaults to workspaceRoot/.codex/config.toml or a routeledger fragment when config.toml already exists."
        ),
        existingConfigStrategy: {
          type: "string",
          enum: ["write-fragment", "overwrite", "error"],
          description:
            "How Codex should write when .codex/config.toml already exists. Defaults to writing a fragment instead of overwriting."
        }
      }),
      {
        title: "Write Host Binding Config",
        riskLevel: "write",
        toolKind: "planning",
        recommendedApprovalMode: "prompt"
      },
      async (input) => ({
        ok: true,
        data: await writeHostBindingConfig({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          routeLedgerWorkspaceRoot:
            typeof input.routeLedgerWorkspaceRoot === "string" &&
            input.routeLedgerWorkspaceRoot.length > 0
              ? input.routeLedgerWorkspaceRoot
              : undefined,
          serverName: input.serverName,
          outputPath: input.outputPath,
          existingConfigStrategy: input.existingConfigStrategy
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "open_mission_control",
      { what: "Open or reuse source-mode Mission Control." },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."
        ),
        devBuild: booleanSchema(
          "When true, auto-build the UI dist if it is missing before launching the source-mode Mission Control server."
        )
      }),
      {
        title: "Open Mission Control",
        riskLevel: "read-only",
        toolKind: "diagnostic",
        visibility: "source-only"
      },
      async (input) => {
        const roots = resolveMissionControlRoots(input, readBinding());
        const missionControlSource = await loadMissionControlSourceModule();
        const result = await missionControlSource.openMissionControlSource({
          workspaceRoot: roots.workspaceRoot,
          routeledgerRoot: roots.routeledgerRoot,
          devBuild: input.devBuild === true
        });

        return {
          ok: true,
          data: result,
          meta: withCurrentRuntimeContextMeta({
            data: {
              project: result.projectId === null ? null : { id: result.projectId }
            }
          })
        };
      }
    ),
    defineTool(
      "get_mission_control_status",
      { what: "Inspect source-mode Mission Control health." },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."
        )
      }),
      {
        title: "Get Mission Control Status",
        riskLevel: "read-only",
        toolKind: "diagnostic",
        visibility: "source-only"
      },
      async (input) => {
        const roots = resolveMissionControlRoots(input, readBinding());
        const missionControlSource = await loadMissionControlSourceModule();
        const status = await missionControlSource.getMissionControlStatus({
          workspaceRoot: roots.workspaceRoot,
          routeledgerRoot: roots.routeledgerRoot
        });

        return {
          ok: true,
          data: status,
          meta: withCurrentRuntimeContextMeta({
            data: {
              project: status.projectId === null ? null : { id: status.projectId }
            }
          })
        };
      }
    ),
    defineTool(
      "init_project",
      { what: "Initialize canonical RouteLedger project data." },
      objectSchema(
        {
          name: stringSchema("Project name."),
          description: stringSchema("Optional project description."),
          contentLocale: stringSchema(
            "Concrete BCP 47 locale confirmed by the user for future project content. null and auto are not allowed."
          ),
          firstVersion: firstVersionSchema
        },
        ["name", "contentLocale"]
      ),
      {
        title: "Init Project",
        riskLevel: "write",
        toolKind: "bootstrap"
      },
      async (input) => ({
        ok: true,
        data: await service.initProject({
          name: input.name,
          description: input.description,
          contentLocale: input.contentLocale,
          firstVersion: input.firstVersion ?? null,
          actor
        })
      })
    ),
    defineTool(
      "set_project_content_locale",
      {
        what: "Set a user-confirmed content locale for an existing project.",
        parameter: "projectId, contentLocale, reason",
        warning: "Affects future writes only"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          contentLocale: stringSchema(
            "Concrete BCP 47 locale confirmed by the user. null and auto are not allowed."
          ),
          reason: stringSchema("Why the project content locale was selected or changed.")
        },
        ["projectId", "contentLocale", "reason"]
      ),
      {
        title: "Set Project Content Locale",
        riskLevel: "write",
        recommendedApprovalMode: "prompt"
      },
      async (input) => ({
        ok: true,
        data: await service.setProjectContentLocale({
          projectId: input.projectId,
          contentLocale: input.contentLocale,
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "get_current_context",
      { what: "Read current project, route, work, and gate context." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          budgetBytes: integerSchema("Optional payload budget in bytes.", {
            minimum: 8192,
            maximum: 65536
          }),
          includeAllVersions: booleanSchema("Return all versions instead of a current-centered window."),
          versionWindowBefore: integerSchema("How many versions before current to include.", {
            minimum: 0,
            maximum: 20
          }),
          versionWindowAfter: integerSchema("How many versions after current to include.", {
            minimum: 0,
            maximum: 20
          }),
          includeLegacyUndo: booleanSchema(
            "Audit-only. Include legacy Undo records under legacyUndo when a hidden legacy blocker must be inspected. Defaults to false."
          )
        },
        ["projectId"]
      ),
      {
        title: "Get Current Context",
        riskLevel: "read-only"
      },
      withInputAdapter<GetCurrentContextToolInput>(adaptGetCurrentContextInput, async (input) => {
        const context = await service.getCurrentContext({
          projectId: input.projectId,
          budgetBytes: input.budgetBytes,
          includeAllVersions: input.includeAllVersions,
          versionWindowBefore: input.versionWindowBefore,
          versionWindowAfter: input.versionWindowAfter,
          includeLegacyUndo: input.includeLegacyUndo
        });

        return {
          ok: true,
          data: context.data,
          meta: withCurrentRuntimeContextMeta({
            meta: context.meta,
            data: context.data
          })
        };
      })
    ),
    defineTool(
      "next_action",
      { what: "Read the shared next route action." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID.")
        },
        ["projectId"]
      ),
      {
        title: "Next Action",
        riskLevel: "read-only"
      },
      async (input) => {
        const nextAction = await service.getNextAction({
          projectId: input.projectId
        });

        return {
          ok: true,
          data: nextAction.data,
          meta: withCurrentRuntimeContextMeta({ data: nextAction.data })
        };
      }
    ),
    defineTool(
      "check_doc_drift",
      { what: "Compare selected entry docs with RouteLedger truth.", parameter: "entryFiles" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          entryFiles: {
            type: "array",
            description: "Repo-relative human entry docs to inspect under the MCP server workspaceRoot.",
            items: stringSchema("Repo-relative entry doc path.")
          },
          expectedPointers: {
            type: "array",
            description: "Optional expected doc pointers that should appear in at least one checked file.",
            items: docDriftExpectedPointerSchema
          }
        },
        ["projectId", "entryFiles"]
      ),
      {
        title: "Check Doc Drift",
        riskLevel: "read-only"
      },
      withInputAdapter<CheckDocDriftToolInput>(adaptCheckDocDriftInput, async (input) => {
        const result = await service.checkDocDrift({
          projectId: input.projectId,
          entryFiles: input.entryFiles,
          expectedPointers: input.expectedPointers
        });

        return {
          ok: true,
          data: sanitizeDocDriftForAgent(result.data),
          meta: withCurrentRuntimeContextMeta({ data: result.data })
        };
      })
    ),
    defineTool(
      "summarize_version_closeout",
      { what: "Summarize a version's closeout blockers and evidence." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
          eventLimit: integerSchema("How many related recent events to include.", {
            minimum: 1,
            maximum: 50
          })
        },
        ["projectId"]
      ),
      {
        title: "Summarize Version Closeout",
        riskLevel: "read-only"
      },
      async (input) => {
        const summary = await service.summarizeVersionCloseout({
          projectId: input.projectId,
          versionId: input.versionId,
          eventLimit: input.eventLimit
        });
        await appendDebugLog("summarize_version_closeout", {
          type: "closeout.summary",
          projectId: summary.data.projectId,
          versionId: summary.data.version.id,
          payload: {
            canClose: summary.data.canClose,
            closeGateOk: summary.data.closeGate.ok,
            blockerCodes: summary.data.closeGate.blockers.map((blocker) => blocker.code),
            eventLimit: input.eventLimit ?? null
          }
        });

        return {
          ok: true,
          data: summary.data,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              ...summary.meta,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            },
            data: {
              project: {
                id: summary.data.projectId
              }
            }
          })
        };
      }
    ),
    defineTool(
      "plan_version_closeout",
      { what: "Plan concrete steps to clear a version closeout." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
          eventLimit: integerSchema("How many related recent events to include in the embedded summary.", {
            minimum: 1,
            maximum: 50
          })
        },
        ["projectId"]
      ),
      {
        title: "Plan Version Closeout",
        riskLevel: "read-only"
      },
      async (input) => {
        const plan = await service.planVersionCloseout({
          projectId: input.projectId,
          versionId: input.versionId,
          eventLimit: input.eventLimit
        });
        await appendDebugLog("plan_version_closeout", {
          type: "closeout.plan",
          projectId: plan.data.projectId,
          versionId: plan.data.version.id,
          payload: {
            status: plan.data.status,
            stepKinds: plan.data.steps.map((step) => step.kind),
            closeGateOk: plan.data.summary.closeGate.ok,
            eventLimit: input.eventLimit ?? null
          }
        });

        return {
          ok: true,
          data: plan.data,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              ...plan.meta,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            },
            data: {
              project: {
                id: plan.data.projectId
              }
            }
          })
        };
      }
    ),
    defineTool(
      "list_versions_window",
      { what: "List a compact version window." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          aroundVersionId: stringSchema("Optional anchor version ID. Defaults to currentVersionId."),
          before: integerSchema("How many versions before the anchor to include.", {
            minimum: 0,
            maximum: 20
          }),
          after: integerSchema("How many versions after the anchor to include.", {
            minimum: 0,
            maximum: 20
          })
        },
        ["projectId"]
      ),
      {
        title: "List Versions Window",
        riskLevel: "read-only"
      },
      withInputAdapter<ListVersionsWindowToolInput>(
        adaptListVersionsWindowInput,
        async (input) => {
          const window = await service.listVersionsWindow({
            projectId: input.projectId,
            aroundVersionId: input.aroundVersionId,
            before: input.before,
            after: input.after
          });

          return {
            ok: true,
            data: window.data,
            meta: withCurrentRuntimeContextMeta({
              meta: window.meta,
              data: window.data
            })
          };
        }
      )
    ),
    defineTool(
      "list_versions",
      { what: "List project versions." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID.")
        },
        ["projectId"]
      ),
      {
        title: "List Versions",
        riskLevel: "read-only"
      },
      async (input) => ({
        ok: true,
        data: await service.listVersions(input.projectId)
      })
    ),
    defineTool(
      "check_start_gate",
      { what: "Evaluate a version start gate." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Check Start Gate",
        riskLevel: "read-only"
      },
      async (input) => {
        const gate = await service.checkStartGate({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        });
        await appendDebugLog("check_start_gate", {
          type: "gate.start",
          projectId: input.projectId,
          versionId: input.versionId,
          payload: {
            allowed: gate.allowed,
            blockerCodes: gate.blockers.map((blocker) => blocker.code)
          }
        });

        return {
          ok: true,
          data: gate
        };
      }
    ),
    defineTool(
      "check_close_gate",
      { what: "Evaluate a version close gate." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          residualAudit: {
            ...residualAuditInputSchema,
            description: "Explicit reviewed residual audit for close-gate evaluation; { status: reviewed, items: [] } means reviewed-empty."
          }
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Check Close Gate",
        riskLevel: "read-only"
      },
      async (input) => {
        const gate = await service.checkCloseGate({
          projectId: input.projectId,
          versionId: input.versionId,
          residualAudit: input.residualAudit as ResidualAuditInput,
          actor
        });
        await appendDebugLog("check_close_gate", {
          type: "gate.close",
          projectId: input.projectId,
          versionId: input.versionId,
          payload: {
            allowed: gate.allowed,
            blockerCodes: gate.blockers.map((blocker) => blocker.code),
            residualAuditCount: Array.isArray(input.residualAudit)
              ? input.residualAudit.length
              : Array.isArray((input.residualAudit as { items?: unknown } | undefined)?.items)
                ? ((input.residualAudit as { items: unknown[] }).items.length)
                : 0
          }
        });

        return {
          ok: true,
          data: gate
        };
      }
    ),
    defineTool(
      "get_version_structure",
      { what: "Read version topology and legal operation hints." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional focus version ID. Defaults to currentVersionId."),
          residualAudit: {
            ...residualAuditInputSchema,
            description: "Optional residual audit sample used to evaluate close_version legality."
          }
        },
        ["projectId"]
      ),
      {
        title: "Get Version Structure",
        riskLevel: "read-only"
      },
      async (input) => {
        const structure = await service.getVersionStructure({
          projectId: input.projectId,
          versionId: input.versionId,
          residualAudit: input.residualAudit as ResidualAuditInput
        });

        return {
          ok: true,
          data: sanitizeVersionStructureForAgent(structure)
        };
      }
    ),
    defineTool(
      "get_version_transition_guide",
      { what: "Guide a from-version to target-version transition.", parameter: "fromVersionId and targetVersionId" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          fromVersionId: stringSchema("Optional from version ID. Defaults to currentVersionId."),
          targetVersionId: stringSchema("Target version ID."),
          residualAudit: {
            ...residualAuditInputSchema,
            description: "Optional residual audit sample used to preview the from-version close gate."
          }
        },
        ["projectId", "targetVersionId"]
      ),
      {
        title: "Get Version Transition Guide",
        riskLevel: "read-only"
      },
      async (input) => {
        const guide = await service.getVersionTransitionGuide({
          projectId: input.projectId,
          fromVersionId: input.fromVersionId,
          targetVersionId: input.targetVersionId,
          residualAudit: input.residualAudit as ResidualAuditInput
        });

        return {
          ok: true,
          data: guide,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            },
            data: guide
          })
        };
      }
    ),
    defineTool(
      "recommend_l3_authorization_policy",
      {
        what: "Build a bound conservative L3 policy candidate."
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          expiresInHours: integerSchema("Policy lifetime in hours. Defaults to 24.", {
            minimum: 1,
            maximum: 168
          }),
          maxUses: integerSchema("Maximum delegated uses per rule. Defaults to 16.", {
            minimum: 1,
            maximum: 100
          })
        },
        ["projectId"]
      ),
      {
        title: "Recommend L3 Authorization Policy",
        riskLevel: "read-only"
      },
      async (input) => {
        const expiresInHours = input.expiresInHours ?? 24;
        const maxUses = input.maxUses ?? 16;
        const policy = await service.recommendBalancedL3AuthorizationPolicy({
          projectId: input.projectId,
          policyId: `balanced-${input.projectId}-${Date.now()}`,
          routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
          expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
          maxUses,
          subjectId: approver.id,
          hostKind: hostProfile,
          ...(options.l3Authorization?.trustedClientId === undefined
            ? {}
            : { clientId: options.l3Authorization.trustedClientId })
        });
        return {
          ok: true,
          data: {
            policy,
            candidateOnly: true,
            authorityPlacement: "host_managed_outside_agent_write_scope",
            injectionContract: "RouteLedgerMcpDelegatedAuthorizationAuthority",
            installationContract: {
              configSchemaVersion: 1,
              trustedHostApi: "installLocalL3AuthorityConfig",
              runtimeOption: "--l3-authority-config",
              requiredHostInputs: [
                "absolute configPath outside workspace and RouteLedger root",
                "absolute statePath outside workspace and RouteLedger root",
                "explicit user confirmation of the reviewed candidate"
              ],
              agentCanInstall: false
            },
            coverage: {
              delegatedWhenLiveGatePasses: [...BALANCED_AUTO_ACTIONS],
              alwaysPrompt: [...BALANCED_ALWAYS_PROMPT_ACTIONS],
              unmatchedAction: policy.defaultEffect
            },
            reviewChecklist: [
              "Verify the project and RouteLedger-root bindings.",
              "Verify the current-version and target list snapshot.",
              "Choose an expiry and maximum-use budget.",
              "Keep shutdown, reopen, route editing, and current-pointer changes in alwaysPrompt.",
              "Install only in a host-managed authority and inject its opaque handle at MCP startup; never save this candidate as project authority."
            ]
          }
        };
      }
    ),
    defineTool(
      "list_l3_proposals",
      { what: "List pending and historical L3 proposals." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID.")
        },
        ["projectId"]
      ),
      {
        title: "List L3 Proposals",
        riskLevel: "read-only"
      },
      async (input) => ({
        ok: true,
        data: await service.listL3Proposals(input.projectId)
      })
    ),
    defineTool(
      "get_l3_proposal",
      { what: "Read one L3 proposal." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID.")
        },
        ["projectId", "pendingOperationId"]
      ),
      {
        title: "Get L3 Proposal",
        riskLevel: "read-only"
      },
      async (input) => ({
        ok: true,
        data: await service.getL3Proposal(input.projectId, input.pendingOperationId)
      })
    ),
    defineTool(
      "batch_create_versions",
      {
        what: "Preflight or propose an atomic version batch, including append-only continuation after a closed top-level tail.",
        parameter: "mode and versions"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          mode: {
            type: "string",
            enum: ["preflight", "propose"],
            description: "preflight only validates; propose creates one pending L3 proposal after a successful preflight."
          },
          partialAllowed: booleanSchema("Batch B only supports false; true returns a structured plan failure."),
          anchor: batchCreateVersionsAnchorSchema,
          items: {
            type: "array",
            items: batchCreateVersionsItemSchema,
            description: "Ordered versions to create as one contiguous chain."
          },
          setCurrentTo: stringSchema("Optional clientKey of the new version that should become current after commit."),
          previousCurrentPolicy: {
            type: "string",
            enum: ["leave_as_is", "require_complete_or_close"],
            description: "How to treat the previous current version if setCurrentTo is provided."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "mode", "items"]
      ),
      {
        title: "Batch Create Versions",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.batchCreateVersions({
          projectId: input.projectId,
          mode: parseBatchCreateVersionsMode(input.mode),
          partialAllowed: input.partialAllowed,
          anchor: input.anchor,
          items: input.items as Array<{
            clientKey: string;
            title: string;
            description: string;
            initialTodos: string[];
          }>,
          setCurrentTo: input.setCurrentTo,
          previousCurrentPolicy: parseBatchPreviousCurrentPolicy(
            input.previousCurrentPolicy
          ),
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "transition_version",
      {
        what: "Binding-sensitive transition preview or proposal.",
        parameter: "mode and targetVersionId"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description: "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates exactly one next-step proposal when actionable."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Transition Version",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.transitionVersion({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "advance_to_version",
      {
        what: "Atomically switch to and start the ready next Version.",
        warning: "Blocked gates return without writing; passing gates create one L3 proposal."
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Ready target Version ID."),
          fromVersionId: stringSchema("Optional expected closed current Version ID."),
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Advance To Version",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.advanceToVersion({
          projectId: input.projectId,
          versionId: input.versionId,
          fromVersionId: input.fromVersionId,
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "close_version",
      {
        what: "Binding-sensitive close preview or proposal.",
        parameter: "mode and versionId",
        warning: "proposal needs a passing gate"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description: "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates a close_version proposal only when the gate passes."
          },
          residualAudit: {
            ...residualAuditInputSchema,
            description: "Residual audit items used for close preflight and, when allowed, the proposal payload."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Close Version",
        riskLevel: "write"
      },
      async (input) => {
        const result = await service.closeVersionWorkflow({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          residualAudit: input.residualAudit as ResidualAuditInput,
          reason: input.reason,
          actor
        });
        await appendDebugLog("close_version", {
          type: "version.close",
          projectId: input.projectId,
          versionId: result.versionId,
          pendingOperationId: result.pendingOperationId,
          payload: {
            status: result.status,
            mode: result.mode,
            blockerCodes: result.blockers.map((blocker) => blocker.code),
            createsPendingProposal: result.pendingOperationId !== undefined
          }
        });

        return {
          ok: true,
          data: result
        };
      }
    ),
    defineTool(
      "shutdown_version",
      {
        what: "Binding-sensitive forced-close preview or proposal.",
        parameter: "mode and versionId",
        warning: "bypasses ordinary blockers"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description: "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates a shutdown_version proposal."
          },
          shutdownReason: stringSchema("Required shutdown reason suffix. RouteLedger stores it as version.stateReason with a shutdown: prefix."),
          reason: stringSchema("Optional proposal reason override shown in audit/review surfaces.")
        },
        ["projectId", "versionId", "shutdownReason"]
      ),
      {
        title: "Shutdown Version",
        riskLevel: "high-risk"
      },
      async (input) => {
        const result = await service.shutdownVersionWorkflow({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          shutdownReason: input.shutdownReason,
          reason: input.reason,
          actor
        });
        await appendDebugLog("shutdown_version", {
          type: "version.shutdown",
          projectId: input.projectId,
          versionId: result.versionId,
          pendingOperationId: result.pendingOperationId,
          payload: {
            status: result.status,
            mode: result.mode,
            forced: result.forced,
            shutdownStateReason: result.shutdownStateReason,
            ordinaryCloseBlockerCodes: result.ordinaryCloseGate.blockers.map(
              (blocker) => blocker.code
            ),
            createsPendingProposal: result.pendingOperationId !== undefined
          }
        });

        return {
          ok: true,
          data: result
        };
      }
    ),
    defineTool(
      "create_todo",
      { what: "Create a Todo for current work." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Owning version ID."),
          title: stringSchema("Todo title."),
          description: stringSchema("Optional todo description.")
        },
        ["projectId", "versionId", "title"]
      ),
      {
        title: "Create Todo",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.createTodo({
          projectId: input.projectId,
          versionId: input.versionId,
          title: input.title,
          description: input.description,
          actor
        })
      })
    ),
    defineTool(
      "close_todo",
      { what: "Close a Todo with its outcome." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          todoId: stringSchema("Todo ID."),
          reason: stringSchema("Close reason."),
          note: stringSchema("Close note.")
        },
        ["projectId", "todoId", "reason", "note"]
      ),
      {
        title: "Close Todo",
        riskLevel: "write",
        destructive: true
      },
      async (input) => ({
        ok: true,
        data: await service.closeTodo({
          projectId: input.projectId,
          todoId: input.todoId,
          reason: input.reason,
          note: input.note,
          actor
        })
      })
    ),
    defineTool(
      "defer_work",
      { what: "Create Deferred work for a future review.", parameter: "mode, targetReviewVersionId, and Todo or new-work fields" },
      objectSchema(
        {
          mode: {
            type: "string",
            enum: ["new", "todo"],
            description:
              "new creates Deferred work; todo converts an existing Todo into Deferred work."
          },
          projectId: stringSchema("RouteLedger project ID."),
          currentVersionId: stringSchema(
            "Required for mode=new. The current version where this work was identified."
          ),
          targetReviewVersionId: stringSchema(
            "Downstream version where this Deferred work must be reviewed."
          ),
          title: stringSchema("Required for mode=new. Deferred work title."),
          description: stringSchema("Optional description for mode=new."),
          todoId: stringSchema("Required for mode=todo. Existing Todo ID."),
          reason: stringSchema("Why the work is being deferred."),
          note: stringSchema(
            "Required for mode=todo. Operator note explaining the Todo transition."
          ),
          reviewTrigger: stringSchema(
            "Optional condition or evidence that should trigger review."
          )
        },
        ["mode", "projectId", "targetReviewVersionId", "reason"]
      ),
      {
        title: "Defer Work",
        riskLevel: "write"
      },
      withInputAdapter<DeferWorkToolInput>(adaptDeferWorkInput, async (input) => {
        const result =
          input.mode === "new"
            ? await service.deferWork({
                mode: "new",
                projectId: input.projectId,
                originVersionId: input.currentVersionId,
                targetReviewVersionId: input.targetReviewVersionId,
                title: input.title,
                description: input.description,
                reason: input.reason,
                reviewTrigger: input.reviewTrigger,
                actor
              })
            : await service.deferWork({
                mode: "todo",
                projectId: input.projectId,
                todoId: input.todoId,
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger,
                actor
              });
        await appendDebugLog("defer_work", {
          type: "deferred.created",
          projectId: input.projectId,
          versionId: result.deferred.targetReviewVersionId,
          deferredId: result.deferred.id,
          payload: {
            mode: result.mode,
            deferredId: result.deferred.id,
            status: result.deferred.status,
            targetReviewVersionId: result.deferred.targetReviewVersionId
          }
        });

        return {
          ok: true,
          data:
            result.mode === "todo"
              ? {
                  mode: result.mode,
                  todo: summarizeTodoForAgent(result.todo),
                  deferred: summarizeDeferredForAgent(result.deferred)
                }
              : {
                  mode: result.mode,
                  deferred: summarizeDeferredForAgent(result.deferred)
                }
        };
      })
    ),
    defineTool(
      "review_deferred",
      { what: "Review Deferred work: activate, defer again, or resolve.", parameter: "deferredId and action" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          deferredId: stringSchema("Deferred item ID."),
          action: {
            type: "string",
            enum: ["activate", "defer_again", "resolve"],
            description: "Review action."
          },
          targetVersionId: stringSchema(
            "Required for activate. Version where the activated Todo will run."
          ),
          targetReviewVersionId: stringSchema(
            "Required for defer_again. Later version where review must happen."
          ),
          outcome: {
            type: "string",
            enum: ["superseded", "rejected", "out_of_scope"],
            description: "Required for resolve."
          },
          reason: stringSchema("Reason for this review decision."),
          note: stringSchema("Optional operator note."),
          reviewTrigger: stringSchema("Optional updated review trigger for defer_again."),
          decisionRef: stringSchema(
            "Decision reference. Required by the service for rejected and out_of_scope outcomes."
          )
        },
        ["projectId", "deferredId", "action", "reason"]
      ),
      {
        title: "Review Deferred",
        riskLevel: "write",
        destructive: true
      },
      withInputAdapter<ReviewDeferredToolInput>(
        adaptReviewDeferredInput,
        async (input) => {
          const result =
            input.action === "activate"
              ? await service.reviewDeferred({
                  ...input,
                  actor
                })
              : input.action === "defer_again"
                ? await service.reviewDeferred({
                    ...input,
                    actor
                  })
                : await service.reviewDeferred({
                    ...input,
                    actor
                  });
          await appendDebugLog("review_deferred", {
            type: `deferred.${input.action}`,
            projectId: input.projectId,
            deferredId: input.deferredId,
            payload: {
              action: input.action,
              deferredId: input.deferredId,
              status: result.deferred.status,
              resolutionOutcome: result.deferred.resolutionOutcome,
              targetReviewVersionId: result.deferred.targetReviewVersionId
            }
          });

          return {
            ok: true,
            data:
              result.action === "activate"
                ? {
                    action: result.action,
                    deferred: summarizeDeferredForAgent(result.deferred),
                    todo: summarizeTodoForAgent(result.todo)
                  }
                : {
                    action: result.action,
                    deferred: summarizeDeferredForAgent(result.deferred)
                  }
          };
        }
      )
    ),
    defineTool(
      "record_constraint",
      { what: "Record a RouteLedger constraint.", parameter: "rule, rationale, and scopeType" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          rule: stringSchema("The rule that must not be violated."),
          rationale: stringSchema("Why this constraint exists."),
          scopeType: {
            type: "string",
            enum: ["project", "version"],
            description: "project applies everywhere; version applies only to versionId."
          },
          versionId: stringSchema("Required when scopeType=version.")
        },
        ["projectId", "rule", "rationale", "scopeType"]
      ),
      {
        title: "Record Constraint",
        riskLevel: "write"
      },
      withInputAdapter<RecordConstraintToolInput>(
        adaptRecordConstraintInput,
        async (input) => {
          const result = await service.recordConstraint({
            projectId: input.projectId,
            rule: input.rule,
            rationale: input.rationale,
            scope:
              input.scopeType === "project"
                ? { type: "project" }
                : { type: "version", versionId: input.versionId },
            actor
          });
          await appendDebugLog("record_constraint", {
            type: "constraint.recorded",
            projectId: input.projectId,
            versionId:
              input.scopeType === "version" ? input.versionId : undefined,
            constraintId: result.constraint.id,
            payload: {
              constraintId: result.constraint.id,
              status: result.constraint.status,
              scope: result.constraint.scope
            }
          });

          return {
            ok: true,
            data: {
              constraint: summarizeConstraintForAgent(result.constraint)
            }
          };
        }
      )
    ),
    defineTool(
      "retire_constraint",
      { what: "Retire an obsolete constraint." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          constraintId: stringSchema("Constraint ID."),
          reason: stringSchema("Why this constraint no longer applies."),
          note: stringSchema("Operator note for the retirement audit.")
        },
        ["projectId", "constraintId", "reason", "note"]
      ),
      {
        title: "Retire Constraint",
        riskLevel: "write",
        destructive: true
      },
      withInputAdapter<RetireConstraintToolInput>(
        adaptRetireConstraintInput,
        async (input) => {
          const result = await service.retireConstraint({
            ...input,
            actor
          });
          await appendDebugLog("retire_constraint", {
            type: "constraint.retired",
            projectId: input.projectId,
            constraintId: input.constraintId,
            payload: {
              constraintId: result.constraint.id,
              status: result.constraint.status
            }
          });

          return {
            ok: true,
            data: {
              constraint: summarizeConstraintForAgent(result.constraint)
            }
          };
        }
      )
    ),
    defineTool(
      "prepare_version",
      { what: "Prepare a version for execution." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Prepare Version",
        riskLevel: "write",
        destructive: true
      },
      async (input) => ({
        ok: true,
        data: await service.prepareVersion({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        })
      })
    ),
    defineTool(
      "mark_version_complete",
      { what: "Mark a version complete." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Mark Version Complete",
        riskLevel: "write",
        destructive: true
      },
      async (input) => ({
        ok: true,
        data: await service.markVersionComplete({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        })
      })
    ),
    defineTool(
      "create_version",
      {
        what: "Propose a top-level version, including append-only continuation after a closed top-level tail.",
        warning: "returns a pending L3 operation"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description.")
        },
        ["projectId", "title"]
      ),
      {
        title: "Create Version",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.createVersion({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          actor
        })
      })
    ),
    defineTool(
      "insert_version",
      { what: "Propose a sibling version insertion.", parameter: "sibling anchor" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description."),
          afterVersionId: stringSchema("Insert after this sibling version ID."),
          beforeVersionId: stringSchema("Insert before this sibling version ID.")
        },
        ["projectId", "title"]
      ),
      {
        title: "Insert Version",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.insertVersion({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          actor
        })
      })
    ),
    defineTool(
      "create_child_version",
      { what: "Propose a child version.", parameter: "parentVersionId and child anchor" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          parentVersionId: stringSchema("Parent version ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description."),
          afterVersionId: stringSchema("Insert after this child version ID."),
          beforeVersionId: stringSchema("Insert before this child version ID.")
        },
        ["projectId", "parentVersionId", "title"]
      ),
      {
        title: "Create Child Version",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.createChildVersion({
          projectId: input.projectId,
          parentVersionId: input.parentVersionId,
          title: input.title,
          description: input.description,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          actor
        })
      })
    ),
    defineTool(
      "reorder_versions",
      { what: "Propose a version reorder within its parent.", parameter: "sibling anchor" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID to move."),
          afterVersionId: stringSchema("Move after this sibling version ID."),
          beforeVersionId: stringSchema("Move before this sibling version ID.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Reorder Versions",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.reorderVersions({
          projectId: input.projectId,
          versionId: input.versionId,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          actor
        })
      })
    ),
    defineTool(
      "propose_l3_operation",
      { what: "Create a pending L3 proposal.", parameter: "actionType, targetId, and reason" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          actionType: {
            type: "string",
            enum: [
              "start_version",
              "close_version",
              "shutdown_version",
              "reopen_version",
              "set_current_version",
              "advance_to_version",
              "create_version",
              "insert_version",
              "create_child_version",
              "reorder_versions"
            ],
            description: "L3 action type."
          },
          targetId: stringSchema("Target record ID."),
          reason: stringSchema("Proposal reason."),
          payload: payloadSchema
        },
        ["projectId", "actionType", "targetId", "reason"]
      ),
      {
        title: "Propose L3 Operation",
        riskLevel: "write"
      },
      async (input) => ({
        ok: true,
        data: await service.proposeL3Operation({
          projectId: input.projectId,
          actionType: input.actionType as L3ActionType,
          targetId: input.targetId,
          reason: input.reason,
          payload: input.payload ?? {},
          actor
        })
      })
    ),
    defineTool(
      "execute_l3_operation",
      {
        what: "Execute one exact L3 operation end to end.",
        parameter: "action, target, reason, and idempotency key",
        warning: "key reuse requires the same input"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          actionType: {
            type: "string",
            enum: [
              "start_version",
              "close_version",
              "shutdown_version",
              "reopen_version",
              "set_current_version",
              "advance_to_version",
              "create_version",
              "insert_version",
              "create_child_version",
              "reorder_versions"
            ],
            description: "L3 action type."
          },
          targetId: stringSchema("Target record ID."),
          reason: stringSchema("Proposal reason."),
          idempotencyKey: stringSchema("Caller-stable key for exact retry within this MCP registry lifetime."),
          payload: payloadSchema
        },
        ["projectId", "actionType", "targetId", "reason", "idempotencyKey"]
      ),
      {
        title: "Execute L3 Operation",
        riskLevel: "high-risk",
        destructive: true,
        idempotent: true,
        recommendedApprovalMode: "approve"
      },
      async (input) => {
        if (options.l3Authorization === undefined) {
          throw new ApplicationError(
            "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
            "This MCP connection has no trusted L3 authorization control plane"
          );
        }
        if (options.l3Authorization.profile?.status === "disabled") {
          throw new ApplicationError(
            "AUTHORIZATION_PROFILE_DISABLED",
            "The bound L3 authorization profile is disabled",
            {
              profileId: options.l3Authorization.profile.profileId,
              modeEpoch: options.l3Authorization.profile.modeEpoch
            }
          );
        }
        if (
          hostProfile === "codex" &&
          options.hostPermissionContext?.status === "resolved" &&
          options.l3Authorization.profile !== undefined &&
          options.l3Authorization.profile.mode !== options.hostPermissionContext.mode
        ) {
          throw new ApplicationError(
            "AUTHORIZATION_PROFILE_DISABLED",
            "The bound RouteLedger authorization profile does not match the effective Codex permission mode",
            {
              reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
              effectiveMode: options.hostPermissionContext.mode,
              configuredMode: options.l3Authorization.profile.mode
            }
          );
        }
        if (input.idempotencyKey.trim().length === 0) {
          throw new InvalidToolInputError("idempotencyKey must be non-empty", {
            toolName: "execute_l3_operation",
            path: "$.idempotencyKey",
            expected: "non-empty string"
          });
        }

        const exactInput = {
          projectId: input.projectId,
          actionType: input.actionType,
          targetId: input.targetId,
          reason: input.reason,
          payload: input.payload ?? {}
        };
        const fingerprint = digestExecutionInput(exactInput);
        const existing = executionRequests.get(input.idempotencyKey);
        if (existing !== undefined && existing.fingerprint !== fingerprint) {
          throw new InvalidToolInputError(
            "idempotencyKey is already bound to a different L3 execution request",
            {
              toolName: "execute_l3_operation",
              path: "$.idempotencyKey",
              reason: "IDEMPOTENCY_KEY_REUSE_MISMATCH",
              idempotencyKey: input.idempotencyKey
            }
          );
        }

        let entry = existing;
        if (entry === undefined) {
          const resumeProposalId = (input as Record<string, unknown>)[
            "__routeledgerMcpResumeProposalId"
          ];
          const proposalId =
            typeof resumeProposalId === "string" && resumeProposalId.trim().length > 0
              ? Promise.resolve(resumeProposalId)
              : service
                  .proposeL3Operation({
                    ...exactInput,
                    actionType: input.actionType as L3ActionType,
                    actor
                  })
                  .then((proposal) => proposal.id);
          entry = { fingerprint, proposalId };
          executionRequests.set(input.idempotencyKey, entry);
          proposalId.catch(() => {
            if (executionRequests.get(input.idempotencyKey) === entry) {
              executionRequests.delete(input.idempotencyKey);
            }
          });
        }

        const pendingOperationId = await entry.proposalId;
        const proposal = await service.getL3Proposal(input.projectId, pendingOperationId);
        const resumeBinding = (input as Record<string, unknown>)[
          "__routeledgerMcpResumeBinding"
        ] as Partial<ExactAuthorizationBinding> | undefined;
        if (
          resumeBinding !== undefined &&
          (resumeBinding.proposalId !== proposal.id ||
            resumeBinding.projectId !== proposal.projectId ||
            resumeBinding.routeledgerRootDigest !== digestRouteLedgerRoot(initialBinding.routeledgerRoot!) ||
            resumeBinding.actionType !== proposal.actionType ||
            resumeBinding.targetId !== proposal.targetId ||
            resumeBinding.operationDigest !== proposal.digest.value)
        ) {
          throw new InvalidToolInputError(
            "requestState no longer matches the live exact proposal",
            {
              toolName: "execute_l3_operation",
              path: "$._meta.requestState",
              reason: "REQUEST_STATE_LIVE_BINDING_MISMATCH",
              pendingOperationId
            }
          );
        }
        if (entry.inFlight === undefined) {
          entry.inFlight = executeExistingL3Proposal(proposal, input.idempotencyKey);
        }
        const inFlight = entry.inFlight;
        try {
          return await inFlight;
        } finally {
          if (entry.inFlight === inFlight) delete entry.inFlight;
        }
      }
    ),
    defineTool(
      "approve_l3_operation",
      {
        what: "Authorize one pending L3 proposal.",
        parameter: "pendingOperationId",
        warning: "Codex gates this call; other hosts need trusted authority"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          decisionRef: stringSchema(
            "Deprecated display-only input. It is ignored and cannot create authorization."
          )
        },
        ["projectId", "pendingOperationId"]
      ),
      {
        title: "Approve L3 Operation",
        riskLevel: "high-risk"
      },
      async (input) => {
        const proposal = await service.getL3Proposal(input.projectId, input.pendingOperationId);
        const adapter = createL3DecisionAdapter(proposal);
        const resolution = await adapter.resolve(createExactProposalDecisionRequest(proposal));
        if (
          resolution.status === "denied" &&
          "details" in resolution &&
          resolution.details.reason === "HOST_DECLINED"
        ) {
          await service.rejectL3Operation({
            projectId: proposal.projectId,
            pendingOperationId: proposal.id,
            reason: `${resolution.code}: ${resolution.reason}`,
            actor
          });
        }
        const decision = requireResolvedExistingL3Decision(resolution);
        if (decision.authorizationGrantId === undefined) {
          throw new ApplicationError(
            "AUTHORIZATION_GRANT_REJECTED",
            "The resolved L3 decision has no exact authorization grant",
            { pendingOperationId: proposal.id, reason: "AUTHORIZATION_GRANT_ID_REQUIRED" }
          );
        }

        return {
          ok: true,
          data: await service.authorizeL3Operation({
            projectId: input.projectId,
            pendingOperationId: input.pendingOperationId,
            grantId: decision.authorizationGrantId,
            actor
          })
        };
      }
    ),
    defineTool(
      "commit_l3_operation",
      { what: "Commit an approved L3 proposal.", parameter: "pendingOperationId and approvalArtifactId", warning: "consumes once; exact retries replay" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          approvalArtifactId: stringSchema("Approval artifact ID."),
          confirm: booleanSchema("Legacy boolean confirmation input. RouteLedger ignores confirm=true without an approval artifact.")
        },
        ["projectId", "pendingOperationId", "approvalArtifactId"]
      ),
      {
        title: "Commit L3 Operation",
        riskLevel: "high-risk",
        destructive: true,
        recommendedApprovalMode: "approve"
      },
      async (input) => {
        const committed = await service.commitL3Operation({
          projectId: input.projectId,
          pendingOperationId: input.pendingOperationId,
          approvalArtifactId: input.approvalArtifactId,
          confirm: input.confirm,
          actor
        });
        await appendDebugLog("commit_l3_operation", {
          type: "l3.commit",
          projectId: input.projectId,
          versionId: committed.pendingOperation.targetId,
          pendingOperationId: committed.pendingOperation.id,
          payload: {
            actionType: committed.pendingOperation.actionType,
            pendingOperationStatus: committed.pendingOperation.status,
            approvalArtifactId: committed.approvalArtifact.id,
            approvalArtifactStatus: committed.approvalArtifact.status,
            replayed: committed.replayed
          }
        });

        return {
          ok: true,
          data: committed
        };
      }
    ),
    defineTool(
      "reject_l3_operation",
      { what: "Reject a pending L3 proposal.", warning: "requires a host decision" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          reason: stringSchema("Rejection reason.")
        },
        ["projectId", "pendingOperationId", "reason"]
      ),
      {
        title: "Reject L3 Operation",
        riskLevel: "high-risk"
      },
      async (input) => ({
        ok: true,
        data: await service.rejectL3Operation({
          projectId: input.projectId,
          pendingOperationId: input.pendingOperationId,
          reason: input.reason,
          actor
        })
      })
    )
  ];

  guardedTools = tools.map((tool) => {
    return {
      ...tool,
      handler: async (input: Record<string, any>) => {
        const normalizedInput = input ?? {};
        const currentBinding = readBinding();
        const preflight = runBindingPreflight({
          toolName: tool.definition.name,
          toolKind: tool.toolKind,
          binding: currentBinding,
          expectedRouteLedgerRoot: normalizedInput.expectedRouteLedgerRoot
        });

        if (!preflight.allowed) {
          return {
            ok: false,
            error: {
              code: preflight.failure!.code,
              message: preflight.failure!.message,
              details: preflight.failure!.details
            },
            meta: withCurrentRuntimeContextMeta({ data: null })
          };
        }

        const forwardedInput = { ...normalizedInput };
        delete forwardedInput.expectedRouteLedgerRoot;
        return tool.handler(forwardedInput);
      }
    };
  });

  const callableTools = guardedTools.filter(
    (tool) =>
      tool.visibility !== "source-only" ||
      runtimeProfile === "full"
  );
  const registeredTools = callableTools.filter(
    (tool) =>
      tool.visibility === "default" ||
      (tool.visibility === "source-only" && runtimeProfile === "full")
  );
  const handlers = new Map<string, ToolHandler>(
    callableTools.map((tool) => [tool.definition.name, tool.handler])
  );
  toolDefinitions = registeredTools
    .map((tool) => tool.definition);

  let reboundRegistry: RouteLedgerMcpRegistry | null = null;
  const createActivationSuccessResponse = async (
    pendingRebind: RouteLedgerPendingSessionRebind
  ): Promise<ToolResponse> => {
    const binding = readBinding();
    const runtimeContext = await getRuntimeContextData(binding);

    return {
      ok: true,
      data: {
        status: "activated",
        rebound: true,
        previousBinding: pendingRebind.previousBinding,
        activeBinding: runtimeContext.binding,
        requiresInit: pendingRebind.requiresInit,
        bindingPlan: pendingRebind.bindingPlan
      },
      meta: withRuntimeContextMeta({
        data:
          runtimeContext.activeProject === null
            ? null
            : {
                project: {
                  id: runtimeContext.activeProject.id,
                  name: runtimeContext.activeProject.name
                }
              },
        binding,
        hostProfile,
        runtimeIdentity
      })
    };
  };

  const activatePendingRebindForDirectRegistry = async (): Promise<ToolResponse | null> => {
    if (options.deferSessionRebind || pendingSessionRebind === null) {
      return null;
    }

    const nextBinding = pendingSessionRebind;
    let nextRegistry: RouteLedgerMcpRegistry;
    try {
      nextRegistry = createRouteLedgerMcpRegistry({
        ...options,
        workspaceRoot: nextBinding.workspaceRoot,
        workspaceRootSource: "explicit_arg",
        routeledgerRoot: nextBinding.routeledgerRoot,
        mcpRoots: undefined,
        deferSessionRebind: false
      });
    } catch (error) {
      return createSessionRebindFailureResponse(nextBinding, error);
    }

    let activationResponse: ToolResponse;
    try {
      activationResponse = await nextRegistry.createActivationSuccessResponse(nextBinding);
    } catch (error) {
      try {
        nextRegistry.close();
      } catch {
        // The original registry remains active; candidate cleanup cannot change that.
      }
      return createSessionRebindFailureResponse(nextBinding, error);
    }

    const previousReboundRegistry = reboundRegistry;
    reboundRegistry = nextRegistry;
    pendingSessionRebind = null;
    try {
      previousReboundRegistry?.close();
    } catch {
      // The replacement is active; a stale close hook cannot roll it back.
    }
    return activationResponse;
  };

  return {
    tools: toolDefinitions,
    serverInfo,
    serverCapabilities,
    hostProfile,
    runtimeProfile,
    runtimeIdentity,
    instructions,
    getTool: (toolName) => toolDefinitions.find((tool) => tool.name === toolName),
    invoke: async (toolName, input) => {
      if (reboundRegistry !== null) {
        return reboundRegistry.invoke(toolName, input);
      }
      const responseLocale = resolveResponseLocale(
        input?.responseLocale,
        options.defaultResponseLocale
      );
      const handler = handlers.get(toolName);

      if (handler === undefined) {
        return localizeToolResponse(
          await attachRuntimeContextToError({
            ok: false,
            error: {
              code: "ACTION_NOT_IMPLEMENTED",
              message: `unknown tool ${toolName}`
            }
          }),
          responseLocale,
          toolName
        );
      }

      try {
        const response = await handler(input);
        const activationResponse =
          toolName === "activate_routeledger_binding"
            ? await activatePendingRebindForDirectRegistry()
            : null;
        return localizeToolResponse(
          await attachRuntimeContextToError(activationResponse ?? response),
          responseLocale,
          toolName
        );
      } catch (error) {
        const response = toToolError(error);
        await appendDebugLog(toolName, {
          type: "tool.failure",
          projectId: readStringField(input, "projectId"),
          versionId: readDebugVersionId(input),
          pendingOperationId: readDebugPendingOperationId(input),
          payload: {
            error: response.error,
            inputKeys: Object.keys(input ?? {}).sort()
          }
        });
        return localizeToolResponse(
          await attachRuntimeContextToError(response),
          responseLocale,
          toolName
        );
      }
    },
    getRuntimeContextMeta,
    peekPendingSessionRebind: () => pendingSessionRebind,
    clearPendingSessionRebind: () => {
      pendingSessionRebind = null;
    },
    createActivationSuccessResponse,
    close: () => {
      reboundRegistry?.close();
      close();
    }
  };
};
