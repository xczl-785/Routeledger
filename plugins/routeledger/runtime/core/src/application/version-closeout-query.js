import { describeVersionState, isShutdownStateReason, isUndoBlockingCloseForVersion } from "../domain/route-semantics.js";
import { evaluateCloseGate, resolveResidualAudit } from "../services/gate-service.js";
import { ApplicationError } from "./errors.js";
const DEFAULT_CLOSEOUT_EVENT_LIMIT = 10;
const MAX_CLOSEOUT_EVENT_LIMIT = 50;
const SELF_REFERENTIAL_GUARDRAIL_KEYWORDS = [
    "if",
    "when",
    "fail",
    "rollback",
    "routeback",
    "qa failed",
    "verification failed"
];
const SELF_REFERENTIAL_CLEANUP_KEYWORDS = [
    "after close",
    "afterwards",
    "cleanup",
    "delete",
    "migrate",
    "follow-up"
];
const requireVersion = (snapshot, versionId) => {
    const version = snapshot.versions.find((item) => item.id === versionId);
    if (version === undefined) {
        throw new ApplicationError("VERSION_NOT_FOUND", "version not found", {
            projectId: snapshot.project.id,
            versionId
        });
    }
    return version;
};
const summarizeOpenTodo = (todo) => ({
    id: todo.id,
    versionId: todo.versionId,
    title: todo.title,
    status: todo.status,
    description: todo.description,
    updatedAt: todo.updatedAt
});
const summarizeOpenUndo = (undo) => ({
    id: undo.id,
    versionId: undo.versionId,
    originVersionId: undo.originVersionId,
    preferredResolutionVersionId: undo.preferredResolutionVersionId,
    carriedForwardAt: undo.carriedForwardAt,
    carriedForwardToVersionId: undo.carriedForwardToVersionId,
    title: undo.title,
    reason: undo.reason,
    description: undo.description,
    updatedAt: undo.updatedAt
});
const collectBlockerIds = (blockers) => [
    ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];
const compareIsoDesc = (left, right) => (right ?? "").localeCompare(left ?? "");
const comparePendingOperationsDesc = (left, right) => compareIsoDesc(left.updatedAt, right.updatedAt) ||
    compareIsoDesc(left.createdAt, right.createdAt) ||
    right.id.localeCompare(left.id);
const extractRelatedPendingOperationId = (event) => {
    if (event.targetType === "pending_operation") {
        return event.targetId;
    }
    const pendingOperationId = event.metadata.pendingOperationId;
    return typeof pendingOperationId === "string" ? pendingOperationId : null;
};
const summarizeCloseoutVersion = (version) => ({
    ...describeVersionState(version),
    id: version.id,
    title: version.title,
    state: version.state,
    isCurrent: version.isCurrent
});
const summarizeCloseoutPendingOperation = (operation) => ({
    id: operation.id,
    actionType: operation.actionType,
    targetId: operation.targetId,
    status: operation.status,
    reason: operation.reason,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    committedAt: operation.committedAt,
    rejectedAt: operation.rejectedAt,
    approvalArtifactId: operation.approvalArtifactId,
    gate: {
        kind: operation.gateSnapshot.kind,
        allowed: operation.gateSnapshot.allowed,
        blockerCodes: operation.gateSnapshot.blockers.map((blocker) => blocker.code),
        blockerCount: operation.gateSnapshot.blockers.length
    }
});
const summarizeCloseoutRecentEvent = (event) => ({
    id: event.id,
    eventType: event.eventType,
    targetType: event.targetType,
    targetId: event.targetId,
    operationId: event.operationId,
    createdAt: event.createdAt,
    fromState: event.fromState,
    toState: event.toState,
    note: event.note,
    relatedPendingOperationId: extractRelatedPendingOperationId(event),
    metadata: event.metadata
});
const isProjectCurrentVersionEventForVersion = (event, versionId) => event.targetType === "project" &&
    event.eventType === "project.current_version_changed" &&
    (event.fromState === versionId || event.toState === versionId);
const collectKeywordMatches = (text, keywords) => {
    const normalized = text.toLowerCase();
    return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
};
const buildSelfReferentialUndoAlternatives = (category) => {
    if (category === "guardrail_like") {
        return [
            {
                actionType: "carry_forward_undo",
                recommendedTool: "carry_forward_undo",
                summary: "Only carry it forward if the rollback really belongs to a downstream version.",
                reason: "Guardrail-like self undo usually closes better as a documented closeout condition than as a fresh downstream blocker."
            }
        ];
    }
    if (category === "cleanup_like") {
        return [
            {
                actionType: "carry_forward_undo",
                recommendedTool: "carry_forward_undo",
                summary: "Keep it as undo only if the downstream owner and preferred resolution version are already explicit.",
                reason: "Cleanup-like self undo usually reads more clearly as a follow-up todo than as an open undo pointing back to itself."
            }
        ];
    }
    return [
        {
            actionType: "close_undo",
            recommendedTool: "close_undo",
            summary: "Close the self-referential undo in place.",
            reason: "Use this when the record is really a guardrail or a note that should stop blocking the route."
        },
        {
            actionType: "close_undo_then_create_todo",
            recommendedTool: null,
            summary: "Close the undo, then create a downstream todo.",
            reason: "Use this when the text actually describes post-close cleanup instead of a true rollback guardrail."
        },
        {
            actionType: "carry_forward_undo",
            recommendedTool: "carry_forward_undo",
            summary: "Carry the undo forward unchanged.",
            reason: "Use this only when the issue is still an undo and a downstream preferred resolution version is already clear."
        }
    ];
};
const summarizeSelfReferentialUndo = (undo) => {
    const base = summarizeOpenUndo(undo);
    const searchText = `${undo.title}\n${undo.reason}\n${undo.description}`;
    const guardrailMatches = collectKeywordMatches(searchText, SELF_REFERENTIAL_GUARDRAIL_KEYWORDS);
    const cleanupMatches = collectKeywordMatches(searchText, SELF_REFERENTIAL_CLEANUP_KEYWORDS);
    if (guardrailMatches.length > 0 && cleanupMatches.length === 0) {
        return {
            ...base,
            code: "SELF_REFERENTIAL_UNDO_GUARDRAIL",
            category: "guardrail_like",
            matchedKeywords: guardrailMatches,
            recommendedResolution: "close_undo",
            reason: "This self-referential undo reads like a guardrail. Close it and keep the conditional rollback in the closeout record instead of blocking start/close as a due undo.",
            note: "Recommended path: close_undo, then copy the guardrail into residual audit or the closeout note so the controller still sees the rollback condition without treating it as an open undo.",
            alternatives: buildSelfReferentialUndoAlternatives("guardrail_like")
        };
    }
    if (cleanupMatches.length > 0 && guardrailMatches.length === 0) {
        return {
            ...base,
            code: "SELF_REFERENTIAL_UNDO_CLEANUP",
            category: "cleanup_like",
            matchedKeywords: cleanupMatches,
            recommendedResolution: "close_undo_then_create_todo",
            reason: "This self-referential undo reads like post-close cleanup. It should stop blocking the current version and move onto an explicit follow-up todo path.",
            note: "Recommended path: close_undo, then create_todo on the chosen follow-up version or backlog owner. Do not keep a cleanup note as a self-referential undo.",
            alternatives: buildSelfReferentialUndoAlternatives("cleanup_like")
        };
    }
    return {
        ...base,
        code: "SELF_REFERENTIAL_UNDO_NEEDS_REVIEW",
        category: "uncertain",
        matchedKeywords: [...guardrailMatches, ...cleanupMatches],
        recommendedResolution: "manual_review",
        reason: "This self-referential undo still blocks the route, but the text does not cleanly say whether it is a guardrail or a follow-up cleanup item.",
        note: "Manual review required. Decide whether to close_undo, close_undo then create_todo, or carry_forward_undo before treating it as an ordinary blocker.",
        alternatives: buildSelfReferentialUndoAlternatives("uncertain")
    };
};
const resolveCloseoutResidualAudit = (pendingOperations, versionId) => {
    const resolved = resolveResidualAudit(undefined, pendingOperations
        .filter((operation) => operation.status === "pending" &&
        operation.actionType === "close_version" &&
        operation.targetId === versionId)
        .slice()
        .sort(comparePendingOperationsDesc)
        .map((operation) => ({
        id: operation.id,
        residualAudit: operation.payload.residualAudit,
        residualAuditReviewed: operation.payload.residualAuditReviewed
    })));
    return {
        residualAudit: structuredClone(resolved.audit?.items ?? []),
        source: resolved.source,
        proposalId: resolved.proposalId,
        reviewed: resolved.audit !== null
    };
};
const buildCloseoutNextAction = (options) => {
    const { version, closeGate, openTodos, openUndos, pendingOperations } = options;
    const pendingProposal = pendingOperations.find((operation) => operation.status === "pending");
    if (version.state === "close") {
        if (isShutdownStateReason(version.stateReason)) {
            return {
                actionType: "none",
                recommendedTool: null,
                summary: "This version is already SHUTDOWN/ABORTED.",
                reason: `version ${version.id} was force-closed via ${version.stateReason}. Do not treat it as an ordinary closeout boundary.`,
                targetId: null,
                requiresL3Approval: false,
                blockerIds: []
            };
        }
        return {
            actionType: "none",
            recommendedTool: null,
            summary: "This version is already closed.",
            reason: `version ${version.id} is already at the close boundary.`,
            targetId: null,
            requiresL3Approval: false,
            blockerIds: []
        };
    }
    if (pendingProposal !== undefined) {
        return {
            actionType: "review_pending_proposal",
            recommendedTool: "get_l3_proposal",
            summary: "Review the pending proposal first.",
            reason: `proposal ${pendingProposal.id} is still pending, so closeout state is not final yet.`,
            targetId: pendingProposal.id,
            requiresL3Approval: false,
            blockerIds: [pendingProposal.id]
        };
    }
    if (openTodos.length > 0) {
        const todo = openTodos[0];
        return {
            actionType: "close_todo",
            recommendedTool: "close_todo",
            summary: "Close the open todo first.",
            reason: `todo ${todo.id} is still open, so the ordinary close gate cannot pass.`,
            targetId: todo.id,
            requiresL3Approval: false,
            blockerIds: openTodos.map((item) => item.id)
        };
    }
    if (openUndos.length > 0) {
        const undo = openUndos[0];
        return {
            actionType: "close_undo",
            recommendedTool: "close_undo",
            summary: "Resolve the open undo first.",
            reason: `undo ${undo.id} is still open. If it truly belongs downstream, carry_forward_undo is the alternative.`,
            targetId: undo.id,
            requiresL3Approval: false,
            blockerIds: openUndos.map((item) => item.id)
        };
    }
    if (version.state === "running") {
        return {
            actionType: "mark_version_complete",
            recommendedTool: "mark_version_complete",
            summary: "Mark the version complete first.",
            reason: `version ${version.id} is still running, so it must enter the complete boundary before closeout.`,
            targetId: version.id,
            requiresL3Approval: false,
            blockerIds: []
        };
    }
    if (version.state === "complete" &&
        closeGate.blockers.some((blocker) => blocker.code === "MISSING_RESIDUAL_AUDIT")) {
        return {
            actionType: "review_residual_audit",
            recommendedTool: "check_close_gate",
            summary: "Review and declare the residual audit first.",
            reason: "No reviewed residual-audit declaration exists. Supply { status: reviewed, items: [] } only after reviewing that no residuals remain, or include routed residual items.",
            targetId: version.id,
            requiresL3Approval: false,
            blockerIds: []
        };
    }
    if (version.state === "complete" && closeGate.ok) {
        return {
            actionType: "close_version",
            recommendedTool: "close_version",
            mode: "propose",
            summary: "The version is ordinary-close ready.",
            reason: `version ${version.id} is complete and the ordinary close gate now passes.`,
            targetId: version.id,
            requiresL3Approval: true,
            blockerIds: []
        };
    }
    return {
        actionType: "none",
        recommendedTool: null,
        summary: "There is no direct closeout action yet.",
        reason: version.state === "complete"
            ? "The ordinary close gate still has unresolved blockers."
            : `version is currently ${version.state}, so it is not at a closeout boundary yet.`,
        targetId: null,
        requiresL3Approval: false,
        blockerIds: collectBlockerIds(closeGate.blockers)
    };
};
export const clampCloseoutEventLimit = (value) => Math.max(1, Math.min(MAX_CLOSEOUT_EVENT_LIMIT, value ?? DEFAULT_CLOSEOUT_EVENT_LIMIT));
export const isSelfReferentialUndoForVersion = (undo, versionId) => undo.status === "wait" &&
    undo.versionId === versionId &&
    undo.preferredResolutionVersionId === versionId;
export const collectVersionCloseoutView = (options) => {
    const { snapshot, versionId, eventLimit } = options;
    const version = requireVersion(snapshot, versionId);
    const versionTodos = snapshot.todos.filter((todo) => todo.versionId === version.id);
    const versionUndos = snapshot.undos.filter((undo) => undo.versionId === version.id ||
        undo.originVersionId === version.id ||
        undo.preferredResolutionVersionId === version.id);
    const openTodos = versionTodos
        .filter((todo) => todo.status === "wait" || todo.status === "running")
        .map(summarizeOpenTodo);
    const openUndos = versionUndos
        .filter((undo) => isUndoBlockingCloseForVersion(undo, version.id))
        .map(summarizeOpenUndo);
    const selfReferentialUndos = versionUndos
        .filter((undo) => isSelfReferentialUndoForVersion(undo, version.id))
        .map(summarizeSelfReferentialUndo);
    const relatedTodoIds = new Set(versionTodos.map((todo) => todo.id));
    const relatedUndoIds = new Set(versionUndos.map((undo) => undo.id));
    const relatedWorkItemIds = new Set([
        ...versionTodos.map((todo) => todo.workItemId),
        ...versionUndos.map((undo) => undo.workItemId)
    ]);
    const relatedPendingOperations = snapshot.pendingOperations
        .filter((operation) => operation.targetId === version.id ||
        relatedTodoIds.has(operation.targetId) ||
        relatedUndoIds.has(operation.targetId) ||
        relatedWorkItemIds.has(operation.targetId) ||
        operation.payload.currentVersionId === version.id)
        .slice()
        .sort(comparePendingOperationsDesc);
    const relatedPendingOperationIds = new Set(relatedPendingOperations.map((operation) => operation.id));
    const newestEvents = snapshot.events.slice().reverse();
    const residualAudit = resolveCloseoutResidualAudit(relatedPendingOperations, version.id);
    const closeGateEvaluation = evaluateCloseGate({
        version,
        todos: versionTodos,
        undos: versionUndos,
        residualAudit: residualAudit.reviewed
            ? { status: "reviewed", items: residualAudit.residualAudit }
            : null,
        knownVersions: snapshot.versions,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
    });
    const closeGate = {
        ok: version.state === "close" ? true : closeGateEvaluation.allowed,
        applicable: version.state !== "close",
        blockers: version.state === "close" ? [] : closeGateEvaluation.blockers,
        unresolvedTodoIds: version.state === "close" ? [] : closeGateEvaluation.unresolvedTodoIds,
        unresolvedUndoIds: version.state === "close" ? [] : closeGateEvaluation.unresolvedUndoIds,
        unresolvedDeferredIds: version.state === "close" ? [] : closeGateEvaluation.unresolvedDeferredIds,
        blockedConstraintIds: version.state === "close" ? [] : closeGateEvaluation.blockedConstraintIds,
        residualAuditSource: residualAudit.source,
        residualAuditProposalId: residualAudit.proposalId,
        residualAuditReviewed: residualAudit.reviewed
    };
    const recentEvents = newestEvents
        .filter((event) => (event.targetType === "version" && event.targetId === version.id) ||
        (event.targetType === "todo" && relatedTodoIds.has(event.targetId)) ||
        (event.targetType === "undo" && relatedUndoIds.has(event.targetId)) ||
        (event.targetType === "work_item" && relatedWorkItemIds.has(event.targetId)) ||
        (event.targetType === "pending_operation" &&
            relatedPendingOperationIds.has(event.targetId)) ||
        (event.targetType === "approval_artifact" &&
            typeof event.metadata.pendingOperationId === "string" &&
            relatedPendingOperationIds.has(event.metadata.pendingOperationId)) ||
        isProjectCurrentVersionEventForVersion(event, version.id))
        .slice(0, eventLimit)
        .map(summarizeCloseoutRecentEvent);
    const reopenEvents = newestEvents.filter((event) => event.targetType === "version" &&
        event.targetId === version.id &&
        event.eventType === "version.state_changed" &&
        event.toState === "ready" &&
        (event.fromState === "close" || event.fromState === "suspend"));
    const latestReopenOperation = relatedPendingOperations.find((operation) => operation.actionType === "reopen_version" &&
        operation.targetId === version.id &&
        operation.status === "committed") ??
        relatedPendingOperations.find((operation) => operation.actionType === "reopen_version" && operation.targetId === version.id) ??
        null;
    const latestReopenEvent = reopenEvents.length === 0 ? null : summarizeCloseoutRecentEvent(reopenEvents[0]);
    const nextAction = buildCloseoutNextAction({
        version,
        closeGate,
        openTodos,
        openUndos,
        pendingOperations: relatedPendingOperations
    });
    const summary = {
        projectId: snapshot.project.id,
        version: summarizeCloseoutVersion(version),
        canClose: version.state !== "close" && closeGate.ok,
        closeGate,
        openTodos,
        openUndos,
        selfReferentialUndos,
        pendingOperations: relatedPendingOperations.map(summarizeCloseoutPendingOperation),
        recentEvents,
        reopenSummary: {
            hasReopened: reopenEvents.length > 0,
            count: reopenEvents.length,
            latestReason: latestReopenOperation?.reason ?? latestReopenEvent?.note ?? null,
            latestEvent: latestReopenEvent
        },
        nextAction
    };
    return {
        version,
        residualAudit: residualAudit.residualAudit,
        relatedPendingOperations,
        summary,
        meta: {
            eventLimit,
            relatedPendingOperationCount: relatedPendingOperations.length,
            residualAuditSource: residualAudit.source,
            residualAuditProposalId: residualAudit.proposalId
        }
    };
};
