import { randomUUID } from "node:crypto";
import { ApplicationError, BATCH_CREATE_VERSIONS_MODES, BATCH_PREVIOUS_CURRENT_POLICIES, DomainError, ROUTE_OPERATION_WORKFLOW_MODES, RouteLedgerService, isBatchCreateVersionsMode, isBatchPreviousCurrentPolicy, isRouteOperationWorkflowMode } from "../../core/src/index.js";
import { JsonFirstStorageAdapter, JsonFirstStorageError } from "./json-first-storage.js";
import { discoverRouteLedgerRoots, planRouteLedgerBinding, renderHostBindingConfig, writeHostBindingConfig } from "./binding-assist.js";
import { runBindingPreflight, getBindingRecommendedNextActions, isBindingToolKindAllowed } from "./binding-preflight.js";
import { resolveRouteLedgerBinding } from "./binding.js";
import { isPhysicalPathContainedWithinSync, resolvePhysicalPathForContainmentSync } from "./physical-path.js";
import { RouteLedgerDebugLogger } from "./debug-log.js";
import { adaptCheckDocDriftInput, adaptDeferWorkInput, adaptGetCurrentContextInput, adaptListVersionsWindowInput, adaptRecordConstraintInput, adaptRetireConstraintInput, adaptReviewDeferredInput, InvalidToolInputError } from "./input-adapter.js";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = {
    name: "routeledger",
    title: "RouteLedger MCP",
    version: "0.0.0-package-prep",
    description: "Standard MCP stdio adapter for RouteLedger"
};
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
const LEGACY_HIDDEN_TOOL_NAMES = [
    "create_undo",
    "reassign_undo",
    "carry_forward_undo",
    "resolve_undo_as_downstream_input",
    "close_undo"
];
const isLegacyHiddenToolName = (value) => typeof value === "string" &&
    LEGACY_HIDDEN_TOOL_NAMES.includes(value);
const containsLegacyHiddenToolName = (value) => typeof value === "string" &&
    LEGACY_HIDDEN_TOOL_NAMES.some((toolName) => value.includes(toolName));
const isLegacyCloseoutAction = (value) => isLegacyHiddenToolName(value) || value === "close_undo_then_create_todo";
const sanitizeLegacyGateBlockersForAgent = (blockers) => (Array.isArray(blockers) ? blockers : []).map((blocker) => {
    if (typeof blocker.code !== "string" ||
        !blocker.code.includes("UNDO")) {
        return blocker;
    }
    return {
        code: "LEGACY_WORK_REQUIRES_AUDIT",
        message: "Legacy work blocks this operation; use get_current_context(projectId, includeLegacyUndo=true) for audit details.",
        recordCount: Array.isArray(blocker.recordIds)
            ? blocker.recordIds.length
            : 0
    };
});
const sanitizeVersionStructureOperationForAgent = (operation) => {
    const sanitized = structuredClone(operation);
    sanitized.blockers = sanitizeLegacyGateBlockersForAgent(sanitized.blockers);
    if (sanitized.details !== null && typeof sanitized.details === "object") {
        const details = sanitized.details;
        if (Array.isArray(details.unresolvedUndoIds)) {
            details.legacyBlockerCount = details.unresolvedUndoIds.length;
            delete details.unresolvedUndoIds;
        }
        if (details.ordinaryCloseGate !== null &&
            typeof details.ordinaryCloseGate === "object") {
            const ordinaryCloseGate = details.ordinaryCloseGate;
            if (Array.isArray(ordinaryCloseGate.unresolvedUndoIds)) {
                ordinaryCloseGate.legacyBlockerCount =
                    ordinaryCloseGate.unresolvedUndoIds.length;
                delete ordinaryCloseGate.unresolvedUndoIds;
            }
            if (Array.isArray(ordinaryCloseGate.blockerCodes)) {
                ordinaryCloseGate.blockerCodes = [
                    ...new Set(ordinaryCloseGate.blockerCodes.map((code) => typeof code === "string" && code.includes("UNDO")
                        ? "LEGACY_WORK_REQUIRES_AUDIT"
                        : code))
                ];
            }
        }
    }
    return sanitized;
};
const sanitizeCloseoutAlternatives = (alternatives) => {
    if (!Array.isArray(alternatives)) {
        return [];
    }
    const sanitized = alternatives.map((alternative) => {
        const record = alternative;
        if (!isLegacyCloseoutAction(record.actionType) &&
            !isLegacyHiddenToolName(record.recommendedTool)) {
            return structuredClone(record);
        }
        return {
            ...structuredClone(record),
            actionType: "review_context",
            recommendedTool: "get_current_context",
            summary: "Review the legacy audit record before choosing a product-semantic route.",
            reason: "This historical record is audit-only; decide whether it becomes Todo, Deferred, Constraint, or a resolved outcome."
        };
    });
    const seen = new Set();
    return sanitized.filter((alternative) => {
        const key = `${String(alternative.actionType)}:${String(alternative.recommendedTool)}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};
const sanitizeCloseoutSummaryForAgent = (summary) => {
    const sanitized = structuredClone(summary);
    const nextAction = sanitized.nextAction;
    if (nextAction !== undefined &&
        (isLegacyCloseoutAction(nextAction.actionType) ||
            isLegacyHiddenToolName(nextAction.recommendedTool))) {
        sanitized.nextAction = {
            ...nextAction,
            actionType: "review_context",
            recommendedTool: "get_current_context",
            summary: "Review the legacy audit record before continuing closeout.",
            reason: "Use audit context to classify the historical record as Todo, Deferred, Constraint, or resolved.",
            requiresL3Approval: false
        };
    }
    if (Array.isArray(sanitized.selfReferentialUndos)) {
        sanitized.selfReferentialUndos = sanitized.selfReferentialUndos.map((entry) => ({
            ...entry,
            ...(isLegacyCloseoutAction(entry.recommendedResolution)
                ? {
                    recommendedResolution: "manual_review",
                    reason: "This historical record needs an audit-only product-semantic decision.",
                    note: "Review it as Todo, Deferred, Constraint, or a resolved outcome."
                }
                : {}),
            alternatives: sanitizeCloseoutAlternatives(entry.alternatives)
        }));
    }
    return sanitized;
};
const sanitizeGeneratedCloseoutText = (value) => containsLegacyHiddenToolName(value)
    ? "Review the legacy audit record before choosing a product-semantic route."
    : value;
const sanitizeCloseoutPlanForAgent = (plan) => {
    const sanitized = structuredClone(plan);
    sanitized.summary = sanitizeCloseoutSummaryForAgent(sanitized.summary);
    const seenLegacyTargets = new Set();
    const legacyAuditRequiredInputs = [
        {
            field: "projectId",
            value: sanitized.projectId
        },
        {
            field: "includeLegacyUndo",
            value: true
        }
    ];
    sanitized.steps = (Array.isArray(sanitized.steps) ? sanitized.steps : [])
        .map((step) => {
        const legacyStep = isLegacyCloseoutAction(step.kind) ||
            isLegacyHiddenToolName(step.recommendedTool);
        const mapped = legacyStep
            ? {
                ...step,
                kind: "review_self_referential_undo",
                recommendedTool: "get_current_context",
                governanceLayer: "manual",
                requiresL3Approval: false,
                writesRouteState: false,
                requiredInputs: structuredClone(legacyAuditRequiredInputs),
                summary: "Review the legacy audit record before choosing a product-semantic route.",
                reason: "This historical record is audit-only and cannot recommend a hidden write tool."
            }
            : { ...step };
        mapped.recommendedTool = isLegacyHiddenToolName(mapped.recommendedTool)
            ? "get_current_context"
            : mapped.recommendedTool;
        mapped.reason = sanitizeGeneratedCloseoutText(mapped.reason);
        mapped.summary = sanitizeGeneratedCloseoutText(mapped.summary);
        mapped.warnings = Array.isArray(mapped.warnings)
            ? mapped.warnings.map(sanitizeGeneratedCloseoutText)
            : mapped.warnings;
        mapped.alternatives = sanitizeCloseoutAlternatives(mapped.alternatives);
        mapped.unlockPaths = (Array.isArray(mapped.unlockPaths)
            ? mapped.unlockPaths
            : []).map((path) => isLegacyCloseoutAction(path.actionType) ||
            isLegacyHiddenToolName(path.recommendedTool)
            ? {
                ...path,
                actionType: "review_context",
                recommendedTool: "get_current_context",
                governanceLayer: "manual",
                requiresL3Approval: false,
                requiredInputs: structuredClone(legacyAuditRequiredInputs),
                summary: "Review the legacy audit record before choosing a product-semantic route."
            }
            : path);
        return mapped;
    })
        .filter((step) => {
        if (step.kind !== "review_self_referential_undo") {
            return true;
        }
        const targetKey = String(step.targetId ?? "legacy");
        if (seenLegacyTargets.has(targetKey)) {
            return false;
        }
        seenLegacyTargets.add(targetKey);
        return true;
    });
    sanitized.warnings = Array.isArray(sanitized.warnings)
        ? sanitized.warnings.map(sanitizeGeneratedCloseoutText)
        : sanitized.warnings;
    return sanitized;
};
const sanitizeVersionStructureForAgent = (structure) => {
    const sanitized = structuredClone(structure);
    const operations = Array.isArray(sanitized.legalOperations)
        ? sanitized.legalOperations
        : [];
    const hasLegacyOperations = operations.some((operation) => isLegacyHiddenToolName(operation.actionType));
    const openUndos = sanitized.openUndos !== null &&
        typeof sanitized.openUndos === "object"
        ? sanitized.openUndos
        : {};
    const legacyRecordIds = new Set(["owned", "origin", "preferredResolution"].flatMap((field) => Array.isArray(openUndos[field])
        ? openUndos[field]
            .map((record) => record.id)
            .filter((id) => typeof id === "string")
        : []));
    delete sanitized.openUndos;
    sanitized.legalOperations = operations
        .filter((operation) => !isLegacyHiddenToolName(operation.actionType))
        .map(sanitizeVersionStructureOperationForAgent);
    if (hasLegacyOperations &&
        legacyRecordIds.size > 0 &&
        !sanitized.legalOperations.some((operation) => operation.actionType === "review_context")) {
        sanitized.legalOperations.push({
            actionType: "review_context",
            allowed: true,
            summary: "Review legacy audit records before choosing Todo, Deferred, Constraint, or a resolved outcome.",
            blockers: []
        });
    }
    if (legacyRecordIds.size > 0) {
        sanitized.legacyAudit = {
            required: true,
            recordCount: legacyRecordIds.size,
            guidance: "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
        };
    }
    return sanitized;
};
const sanitizeDocDriftForAgent = (result) => {
    const sanitized = structuredClone(result);
    const routeTruth = sanitized.routeTruth !== null && typeof sanitized.routeTruth === "object"
        ? sanitized.routeTruth
        : {};
    const openUndoCount = typeof routeTruth.openUndoCount === "number"
        ? routeTruth.openUndoCount
        : 0;
    delete routeTruth.openUndoCount;
    routeTruth.legacyBlockerCount = openUndoCount;
    const hasLegacyRisk = openUndoCount > 0 ||
        (Array.isArray(routeTruth.statusRiskCodes) &&
            routeTruth.statusRiskCodes.includes("OPEN_UNDOS_BLOCK_CLOSE"));
    if (Array.isArray(routeTruth.statusRiskCodes)) {
        const statusRiskCodes = routeTruth.statusRiskCodes.map((code) => code === "OPEN_UNDOS_BLOCK_CLOSE"
            ? "LEGACY_BLOCKERS_REQUIRE_AUDIT"
            : code);
        if (openUndoCount > 0) {
            statusRiskCodes.push("LEGACY_BLOCKERS_REQUIRE_AUDIT");
        }
        routeTruth.statusRiskCodes = [...new Set(statusRiskCodes)];
    }
    sanitized.routeTruth = routeTruth;
    if (Array.isArray(sanitized.warnings)) {
        sanitized.warnings = sanitized.warnings.map((warning) => warning.code === "OPEN_UNDOS_BLOCK_CLOSE"
            ? {
                ...warning,
                code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
                summary: "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
            }
            : warning);
    }
    if (hasLegacyRisk && Array.isArray(sanitized.warnings)) {
        const hasLegacyAuditWarning = sanitized.warnings.some((warning) => warning.code === "LEGACY_BLOCKERS_REQUIRE_AUDIT");
        if (!hasLegacyAuditWarning) {
            sanitized.warnings.push({
                code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
                severity: "blocking",
                file: null,
                summary: "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
            });
        }
    }
    if (openUndoCount > 0 || hasLegacyRisk) {
        sanitized.legacyAudit = {
            required: true,
            guidance: "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
        };
    }
    if (typeof sanitized.summaryText === "string") {
        sanitized.summaryText = sanitized.summaryText.replace(/Route truth shows (\d+) open todos, \d+ open undos, and (\d+) pending proposals on the current route\./, "Route truth shows $1 open todos and $2 pending proposals on the current route.");
    }
    return sanitized;
};
const objectSchema = (properties, required = [], extra = {}) => ({
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    ...extra
});
const residualAuditItemSchema = objectSchema({
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
                enum: ["close", "create_todo", "defer_work", "record_constraint"]
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
}, ["kind", "summary", "destination"]);
const residualAuditArraySchema = {
    type: "array",
    description: "Residual audit items used by close gate and close-version L3 proposals.",
    items: residualAuditItemSchema
};
const payloadSchema = objectSchema({
    currentVersionId: {
        anyOf: [
            stringSchema("Optional current version override."),
            {
                type: "null"
            }
        ]
    },
    residualAudit: {
        anyOf: [
            residualAuditArraySchema,
            {
                type: "null"
            }
        ]
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
const batchCreateVersionsItemSchema = objectSchema({
    clientKey: stringSchema("Stable client-side key for this planned version."),
    title: stringSchema("Version title."),
    description: stringSchema("Version description. Field is required; use an empty string when there is no extra detail."),
    initialTodos: {
        type: "array",
        description: "Initial todo titles created atomically with this version. Field is required and may be an empty array.",
        items: stringSchema("Todo title.")
    }
}, ["clientKey", "title", "description", "initialTodos"]);
const docDriftExpectedPointerSchema = objectSchema({
    kind: stringSchema("Pointer kind label used by the caller."),
    path: stringSchema("Expected repo-relative pointer path."),
    required: booleanSchema("Defaults to true. Set false to make this pointer advisory only.")
}, ["kind", "path"]);
const approvalModeForRisk = (riskLevel) => {
    switch (riskLevel) {
        case "read-only":
            return "auto";
        case "write":
        case "high-risk":
            return "prompt";
        default: {
            const exhaustiveRiskLevel = riskLevel;
            return exhaustiveRiskLevel;
        }
    }
};
const createToolMetadata = (options) => {
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
                recommendedApprovalMode: options.recommendedApprovalMode ?? approvalModeForRisk(options.riskLevel)
            }
        }
    };
};
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
        "L3 route changes are always proposal-based: call propose_l3_operation first, then approve_l3_operation or reject_l3_operation, and only then commit_l3_operation with a valid approval artifact.",
        "Business failures such as CONFIRMATION_REQUIRED are returned as tool-level isError results, not JSON-RPC protocol errors.",
        "High-risk tools are shutdown_version, approve_l3_operation, reject_l3_operation, and commit_l3_operation. shutdown_version is an emergency forced-close proposal path. approve_l3_operation and reject_l3_operation should prompt; commit_l3_operation is destructive and should require explicit human approval in the host.",
        `Current host profile: ${hostLabel}. Default actor: ${actorLabel}. Default approver: ${approverLabel}.`
    ].join(" ");
};
const resolveActor = (baseActor, override) => ({
    ...baseActor,
    id: override?.id ?? baseActor.id,
    displayName: override?.displayName ?? baseActor.displayName
});
const createService = (workspaceRoot, routeledgerRoot, sqliteReadModel, storageTestHooks) => {
    const storage = new JsonFirstStorageAdapter({
        workspaceRoot,
        routeledgerRoot,
        sqliteReadModel,
        testHooks: storageTestHooks
    });
    const service = new RouteLedgerService({
        storage,
        projectRoot: workspaceRoot,
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
    const project = options.data !== null &&
        typeof options.data === "object" &&
        "project" in options.data &&
        options.data.project !== null &&
        typeof options.data.project === "object"
        ? options.data.project
        : null;
    return {
        binding: {
            status: options.binding.status,
            workspaceRoot: options.binding.workspaceRoot,
            workspaceRootSource: options.binding.workspaceRootSource,
            workspaceRootConfidence: options.binding.workspaceRootConfidence,
            routeledgerRoot: options.binding.routeledgerRoot,
            workspaceConfigPath: options.binding.workspaceConfigPath,
            dataRoot: options.binding.dataRoot,
            routeledgerDir: options.binding.routeledgerDir
        },
        dataRoot: options.binding.dataRoot,
        routeledgerDir: options.binding.routeledgerDir,
        workspaceConfigPath: options.binding.workspaceConfigPath,
        jsonProjectPath: options.binding.jsonProjectPath,
        sqliteDbPath: options.binding.sqliteDbPath,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        hostProfile: options.hostProfile,
        serverWorkspaceRoot: options.binding.workspaceRoot,
        serverRouteLedgerRoot: options.binding.routeledgerRoot,
        processCwd: options.binding.processCwd
    };
};
const withRuntimeContextMeta = (options) => ({
    ...(options.meta ?? {}),
    runtimeContext: buildRuntimeContext({
        binding: options.binding,
        hostProfile: options.hostProfile,
        data: options.data
    })
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
const readStringField = (input, key) => typeof input?.[key] === "string" ? input[key] : undefined;
const readDebugVersionId = (input) => readStringField(input, "versionId") ??
    readStringField(input, "targetVersionId") ??
    readStringField(input, "targetId") ??
    readStringField(input, "parentVersionId");
const readDebugPendingOperationId = (input) => readStringField(input, "pendingOperationId");
const parseBatchCreateVersionsMode = (value) => {
    if (isBatchCreateVersionsMode(value)) {
        return value;
    }
    throw new ApplicationError("BATCH_CREATE_VERSIONS_MODE_INVALID", "batch_create_versions mode 仅支持 preflight 或 propose", {
        receivedMode: value ?? null,
        allowedModes: [...BATCH_CREATE_VERSIONS_MODES]
    });
};
const parseBatchPreviousCurrentPolicy = (value) => {
    if (value === undefined) {
        return undefined;
    }
    if (isBatchPreviousCurrentPolicy(value)) {
        return value;
    }
    throw new ApplicationError("BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID", "batch_create_versions previousCurrentPolicy 仅支持 leave_as_is 或 require_complete_or_close", {
        receivedPreviousCurrentPolicy: value ?? null,
        allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    });
};
const parseRouteOperationWorkflowMode = (value) => {
    if (value === undefined) {
        return undefined;
    }
    if (isRouteOperationWorkflowMode(value)) {
        return value;
    }
    throw new ApplicationError("ROUTE_OPERATION_WORKFLOW_MODE_INVALID", "workflow mode 仅支持 dry_run 或 propose", {
        receivedMode: value ?? null,
        allowedModes: [...ROUTE_OPERATION_WORKFLOW_MODES]
    });
};
const isErrnoException = (error) => error instanceof Error && "code" in error;
const loadMissionControlSourceModule = async () => {
    try {
        return (await import("../../ui/src/server/launcher.js"));
    }
    catch (error) {
        if (isErrnoException(error) && error.code === "ERR_MODULE_NOT_FOUND") {
            throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "Mission Control source-mode tools 需要 RouteLedger 源码工作区；当前安装包 artifact 不提供该入口。", {
                modulePath: "../../ui/src/server/launcher.js"
            });
        }
        throw error;
    }
};
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
const expectedRouteLedgerRootSchema = stringSchema("Absolute routeledgerRoot assertion for write/high-risk tools. It must exactly match the MCP server routeledgerRoot.");
const withExpectedRouteLedgerRootInputSchema = (inputSchema, riskLevel) => {
    if (riskLevel === "read-only") {
        return inputSchema;
    }
    const properties = inputSchema.properties !== null && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : {};
    return {
        ...inputSchema,
        properties: {
            ...properties,
            expectedRouteLedgerRoot: expectedRouteLedgerRootSchema
        }
    };
};
const defineTool = (name, description, inputSchema, options, handler) => ({
    definition: {
        name,
        description,
        inputSchema: withExpectedRouteLedgerRootInputSchema(inputSchema, options.riskLevel),
        ...createToolMetadata(options)
    },
    toolKind: options.toolKind ??
        (options.riskLevel === "read-only" ? "read" : "write"),
    visibility: options.visibility ?? "default",
    handler
});
const withInputAdapter = (adapter, handler) => async (input) => handler(adapter(input));
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
        : createService(initialBinding.workspaceRoot ?? initialBinding.processCwd, initialBinding.routeledgerRoot, options.sqliteReadModel ?? "enabled", options.storageTestHooks);
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
        hostProfile
    });
    const getBlockedTools = (binding) => {
        return guardedTools
            .filter((tool) => !isBindingToolKindAllowed(binding, tool.toolKind))
            .map((tool) => tool.definition.name);
    };
    const getRuntimeContextData = async (binding = readBinding()) => {
        const storageInspection = storage === null ? null : await storage.inspectRuntimeBinding();
        const activeProject = storageInspection?.activeProject ?? null;
        return {
            binding: {
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
            },
            processCwd: binding.processCwd,
            hostProfile,
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
            blockedTools: getBlockedTools(binding),
            recommendedNextActions: binding.status === "bound" ? [] : getBindingRecommendedNextActions(binding)
        };
    };
    const tools = [
        defineTool("get_runtime_context", "Inspect the current MCP runtime binding and storage state without rebuilding read models or mutating canonical RouteLedger data.", objectSchema({}), {
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
                    hostProfile
                })
            };
        }),
        defineTool("discover_routeledger_roots", "Scan an explicit or trusted workspaceRoot for .routeledger candidates without modifying data or switching the active MCP binding.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd.")
        }), {
            title: "Discover RouteLedger Roots",
            riskLevel: "read-only",
            toolKind: "discovery"
        }, async (input) => ({
            ok: true,
            data: await discoverRouteLedgerRoots({
                workspaceRoot: input.workspaceRoot ??
                    (readBinding().workspaceRootConfidence === "low" ||
                        readBinding().workspaceRootConfidence === "none"
                        ? undefined
                        : readBinding().workspaceRoot ?? undefined)
            }),
            meta: withCurrentRuntimeContextMeta({ data: null })
        })),
        defineTool("plan_routeledger_binding", "Generate a read-only binding plan for an explicit workspaceRoot and/or routeledgerRoot.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd."),
            routeledgerRoot: stringSchema("Optional absolute routeledgerRoot to plan. When omitted, the tool uses the current binding or a discovered single candidate.")
        }), {
            title: "Plan RouteLedger Binding",
            riskLevel: "read-only",
            toolKind: "planning"
        }, async (input) => ({
            ok: true,
            data: await planRouteLedgerBinding({
                binding: readBinding(),
                workspaceRoot: input.workspaceRoot,
                routeledgerRoot: input.routeledgerRoot
            }),
            meta: withCurrentRuntimeContextMeta({ data: null })
        })),
        defineTool("activate_routeledger_binding", "Prompt before explicitly activating one workspaceRoot + routeledgerRoot for this MCP stdio session. It may create or normalize .routeledger/config.json for that explicit binding, never creates canonical project JSON, and refuses to switch an established project.", objectSchema({
            workspaceRoot: stringSchema("Required absolute host workspaceRoot."),
            routeledgerRoot: stringSchema("Optional absolute RouteLedger root inside workspaceRoot. Defaults to workspaceRoot.")
        }, ["workspaceRoot"]), {
            title: "Activate RouteLedger Binding",
            riskLevel: "write",
            toolKind: "planning",
            recommendedApprovalMode: "prompt"
        }, async (input) => {
            const previousBinding = readBinding();
            const canBootstrap = previousBinding.status === "unbound" ||
                previousBinding.status === "invalid" ||
                previousBinding.workspaceRootConfidence === "low" ||
                previousBinding.workspaceRootConfidence === "none";
            if (!canBootstrap) {
                return {
                    ok: true,
                    data: {
                        status: "blocked",
                        code: previousBinding.status === "bound" &&
                            previousBinding.workspaceRootConfidence === "high"
                            ? "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED"
                            : "BINDING_BOOTSTRAP_NOT_ALLOWED",
                        message: "Binding activation only starts from an unbound, invalid, or low-confidence session; do not switch an established project.",
                        previousBinding
                    },
                    meta: withCurrentRuntimeContextMeta({ data: null })
                };
            }
            const bindingPlan = await planRouteLedgerBinding({
                binding: previousBinding,
                workspaceRoot: input.workspaceRoot,
                routeledgerRoot: input.routeledgerRoot ?? input.workspaceRoot
            });
            if ((bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") ||
                bindingPlan.targetBinding === null) {
                return {
                    ok: true,
                    data: { status: "blocked", bindingPlan },
                    meta: withCurrentRuntimeContextMeta({ data: null })
                };
            }
            pendingSessionRebind = {
                workspaceRoot: bindingPlan.targetBinding.workspaceRoot,
                routeledgerRoot: bindingPlan.targetBinding.routeledgerRoot
            };
            return {
                ok: true,
                data: {
                    status: "activated",
                    rebound: true,
                    previousBinding,
                    nextBinding: bindingPlan.targetBinding,
                    requiresInit: bindingPlan.requiresInit,
                    bindingPlan
                },
                meta: withRuntimeContextMeta({
                    data: null,
                    binding: resolveRouteLedgerBinding(pendingSessionRebind, {
                        autoCreateWorkspaceConfig: false
                    }),
                    hostProfile
                })
            };
        }),
        defineTool("render_host_binding_config", "Render a Codex host binding config or fragment for a planned routeledgerRoot without writing user config files.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."),
            routeledgerRoot: stringSchema("Optional absolute routeledgerRoot to render. When omitted, the tool uses the current binding or a discovered single candidate."),
            routeLedgerWorkspaceRoot: stringSchema("Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."),
            serverName: stringSchema("Optional MCP server name override."),
            existingConfigStrategy: {
                type: "string",
                enum: ["write-fragment", "overwrite", "error"],
                description: "How Codex should plan the target path when .codex/config.toml already exists. The tool only renders and plans; it never writes."
            }
        }), {
            title: "Render Host Binding Config",
            riskLevel: "read-only",
            toolKind: "planning"
        }, async (input) => ({
            ok: true,
            data: await renderHostBindingConfig({
                binding: readBinding(),
                workspaceRoot: input.workspaceRoot,
                routeledgerRoot: input.routeledgerRoot,
                routeLedgerWorkspaceRoot: typeof input.routeLedgerWorkspaceRoot === "string" &&
                    input.routeLedgerWorkspaceRoot.length > 0
                    ? input.routeLedgerWorkspaceRoot
                    : undefined,
                serverName: input.serverName,
                existingConfigStrategy: input.existingConfigStrategy
            }),
            meta: withCurrentRuntimeContextMeta({ data: null })
        })),
        defineTool("write_host_binding_config", "Write a Codex project-level host binding config or fragment for a planned routeledgerRoot.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."),
            routeledgerRoot: stringSchema("Optional absolute routeledgerRoot to write. When omitted, the tool uses the current binding or a discovered single candidate."),
            routeLedgerWorkspaceRoot: stringSchema("Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."),
            serverName: stringSchema("Optional MCP server name override."),
            outputPath: stringSchema("Optional absolute output path. Defaults to workspaceRoot/.codex/config.toml or a routeledger fragment when config.toml already exists."),
            existingConfigStrategy: {
                type: "string",
                enum: ["write-fragment", "overwrite", "error"],
                description: "How Codex should write when .codex/config.toml already exists. Defaults to writing a fragment instead of overwriting."
            }
        }), {
            title: "Write Host Binding Config",
            riskLevel: "write",
            toolKind: "planning",
            recommendedApprovalMode: "prompt"
        }, async (input) => ({
            ok: true,
            data: await writeHostBindingConfig({
                binding: readBinding(),
                workspaceRoot: input.workspaceRoot,
                routeledgerRoot: input.routeledgerRoot,
                routeLedgerWorkspaceRoot: typeof input.routeLedgerWorkspaceRoot === "string" &&
                    input.routeLedgerWorkspaceRoot.length > 0
                    ? input.routeLedgerWorkspaceRoot
                    : undefined,
                serverName: input.serverName,
                outputPath: input.outputPath,
                existingConfigStrategy: input.existingConfigStrategy
            }),
            meta: withCurrentRuntimeContextMeta({ data: null })
        })),
        defineTool("open_mission_control", "Open or reuse the source-mode Mission Control UI for the current binding or an explicit workspaceRoot + routeledgerRoot pair.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
            routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."),
            devBuild: booleanSchema("When true, auto-build the UI dist if it is missing before launching the source-mode Mission Control server.")
        }), {
            title: "Open Mission Control",
            riskLevel: "read-only",
            toolKind: "diagnostic"
        }, async (input) => {
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
        }),
        defineTool("get_mission_control_status", "Inspect Mission Control source-mode registry and health state for the current binding or an explicit workspaceRoot + routeledgerRoot pair without starting the UI.", objectSchema({
            workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
            routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot.")
        }), {
            title: "Get Mission Control Status",
            riskLevel: "read-only",
            toolKind: "diagnostic"
        }, async (input) => {
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
        }),
        defineTool("init_project", "Create a new RouteLedger project.", objectSchema({
            name: stringSchema("Project name."),
            description: stringSchema("Optional project description.")
        }, ["name"]), {
            title: "Init Project",
            riskLevel: "write",
            toolKind: "bootstrap"
        }, async (input) => ({
            ok: true,
            data: await service.initProject({
                name: input.name,
                description: input.description,
                actor
            })
        })),
        defineTool("get_current_context", "Get lightweight current context for a project.", objectSchema({
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
            includeLegacyUndo: booleanSchema("Audit-only. Include legacy Undo records under legacyUndo when a hidden legacy blocker must be inspected. Defaults to false.")
        }, ["projectId"]), {
            title: "Get Current Context",
            riskLevel: "read-only"
        }, withInputAdapter(adaptGetCurrentContextInput, async (input) => {
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
        })),
        defineTool("next_action", "Get the shared current-context judgment and recommended next route action.", objectSchema({
            projectId: stringSchema("RouteLedger project ID.")
        }, ["projectId"]), {
            title: "Next Action",
            riskLevel: "read-only"
        }, async (input) => {
            const nextAction = await service.getNextAction({
                projectId: input.projectId
            });
            return {
                ok: true,
                data: nextAction.data,
                meta: withCurrentRuntimeContextMeta({ data: nextAction.data })
            };
        }),
        defineTool("check_doc_drift", "Check whether selected human entry docs drift from the current RouteLedger truth without creating proposals or changing canonical .routeledger route truth. Read paths may still refresh derived caches or read models.", objectSchema({
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
        }, ["projectId", "entryFiles"]), {
            title: "Check Doc Drift",
            riskLevel: "read-only"
        }, withInputAdapter(adaptCheckDocDriftInput, async (input) => {
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
        })),
        defineTool("summarize_version_closeout", "Get a controller-facing closeout summary for one version without creating proposals or changing canonical .routeledger route truth. Read paths may still refresh derived caches or read models.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
            eventLimit: integerSchema("How many related recent events to include.", {
                minimum: 1,
                maximum: 50
            })
        }, ["projectId"]), {
            title: "Summarize Version Closeout",
            riskLevel: "read-only"
        }, async (input) => {
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
                data: sanitizeCloseoutSummaryForAgent(summary.data),
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
        }),
        defineTool("plan_version_closeout", "Get a controller closeout execution plan for one version without creating proposals or changing canonical .routeledger route truth. Read paths may still refresh derived caches or read models.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
            eventLimit: integerSchema("How many related recent events to include in the embedded summary.", {
                minimum: 1,
                maximum: 50
            })
        }, ["projectId"]), {
            title: "Plan Version Closeout",
            riskLevel: "read-only"
        }, async (input) => {
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
                data: sanitizeCloseoutPlanForAgent(plan.data),
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
        }),
        defineTool("list_versions_window", "List a lightweight version window around the current or specified version.", objectSchema({
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
        }, ["projectId"]), {
            title: "List Versions Window",
            riskLevel: "read-only"
        }, withInputAdapter(adaptListVersionsWindowInput, async (input) => {
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
        })),
        defineTool("list_versions", "List project versions.", objectSchema({
            projectId: stringSchema("RouteLedger project ID.")
        }, ["projectId"]), {
            title: "List Versions",
            riskLevel: "read-only"
        }, async (input) => ({
            ok: true,
            data: await service.listVersions(input.projectId)
        })),
        defineTool("check_start_gate", "Evaluate the start gate for a version.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Target version ID.")
        }, ["projectId", "versionId"]), {
            title: "Check Start Gate",
            riskLevel: "read-only"
        }, async (input) => {
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
        }),
        defineTool("check_close_gate", "Evaluate the close gate for a version.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Target version ID."),
            residualAudit: {
                anyOf: [
                    residualAuditArraySchema,
                    {
                        type: "null"
                    }
                ],
                description: "Residual audit items used for close-gate evaluation."
            }
        }, ["projectId", "versionId"]), {
            title: "Check Close Gate",
            riskLevel: "read-only"
        }, async (input) => {
            const gate = await service.checkCloseGate({
                projectId: input.projectId,
                versionId: input.versionId,
                residualAudit: (input.residualAudit ?? []),
                actor
            });
            await appendDebugLog("check_close_gate", {
                type: "gate.close",
                projectId: input.projectId,
                versionId: input.versionId,
                payload: {
                    allowed: gate.allowed,
                    blockerCodes: gate.blockers.map((blocker) => blocker.code),
                    residualAuditCount: Array.isArray(input.residualAudit) ? input.residualAudit.length : 0
                }
            });
            return {
                ok: true,
                data: gate
            };
        }),
        defineTool("get_version_structure", "Get a read-only version topology view with legal operation hints around the current or specified version.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Optional focus version ID. Defaults to currentVersionId."),
            residualAudit: {
                anyOf: [
                    residualAuditArraySchema,
                    {
                        type: "null"
                    }
                ],
                description: "Optional residual audit sample used to evaluate close_version legality."
            }
        }, ["projectId"]), {
            title: "Get Version Structure",
            riskLevel: "read-only"
        }, async (input) => {
            const structure = await service.getVersionStructure({
                projectId: input.projectId,
                versionId: input.versionId,
                residualAudit: (input.residualAudit ?? [])
            });
            return {
                ok: true,
                data: sanitizeVersionStructureForAgent(structure)
            };
        }),
        defineTool("get_version_transition_guide", "Read-only workflow guide for a from-version -> target-version transition. It evaluates close/start gates and recommends the existing step-by-step tools without creating proposals.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            fromVersionId: stringSchema("Optional from version ID. Defaults to currentVersionId."),
            targetVersionId: stringSchema("Target version ID."),
            residualAudit: {
                anyOf: [
                    residualAuditArraySchema,
                    {
                        type: "null"
                    }
                ],
                description: "Optional residual audit sample used to preview the from-version close gate."
            }
        }, ["projectId", "targetVersionId"]), {
            title: "Get Version Transition Guide",
            riskLevel: "read-only"
        }, async (input) => {
            const guide = await service.getVersionTransitionGuide({
                projectId: input.projectId,
                fromVersionId: input.fromVersionId,
                targetVersionId: input.targetVersionId,
                residualAudit: (input.residualAudit ?? [])
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
        }),
        defineTool("list_l3_proposals", "List pending and historical L3 proposals for a project.", objectSchema({
            projectId: stringSchema("RouteLedger project ID.")
        }, ["projectId"]), {
            title: "List L3 Proposals",
            riskLevel: "read-only"
        }, async (input) => ({
            ok: true,
            data: await service.listL3Proposals(input.projectId)
        })),
        defineTool("get_l3_proposal", "Get a single L3 proposal.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID.")
        }, ["projectId", "pendingOperationId"]), {
            title: "Get L3 Proposal",
            riskLevel: "read-only"
        }, async (input) => ({
            ok: true,
            data: await service.getL3Proposal(input.projectId, input.pendingOperationId)
        })),
        defineTool("batch_create_versions", "Preflight or propose one atomic batch version-creation plan.", objectSchema({
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
        }, ["projectId", "mode", "items"]), {
            title: "Batch Create Versions",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.batchCreateVersions({
                projectId: input.projectId,
                mode: parseBatchCreateVersionsMode(input.mode),
                partialAllowed: input.partialAllowed,
                anchor: input.anchor,
                items: input.items,
                setCurrentTo: input.setCurrentTo,
                previousCurrentPolicy: parseBatchPreviousCurrentPolicy(input.previousCurrentPolicy),
                reason: input.reason,
                actor
            })
        })),
        defineTool("transition_version", "Workflow-first wrapper that plans or proposes the next live step needed to transition focus to a target version without bypassing the existing L3 chain.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Target version ID."),
            mode: {
                type: "string",
                enum: ["dry_run", "propose"],
                description: "dry_run only inspects live legality; propose creates exactly one next-step proposal when the transition is actionable."
            },
            reason: stringSchema("Optional proposal reason override.")
        }, ["projectId", "versionId"]), {
            title: "Transition Version",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.transitionVersion({
                projectId: input.projectId,
                versionId: input.versionId,
                mode: parseRouteOperationWorkflowMode(input.mode),
                reason: input.reason,
                actor
            })
        })),
        defineTool("close_version", "Workflow-first close wrapper. It defaults to dry-run semantics and only creates a close proposal when explicitly asked and the gate already passes.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Target version ID."),
            mode: {
                type: "string",
                enum: ["dry_run", "propose"],
                description: "dry_run returns blockers only; propose creates a close_version proposal only when the gate passes."
            },
            residualAudit: {
                anyOf: [
                    residualAuditArraySchema,
                    {
                        type: "null"
                    }
                ],
                description: "Residual audit items used for close preflight and, when allowed, the proposal payload."
            },
            reason: stringSchema("Optional proposal reason override.")
        }, ["projectId", "versionId"]), {
            title: "Close Version",
            riskLevel: "write"
        }, async (input) => {
            const result = await service.closeVersionWorkflow({
                projectId: input.projectId,
                versionId: input.versionId,
                mode: parseRouteOperationWorkflowMode(input.mode),
                residualAudit: (input.residualAudit ?? []),
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
        }),
        defineTool("shutdown_version", "Emergency forced-close wrapper. It defaults to dry-run semantics and, when proposed, creates a shutdown_version L3 proposal that bypasses ordinary close blockers while explicitly recording forced-path metadata.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Target version ID."),
            mode: {
                type: "string",
                enum: ["dry_run", "propose"],
                description: "dry_run previews the forced path; propose creates a shutdown_version proposal."
            },
            shutdownReason: stringSchema("Required shutdown reason suffix. RouteLedger stores it as version.stateReason with a shutdown: prefix."),
            reason: stringSchema("Optional proposal reason override shown in audit/review surfaces.")
        }, ["projectId", "versionId", "shutdownReason"]), {
            title: "Shutdown Version",
            riskLevel: "high-risk"
        }, async (input) => {
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
                    ordinaryCloseBlockerCodes: result.ordinaryCloseGate.blockers.map((blocker) => blocker.code),
                    createsPendingProposal: result.pendingOperationId !== undefined
                }
            });
            return {
                ok: true,
                data: result
            };
        }),
        defineTool("create_todo", "Create a todo.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Owning version ID."),
            title: stringSchema("Todo title."),
            description: stringSchema("Optional todo description.")
        }, ["projectId", "versionId", "title"]), {
            title: "Create Todo",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.createTodo({
                projectId: input.projectId,
                versionId: input.versionId,
                title: input.title,
                description: input.description,
                actor
            })
        })),
        defineTool("close_todo", "Close a todo.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            todoId: stringSchema("Todo ID."),
            reason: stringSchema("Close reason."),
            note: stringSchema("Close note.")
        }, ["projectId", "todoId", "reason", "note"]), {
            title: "Close Todo",
            riskLevel: "write",
            destructive: true
        }, async (input) => ({
            ok: true,
            data: await service.closeTodo({
                projectId: input.projectId,
                todoId: input.todoId,
                reason: input.reason,
                note: input.note,
                actor
            })
        })),
        defineTool("defer_work", "Move work out of the current execution path and schedule a future review. Use mode=new for newly identified work or mode=todo for an existing Todo.", objectSchema({
            mode: {
                type: "string",
                enum: ["new", "todo"],
                description: "new creates Deferred work; todo converts an existing Todo into Deferred work."
            },
            projectId: stringSchema("RouteLedger project ID."),
            currentVersionId: stringSchema("Required for mode=new. The current version where this work was identified."),
            targetReviewVersionId: stringSchema("Downstream version where this Deferred work must be reviewed."),
            title: stringSchema("Required for mode=new. Deferred work title."),
            description: stringSchema("Optional description for mode=new."),
            todoId: stringSchema("Required for mode=todo. Existing Todo ID."),
            reason: stringSchema("Why the work is being deferred."),
            note: stringSchema("Required for mode=todo. Operator note explaining the Todo transition."),
            reviewTrigger: stringSchema("Optional condition or evidence that should trigger review.")
        }, ["mode", "projectId", "targetReviewVersionId", "reason"]), {
            title: "Defer Work",
            riskLevel: "write"
        }, withInputAdapter(adaptDeferWorkInput, async (input) => {
            const result = input.mode === "new"
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
                data: result.mode === "todo"
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
        })),
        defineTool("review_deferred", "Review one Deferred item through a single action: activate it as a Todo, defer it again to a later review version, or resolve it with a final outcome.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            deferredId: stringSchema("Deferred item ID."),
            action: {
                type: "string",
                enum: ["activate", "defer_again", "resolve"],
                description: "Review action."
            },
            targetVersionId: stringSchema("Required for activate. Version where the activated Todo will run."),
            targetReviewVersionId: stringSchema("Required for defer_again. Later version where review must happen."),
            outcome: {
                type: "string",
                enum: ["superseded", "rejected", "out_of_scope"],
                description: "Required for resolve."
            },
            reason: stringSchema("Reason for this review decision."),
            note: stringSchema("Optional operator note."),
            reviewTrigger: stringSchema("Optional updated review trigger for defer_again."),
            decisionRef: stringSchema("Decision reference. Required by the service for rejected and out_of_scope outcomes.")
        }, ["projectId", "deferredId", "action", "reason"]), {
            title: "Review Deferred",
            riskLevel: "write",
            destructive: true
        }, withInputAdapter(adaptReviewDeferredInput, async (input) => {
            const result = input.action === "activate"
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
                data: result.action === "activate"
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
        })),
        defineTool("record_constraint", "Record a rule that RouteLedger agents must not violate. Scope it to the whole project or one version.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            rule: stringSchema("The rule that must not be violated."),
            rationale: stringSchema("Why this constraint exists."),
            scopeType: {
                type: "string",
                enum: ["project", "version"],
                description: "project applies everywhere; version applies only to versionId."
            },
            versionId: stringSchema("Required when scopeType=version.")
        }, ["projectId", "rule", "rationale", "scopeType"]), {
            title: "Record Constraint",
            riskLevel: "write"
        }, withInputAdapter(adaptRecordConstraintInput, async (input) => {
            const result = await service.recordConstraint({
                projectId: input.projectId,
                rule: input.rule,
                rationale: input.rationale,
                scope: input.scopeType === "project"
                    ? { type: "project" }
                    : { type: "version", versionId: input.versionId },
                actor
            });
            await appendDebugLog("record_constraint", {
                type: "constraint.recorded",
                projectId: input.projectId,
                versionId: input.scopeType === "version" ? input.versionId : undefined,
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
        })),
        defineTool("retire_constraint", "Retire a Constraint that no longer applies while preserving its audit history.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            constraintId: stringSchema("Constraint ID."),
            reason: stringSchema("Why this constraint no longer applies."),
            note: stringSchema("Operator note for the retirement audit.")
        }, ["projectId", "constraintId", "reason", "note"]), {
            title: "Retire Constraint",
            riskLevel: "write",
            destructive: true
        }, withInputAdapter(adaptRetireConstraintInput, async (input) => {
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
        })),
        defineTool("create_undo", "Create an undo.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Owning version ID."),
            originVersionId: stringSchema("Origin version ID."),
            preferredResolutionVersionId: stringSchema("Preferred resolution version ID."),
            title: stringSchema("Undo title."),
            reason: stringSchema("Undo reason."),
            description: stringSchema("Optional undo description.")
        }, [
            "projectId",
            "versionId",
            "originVersionId",
            "preferredResolutionVersionId",
            "title",
            "reason"
        ]), {
            title: "Create Undo",
            riskLevel: "write",
            visibility: "legacy-hidden"
        }, async (input) => {
            const created = await service.createUndo({
                projectId: input.projectId,
                versionId: input.versionId,
                originVersionId: input.originVersionId,
                preferredResolutionVersionId: input.preferredResolutionVersionId,
                title: input.title,
                reason: input.reason,
                description: input.description,
                actor
            });
            await appendDebugLog("create_undo", {
                type: "undo.create",
                projectId: input.projectId,
                versionId: created.undo.versionId,
                undoId: created.undo.id,
                payload: {
                    originVersionId: created.undo.originVersionId,
                    preferredResolutionVersionId: created.undo.preferredResolutionVersionId,
                    status: created.undo.status
                }
            });
            return {
                ok: true,
                data: created
            };
        }),
        defineTool("reassign_undo", "Reassign an undo.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            undoId: stringSchema("Undo ID."),
            preferredResolutionVersionId: stringSchema("Next preferred resolution version ID."),
            reason: stringSchema("Reassignment reason."),
            note: stringSchema("Reassignment note.")
        }, ["projectId", "undoId", "preferredResolutionVersionId", "reason", "note"]), {
            title: "Reassign Undo",
            riskLevel: "write",
            destructive: true,
            visibility: "legacy-hidden"
        }, async (input) => ({
            ok: true,
            data: await service.reassignUndo({
                projectId: input.projectId,
                undoId: input.undoId,
                preferredResolutionVersionId: input.preferredResolutionVersionId,
                reason: input.reason,
                note: input.note,
                actor
            })
        })),
        defineTool("carry_forward_undo", "Keep an open undo as an undo while routing its preferred downstream resolution version forward.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            undoId: stringSchema("Undo ID."),
            preferredResolutionVersionId: stringSchema("Downstream version ID that should inherit responsibility."),
            reason: stringSchema("Why the undo is being carried forward."),
            note: stringSchema("Operator note for the reassignment event.")
        }, ["projectId", "undoId", "preferredResolutionVersionId", "reason", "note"]), {
            title: "Carry Forward Undo",
            riskLevel: "write",
            destructive: true,
            visibility: "legacy-hidden"
        }, async (input) => ({
            ok: true,
            data: await service.carryForwardUndo({
                projectId: input.projectId,
                undoId: input.undoId,
                preferredResolutionVersionId: input.preferredResolutionVersionId,
                reason: input.reason,
                note: input.note,
                actor
            })
        })),
        defineTool("resolve_undo_as_downstream_input", "Alias of carry_forward_undo for route semantics that treat unresolved undo as downstream input.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            undoId: stringSchema("Undo ID."),
            preferredResolutionVersionId: stringSchema("Downstream version ID that should inherit responsibility."),
            reason: stringSchema("Why the undo is being routed forward."),
            note: stringSchema("Operator note for the reassignment event.")
        }, ["projectId", "undoId", "preferredResolutionVersionId", "reason", "note"]), {
            title: "Resolve Undo As Downstream Input",
            riskLevel: "write",
            destructive: true,
            visibility: "legacy-hidden"
        }, async (input) => ({
            ok: true,
            data: await service.resolveUndoAsDownstreamInput({
                projectId: input.projectId,
                undoId: input.undoId,
                preferredResolutionVersionId: input.preferredResolutionVersionId,
                reason: input.reason,
                note: input.note,
                actor
            })
        })),
        defineTool("close_undo", "Close an undo.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            undoId: stringSchema("Undo ID."),
            reason: stringSchema("Close reason."),
            note: stringSchema("Close note.")
        }, ["projectId", "undoId", "reason", "note"]), {
            title: "Close Undo",
            riskLevel: "write",
            destructive: true,
            visibility: "legacy-hidden"
        }, async (input) => {
            const closed = await service.closeUndo({
                projectId: input.projectId,
                undoId: input.undoId,
                reason: input.reason,
                note: input.note,
                actor
            });
            await appendDebugLog("close_undo", {
                type: "undo.close",
                projectId: input.projectId,
                versionId: closed.undo.versionId,
                undoId: closed.undo.id,
                payload: {
                    status: closed.undo.status
                }
            });
            return {
                ok: true,
                data: closed
            };
        }),
        defineTool("prepare_version", "Prepare a version.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Version ID.")
        }, ["projectId", "versionId"]), {
            title: "Prepare Version",
            riskLevel: "write",
            destructive: true
        }, async (input) => ({
            ok: true,
            data: await service.prepareVersion({
                projectId: input.projectId,
                versionId: input.versionId,
                actor
            })
        })),
        defineTool("mark_version_complete", "Mark a version complete.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Version ID.")
        }, ["projectId", "versionId"]), {
            title: "Mark Version Complete",
            riskLevel: "write",
            destructive: true
        }, async (input) => ({
            ok: true,
            data: await service.markVersionComplete({
                projectId: input.projectId,
                versionId: input.versionId,
                actor
            })
        })),
        defineTool("create_version", "Create a top-level version proposal and return CONFIRMATION_REQUIRED with the pending operation details.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            title: stringSchema("Version title."),
            description: stringSchema("Optional version description.")
        }, ["projectId", "title"]), {
            title: "Create Version",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.createVersion({
                projectId: input.projectId,
                title: input.title,
                description: input.description,
                actor
            })
        })),
        defineTool("insert_version", "Insert a new sibling version proposal relative to an existing root or child anchor.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            title: stringSchema("Version title."),
            description: stringSchema("Optional version description."),
            afterVersionId: stringSchema("Insert after this sibling version ID."),
            beforeVersionId: stringSchema("Insert before this sibling version ID.")
        }, ["projectId", "title"]), {
            title: "Insert Version",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.insertVersion({
                projectId: input.projectId,
                title: input.title,
                description: input.description,
                afterVersionId: input.afterVersionId,
                beforeVersionId: input.beforeVersionId,
                actor
            })
        })),
        defineTool("create_child_version", "Create a child version proposal under a parent, optionally positioned by child anchors.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            parentVersionId: stringSchema("Parent version ID."),
            title: stringSchema("Version title."),
            description: stringSchema("Optional version description."),
            afterVersionId: stringSchema("Insert after this child version ID."),
            beforeVersionId: stringSchema("Insert before this child version ID.")
        }, ["projectId", "parentVersionId", "title"]), {
            title: "Create Child Version",
            riskLevel: "write"
        }, async (input) => ({
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
        })),
        defineTool("reorder_versions", "Reorder an existing version within the same parent scope.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            versionId: stringSchema("Version ID to move."),
            afterVersionId: stringSchema("Move after this sibling version ID."),
            beforeVersionId: stringSchema("Move before this sibling version ID.")
        }, ["projectId", "versionId"]), {
            title: "Reorder Versions",
            riskLevel: "write"
        }, async (input) => ({
            ok: true,
            data: await service.reorderVersions({
                projectId: input.projectId,
                versionId: input.versionId,
                afterVersionId: input.afterVersionId,
                beforeVersionId: input.beforeVersionId,
                actor
            })
        })),
        defineTool("propose_l3_operation", "Create a pending L3 proposal.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            actionType: {
                type: "string",
                enum: [
                    "start_version",
                    "close_version",
                    "shutdown_version",
                    "reopen_version",
                    "set_current_version",
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
        defineTool("approve_l3_operation", "Create an approval artifact for a pending L3 proposal.", objectSchema({
            projectId: stringSchema("RouteLedger project ID."),
            pendingOperationId: stringSchema("Pending operation ID."),
            decisionRef: stringSchema("Optional host-visible decision reference.")
        }, ["projectId", "pendingOperationId"]), {
            title: "Approve L3 Operation",
            riskLevel: "high-risk"
        }, async (input) => ({
            ok: true,
            data: await service.approveL3Operation({
                projectId: input.projectId,
                pendingOperationId: input.pendingOperationId,
                approver,
                actor,
                decisionRef: input.decisionRef
            })
        })),
        defineTool("commit_l3_operation", "Commit a pending L3 proposal with an approval artifact.", objectSchema({
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
                    approvalArtifactStatus: committed.approvalArtifact.status
                }
            });
            return {
                ok: true,
                data: committed
            };
        }),
        defineTool("reject_l3_operation", "Reject a pending L3 proposal.", objectSchema({
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
    const handlers = new Map(guardedTools.map((tool) => [tool.definition.name, tool.handler]));
    toolDefinitions = guardedTools
        .filter((tool) => tool.visibility === "default")
        .map((tool) => tool.definition);
    let reboundRegistry = null;
    const activatePendingRebindForDirectRegistry = () => {
        if (options.deferSessionRebind || pendingSessionRebind === null) {
            return;
        }
        const nextBinding = pendingSessionRebind;
        pendingSessionRebind = null;
        reboundRegistry?.close();
        reboundRegistry = createRouteLedgerMcpRegistry({
            ...options,
            workspaceRoot: nextBinding.workspaceRoot,
            workspaceRootSource: "explicit_arg",
            routeledgerRoot: nextBinding.routeledgerRoot,
            mcpRoots: undefined,
            deferSessionRebind: false
        });
    };
    return {
        tools: toolDefinitions,
        serverInfo: SERVER_INFO,
        serverCapabilities,
        hostProfile,
        instructions,
        getTool: (toolName) => toolDefinitions.find((tool) => tool.name === toolName),
        invoke: async (toolName, input) => {
            if (reboundRegistry !== null) {
                return reboundRegistry.invoke(toolName, input);
            }
            const handler = handlers.get(toolName);
            if (handler === undefined) {
                return {
                    ok: false,
                    error: {
                        code: "ACTION_NOT_IMPLEMENTED",
                        message: `unknown tool ${toolName}`
                    }
                };
            }
            try {
                const response = await handler(input);
                activatePendingRebindForDirectRegistry();
                return response;
            }
            catch (error) {
                const response = toToolError(error);
                await appendDebugLog(toolName, {
                    type: "tool.failure",
                    projectId: readStringField(input, "projectId"),
                    versionId: readDebugVersionId(input),
                    undoId: readStringField(input, "undoId"),
                    pendingOperationId: readDebugPendingOperationId(input),
                    payload: {
                        error: response.error,
                        inputKeys: Object.keys(input ?? {}).sort()
                    }
                });
                return response;
            }
        },
        peekPendingSessionRebind: () => pendingSessionRebind,
        clearPendingSessionRebind: () => {
            pendingSessionRebind = null;
        },
        close: () => {
            reboundRegistry?.close();
            close();
        }
    };
};
