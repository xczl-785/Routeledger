import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ApplicationError, DomainError, RouteLedgerService } from "../../core/src/index.js";
import { WorkspaceDocumentSource } from "../../json/src/index.js";
import { JsonFirstStorageAdapter, JsonFirstStorageError } from "./json-first-storage.js";
import { discoverRouteLedgerRoots, planRouteLedgerBinding, renderHostBindingConfig, writeHostBindingConfig } from "./binding-assist.js";
import { runBindingPreflight, getBindingRecommendedNextActions, isBindingToolKindAllowed } from "./binding-preflight.js";
import { resolveRouteLedgerBinding } from "./binding.js";
import { isPhysicalPathContainedWithinSync, resolvePhysicalPathForContainmentSync } from "./physical-path.js";
import { RouteLedgerDebugLogger } from "./debug-log.js";
import { InvalidToolInputError } from "./input-adapter.js";
import { resolveInteractionProfile } from "./interaction-profile.js";
import { resolveRuntimeIdentity } from "./runtime-identity.js";
import { normalizeAgentToolResponse } from "./agent-response.js";
import { applyAgentResponseDetail, parseAgentResponseDetail } from "./response-detail.js";
import { defineTool } from "./registry/tool-contract.js";
import { buildMissionControlRuntimeContext, buildMissionControlRuntimeContextError, buildUnavailableMissionControlRuntimeContext, createMissionControlTools } from "./capabilities/mission-control-tools.js";
import { createContextTools } from "./capabilities/context-tools.js";
import { createWorkTools } from "./capabilities/work-tools.js";
import { createBindingAssistTools, createProjectBootstrapTools } from "./capabilities/binding-tools.js";
import { createVersionMutationTools, createVersionWorkflowTools } from "./capabilities/version-tools.js";
import { createL3AuthorizationTools, createL3OperationTools, createL3ProposalTools } from "./capabilities/l3-tools.js";
import { validateValueAgainstSchema } from "./schema-validation.js";
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
const CODEX_HOST_AUTHORITY = {
    id: "codex-host-authority",
    type: "system",
    displayName: "Codex host admission"
};
const serverCapabilities = {
    tools: {
        listChanged: false
    }
};
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
const publicToolOutputSchema = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        data: {},
        error: {
            type: "object",
            properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: { type: "object", additionalProperties: true }
            },
            required: ["code", "message"],
            additionalProperties: false
        },
        meta: { type: "object", additionalProperties: true }
    },
    required: ["ok"],
    additionalProperties: false
};
export const createCompositeTool = (name, title, what, branches, options) => {
    const branchByAction = new Map(branches.map((branch) => [branch.action, branch.tool]));
    const inputSchema = {
        oneOf: branches.map(({ action, tool }) => {
            const schema = tool.definition.inputSchema;
            const properties = schema.properties !== null && typeof schema.properties === "object"
                ? schema.properties
                : {};
            const required = Array.isArray(schema.required)
                ? schema.required.filter((item) => typeof item === "string")
                : [];
            return {
                ...schema,
                properties: {
                    operation: {
                        type: "string",
                        const: action,
                        description: `Select the ${action} workflow.`
                    },
                    ...properties
                },
                required: ["operation", ...required]
            };
        })
    };
    return defineTool(name, { what, parameter: "operation and the selected workflow fields" }, inputSchema, { ...options, title, outputSchema: publicToolOutputSchema }, async (input) => {
        const branch = branchByAction.get(input.operation);
        if (branch === undefined) {
            throw new InvalidToolInputError(`Unknown ${name} operation`, {
                toolName: name,
                path: "$.operation",
                expected: branches.map((item) => item.action)
            });
        }
        const forwardedInput = { ...input };
        delete forwardedInput.operation;
        const branchOutput = await branch.handler(forwardedInput);
        if (branch.definition.outputSchema !== undefined) {
            const issues = validateValueAgainstSchema(branch.definition.outputSchema, branchOutput);
            if (issues.length > 0) {
                return {
                    ok: false,
                    error: {
                        code: "INVALID_TOOL_OUTPUT",
                        message: "Selected operation output did not match its internal outputSchema.",
                        details: { path: issues[0]?.path ?? "$", issues }
                    }
                };
            }
        }
        return normalizeAgentToolResponse(branchOutput, branch.definition.name);
    });
};
const renameTool = (tool, name, title, description) => ({
    ...tool,
    definition: {
        ...tool.definition,
        name,
        title,
        description,
        outputSchema: publicToolOutputSchema,
        annotations: { ...tool.definition.annotations, title }
    }
});
const createInstructions = (options) => {
    const hostLabel = HOST_PROFILE_LABELS[options.hostProfile];
    const actorLabel = options.actor.displayName ?? options.actor.id;
    const approverLabel = options.approver.displayName ?? options.approver.id;
    return [
        "RouteLedger manages one bound Project and advances its work through an ordered Route of Versions.",
        "First-use concepts: (1) Bound Project Context; (2) Route and Current Version; (3) Version Lifecycle; (4) Work Classification; (5) Gates and Blockers; (6) Next Action Contract.",
        "Bound Project Context identifies the Project this server can operate; Route is its ordered Version plan, and Current Version is the stage to advance now.",
        "The normal Version lifecycle is wait -> ready -> running -> complete -> close: complete means implementation is finished; close means closeout and residual work are settled. Explain suspend, reopen, shutdown, nesting, and reordering only when that scenario appears.",
        "Work Classification is simple: Todo is work now, Deferred is work reviewed at a named future Version, and Constraint is a rule that must remain true.",
        "A gate decides whether a transition is allowed; blockers explain why it is not. Start and close gates may have different blockers.",
        "Use inspect_route_progress with operation=next_action as the navigation source. Use the returned recommendedTool and exact toolInput instead of reconstructing the state machine.",
        "The Next Action Contract also states when a decision or host admission is required. Never infer executable authorization from ordinary chat or project files.",
        "After a timeout, conflict, or unknown result, reread current state and next_action before any retry; do not blindly repeat a write.",
        "Before route operations, call inspect_runtime with operation=runtime to verify workspaceRoot and routeledgerRoot.",
        "On the first RouteLedger interaction in a task, inspect inspect_runtime.missionControl and surface the Mission Control decision once. Use the project's contentLocale when paraphrasing the stable English notice. If it requires a user decision, wait for explicit confirmation before calling manage_mission_control with operation=open; declining UI must never block route work.",
        "If binding is missing, invalid, or low-confidence, use inspect_runtime to discover and plan the target, then call configure_binding; never treat the MCP process cwd as an initialization target.",
        "Use inspect_route_progress for current context, next actions, document drift, and closeout planning; use inspect_versions for version lists, structure, gates, and transition guidance; use inspect_l3_route_operations for L3 authorization and proposal state.",
        "Use detail=compact for routine Agent action loops, standard for the compatibility response, and audit only when complete diagnostic or authorization material is required. Compact responses report omittedSections and preserve executable next actions plus exact L3 identifiers and digests.",
        "Use manage_todo, manage_deferred, and manage_constraint for current work. Legacy Undo records remain audit-only and are available only through inspect_route_progress when explicitly requested.",
        "Write tools update RouteLedger state through RouteLedgerService and never bypass the shared service boundary.",
        "Disclose closeout, Deferred review, exceptional Version states, route structure, and L3 proposal details only when the matching blocker or Next Action appears; keep recovery and audit implementation details out of routine first-use guidance.",
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
const createService = (workspaceRoot, routeledgerRoot, sqliteReadModel, storageTestHooks, authorization) => {
    const storage = new JsonFirstStorageAdapter({
        workspaceRoot,
        routeledgerRoot,
        sqliteReadModel,
        testHooks: storageTestHooks
    });
    const service = new RouteLedgerService({
        storage,
        documentSource: new WorkspaceDocumentSource({ workspaceRoot }),
        ...(authorization === undefined
            ? {}
            : {
                l3Authorization: {
                    exactStore: authorization.exactStore,
                    commitCoordinator: authorization.commitCoordinator,
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
    })
});
const PUBLIC_TOOL_REFERENCE_MAP = {
    get_runtime_context: { tool: "inspect_runtime", operation: "runtime" },
    discover_routeledger_roots: { tool: "inspect_runtime", operation: "discover_roots" },
    plan_routeledger_binding: { tool: "inspect_runtime", operation: "plan_binding" },
    get_mission_control_status: { tool: "inspect_runtime", operation: "mission_control_status" },
    render_host_binding_config: { tool: "inspect_runtime", operation: "plan_binding" },
    write_host_binding_config: { tool: "inspect_runtime", operation: "plan_binding" },
    activate_routeledger_binding: { tool: "configure_binding" },
    init_project: { tool: "configure_project", operation: "initialize" },
    set_project_content_locale: { tool: "configure_project", operation: "set_content_locale" },
    open_mission_control: { tool: "manage_mission_control", operation: "open" },
    stop_mission_control: { tool: "manage_mission_control", operation: "stop" },
    create_todo: { tool: "manage_todo", operation: "create" },
    close_todo: { tool: "manage_todo", operation: "close" },
    defer_work: { tool: "manage_deferred", operation: "defer" },
    review_deferred: { tool: "manage_deferred", operation: "review" },
    record_constraint: { tool: "manage_constraint", operation: "record" },
    retire_constraint: { tool: "manage_constraint", operation: "retire" },
    prepare_version: { tool: "set_version_state", operation: "prepare" },
    mark_version_complete: { tool: "set_version_state", operation: "mark_complete" },
    preflight_or_propose_version_batch: { tool: "propose_version_lifecycle_change", operation: "preflight_or_propose_version_batch" },
    batch_create_versions: { tool: "propose_version_lifecycle_change", operation: "preflight_or_propose_version_batch" },
    preview_or_propose_version_transition: { tool: "propose_version_lifecycle_change", operation: "preview_or_propose_version_transition" },
    transition_version: { tool: "propose_version_lifecycle_change", operation: "preview_or_propose_version_transition" },
    propose_version_advance: { tool: "propose_version_lifecycle_change", operation: "propose_version_advance" },
    advance_to_version: { tool: "propose_version_lifecycle_change", operation: "propose_version_advance" },
    preview_or_propose_version_close: { tool: "propose_version_lifecycle_change", operation: "preview_or_propose_version_close" },
    close_version: { tool: "propose_version_lifecycle_change", operation: "preview_or_propose_version_close" },
    propose_version_creation: { tool: "propose_version_structure_change", operation: "propose_version_creation" },
    create_version: { tool: "propose_version_structure_change", operation: "propose_version_creation" },
    propose_version_insertion: { tool: "propose_version_structure_change", operation: "propose_version_insertion" },
    insert_version: { tool: "propose_version_structure_change", operation: "propose_version_insertion" },
    propose_child_version_creation: { tool: "propose_version_structure_change", operation: "propose_child_version_creation" },
    create_child_version: { tool: "propose_version_structure_change", operation: "propose_child_version_creation" },
    propose_version_reorder: { tool: "propose_version_structure_change", operation: "propose_version_reorder" },
    reorder_versions: { tool: "propose_version_structure_change", operation: "propose_version_reorder" },
    propose_l3_operation: { tool: "propose_l3_route_change" },
    preview_or_propose_forced_version_shutdown: { tool: "execute_route_change", operation: "force_shutdown" },
    shutdown_version: { tool: "execute_route_change", operation: "force_shutdown" },
    execute_l3_operation: { tool: "execute_route_change", operation: "execute_l3_operation" },
    execute_admitted_proposal: { tool: "execute_route_change", operation: "execute_admitted_proposal" },
    approve_l3_operation: { tool: "execute_route_change", operation: "approve_l3_operation" },
    commit_l3_operation: { tool: "execute_route_change", operation: "commit_l3_operation" },
    reject_l3_operation: { tool: "execute_route_change", operation: "reject_l3_operation" }
};
const PUBLIC_TOOLS_REQUIRING_ROUTELEDGER_ROOT = new Set([
    "configure_project",
    "manage_todo",
    "manage_deferred",
    "manage_constraint",
    "set_version_state",
    "propose_version_lifecycle_change",
    "propose_version_structure_change",
    "propose_l3_route_change",
    "execute_route_change"
]);
for (const [publicTool, operations] of [
    ["inspect_route_progress", ["get_current_context", "next_action", "check_doc_drift", "summarize_version_closeout", "plan_version_closeout"]],
    ["inspect_versions", ["list_versions_window", "list_versions", "check_start_gate", "check_close_gate", "get_version_structure", "get_version_transition_guide"]],
    ["inspect_l3_route_operations", ["get_l3_authorization_status", "recommend_l3_authorization_profile", "recommend_l3_authorization_policy", "list_l3_proposals", "get_l3_proposal"]]
]) {
    for (const operation of operations) {
        PUBLIC_TOOL_REFERENCE_MAP[operation] = { tool: publicTool, operation };
    }
}
const projectPublicToolReferences = (value, expectedRouteLedgerRoot = null) => {
    if (Array.isArray(value)) {
        return value.map((item) => projectPublicToolReferences(item, expectedRouteLedgerRoot));
    }
    if (value === null || typeof value !== "object")
        return value;
    const record = Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        projectPublicToolReferences(child, expectedRouteLedgerRoot)
    ]));
    const mapped = typeof record.tool === "string" ? PUBLIC_TOOL_REFERENCE_MAP[record.tool] : undefined;
    if (mapped !== undefined) {
        record.tool = mapped.tool;
        if (mapped.operation !== undefined) {
            const carrierKeys = ["toolInput", "arguments", "input"].filter((key) => record[key] !== null && typeof record[key] === "object" && !Array.isArray(record[key]));
            for (const key of carrierKeys.length > 0 ? carrierKeys : ["toolInput"]) {
                record[key] = {
                    operation: mapped.operation,
                    ...record[key]
                };
            }
        }
    }
    const recommendedMapping = typeof record.recommendedTool === "string"
        ? PUBLIC_TOOL_REFERENCE_MAP[record.recommendedTool]
        : undefined;
    if (recommendedMapping !== undefined) {
        record.recommendedTool = recommendedMapping.tool;
        if (recommendedMapping.operation !== undefined) {
            record.toolInput = {
                operation: recommendedMapping.operation,
                ...(record.toolInput !== null &&
                    typeof record.toolInput === "object" &&
                    !Array.isArray(record.toolInput)
                    ? record.toolInput
                    : {})
            };
        }
    }
    const projectedTool = typeof record.tool === "string"
        ? record.tool
        : typeof record.recommendedTool === "string"
            ? record.recommendedTool
            : null;
    if (projectedTool !== null &&
        PUBLIC_TOOLS_REQUIRING_ROUTELEDGER_ROOT.has(projectedTool)) {
        const carrierKeys = ["toolInput", "arguments", "input"].filter((key) => record[key] !== null &&
            typeof record[key] === "object" &&
            !Array.isArray(record[key]));
        for (const key of carrierKeys.length > 0 ? carrierKeys : ["toolInput"]) {
            const carrier = record[key] ?? {};
            if (expectedRouteLedgerRoot !== null) {
                record[key] = {
                    ...carrier,
                    expectedRouteLedgerRoot: typeof carrier.expectedRouteLedgerRoot === "string"
                        ? carrier.expectedRouteLedgerRoot
                        : expectedRouteLedgerRoot
                };
            }
            else {
                record[key] = carrier;
                const bindings = Array.isArray(record.requiredRuntimeBindings)
                    ? record.requiredRuntimeBindings.filter((item) => typeof item === "string")
                    : [];
                record.requiredRuntimeBindings = [
                    ...new Set([...bindings, "expectedRouteLedgerRoot"])
                ];
            }
        }
    }
    return record;
};
const attachIdempotencyReplayGuidance = (response, input) => {
    if (!response.ok ||
        response.data === null ||
        typeof response.data !== "object" ||
        Array.isArray(response.data)) {
        return response;
    }
    const data = response.data;
    const idempotency = data.idempotency;
    const projectId = readStringField(input, "projectId");
    if (idempotency === null ||
        typeof idempotency !== "object" ||
        Array.isArray(idempotency) ||
        idempotency.replayed !== true ||
        projectId === undefined) {
        return response;
    }
    return {
        ...response,
        data: {
            ...data,
            idempotency: {
                ...idempotency,
                recommendedNextAction: {
                    type: "refresh_current_context",
                    tool: "get_current_context",
                    toolInput: { projectId }
                }
            }
        }
    };
};
const attachL3ProposalConfirmationGuidance = (response, toolName) => {
    if (toolName !== "propose_l3_route_change" ||
        !response.ok ||
        response.data === null ||
        typeof response.data !== "object" ||
        Array.isArray(response.data)) {
        return response;
    }
    const proposal = response.data;
    const digest = proposal.digest;
    const digestValue = digest !== null &&
        typeof digest === "object" &&
        !Array.isArray(digest) &&
        typeof digest.value === "string"
        ? digest.value
        : undefined;
    if (typeof proposal.id !== "string" ||
        typeof proposal.projectId !== "string" ||
        digestValue === undefined) {
        return response;
    }
    const input = {
        projectId: proposal.projectId,
        pendingOperationId: proposal.id
    };
    return {
        ...response,
        data: {
            status: "confirmation_required",
            proposalPersisted: true,
            pendingOperationId: proposal.id,
            digest: digestValue,
            proposal,
            recommendedNextActions: [
                {
                    action: "execute_if_admitted",
                    tool: "execute_admitted_proposal",
                    input: {
                        ...input,
                        expectedOperationDigest: digestValue
                    }
                },
                {
                    action: "approve",
                    tool: "approve_l3_operation",
                    input
                },
                {
                    action: "reject",
                    tool: "reject_l3_operation",
                    input,
                    requiredInputs: ["reason"]
                }
            ]
        }
    };
};
const buildPersistedProposalResponse = (error, context) => {
    if (!(error instanceof ApplicationError) ||
        error.code !== "CONFIRMATION_REQUIRED" ||
        context.toolName !== "propose_version_structure_change" ||
        error.details === undefined) {
        return null;
    }
    const proposal = error.details.proposal;
    if (proposal === null ||
        typeof proposal !== "object" ||
        Array.isArray(proposal) ||
        typeof proposal.id !== "string") {
        return null;
    }
    const pendingOperationId = proposal.id;
    const projectId = context.input.projectId;
    const nextActionInput = {
        ...(typeof projectId === "string" ? { projectId } : {}),
        pendingOperationId
    };
    return {
        ok: true,
        data: {
            status: "confirmation_required",
            proposalPersisted: true,
            pendingOperationId,
            proposal,
            ...(typeof error.details.digest === "string" ? { digest: error.details.digest } : {}),
            ...(typeof error.details.humanReviewText === "string"
                ? { humanReviewText: error.details.humanReviewText }
                : {}),
            recommendedNextActions: [
                {
                    action: "execute_if_admitted",
                    tool: "execute_route_change",
                    input: {
                        operation: "execute_admitted_proposal",
                        ...nextActionInput,
                        ...(typeof error.details.digest === "string"
                            ? { expectedOperationDigest: error.details.digest }
                            : {})
                    }
                },
                {
                    action: "approve",
                    tool: "approve_l3_operation",
                    input: nextActionInput
                },
                {
                    action: "reject",
                    tool: "reject_l3_operation",
                    input: nextActionInput,
                    requiredInputs: ["reason"]
                }
            ]
        }
    };
};
const STALE_PROPOSAL_ACTION_DESCRIPTIONS = {
    reject_stale_proposal: "Reject the stale proposal before creating a replacement.",
    refresh_context: "Refresh the current route and work context.",
    resolve_live_blocker: "Resolve the live blocker recorded in the gate difference.",
    recheck_close_gate: "Recheck the close gate against live state.",
    propose_replacement: "Create a replacement proposal only after the live gate passes."
};
const buildToolErrorRecovery = (error, context) => {
    if (error.code === "APPROVAL_ARTIFACT_DIGEST_MISMATCH" &&
        error.details?.staleProposal === true &&
        Array.isArray(error.details.recommendedNextActions)) {
        const recommendedNextActions = error.details.recommendedNextActions.flatMap((candidate) => {
            if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
                return [];
            }
            const action = candidate;
            if (typeof action.action !== "string" || typeof action.tool !== "string") {
                return [];
            }
            return [
                {
                    type: action.action,
                    tool: action.tool,
                    description: STALE_PROPOSAL_ACTION_DESCRIPTIONS[action.action] ??
                        "Follow the structured stale-proposal recovery step.",
                    ...(action.input !== null &&
                        typeof action.input === "object" &&
                        !Array.isArray(action.input)
                        ? { toolInput: action.input }
                        : {}),
                    ...(Array.isArray(action.requiredInputs) &&
                        action.requiredInputs.every((value) => typeof value === "string")
                        ? { requiredInputs: action.requiredInputs }
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
    if (error.code === "INVALID_TODO_TRANSITION" &&
        context?.toolName === "manage_todo" &&
        context.input.operation === "close" &&
        error.details?.status === "closed") {
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
                    toolInput: typeof context.input.projectId === "string"
                        ? { projectId: context.input.projectId }
                        : undefined
                }
            ]
        };
    }
    if (error.code.startsWith("DEFERRED_ROUTE_TARGET_") && context !== undefined) {
        const eligibleTargetVersions = Array.isArray(error.details?.eligibleTargetVersions)
            ? error.details.eligibleTargetVersions.filter((candidate) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate))
            : [];
        const retryActions = eligibleTargetVersions.flatMap((candidate) => typeof candidate.id === "string"
            ? [
                {
                    type: "choose_legal_deferred_target",
                    tool: context.toolName,
                    description: "Retry the Deferred operation with this eligible downstream Version.",
                    toolInput: {
                        ...context.input,
                        targetReviewVersionId: candidate.id
                    }
                }
            ]
            : []);
        if (eligibleTargetVersions.length === 0) {
            const projectId = context.input.projectId;
            const deferredRetryInput = Object.fromEntries(Object.entries(context.input).filter(([key]) => key !== "targetReviewVersionId"));
            return {
                recoveryState: "downstream_version_required",
                currentState: "no_downstream_version",
                expectedState: "downstream_version",
                blockedReason: error.code,
                safeToRetry: false,
                writesPerformed: false,
                artifactConsumed: false,
                recommendedNextActions: [
                    {
                        stepId: "propose_downstream_version",
                        type: "propose_downstream_version",
                        tool: "propose_version_creation",
                        description: "Propose a downstream Version, complete its approval flow, then retry the Deferred operation with that Version ID.",
                        toolInput: {
                            operation: "propose_version_creation",
                            ...(typeof projectId === "string" ? { projectId } : {})
                        },
                        requiredInputs: ["title"]
                    },
                    {
                        stepId: "execute_downstream_version_creation",
                        dependsOn: ["propose_downstream_version"],
                        type: "execute_downstream_version_creation",
                        tool: "execute_route_change",
                        description: "After host admission, execute the persisted Version creation proposal.",
                        toolInput: {
                            operation: "execute_admitted_proposal",
                            ...(typeof projectId === "string" ? { projectId } : {})
                        },
                        inputBindings: [
                            {
                                target: "pendingOperationId",
                                sourceStep: "propose_downstream_version",
                                sourcePath: "pendingOperationId"
                            },
                            {
                                target: "expectedOperationDigest",
                                sourceStep: "propose_downstream_version",
                                sourcePath: "proposal.digest.value",
                                optional: true
                            }
                        ]
                    },
                    {
                        stepId: "retry_deferred_with_created_version",
                        dependsOn: ["execute_downstream_version_creation"],
                        type: "retry_deferred_with_created_version",
                        tool: context.toolName,
                        description: "Retry the original Deferred request with the created downstream Version ID.",
                        toolInput: deferredRetryInput,
                        inputBindings: [
                            {
                                target: "targetReviewVersionId",
                                sourceStep: "propose_downstream_version",
                                sourcePath: "proposal.targetId"
                            }
                        ]
                    }
                ]
            };
        }
        return {
            recoveryState: "retry_with_legal_target",
            currentState: "invalid_target",
            expectedState: "downstream_version",
            blockedReason: error.code,
            safeToRetry: true,
            writesPerformed: false,
            artifactConsumed: false,
            recommendedNextActions: retryActions.length > 0
                ? retryActions
                : []
        };
    }
    const isCreateVersionFailure = error.code === "INVALID_VERSION_TRANSITION" &&
        (context?.toolName === "propose_version_structure_change" ||
            (context?.toolName === "execute_route_change" &&
                context.input.operation === "execute_l3_operation" &&
                context.input.actionType === "create_version"));
    if (isCreateVersionFailure) {
        const projectId = context?.input.projectId;
        const targetId = context?.input.targetId;
        const payload = context?.input.payload !== null &&
            typeof context?.input.payload === "object" &&
            !Array.isArray(context.input.payload)
            ? context.input.payload
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
                    toolInput: typeof projectId === "string" && typeof targetId === "string"
                        ? { projectId, versionId: targetId }
                        : typeof projectId === "string"
                            ? { projectId }
                            : undefined,
                    requiredInputs: typeof targetId === "string" ? undefined : ["versionId"]
                },
                {
                    type: "retry_create_version",
                    tool: "propose_version_creation",
                    description: "Retry propose_version_creation against the current route; do not reuse a stale tail ID as the new target.",
                    toolInput: createVersionInput,
                    requiredInputs: typeof title === "string" ? undefined : ["title"]
                }
            ]
        };
    }
    return null;
};
export const toToolError = (error, context) => {
    if (error instanceof ApplicationError ||
        error instanceof DomainError ||
        error instanceof InvalidToolInputError ||
        error instanceof JsonFirstStorageError) {
        const recovery = buildToolErrorRecovery(error, context);
        const details = recovery === null
            ? error.details
            : {
                ...(error.details ?? {}),
                ...recovery
            };
        return {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                ...(details === undefined ? {} : { details })
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
    const hostProfile = options.hostProfile ?? "generic";
    const interactionProfile = resolveInteractionProfile(hostProfile, options.interactionProfile);
    const actor = resolveActor(DEFAULT_ACTOR, options.actor);
    const approver = resolveActor(hostProfile === "codex" ? CODEX_HOST_AUTHORITY : DEFAULT_APPROVER, options.approver);
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
                commitCoordinator: options.l3Authorization.commitCoordinator,
                ...(options.l3Authorization.profile === undefined
                    ? {}
                    : { profile: options.l3Authorization.profile }),
                ...(options.l3Authorization.trustedClientId === undefined
                    ? {}
                    : { clientId: options.l3Authorization.trustedClientId }),
                subjectId: approver.id,
                hostKind: hostProfile
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
    const runtimeProfile = options.runtimeProfile ?? "full";
    const configuredRuntimeIdentity = options.runtimeIdentity ?? resolveRuntimeIdentity(runtimeProfile);
    const runtimeIdentity = {
        ...configuredRuntimeIdentity,
        buildProvenance: {
            scope: "runtime_build_inputs",
            sourceTreeState: configuredRuntimeIdentity.sourceTreeState
        },
        // Caller-selected profile governs the executable capability surface; do not
        // let a stale injected identity misreport it after a direct registry call.
        runtimeProfile
    };
    const missionControlSourceLoader = options.missionControlSourceLoader ?? loadMissionControlSourceModule;
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
    const getRuntimeContextData = async (binding = readBinding()) => {
        const storageInspection = storage === null ? null : await storage.inspectRuntimeBinding();
        const activeProject = storageInspection?.activeProject ?? null;
        const suggestedContentLocale = null;
        const contentLocaleEffectiveScopes = [
            "project_setting",
            "agent_authored_project_content_default",
            "write_integrity_gate"
        ];
        const contentLocale = activeProject?.contentLocale !== null && activeProject?.contentLocale !== undefined
            ? {
                scope: "project_content_only",
                status: "configured",
                configuredValue: activeProject.contentLocale,
                suggestedValue: null,
                suggestionSource: null,
                requiresUserDecision: false,
                effectiveScopes: contentLocaleEffectiveScopes
            }
            : binding.status === "uninitialized" || activeProject !== null
                ? {
                    scope: "project_content_only",
                    status: "confirmation_required",
                    configuredValue: null,
                    suggestedValue: suggestedContentLocale,
                    suggestionSource: suggestedContentLocale === null ? null : "response_locale",
                    requiresUserDecision: true,
                    effectiveScopes: contentLocaleEffectiveScopes
                }
                : {
                    scope: "project_content_only",
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
        const missionControl = await (async () => {
            if (binding.routeledgerRoot === null || binding.workspaceRoot === null) {
                return buildUnavailableMissionControlRuntimeContext("binding_unavailable");
            }
            if (activeProject === null) {
                return buildUnavailableMissionControlRuntimeContext("project_uninitialized");
            }
            try {
                const roots = resolveMissionControlRoots({}, binding);
                const source = await missionControlSourceLoader();
                const status = await source.getMissionControlStatus({
                    workspaceRoot: roots.workspaceRoot,
                    routeledgerRoot: roots.routeledgerRoot,
                    expectedRuntimeIdentity: runtimeIdentity
                });
                return buildMissionControlRuntimeContext(status, interactionProfile);
            }
            catch (error) {
                return buildMissionControlRuntimeContextError(error);
            }
        })();
        return {
            binding: summarizeRuntimeBinding(binding),
            processCwd: binding.processCwd,
            hostProfile,
            interactionProfile,
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
                blockingIssue: storageInspection?.blockingIssue ?? null,
                conflict: storageInspection?.conflict ?? null,
                jsonError: storageInspection?.jsonError ?? null,
                sqliteError: storageInspection?.sqliteError ?? null,
                writeLock: storageInspection?.writeLock ?? null
            },
            activeProject,
            contentLocale,
            missionControl,
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
    const runtimeContextTool = defineTool("get_runtime_context", { what: "Inspect MCP binding, active project, and storage state." }, objectSchema({}), {
        title: "Get Runtime Context",
        riskLevel: "read-only",
        toolKind: "diagnostic"
    }, async () => {
        const binding = readBinding();
        const runtimeContext = await getRuntimeContextData(binding);
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
    });
    const l3AuthorizationTools = createL3AuthorizationTools(l3ToolDependencies);
    const bindingTools = createBindingAssistTools({
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
    });
    const missionControlTools = createMissionControlTools({
        readBinding,
        resolveRoots: resolveMissionControlRoots,
        loadSourceModule: missionControlSourceLoader,
        runtimeIdentity,
        withCurrentRuntimeContextMeta
    });
    const projectBootstrapTools = createProjectBootstrapTools({
        service,
        actor,
        interactionProfile
    });
    const contextTools = createContextTools({
        service,
        actor,
        appendDebugLog,
        withCurrentRuntimeContextMeta
    });
    const l3ProposalTools = createL3ProposalTools(l3ToolDependencies);
    const versionWorkflowTools = createVersionWorkflowTools({ service, actor, appendDebugLog });
    const workTools = createWorkTools({
        service,
        actor,
        appendDebugLog,
        summarizeTodoForAgent,
        summarizeDeferredForAgent,
        summarizeConstraintForAgent
    });
    const versionMutationTools = createVersionMutationTools({ service, actor, appendDebugLog });
    const l3OperationTools = createL3OperationTools(l3ToolDependencies);
    const requireTool = (items, name) => {
        const tool = items.find((item) => item.definition.name === name);
        if (tool === undefined)
            throw new Error(`Missing internal tool registration: ${name}`);
        return tool;
    };
    const tools = [
        createCompositeTool("inspect_runtime", "Inspect RouteLedger Runtime", "Inspect runtime identity, binding candidates, binding plans, or Mission Control status.", [
            { action: "runtime", tool: runtimeContextTool },
            { action: "discover_roots", tool: requireTool(bindingTools, "discover_routeledger_roots") },
            { action: "plan_binding", tool: requireTool(bindingTools, "plan_routeledger_binding") },
            { action: "mission_control_status", tool: requireTool(missionControlTools, "get_mission_control_status") }
        ], { title: "Inspect RouteLedger Runtime", riskLevel: "read-only", toolKind: "diagnostic" }),
        renameTool(requireTool(bindingTools, "activate_routeledger_binding"), "configure_binding", "Configure RouteLedger Binding", "Activate an explicit RouteLedger project binding. Switching an established binding requires explicit confirmation."),
        createCompositeTool("configure_project", "Configure RouteLedger Project", "Initialize canonical project data or set its confirmed content locale.", [
            { action: "initialize", tool: requireTool(projectBootstrapTools, "init_project") },
            { action: "set_content_locale", tool: requireTool(projectBootstrapTools, "set_project_content_locale") }
        ], { title: "Configure RouteLedger Project", riskLevel: "write", toolKind: "bootstrap" }),
        createCompositeTool("inspect_route_progress", "Inspect Route Progress", "Inspect current route context, next actions, document drift, or Version closeout progress.", [
            ...["get_current_context", "next_action", "check_doc_drift", "summarize_version_closeout", "plan_version_closeout"]
                .map((name) => ({ action: name, tool: requireTool(contextTools, name) }))
        ], { title: "Inspect Route Progress", riskLevel: "read-only" }),
        createCompositeTool("inspect_versions", "Inspect Versions", "Inspect Version lists, route structure, start and close gates, or transition guidance.", [
            ...["list_versions_window", "list_versions", "check_start_gate", "check_close_gate", "get_version_structure", "get_version_transition_guide"]
                .map((name) => ({ action: name, tool: requireTool(contextTools, name) }))
        ], { title: "Inspect Versions", riskLevel: "read-only" }),
        createCompositeTool("inspect_l3_route_operations", "Inspect L3 Route Operations", "Inspect L3 authorization state, authorization recommendations, or route-change proposals.", [
            ...l3AuthorizationTools.map((tool) => ({ action: tool.definition.name, tool })),
            ...l3ProposalTools
                .filter((tool) => tool.definition.annotations.readOnlyHint === true)
                .map((tool) => ({ action: tool.definition.name, tool }))
        ], { title: "Inspect L3 Route Operations", riskLevel: "read-only" }),
        createCompositeTool("manage_todo", "Manage Todo", "Create or close current Version work.", [
            { action: "create", tool: requireTool(workTools, "create_todo") },
            { action: "close", tool: requireTool(workTools, "close_todo") }
        ], { title: "Manage Todo", riskLevel: "write", destructive: true, idempotent: true }),
        createCompositeTool("manage_deferred", "Manage Deferred Work", "Create, convert, activate, defer again, or resolve Deferred work.", [
            { action: "defer", tool: requireTool(workTools, "defer_work") },
            { action: "review", tool: requireTool(workTools, "review_deferred") }
        ], { title: "Manage Deferred Work", riskLevel: "write", destructive: true, idempotent: true }),
        createCompositeTool("manage_constraint", "Manage Constraint", "Record or retire a project or Version constraint.", [
            { action: "record", tool: requireTool(workTools, "record_constraint") },
            { action: "retire", tool: requireTool(workTools, "retire_constraint") }
        ], { title: "Manage Constraint", riskLevel: "write", destructive: true, idempotent: true }),
        createCompositeTool("propose_version_lifecycle_change", "Propose Version Lifecycle Change", "Preview, preflight, or propose Version batch creation, transition, advance, or close lifecycle changes.", [
            ...versionWorkflowTools
                .filter((tool) => tool.definition.name !== "preview_or_propose_forced_version_shutdown")
                .map((tool) => ({ action: tool.definition.name, tool }))
        ], { title: "Propose Version Lifecycle Change", riskLevel: "write" }),
        createCompositeTool("propose_version_structure_change", "Propose Version Structure Change", "Propose creating, inserting, nesting, or reordering Versions in the route structure.", [
            ...versionMutationTools
                .filter((tool) => !["prepare_version", "mark_version_complete"].includes(tool.definition.name))
                .map((tool) => ({ action: tool.definition.name, tool }))
        ], { title: "Propose Version Structure Change", riskLevel: "write" }),
        renameTool(requireTool(l3OperationTools, "propose_l3_operation"), "propose_l3_route_change", "Propose L3 Route Change", "Create one exact L3 route-change proposal without executing or approving it."),
        createCompositeTool("set_version_state", "Set Version State", "Prepare a Version or mark its implementation complete.", [
            { action: "prepare", tool: requireTool(versionMutationTools, "prepare_version") },
            { action: "mark_complete", tool: requireTool(versionMutationTools, "mark_version_complete") }
        ], { title: "Set Version State", riskLevel: "write", destructive: true }),
        createCompositeTool("execute_route_change", "Execute Route Change", "Execute, resume, decide, commit, reject, or force-close one exact high-risk route change.", [
            { action: "force_shutdown", tool: requireTool(versionWorkflowTools, "preview_or_propose_forced_version_shutdown") },
            ...l3OperationTools
                .filter((tool) => tool.definition.name !== "propose_l3_operation")
                .map((tool) => ({ action: tool.definition.name, tool }))
        ], {
            title: "Execute Route Change",
            riskLevel: "high-risk",
            destructive: true,
            recommendedApprovalMode: "approve"
        }),
        createCompositeTool("manage_mission_control", "Manage Mission Control", "Open or stop the local read-only Mission Control Hub.", [
            { action: "open", tool: requireTool(missionControlTools, "open_mission_control") },
            { action: "stop", tool: requireTool(missionControlTools, "stop_mission_control") }
        ], { title: "Manage Mission Control", riskLevel: "write", toolKind: "diagnostic" })
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
        const postActivationPlan = await planRouteLedgerBinding({
            binding,
            workspaceRoot: pendingRebind.workspaceRoot,
            routeledgerRoot: pendingRebind.routeledgerRoot,
            hostProfile
        });
        const workspaceConfigEffect = pendingRebind.bindingPlan.checks.some((check) => check.code === "WORKSPACE_CONFIG_NOT_FOUND")
            ? "created"
            : "existing";
        const workspaceAttributesPath = path.join(path.dirname(runtimeContext.binding.workspaceConfigPath), ".gitattributes");
        const dataAttributesPath = path.join(runtimeContext.binding.routeledgerDir, ".gitattributes");
        const filesystemEffects = [
            {
                kind: "workspace_binding_config",
                path: runtimeContext.binding.workspaceConfigPath,
                effect: workspaceConfigEffect
            },
            {
                kind: "routeledger_git_attributes",
                path: workspaceAttributesPath,
                effect: pendingRebind.workspaceGitAttributesExisted ? "existing" : "created"
            }
        ];
        if (dataAttributesPath !== workspaceAttributesPath) {
            filesystemEffects.push({
                kind: "routeledger_git_attributes",
                path: dataAttributesPath,
                effect: pendingRebind.dataGitAttributesExisted ? "existing" : "created"
            });
        }
        const activatedBindingPlan = {
            ...postActivationPlan,
            status: pendingRebind.requiresInit ? "needs_init" : "ready",
            currentBinding: {
                status: runtimeContext.binding.status,
                workspaceRoot: runtimeContext.binding.workspaceRoot,
                routeledgerRoot: runtimeContext.binding.routeledgerRoot,
                workspaceConfigPath: runtimeContext.binding.workspaceConfigPath,
                dataRoot: runtimeContext.binding.dataRoot,
                routeledgerDir: runtimeContext.binding.routeledgerDir,
                jsonProjectPath: runtimeContext.binding.jsonProjectPath,
                sqliteDbPath: runtimeContext.binding.sqliteDbPath
            },
            requiresUserDecision: pendingRebind.requiresInit,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false,
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
            recommendedNextActions: pendingRebind.requiresInit
                ? [
                    {
                        type: "initialize_routeledger",
                        tool: "configure_project",
                        description: "Initialize RouteLedger at the active root after confirming the project name and content locale.",
                        requiresUserDecision: true,
                        requiredFields: ["name", "contentLocale"],
                        toolInput: { operation: "initialize" }
                    }
                ]
                : []
        };
        return {
            ok: true,
            data: {
                status: "activated",
                rebound: true,
                previousBinding: pendingRebind.previousBinding,
                activeBinding: runtimeContext.binding,
                requiresInit: pendingRebind.requiresInit,
                filesystemEffects,
                canonicalProjectCreated: false,
                bindingPlan: activatedBindingPlan
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
        interactionProfile,
        runtimeProfile,
        runtimeIdentity,
        instructions,
        getTool: (toolName) => {
            return toolDefinitions.find((tool) => tool.name === toolName);
        },
        invoke: async (toolName, input) => {
            if (reboundRegistry !== null) {
                return reboundRegistry.invoke(toolName, input);
            }
            const handler = handlers.get(toolName);
            const finalizeResponse = (response) => {
                const requestedDetail = parseAgentResponseDetail(input?.detail);
                const definition = toolDefinitions.find((tool) => tool.name === toolName);
                return applyAgentResponseDetail(response, {
                    detail: requestedDetail ?? "standard",
                    explicit: requestedDetail !== null,
                    toolName,
                    ...(typeof input?.operation === "string" ? { operation: input.operation } : {}),
                    riskLevel: definition?._meta.routeledger.riskLevel ?? "read-only"
                });
            };
            if (handler === undefined) {
                return finalizeResponse(normalizeAgentToolResponse(projectPublicToolReferences(await attachRuntimeContextToError({
                    ok: false,
                    error: {
                        code: "ACTION_NOT_IMPLEMENTED",
                        message: `unknown tool ${toolName}`
                    }
                }), readBinding().routeledgerRoot), toolName));
            }
            try {
                const response = await handler(input);
                const activationResponse = toolName === "configure_binding"
                    ? await activatePendingRebindForDirectRegistry()
                    : null;
                const responseWithReplayGuidance = attachIdempotencyReplayGuidance(attachL3ProposalConfirmationGuidance(activationResponse ?? response, toolName), input);
                return finalizeResponse(normalizeAgentToolResponse(projectPublicToolReferences(await attachRuntimeContextToError(responseWithReplayGuidance), readBinding().routeledgerRoot), toolName));
            }
            catch (error) {
                const errorContext = {
                    toolName,
                    input: input ?? {}
                };
                const persistedProposalResponse = buildPersistedProposalResponse(error, errorContext);
                const response = persistedProposalResponse ?? toToolError(error, errorContext);
                await appendDebugLog(toolName, {
                    type: persistedProposalResponse === null
                        ? "tool.failure"
                        : "tool.pending_confirmation",
                    projectId: readStringField(input, "projectId"),
                    versionId: readDebugVersionId(input),
                    pendingOperationId: readDebugPendingOperationId(input),
                    payload: {
                        ...(response.error === undefined ? {} : { error: response.error }),
                        ...(response.data === undefined ? {} : { data: response.data }),
                        inputKeys: Object.keys(input ?? {}).sort()
                    }
                });
                return finalizeResponse(normalizeAgentToolResponse(projectPublicToolReferences(await attachRuntimeContextToError(response), readBinding().routeledgerRoot), toolName));
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
