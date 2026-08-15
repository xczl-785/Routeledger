import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationError,
  DomainError,
  type ExactAuthorizationStore,
  type L3AuthorizationProfileV2,
  RouteLedgerService,
  type Actor,
  type Constraint,
  type DeferredItem,
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
  isBindingToolKindAllowed
} from "./binding-preflight.js";
import { resolveRouteLedgerBinding, type RouteLedgerBindingSummary } from "./binding.js";
import {
  isPhysicalPathContainedWithinSync,
  resolvePhysicalPathForContainmentSync
} from "./physical-path.js";
import { RouteLedgerDebugLogger } from "./debug-log.js";
import { InvalidToolInputError } from "./input-adapter.js";
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
  defineTool,
  type ToolDefinition,
  type ToolHandler,
  type ToolRegistration,
  type ToolResponse
} from "./registry/tool-contract.js";
import {
  createMissionControlTools,
  type MissionControlSourceModule
} from "./capabilities/mission-control-tools.js";
import { createContextTools } from "./capabilities/context-tools.js";
import { createWorkTools } from "./capabilities/work-tools.js";
import {
  createBindingAssistTools,
  createProjectBootstrapTools
} from "./capabilities/binding-tools.js";
import {
  createVersionMutationTools,
  createVersionWorkflowTools
} from "./capabilities/version-tools.js";
import {
  createL3AuthorizationTools,
  createL3OperationTools,
  createL3ProposalTools
} from "./capabilities/l3-tools.js";
import type {
  RouteLedgerMcpAuthorizationInteraction,
  RouteLedgerMcpDelegatedAuthorizationAuthority
} from "./l3-authorization-contract.js";

export * from "./local-l3-authorization.js";
export * from "./local-l3-authority-registry.js";
export * from "./local-l3-authority-broker.js";
export * from "./existing-l3-decision-adapter.js";
export * from "./codex-l3-decision-adapter.js";
export * from "./mcp-decision-input.js";
export * from "./mcp-request-state.js";
export type {
  RouteLedgerMcpAuthorizationDecision,
  RouteLedgerMcpAuthorizationInteraction,
  RouteLedgerMcpAuthorizationRequest,
  RouteLedgerMcpDelegatedAuthorizationAuthority,
  RouteLedgerMcpDelegatedAuthorizationRequest,
  RouteLedgerMcpDelegatedAuthorizationResult
} from "./l3-authorization-contract.js";
export type {
  RouteLedgerApprovalMode,
  RouteLedgerToolRiskLevel,
  ToolAnnotations,
  ToolDefinition,
  ToolMeta,
  ToolResponse
} from "./registry/tool-contract.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MRTR_PROTOCOL_VERSION = "2026-07-28";

export type RouteLedgerHostProfileName = "generic" | "codex" | "claude-code" | "cursor";
/**
 * Runtime packaging profile. This is separate from the MCP host profile: it
 * describes which locally-built runtime is executing the shared MCP source.
 */
export type RouteLedgerMcpRuntimeProfile = "full" | "json-only";

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
    exactStore: ExactAuthorizationStore;
    interaction: RouteLedgerMcpAuthorizationInteraction;
    /** Host-owned V2 profile selected from the verified project/root binding. */
    profile?: L3AuthorizationProfileV2;
    /** Trusted host identity injected at startup; never derived from MCP clientInfo. */
    trustedClientId?: string;
    delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
  };
}

export interface RouteLedgerServerInfo {
  name: string;
  title: string;
  version: string;
  description: string;
  runtimeIdentity: RuntimeIdentity;
}

export interface RouteLedgerPendingSessionRebind {
  workspaceRoot: string;
  routeledgerRoot: string;
  previousBinding: RouteLedgerBindingSummary;
  bindingPlan: RouteLedgerBindingPlanResult;
  requiresInit: boolean;
}

type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  deferredId?: string;
  constraintId?: string;
  pendingOperationId?: string;
  payload?: unknown;
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

const createService = (
  workspaceRoot: string,
  routeledgerRoot: string,
  sqliteReadModel: SqliteReadModelMode,
  storageTestHooks?: JsonFirstStorageTestHooks,
  authorization?: {
    exactStore: ExactAuthorizationStore;
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
            exactStore: authorization.exactStore,
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
              : { clientId: authorization.clientId })
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
    binding: {
      status: options.binding.status,
      workspaceRoot: options.binding.workspaceRoot,
      workspaceRootConfidence: options.binding.workspaceRootConfidence,
      routeledgerRoot: options.binding.routeledgerRoot
    },
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    ...(activeProject === undefined ? {} : { activeProject }),
    hostProfile: options.hostProfile,
    runtime: {
      runtimePackageVersion: options.runtimeIdentity.runtimePackageVersion,
      runtimeProfile: options.runtimeIdentity.runtimeProfile,
      artifactKind: options.runtimeIdentity.artifactKind,
      pluginVersion: options.runtimeIdentity.pluginVersion,
      releaseTag: options.runtimeIdentity.releaseTag,
      runtimePayloadDigest: options.runtimeIdentity.runtimePayloadDigest
    }
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
  })
});

interface ToolErrorContext {
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolErrorRecoveryAction {
  type: string;
  tool: string;
  description: string;
  toolInput?: Record<string, unknown>;
  requiredInputs?: string[];
}

interface ToolErrorRecovery {
  recoveryState: string;
  currentState: string;
  expectedState: string;
  blockedReason: string;
  safeToRetry: boolean;
  writesPerformed: boolean;
  artifactConsumed: boolean;
  recommendedNextActions: ToolErrorRecoveryAction[];
}

const STALE_PROPOSAL_ACTION_DESCRIPTIONS: Record<string, string> = {
  reject_stale_proposal: "Reject the stale proposal before creating a replacement.",
  refresh_context: "Refresh the current route and work context.",
  resolve_live_blocker: "Resolve the live blocker recorded in the gate difference.",
  recheck_close_gate: "Recheck the close gate against live state.",
  propose_replacement: "Create a replacement proposal only after the live gate passes."
};

const buildToolErrorRecovery = (
  error: ApplicationError | DomainError | InvalidToolInputError | JsonFirstStorageError,
  context: ToolErrorContext | undefined
): ToolErrorRecovery | null => {
  if (
    error.code === "APPROVAL_ARTIFACT_DIGEST_MISMATCH" &&
    error.details?.staleProposal === true &&
    Array.isArray(error.details.recommendedNextActions)
  ) {
    const recommendedNextActions = error.details.recommendedNextActions.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [];
      }
      const action = candidate as Record<string, unknown>;
      if (typeof action.action !== "string" || typeof action.tool !== "string") {
        return [];
      }
      return [
        {
          type: action.action,
          tool: action.tool,
          description:
            STALE_PROPOSAL_ACTION_DESCRIPTIONS[action.action] ??
            "Follow the structured stale-proposal recovery step.",
          ...(action.input !== null &&
          typeof action.input === "object" &&
          !Array.isArray(action.input)
            ? { toolInput: action.input as Record<string, unknown> }
            : {}),
          ...(Array.isArray(action.requiredInputs) &&
          action.requiredInputs.every((value) => typeof value === "string")
            ? { requiredInputs: action.requiredInputs as string[] }
            : {})
        }
      ];
    });
    return {
      recoveryState: "stale_proposal",
      currentState: "stale_proposal",
      expectedState: "live_gate_match",
      blockedReason: error.code,
      safeToRetry: false,
      writesPerformed: false,
      artifactConsumed: false,
      recommendedNextActions
    };
  }

  if (
    error.code === "INVALID_TODO_TRANSITION" &&
    context?.toolName === "close_todo" &&
    error.details?.status === "closed"
  ) {
    return {
      recoveryState: "already_applied",
      currentState: "closed",
      expectedState: "wait_or_running",
      blockedReason: error.code,
      safeToRetry: false,
      writesPerformed: false,
      artifactConsumed: false,
      recommendedNextActions: [
        {
          type: "continue_route",
          tool: "next_action",
          description: "The Todo is already closed; do not retry the write and continue with the route.",
          toolInput:
            typeof context.input.projectId === "string"
              ? { projectId: context.input.projectId }
              : undefined
        }
      ]
    };
  }

  if (error.code.startsWith("DEFERRED_ROUTE_TARGET_") && context !== undefined) {
    const eligibleTargetVersions = Array.isArray(error.details?.eligibleTargetVersions)
      ? error.details.eligibleTargetVersions.filter(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        )
      : [];
    const retryActions = eligibleTargetVersions.flatMap((candidate) =>
      typeof candidate.id === "string"
        ? [
            {
              type: "choose_legal_deferred_target",
              tool: context.toolName,
              description:
                "Retry the Deferred operation with this eligible downstream Version.",
              toolInput: {
                ...context.input,
                targetReviewVersionId: candidate.id
              }
            }
          ]
        : []
    );
    return {
      recoveryState: "retry_with_legal_target",
      currentState: "invalid_target",
      expectedState: "downstream_version",
      blockedReason: error.code,
      safeToRetry: true,
      writesPerformed: false,
      artifactConsumed: false,
      recommendedNextActions:
        retryActions.length > 0
          ? retryActions
          : [
              {
                type: "choose_legal_deferred_target",
                tool: context.toolName,
                description:
                  "Choose one of eligibleTargetVersions and retry the Deferred operation with that Version ID.",
                toolInput: { ...context.input },
                requiredInputs: ["targetReviewVersionId"]
              }
            ]
    };
  }

  const isCreateVersionFailure =
    error.code === "INVALID_VERSION_TRANSITION" &&
    (context?.toolName === "create_version" ||
      (context?.toolName === "execute_l3_operation" &&
        context.input.actionType === "create_version"));
  if (isCreateVersionFailure) {
    const projectId = context?.input.projectId;
    const targetId = context?.input.targetId;
    const payload =
      context?.input.payload !== null &&
      typeof context?.input.payload === "object" &&
      !Array.isArray(context.input.payload)
        ? (context.input.payload as Record<string, unknown>)
        : {};
    const title = context?.input.title ?? payload.title;
    const description = context?.input.description ?? payload.description;
    const createVersionInput = {
      ...(typeof projectId === "string" ? { projectId } : {}),
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof description === "string" ? { description } : {})
    };
    return {
      recoveryState: "inspect_current_route",
      currentState: "stale_route_target",
      expectedState: "current_route_tail",
      blockedReason: error.code,
      safeToRetry: true,
      writesPerformed: false,
      artifactConsumed: false,
      recommendedNextActions: [
        {
          type: "inspect_version_structure",
          tool: "get_version_structure",
          description: "Inspect the current tail and legal route operations before retrying.",
          toolInput:
            typeof projectId === "string" && typeof targetId === "string"
              ? { projectId, versionId: targetId }
              : typeof projectId === "string"
                ? { projectId }
                : undefined,
          requiredInputs: typeof targetId === "string" ? undefined : ["versionId"]
        },
        {
          type: "retry_create_version",
          tool: "create_version",
          description:
            "Retry create_version against the current route; do not reuse a stale tail ID as the new target.",
          toolInput: createVersionInput,
          requiredInputs: typeof title === "string" ? undefined : ["title"]
        }
      ]
    };
  }

  return null;
};

export const toToolError = (
  error: unknown,
  context?: ToolErrorContext
): ToolResponse => {
  if (
    error instanceof ApplicationError ||
    error instanceof DomainError ||
    error instanceof InvalidToolInputError ||
    error instanceof JsonFirstStorageError
  ) {
    const recovery = buildToolErrorRecovery(error, context);
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details:
          recovery === null
            ? error.details
            : {
                ...(error.details ?? {}),
                ...recovery
              }
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
                exactStore: options.l3Authorization.exactStore,
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
  const l3ToolDependencies = {
    service,
    actor,
    approver,
    hostProfile,
    initialBinding,
    options,
    usesCodexNativeToolAdmission,
    digestAuthorizationPath,
    digestRouteLedgerRoot,
    appendDebugLog
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
    ...createL3AuthorizationTools(l3ToolDependencies),
    ...createBindingAssistTools({
      readBinding,
      hostProfile,
      withCurrentRuntimeContextMeta,
      stagePendingSessionRebind: (pending) => {
        pendingSessionRebind = pending;
      },
      operations: {
        discoverRouteLedgerRoots,
        planRouteLedgerBinding,
        renderHostBindingConfig,
        writeHostBindingConfig
      }
    }),
    ...createMissionControlTools({
      readBinding,
      resolveRoots: resolveMissionControlRoots,
      loadSourceModule: loadMissionControlSourceModule,
      runtimeIdentity,
      withCurrentRuntimeContextMeta
    }),
    ...createProjectBootstrapTools({ service, actor }),
    ...createContextTools({
      service,
      actor,
      appendDebugLog,
      withCurrentRuntimeContextMeta
    }),
    ...createL3ProposalTools(l3ToolDependencies),
    ...createVersionWorkflowTools({ service, actor, appendDebugLog }),
    ...createWorkTools({
      service,
      actor,
      appendDebugLog,
      summarizeTodoForAgent,
      summarizeDeferredForAgent,
      summarizeConstraintForAgent
    }),
    ...createVersionMutationTools({ service, actor, appendDebugLog }),
    ...createL3OperationTools(l3ToolDependencies)
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
        const response = toToolError(error, { toolName, input: input ?? {} });
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
