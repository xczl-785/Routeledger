import { createHash, randomUUID } from "node:crypto";
import { ApplicationError, BALANCED_ALWAYS_PROMPT_ACTIONS, BALANCED_AUTO_ACTIONS, DomainError, createExactProposalDecisionRequest, digestL3AuthorizationPolicy, digestL3AuthorizationProfile, orchestrateL3Operation, projectDecisionArtifact, RouteLedgerService } from "../../core/src/index.js";
import { JsonFirstStorageAdapter, JsonFirstStorageError } from "./json-first-storage.js";
import { discoverRouteLedgerRoots, planRouteLedgerBinding, renderHostBindingConfig, writeHostBindingConfig } from "./binding-assist.js";
import { runBindingPreflight, getBindingRecommendedNextActions, isBindingToolKindAllowed } from "./binding-preflight.js";
import { resolveRouteLedgerBinding } from "./binding.js";
import { isPhysicalPathContainedWithinSync, resolvePhysicalPathForContainmentSync } from "./physical-path.js";
import { RouteLedgerDebugLogger } from "./debug-log.js";
import { InvalidToolInputError } from "./input-adapter.js";
import { resolveRuntimeIdentity } from "./runtime-identity.js";
import { localizeToolResponse, resolveResponseLocale, suggestContentLocale } from "./locale.js";
import { ExistingL3DecisionAdapter, requireResolvedExistingL3Decision } from "./existing-l3-decision-adapter.js";
import { CodexL3DecisionAdapter } from "./codex-l3-decision-adapter.js";
import { defineTool } from "./registry/tool-contract.js";
import { createMissionControlTools } from "./capabilities/mission-control-tools.js";
import { createContextTools } from "./capabilities/context-tools.js";
import { createWorkTools } from "./capabilities/work-tools.js";
import { createBindingAssistTools, createProjectBootstrapTools } from "./capabilities/binding-tools.js";
import { createVersionMutationTools, createVersionWorkflowTools } from "./capabilities/version-tools.js";
import { residualAuditInputSchema } from "./registry/route-input-schemas.js";
export * from "./local-l3-authorization.js";
export * from "./local-l3-authority-registry.js";
export * from "./local-l3-authority-broker.js";
export * from "./existing-l3-decision-adapter.js";
export * from "./codex-l3-decision-adapter.js";
export * from "./mcp-decision-input.js";
export * from "./mcp-request-state.js";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MRTR_PROTOCOL_VERSION = "2026-07-28";
const createServerInfo = (runtimeIdentity) => ({
    name: "routeledger",
    title: "RouteLedger MCP",
    // MCP's standard version field is the internal runtime package version,
    // never a plugin manifest version.
    version: runtimeIdentity.runtimePackageVersion,
    description: "Standard MCP stdio adapter for RouteLedger",
    runtimeIdentity
});
const HOST_PROFILE_LABELS = {
    generic: "generic MCP host",
    codex: "Codex",
    "claude-code": "Claude Code",
    cursor: "Cursor"
};
const DEFAULT_ACTOR = {
    id: "mcp-agent",
    type: "agent",
    displayName: "routeledger-mcp"
};
const DEFAULT_APPROVER = {
    id: "mcp-user",
    type: "user",
    displayName: "routeledger-mcp-user"
};
const serverCapabilities = {
    tools: {
        listChanged: false
    }
};
const stringSchema = (description, extra = {}) => ({
    type: "string",
    description,
    ...extra
});
const integerSchema = (description, extra = {}) => ({
    type: "integer",
    description,
    ...extra
});
const booleanSchema = (description, extra = {}) => ({
    type: "boolean",
    description,
    ...extra
});
const summarizeTodoForAgent = (todo) => ({
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
const summarizeDeferredForAgent = (deferred) => ({
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
const summarizeConstraintForAgent = (constraint) => ({
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
const objectSchema = (properties, required = [], extra = {}) => ({
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    ...extra
});
const payloadSchema = objectSchema({
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
}, [], {
    description: "Optional payload captured in an L3 proposal."
});
const createInstructions = (options) => {
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
const resolveActor = (baseActor, override) => ({
    ...baseActor,
    id: override?.id ?? baseActor.id,
    displayName: override?.displayName ?? baseActor.displayName
});
const digestAuthorizationPath = (candidate) => {
    const physicalRoot = resolvePhysicalPathForContainmentSync(candidate);
    if (physicalRoot === null) {
        throw new Error("Authorization binding path cannot be physically resolved.");
    }
    return `sha256:${createHash("sha256").update(physicalRoot).digest("hex")}`;
};
export const digestRouteLedgerRoot = (routeledgerRoot) => digestAuthorizationPath(routeledgerRoot);
const canonicalizeExecutionInput = (value) => {
    if (Array.isArray(value))
        return value.map(canonicalizeExecutionInput);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalizeExecutionInput(item)]));
    }
    return value;
};
const digestExecutionInput = (value) => `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeExecutionInput(value)))
    .digest("hex")}`;
const createService = (workspaceRoot, routeledgerRoot, sqliteReadModel, storageTestHooks, authorization) => {
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
const buildRuntimeContext = (options) => {
    const responseProject = options.data !== null &&
        typeof options.data === "object" &&
        "project" in options.data &&
        options.data.project !== null &&
        typeof options.data.project === "object"
        ? options.data.project
        : null;
    // Success envelopes historically derive this compact summary from returned
    // data. Error envelopes pass a storage-inspected identity instead so a
    // request projectId can never become runtime truth.
    const activeProject = options.activeProject;
    const project = activeProject === undefined
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
const summarizeRuntimeBinding = (binding) => ({
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
const withRuntimeContextMeta = (options) => ({
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
const toToolError = (error) => {
    if (error instanceof ApplicationError ||
        error instanceof DomainError ||
        error instanceof InvalidToolInputError ||
        error instanceof JsonFirstStorageError) {
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
export const createSessionRebindFailureResponse = (pendingRebind, cause) => ({
    ok: false,
    error: {
        code: "SESSION_REBIND_FAILED",
        message: "RouteLedger could not activate the requested session binding; the previous binding remains active.",
        details: {
            workspaceRoot: pendingRebind.workspaceRoot,
            routeledgerRoot: pendingRebind.routeledgerRoot,
            cause: cause instanceof Error ? cause.message : String(cause)
        }
    }
});
const readStringField = (input, key) => typeof input?.[key] === "string" ? input[key] : undefined;
const readDebugVersionId = (input) => readStringField(input, "versionId") ??
    readStringField(input, "targetVersionId") ??
    readStringField(input, "targetId") ??
    readStringField(input, "parentVersionId");
const readDebugPendingOperationId = (input) => readStringField(input, "pendingOperationId");
const loadMissionControlSourceModule = async () => (await import("../../ui/src/server/launcher.js"));
const resolveMissionControlRoots = (input, binding) => {
    const workspaceRootInput = typeof input.workspaceRoot === "string" && input.workspaceRoot.length > 0
        ? input.workspaceRoot
        : binding.workspaceRoot ?? binding.processCwd;
    const routeledgerRootInput = typeof input.routeledgerRoot === "string" && input.routeledgerRoot.length > 0
        ? input.routeledgerRoot
        : binding.routeledgerRoot;
    if (typeof routeledgerRootInput !== "string" || routeledgerRootInput.length === 0) {
        throw new InvalidToolInputError("Mission Control source tool 需要可解析的 routeledgerRoot；请先绑定当前 MCP server，或显式传入 routeledgerRoot。", {
            toolName: "mission_control_roots",
            path: "$.routeledgerRoot",
            expected: "absolute routeledgerRoot string or current MCP binding routeledgerRoot",
            bindingStatus: binding.status,
            workspaceRoot: workspaceRootInput,
            routeledgerRoot: binding.routeledgerRoot ?? null,
            receivedType: routeledgerRootInput === undefined ? "undefined" : typeof routeledgerRootInput,
            receivedValue: routeledgerRootInput ?? null
        });
    }
    const workspaceRoot = resolvePhysicalPathForContainmentSync(workspaceRootInput) ?? workspaceRootInput;
    const routeledgerRoot = resolvePhysicalPathForContainmentSync(routeledgerRootInput) ?? routeledgerRootInput;
    const outsideWorkspace = !isPhysicalPathContainedWithinSync(workspaceRootInput, routeledgerRootInput);
    if (outsideWorkspace) {
        throw new InvalidToolInputError("Mission Control source tool 要求 routeledgerRoot 位于 workspaceRoot 内。", {
            toolName: "mission_control_roots",
            path: "$.routeledgerRoot",
            expected: "routeledgerRoot inside workspaceRoot",
            workspaceRoot,
            routeledgerRoot,
            receivedType: "string",
            receivedValue: routeledgerRoot
        });
    }
    return {
        workspaceRoot,
        routeledgerRoot
    };
};
export const createRouteLedgerMcpRegistry = (options) => {
    const bindingConfig = {
        workspaceRoot: options.workspaceRoot,
        workspaceRootSource: options.workspaceRootSource,
        routeledgerRoot: options.routeledgerRoot,
        mcpRoots: options.mcpRoots
    };
    const initialBinding = resolveRouteLedgerBinding(bindingConfig);
    const readBinding = () => resolveRouteLedgerBinding(bindingConfig);
    const runtime = initialBinding.routeledgerRoot === null ||
        (initialBinding.status !== "bound" && initialBinding.status !== "uninitialized")
        ? null
        : createService(initialBinding.workspaceRoot ?? initialBinding.processCwd, initialBinding.routeledgerRoot, options.sqliteReadModel ?? "enabled", options.storageTestHooks, options.l3Authorization === undefined
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
            });
    const service = runtime?.service ?? null;
    const storage = runtime?.storage ?? null;
    const close = runtime?.close ?? (() => undefined);
    const debugLogger = initialBinding.routeledgerRoot === null
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
    const runtimeIdentity = {
        ...configuredRuntimeIdentity,
        // Caller-selected profile governs the executable capability surface; do not
        // let a stale injected identity misreport it after a direct registry call.
        runtimeProfile
    };
    const usesCodexNativeToolAdmission = hostProfile === "codex" &&
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
    const appendDebugLog = async (toolName, draft) => {
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
        }
        catch {
            // Debug logging is optional and must never change MCP tool semantics.
        }
    };
    const executionRequests = new Map();
    const createL3DecisionAdapter = (proposal) => {
        if (options.l3Authorization === undefined) {
            throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "This MCP connection has no trusted L3 authorization control plane", { pendingOperationId: proposal.id });
        }
        const l3Authorization = options.l3Authorization;
        const activeProfile = l3Authorization.profile;
        if (hostProfile === "codex" &&
            options.hostPermissionContext?.status === "resolved" &&
            activeProfile !== undefined &&
            activeProfile.mode !== options.hostPermissionContext.mode) {
            throw new ApplicationError("AUTHORIZATION_PROFILE_DISABLED", "The bound RouteLedger authorization profile does not match the effective Codex permission mode", {
                reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
                effectiveMode: options.hostPermissionContext.mode,
                configuredMode: activeProfile.mode,
                profileId: activeProfile.profileId
            });
        }
        if (activeProfile?.status === "disabled") {
            throw new ApplicationError("AUTHORIZATION_PROFILE_DISABLED", "The bound L3 authorization profile is disabled", { profileId: activeProfile.profileId, modeEpoch: activeProfile.modeEpoch });
        }
        const authorizationContext = {
            audience: "routeledger-core",
            subjectId: approver.id,
            projectId: proposal.projectId,
            routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot),
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
                : { clientId: l3Authorization.trustedClientId })
        };
        if (usesCodexNativeToolAdmission) {
            return new CodexL3DecisionAdapter({
                authorizationContext,
                exactStore: l3Authorization.exactStore
            });
        }
        return new ExistingL3DecisionAdapter({
            proposal,
            authorizationContext,
            exactStore: l3Authorization.exactStore,
            interaction: l3Authorization.interaction,
            hostProfile,
            ...(l3Authorization.trustedClientId === undefined
                ? {}
                : { trustedClientId: l3Authorization.trustedClientId }),
            ...(activeProfile === undefined ? {} : { profile: activeProfile }),
            ...(l3Authorization.delegatedAuthority === undefined
                ? {}
                : { delegatedAuthority: l3Authorization.delegatedAuthority }),
            getEvaluationContext: () => service.getL3AuthorizationEvaluationContext({
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
    const executeExistingL3Proposal = async (proposal, idempotencyKey) => {
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
                    if (decision.authorizationId === undefined) {
                        throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The resolved L3 decision has no exact authorization", { pendingOperationId: proposal.id, reason: "AUTHORIZATION_ID_REQUIRED" });
                    }
                    return service.authorizeL3Operation({
                        projectId: proposal.projectId,
                        pendingOperationId: proposal.id,
                        authorizationId: decision.authorizationId,
                        actor
                    });
                },
                commit: (_proposal, artifact) => service.commitL3Operation({
                    projectId: proposal.projectId,
                    pendingOperationId: proposal.id,
                    approvalArtifactId: artifact.id,
                    actor
                }),
                reject: (_proposal, denial) => service.rejectL3Operation({
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
            data: result.status === "committed"
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
    let toolDefinitions = [];
    let guardedTools = [];
    let pendingSessionRebind = null;
    const withCurrentRuntimeContextMeta = (options) => withRuntimeContextMeta({
        ...options,
        binding: readBinding(),
        hostProfile,
        runtimeIdentity
    });
    const getBlockedTools = (binding) => {
        return guardedTools
            .filter((tool) => (tool.visibility === "default" ||
            (tool.visibility === "source-only" && runtimeProfile === "full")) &&
            !isBindingToolKindAllowed(binding, tool.toolKind))
            .map((tool) => tool.definition.name);
    };
    const getRuntimeContextData = async (binding = readBinding(), requestedResponseLocale) => {
        const storageInspection = storage === null ? null : await storage.inspectRuntimeBinding();
        const activeProject = storageInspection?.activeProject ?? null;
        const resolvedResponseLocale = resolveResponseLocale(requestedResponseLocale, options.defaultResponseLocale);
        const suggestedContentLocale = suggestContentLocale(resolvedResponseLocale.requested ?? resolvedResponseLocale.resolved);
        const contentLocaleEffectiveScopes = [
            "project_setting",
            "agent_content_default",
            "write_integrity_gate"
        ];
        const contentLocale = activeProject?.contentLocale !== null && activeProject?.contentLocale !== undefined
            ? {
                status: "configured",
                configuredValue: activeProject.contentLocale,
                suggestedValue: null,
                suggestionSource: null,
                requiresUserDecision: false,
                effectiveScopes: contentLocaleEffectiveScopes
            }
            : binding.status === "uninitialized" || activeProject !== null
                ? {
                    status: "confirmation_required",
                    configuredValue: null,
                    suggestedValue: suggestedContentLocale,
                    suggestionSource: suggestedContentLocale === null ? null : "response_locale",
                    requiresUserDecision: true,
                    effectiveScopes: contentLocaleEffectiveScopes
                }
                : {
                    status: "unavailable",
                    configuredValue: null,
                    suggestedValue: null,
                    suggestionSource: null,
                    requiresUserDecision: false,
                    effectiveScopes: contentLocaleEffectiveScopes
                };
        const bindingActions = binding.status === "bound" ? [] : getBindingRecommendedNextActions(binding);
        const localeBlockedTools = activeProject?.contentLocale === null
            ? guardedTools
                .filter((tool) => tool.definition.name !== "set_project_content_locale" &&
                (tool.toolKind === "write" || tool.toolKind === "bootstrap"))
                .map((tool) => tool.definition.name)
            : [];
        const recommendedNextActions = contentLocale.status !== "confirmation_required"
            ? bindingActions
            : activeProject === null
                ? [
                    {
                        type: "confirm_content_locale",
                        proposedValue: suggestedContentLocale,
                        description: "Confirm a concrete project content_locale with the user before initialization.",
                        requiresUserDecision: true
                    },
                    ...bindingActions.map((action) => action.type === "initialize_routeledger"
                        ? {
                            ...action,
                            requiredFields: ["name", "contentLocale"],
                            blockedBy: ["content_locale_confirmation"]
                        }
                        : action)
                ]
                : [
                    {
                        type: "set_project_content_locale",
                        tool: "set_project_content_locale",
                        proposedValue: suggestedContentLocale,
                        description: "Set the existing project to the concrete content_locale confirmed by the user.",
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
                mode: binding.status === "unbound" || binding.status === "invalid"
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
    const getRuntimeContextMeta = async () => {
        const binding = readBinding();
        let activeProject = null;
        // Error reporting is best-effort: an inspection failure must not mask the
        // original tool error. When it does succeed, its identity is the only
        // source used for error runtimeContext.
        try {
            activeProject = (await storage?.inspectRuntimeBinding())?.activeProject ?? null;
        }
        catch {
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
    const attachRuntimeContextToError = async (response) => {
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
    const tools = [
        defineTool("get_runtime_context", { what: "Inspect MCP binding, active project, and storage state." }, objectSchema({}), {
            title: "Get Runtime Context",
            riskLevel: "read-only",
            toolKind: "diagnostic"
        }, async (input) => {
            const binding = readBinding();
            const runtimeContext = await getRuntimeContextData(binding, input.responseLocale);
            return {
                ok: true,
                data: runtimeContext,
                meta: withRuntimeContextMeta({
                    data: runtimeContext.activeProject === null
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
        }),
        defineTool("get_l3_authorization_status", { what: "Inspect active L3 authorization." }, objectSchema({
            detail: {
                type: "string",
                enum: ["summary", "internal"],
                description: "Use internal only for host diagnostics; summary is the product default."
            }
        }), {
            title: "Get L3 Authorization Status",
            riskLevel: "read-only"
        }, async (input) => {
            const profile = options.l3Authorization?.profile;
            const profileCompatible = options.hostPermissionContext?.status === "resolved" && profile !== undefined
                ? profile.mode === options.hostPermissionContext.mode
                : null;
            const effectiveMode = options.hostPermissionContext?.status === "resolved"
                ? {
                    mode: options.hostPermissionContext.mode,
                    source: options.hostPermissionContext.source,
                    codexPermissionProfile: options.hostPermissionContext.codexPermissionProfile,
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
                        reason: "Codex enforces the active task permission before this high-risk tool call reaches RouteLedger."
                    }
                    : options.hostPermissionContext ?? null;
            const compatibilityBackend = options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
                ? "host_authority_broker_v2"
                : usesCodexNativeToolAdmission
                    ? "exact_authorization_receipt"
                    : options.l3Authorization === undefined
                        ? "unavailable"
                        : "v1_compatibility";
            const controlPlane = options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
                ? "host_authority_broker_v2"
                : usesCodexNativeToolAdmission
                    ? "codex_native_tool_admission_v2"
                    : compatibilityBackend;
            return {
                ok: true,
                data: profile === undefined
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
                            delegatedPolicy: profile.delegatedPolicy === null
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
        }),
        defineTool("recommend_l3_authorization_profile", {
            what: "Build a conservative V3 profile candidate.",
            warning: "candidate only"
        }, objectSchema({
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
            decisionBudget: integerSchema("Maximum exact decisions allowed by the standing policy. Defaults to 16.", {
                minimum: 1,
                maximum: 100
            }),
            maxAuthorizationTtlSeconds: integerSchema("Maximum exact-authorization validity. Defaults to 3600 seconds.", {
                minimum: 30,
                maximum: 86400
            })
        }, ["projectId", "mode"]), {
            title: "Recommend L3 Authorization Profile",
            riskLevel: "read-only"
        }, async (input) => {
            const mode = input.mode;
            const now = new Date();
            const decisionBudget = input.decisionBudget ?? 16;
            const binding = {
                projectId: input.projectId,
                workspaceRootDigest: digestAuthorizationPath(initialBinding.workspaceRoot),
                routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot),
                subjectId: options.l3AuthorityCandidateIdentity?.subjectId ?? approver.id,
                hostKind: hostProfile,
                trustedClientId: options.l3AuthorityCandidateIdentity?.trustedClientId ??
                    options.l3Authorization?.trustedClientId ??
                    null
            };
            const delegatedPolicy = mode === "delegated"
                ? await service.recommendBalancedL3AuthorizationPolicy({
                    projectId: input.projectId,
                    policyId: `balanced-${input.projectId}-${Date.now()}`,
                    routeledgerRootDigest: binding.routeledgerRootDigest,
                    expiresAt: new Date(now.getTime() + (input.expiresInHours ?? 24) * 60 * 60 * 1000).toISOString(),
                    decisionBudget,
                    subjectId: approver.id,
                    hostKind: hostProfile,
                    ...(binding.trustedClientId === null
                        ? {}
                        : { clientId: binding.trustedClientId })
                })
                : null;
            const profileBase = {
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
                        "Keep credential validity and per-proposal decision budgets finite.",
                        "Treat a mode or policy-capability expansion as a new trusted-host user decision.",
                        "Install only through the host authority broker; project files and MCP tools are not authority."
                    ]
                }
            };
        }),
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
            withCurrentRuntimeContextMeta
        }),
        ...createProjectBootstrapTools({ service, actor }),
        ...createContextTools({
            service,
            actor,
            appendDebugLog,
            withCurrentRuntimeContextMeta
        }),
        defineTool("recommend_l3_authorization_policy", {
            what: "Build a bound conservative L3 policy candidate."
        }, objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            expiresInHours: integerSchema("Policy lifetime in hours. Defaults to 24.", {
                minimum: 1,
                maximum: 168
            }),
            decisionBudget: integerSchema("Maximum exact decisions per standing-policy rule. Defaults to 16.", {
                minimum: 1,
                maximum: 100
            })
        }, ["projectId"]), {
            title: "Recommend L3 Authorization Policy",
            riskLevel: "read-only"
        }, async (input) => {
            const expiresInHours = input.expiresInHours ?? 24;
            const decisionBudget = input.decisionBudget ?? 16;
            const policy = await service.recommendBalancedL3AuthorizationPolicy({
                projectId: input.projectId,
                policyId: `balanced-${input.projectId}-${Date.now()}`,
                routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot),
                expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
                decisionBudget,
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
                        "Choose credential validity and a per-proposal decision budget.",
                        "Keep shutdown, reopen, route editing, and current-pointer changes in alwaysPrompt.",
                        "Install only in a host-managed authority and inject its opaque handle at MCP startup; never save this candidate as project authority."
                    ]
                }
            };
        }),
        defineTool("list_l3_proposals", { what: "List pending and historical L3 proposals." }, objectSchema({
            projectId: stringSchema("RouteLedger project ID.")
        }, ["projectId"]), {
            title: "List L3 Proposals",
            riskLevel: "read-only"
        }, async (input) => ({
            ok: true,
            data: await service.listL3Proposals(input.projectId)
        })),
        defineTool("get_l3_proposal", { what: "Read one L3 proposal." }, objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID.")
        }, ["projectId", "pendingOperationId"]), {
            title: "Get L3 Proposal",
            riskLevel: "read-only"
        }, async (input) => ({
            ok: true,
            data: await service.getL3Proposal(input.projectId, input.pendingOperationId)
        })),
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
        defineTool("propose_l3_operation", { what: "Create a pending L3 proposal.", parameter: "actionType, targetId, and reason" }, objectSchema({
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
        }, ["projectId", "actionType", "targetId", "reason"]), {
            title: "Propose L3 Operation",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.proposeL3Operation({
                projectId: input.projectId,
                actionType: input.actionType,
                targetId: input.targetId,
                reason: input.reason,
                payload: input.payload ?? {},
                actor
            })
        })),
        defineTool("execute_l3_operation", {
            what: "Execute one exact L3 operation end to end.",
            parameter: "action, target, reason, and idempotency key",
            warning: "key reuse requires the same input"
        }, objectSchema({
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
        }, ["projectId", "actionType", "targetId", "reason", "idempotencyKey"]), {
            title: "Execute L3 Operation",
            riskLevel: "high-risk",
            destructive: true,
            idempotent: true,
            recommendedApprovalMode: "approve"
        }, async (input) => {
            if (options.l3Authorization === undefined) {
                throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "This MCP connection has no trusted L3 authorization control plane");
            }
            if (options.l3Authorization.profile?.status === "disabled") {
                throw new ApplicationError("AUTHORIZATION_PROFILE_DISABLED", "The bound L3 authorization profile is disabled", {
                    profileId: options.l3Authorization.profile.profileId,
                    modeEpoch: options.l3Authorization.profile.modeEpoch
                });
            }
            if (hostProfile === "codex" &&
                options.hostPermissionContext?.status === "resolved" &&
                options.l3Authorization.profile !== undefined &&
                options.l3Authorization.profile.mode !== options.hostPermissionContext.mode) {
                throw new ApplicationError("AUTHORIZATION_PROFILE_DISABLED", "The bound RouteLedger authorization profile does not match the effective Codex permission mode", {
                    reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
                    effectiveMode: options.hostPermissionContext.mode,
                    configuredMode: options.l3Authorization.profile.mode
                });
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
                throw new InvalidToolInputError("idempotencyKey is already bound to a different L3 execution request", {
                    toolName: "execute_l3_operation",
                    path: "$.idempotencyKey",
                    reason: "IDEMPOTENCY_KEY_REUSE_MISMATCH",
                    idempotencyKey: input.idempotencyKey
                });
            }
            let entry = existing;
            if (entry === undefined) {
                const resumeProposalId = input["__routeledgerMcpResumeProposalId"];
                const proposalId = typeof resumeProposalId === "string" && resumeProposalId.trim().length > 0
                    ? Promise.resolve(resumeProposalId)
                    : service
                        .proposeL3Operation({
                        ...exactInput,
                        actionType: input.actionType,
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
            const resumeBinding = input["__routeledgerMcpResumeBinding"];
            if (resumeBinding !== undefined &&
                (resumeBinding.proposalId !== proposal.id ||
                    resumeBinding.projectId !== proposal.projectId ||
                    resumeBinding.routeledgerRootDigest !== digestRouteLedgerRoot(initialBinding.routeledgerRoot) ||
                    resumeBinding.actionType !== proposal.actionType ||
                    resumeBinding.targetId !== proposal.targetId ||
                    resumeBinding.operationDigest !== proposal.digest.value)) {
                throw new InvalidToolInputError("requestState no longer matches the live exact proposal", {
                    toolName: "execute_l3_operation",
                    path: "$._meta.requestState",
                    reason: "REQUEST_STATE_LIVE_BINDING_MISMATCH",
                    pendingOperationId
                });
            }
            if (entry.inFlight === undefined) {
                entry.inFlight = executeExistingL3Proposal(proposal, input.idempotencyKey);
            }
            const inFlight = entry.inFlight;
            try {
                return await inFlight;
            }
            finally {
                if (entry.inFlight === inFlight)
                    delete entry.inFlight;
            }
        }),
        defineTool("approve_l3_operation", {
            what: "Authorize one pending L3 proposal.",
            parameter: "pendingOperationId",
            warning: "Codex gates this call; other hosts need trusted authority"
        }, objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID."),
            decisionRef: stringSchema("Deprecated display-only input. It is ignored and cannot create authorization.")
        }, ["projectId", "pendingOperationId"]), {
            title: "Approve L3 Operation",
            riskLevel: "high-risk"
        }, async (input) => {
            const proposal = await service.getL3Proposal(input.projectId, input.pendingOperationId);
            const adapter = createL3DecisionAdapter(proposal);
            const resolution = await adapter.resolve(createExactProposalDecisionRequest(proposal));
            if (resolution.status === "denied" &&
                "details" in resolution &&
                resolution.details.reason === "HOST_DECLINED") {
                await service.rejectL3Operation({
                    projectId: proposal.projectId,
                    pendingOperationId: proposal.id,
                    reason: `${resolution.code}: ${resolution.reason}`,
                    actor
                });
            }
            const decision = requireResolvedExistingL3Decision(resolution);
            if (decision.authorizationId === undefined) {
                throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The resolved L3 decision has no exact authorization", { pendingOperationId: proposal.id, reason: "AUTHORIZATION_ID_REQUIRED" });
            }
            return {
                ok: true,
                data: await service.authorizeL3Operation({
                    projectId: input.projectId,
                    pendingOperationId: input.pendingOperationId,
                    authorizationId: decision.authorizationId,
                    actor
                })
            };
        }),
        defineTool("commit_l3_operation", { what: "Commit an approved L3 proposal.", parameter: "pendingOperationId and approvalArtifactId", warning: "consumes once; exact retries replay" }, objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID."),
            approvalArtifactId: stringSchema("Approval artifact ID."),
            confirm: booleanSchema("Legacy boolean confirmation input. RouteLedger ignores confirm=true without an approval artifact.")
        }, ["projectId", "pendingOperationId", "approvalArtifactId"]), {
            title: "Commit L3 Operation",
            riskLevel: "high-risk",
            destructive: true,
            recommendedApprovalMode: "approve"
        }, async (input) => {
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
        }),
        defineTool("reject_l3_operation", { what: "Reject a pending L3 proposal.", warning: "requires a host decision" }, objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID."),
            reason: stringSchema("Rejection reason.")
        }, ["projectId", "pendingOperationId", "reason"]), {
            title: "Reject L3 Operation",
            riskLevel: "high-risk"
        }, async (input) => ({
            ok: true,
            data: await service.rejectL3Operation({
                projectId: input.projectId,
                pendingOperationId: input.pendingOperationId,
                reason: input.reason,
                actor
            })
        }))
    ];
    guardedTools = tools.map((tool) => {
        return {
            ...tool,
            handler: async (input) => {
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
                            code: preflight.failure.code,
                            message: preflight.failure.message,
                            details: preflight.failure.details
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
    const callableTools = guardedTools.filter((tool) => tool.visibility !== "source-only" ||
        runtimeProfile === "full");
    const registeredTools = callableTools.filter((tool) => tool.visibility === "default" ||
        (tool.visibility === "source-only" && runtimeProfile === "full"));
    const handlers = new Map(callableTools.map((tool) => [tool.definition.name, tool.handler]));
    toolDefinitions = registeredTools
        .map((tool) => tool.definition);
    let reboundRegistry = null;
    const createActivationSuccessResponse = async (pendingRebind) => {
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
                data: runtimeContext.activeProject === null
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
    const activatePendingRebindForDirectRegistry = async () => {
        if (options.deferSessionRebind || pendingSessionRebind === null) {
            return null;
        }
        const nextBinding = pendingSessionRebind;
        let nextRegistry;
        try {
            nextRegistry = createRouteLedgerMcpRegistry({
                ...options,
                workspaceRoot: nextBinding.workspaceRoot,
                workspaceRootSource: "explicit_arg",
                routeledgerRoot: nextBinding.routeledgerRoot,
                mcpRoots: undefined,
                deferSessionRebind: false
            });
        }
        catch (error) {
            return createSessionRebindFailureResponse(nextBinding, error);
        }
        let activationResponse;
        try {
            activationResponse = await nextRegistry.createActivationSuccessResponse(nextBinding);
        }
        catch (error) {
            try {
                nextRegistry.close();
            }
            catch {
                // The original registry remains active; candidate cleanup cannot change that.
            }
            return createSessionRebindFailureResponse(nextBinding, error);
        }
        const previousReboundRegistry = reboundRegistry;
        reboundRegistry = nextRegistry;
        pendingSessionRebind = null;
        try {
            previousReboundRegistry?.close();
        }
        catch {
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
            const responseLocale = resolveResponseLocale(input?.responseLocale, options.defaultResponseLocale);
            const handler = handlers.get(toolName);
            if (handler === undefined) {
                return localizeToolResponse(await attachRuntimeContextToError({
                    ok: false,
                    error: {
                        code: "ACTION_NOT_IMPLEMENTED",
                        message: `unknown tool ${toolName}`
                    }
                }), responseLocale, toolName);
            }
            try {
                const response = await handler(input);
                const activationResponse = toolName === "activate_routeledger_binding"
                    ? await activatePendingRebindForDirectRegistry()
                    : null;
                return localizeToolResponse(await attachRuntimeContextToError(activationResponse ?? response), responseLocale, toolName);
            }
            catch (error) {
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
                return localizeToolResponse(await attachRuntimeContextToError(response), responseLocale, toolName);
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
