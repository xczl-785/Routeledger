import crypto from "node:crypto";
import path from "node:path";
import { buildShutdownStateReason, describeVersionState } from "../domain/route-semantics.js";
import { attachProjectAggregateHeadRevision, getProjectAggregateHeadRevision } from "../ports/storage-port.js";
import { assertDeferredRouteTarget, evaluateCloseGate, evaluateStartGate, resolveResidualAudit } from "../services/gate-service.js";
import { createDomainContext } from "../services/operation.js";
import { createProject, setCurrentVersion as setCurrentVersionDomain, setProjectContentLocale as setProjectContentLocaleDomain } from "../services/project-service.js";
import { createTransitionEvents } from "../services/transition-event-service.js";
import { closeVersion as closeVersionDomain, markVersionComplete as markVersionCompleteDomain, prepareVersion as prepareVersionDomain, reopenVersion as reopenVersionDomain, shutdownVersion as shutdownVersionDomain, startVersion as startVersionDomain } from "../services/version-service.js";
import { applyVersionTreeMutation, normalizeVersionTreePayload } from "../services/version-tree-service.js";
import { closeTodo as closeTodoDomain, createTodo as createTodoDomain } from "../services/work-item-service.js";
import { deferWork as deferWorkWorkflow, recordConstraint as recordConstraintWorkflow, retireRecordedConstraint, reviewDeferred as reviewDeferredWorkflow } from "../services/workflow-service.js";
import { ApplicationError } from "./errors.js";
import { buildCurrentContextResult, buildDerivedCurrentContextData, buildNextActionResult, buildVersionsWindowResult } from "./current-context-query.js";
import { runDocDriftCheck } from "./doc-drift-query.js";
import { buildVersionCloseoutPlan } from "./version-closeout-planner.js";
import { clampCloseoutEventLimit, collectVersionCloseoutView, isSelfReferentialUndoForVersion } from "./version-closeout-query.js";
import { BATCH_CREATE_VERSIONS_MODES, BATCH_PREVIOUS_CURRENT_POLICIES, isBatchCreateVersionsMode, isBatchPreviousCurrentPolicy, isRouteOperationWorkflowMode } from "./types.js";
const DEFAULT_APPROVAL_WINDOW_MS = 60 * 60 * 1000;
const DIAGNOSTIC_VERSION_PATTERNS = [/_probe/i, /\bprobe\b/i, /diagnostic/i, /test-only/i];
const cloneSnapshot = (snapshot) => {
    const cloned = structuredClone(snapshot);
    const headRevision = getProjectAggregateHeadRevision(snapshot);
    return headRevision === undefined
        ? cloned
        : attachProjectAggregateHeadRevision(cloned, headRevision);
};
const sortKeys = (value) => {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value !== null && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((accumulator, key) => {
            accumulator[key] = sortKeys(value[key]);
            return accumulator;
        }, {});
    }
    return value;
};
const stableStringify = (value) => JSON.stringify(sortKeys(value));
const addMilliseconds = (isoString, milliseconds) => new Date(new Date(isoString).getTime() + milliseconds).toISOString();
const assertBatchCreateVersionsMode = (mode) => {
    if (isBatchCreateVersionsMode(mode)) {
        return mode;
    }
    throw new ApplicationError("BATCH_CREATE_VERSIONS_MODE_INVALID", "batch_create_versions mode 仅支持 preflight 或 propose", {
        receivedMode: mode ?? null,
        allowedModes: [...BATCH_CREATE_VERSIONS_MODES]
    });
};
const assertBatchPreviousCurrentPolicy = (previousCurrentPolicy) => {
    if (previousCurrentPolicy === undefined) {
        return undefined;
    }
    if (isBatchPreviousCurrentPolicy(previousCurrentPolicy)) {
        return previousCurrentPolicy;
    }
    throw new ApplicationError("BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID", "batch_create_versions previousCurrentPolicy 仅支持 leave_as_is 或 require_complete_or_close", {
        receivedPreviousCurrentPolicy: previousCurrentPolicy ?? null,
        allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    });
};
const assertRouteOperationWorkflowMode = (mode) => {
    if (mode === undefined) {
        return "dry_run";
    }
    if (isRouteOperationWorkflowMode(mode)) {
        return mode;
    }
    throw new ApplicationError("ROUTE_OPERATION_WORKFLOW_MODE_INVALID", "workflow mode 仅支持 dry_run 或 propose", {
        receivedMode: mode ?? null,
        allowedModes: ["dry_run", "propose"]
    });
};
const makeHumanReviewText = (operation) => {
    const blockerCodes = operation.gateSnapshot.blockers.map((blocker) => blocker.code);
    const shutdownLines = operation.actionType === "shutdown_version" && operation.gateSnapshot.kind === "shutdown"
        ? [
            "forced-path: shutdown_version",
            `stateReason: ${operation.gateSnapshot.stateReason}`,
            operation.gateSnapshot.ordinaryCloseGate.blockers.length > 0
                ? `ordinaryCloseBlockers: ${operation.gateSnapshot.ordinaryCloseGate.blockers
                    .map((blocker) => blocker.code)
                    .join(", ")}`
                : "ordinaryCloseBlockers: none"
        ]
        : [];
    return [
        `RouteLedger proposal ${operation.id}`,
        `action: ${operation.actionType}`,
        `target: ${operation.targetId}`,
        `digest: ${operation.digest.value}`,
        `reason: ${operation.reason}`,
        blockerCodes.length > 0 ? `blockers: ${blockerCodes.join(", ")}` : "blockers: none",
        ...shutdownLines
    ].join("\n");
};
const createAuditEvents = (drafts, projectId, actor, now, operationId, deps, startSeq = 0) => createTransitionEvents(drafts, {
    projectId,
    actor,
    now,
    operationId
}, deps.idGenerator, {
    startSeq
});
const replaceRecord = (records, nextRecord) => records.map((record) => (record.id === nextRecord.id ? nextRecord : record));
const appendRecord = (records, nextRecord) => records.some((record) => record.id === nextRecord.id)
    ? replaceRecord(records, nextRecord)
    : records.concat(nextRecord);
const summarizeVersion = (version) => ({
    ...describeVersionState(version),
    id: version.id,
    title: version.title,
    state: version.state,
    order: version.order,
    isCurrent: version.isCurrent,
    isDiagnostic: isDiagnosticVersion(version),
    updatedAt: version.updatedAt
});
const summarizeCurrentVersion = (version) => ({
    ...summarizeVersion(version),
    description: version.description
});
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
const summarizeVersionStructureVersion = (version) => ({
    ...summarizeCurrentVersion(version),
    parentVersionId: version.parentVersionId,
    previousVersionId: version.previousVersionId,
    nextVersionId: version.nextVersionId
});
const summarizeVersionStructureUndo = (undo) => ({
    ...summarizeOpenUndo(undo),
    status: undo.status
});
const summarizeGuideVersion = (version) => ({
    id: version.id,
    title: version.title,
    state: version.state,
    isCurrent: version.isCurrent
});
const isDiagnosticVersion = (version) => DIAGNOSTIC_VERSION_PATTERNS.some((pattern) => pattern.test(version.title));
const collectBlockerIds = (blockers) => [
    ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];
const buildTransitionWorkflowEvaluation = (snapshot, versionId) => {
    const targetVersion = requireVersion(snapshot, versionId);
    const currentVersionId = snapshot.project.currentVersionId;
    const currentVersion = currentVersionId === null ? null : requireVersion(snapshot, currentVersionId);
    const targetIsCurrent = currentVersionId === targetVersion.id;
    if (targetVersion.state === "running") {
        return {
            status: targetIsCurrent ? "noop" : "ready",
            currentVersionId,
            targetVersion,
            nextActionType: targetIsCurrent ? null : "set_current_version",
            stepsRemaining: targetIsCurrent ? [] : ["set_current_version"],
            blockers: [],
            dueDeferredIds: [],
            blockedConstraintIds: []
        };
    }
    if (targetVersion.state === "ready") {
        const gate = evaluateStartGate({
            targetVersion,
            currentVersionTodos: currentVersion === null
                ? []
                : snapshot.todos.filter((todo) => todo.versionId === currentVersion.id &&
                    (todo.status === "wait" || todo.status === "running")),
            dueUndos: snapshot.undos.filter((undo) => undo.status === "wait"),
            deferredItems: snapshot.deferredItems,
            constraints: snapshot.constraints,
            constraintChecks: []
        });
        return {
            status: gate.allowed ? "ready" : "blocked",
            currentVersionId,
            targetVersion,
            nextActionType: gate.allowed ? (targetIsCurrent ? "start_version" : "set_current_version") : null,
            stepsRemaining: gate.allowed
                ? targetIsCurrent
                    ? ["start_version"]
                    : ["set_current_version", "start_version"]
                : [],
            blockers: gate.blockers,
            dueDeferredIds: gate.dueDeferredIds,
            blockedConstraintIds: gate.blockedConstraintIds
        };
    }
    const stateSpecificBlockers = {
        wait: [
            {
                code: "TARGET_VERSION_NOT_READY",
                message: "目标 version 仍处于 wait；需先 prepare_version 再 transition。",
                recordIds: [targetVersion.id]
            }
        ],
        ready: [],
        running: [],
        suspend: [
            {
                code: "TARGET_VERSION_SUSPENDED",
                message: "目标 version 处于 suspend；需先 reopen_version 再 transition。",
                recordIds: [targetVersion.id]
            }
        ],
        complete: [
            {
                code: "TARGET_VERSION_COMPLETE",
                message: "目标 version 已 complete；transition_version 不会把完成边界重新作为 active route。",
                recordIds: [targetVersion.id]
            }
        ],
        close: [
            {
                code: "TARGET_VERSION_CLOSED",
                message: "目标 version 已 close；需先 reopen_version 才能继续。",
                recordIds: [targetVersion.id]
            }
        ]
    };
    return {
        status: "blocked",
        currentVersionId,
        targetVersion,
        nextActionType: null,
        stepsRemaining: [],
        blockers: stateSpecificBlockers[targetVersion.state],
        dueDeferredIds: [],
        blockedConstraintIds: []
    };
};
const resolveCloseResidualAudit = (snapshot, versionId, input) => resolveResidualAudit(input, snapshot.pendingOperations
    .filter((operation) => operation.status === "pending" &&
    operation.actionType === "close_version" &&
    operation.targetId === versionId)
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((operation) => ({
    id: operation.id,
    residualAudit: operation.payload.residualAudit,
    residualAuditReviewed: operation.payload.residualAuditReviewed
})));
const buildVersionStructureLegalOperations = (snapshot, focusVersion, residualAudit) => {
    const transition = buildTransitionWorkflowEvaluation(snapshot, focusVersion.id);
    const resolvedAudit = resolveCloseResidualAudit(snapshot, focusVersion.id, residualAudit);
    const closeGate = evaluateCloseGate({
        version: focusVersion,
        todos: snapshot.todos.filter((todo) => todo.versionId === focusVersion.id),
        undos: snapshot.undos.filter((undo) => undo.versionId === focusVersion.id ||
            undo.originVersionId === focusVersion.id ||
            undo.preferredResolutionVersionId === focusVersion.id),
        residualAudit: resolvedAudit.audit,
        knownVersions: snapshot.versions,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
    });
    return [
        {
            actionType: "prepare_version",
            allowed: focusVersion.state === "wait",
            summary: "wait -> ready",
            blockers: focusVersion.state === "wait"
                ? []
                : [
                    {
                        code: "INVALID_VERSION_TRANSITION",
                        message: "prepare_version 仅适用于 wait version。",
                        recordIds: [focusVersion.id]
                    }
                ]
        },
        {
            actionType: "transition_version",
            allowed: transition.status === "ready",
            summary: transition.status === "noop"
                ? "目标 version 已是 current 且处于 running。"
                : transition.stepsRemaining.length > 0
                    ? `剩余步骤: ${transition.stepsRemaining.join(" -> ")}`
                    : "当前不可 transition。",
            blockers: transition.blockers,
            details: {
                currentVersionId: transition.currentVersionId,
                targetState: transition.targetVersion.state,
                stepsRemaining: transition.stepsRemaining
            }
        },
        {
            actionType: "mark_version_complete",
            allowed: focusVersion.state === "running",
            summary: "running -> complete",
            blockers: focusVersion.state === "running"
                ? []
                : [
                    {
                        code: "INVALID_VERSION_TRANSITION",
                        message: "mark_version_complete 仅适用于 running version。",
                        recordIds: [focusVersion.id]
                    }
                ]
        },
        {
            actionType: "close_version",
            allowed: closeGate.allowed,
            summary: "complete -> close，且需要 residual audit 与所有 open item 收口。",
            blockers: closeGate.blockers,
            details: {
                unresolvedTodoIds: closeGate.unresolvedTodoIds,
                unresolvedUndoIds: closeGate.unresolvedUndoIds,
                unresolvedDeferredIds: closeGate.unresolvedDeferredIds,
                blockedConstraintIds: closeGate.blockedConstraintIds
            }
        },
        {
            actionType: "shutdown_version",
            allowed: focusVersion.state !== "close",
            summary: "Forced path: emergency shutdown closes the version even if ordinary close blockers still exist.",
            blockers: focusVersion.state !== "close"
                ? []
                : [
                    {
                        code: "VERSION_ALREADY_CLOSED",
                        message: "已 close 的 version 不能再次执行 shutdown_version。",
                        recordIds: [focusVersion.id]
                    }
                ],
            details: {
                forced: true,
                stateReasonPrefix: "shutdown:",
                ordinaryCloseGate: {
                    allowed: closeGate.allowed,
                    unresolvedTodoIds: closeGate.unresolvedTodoIds,
                    unresolvedUndoIds: closeGate.unresolvedUndoIds,
                    unresolvedDeferredIds: closeGate.unresolvedDeferredIds,
                    blockedConstraintIds: closeGate.blockedConstraintIds,
                    blockerCodes: closeGate.blockers.map((blocker) => blocker.code)
                }
            }
        },
        {
            actionType: "reopen_version",
            allowed: focusVersion.state === "close" || focusVersion.state === "suspend",
            summary: "close|suspend -> ready",
            blockers: focusVersion.state === "close" || focusVersion.state === "suspend"
                ? []
                : [
                    {
                        code: "INVALID_VERSION_TRANSITION",
                        message: "reopen_version 仅适用于 close 或 suspend version。",
                        recordIds: [focusVersion.id]
                    }
                ]
        },
        {
            actionType: "set_current_version",
            allowed: !focusVersion.isCurrent,
            summary: "切换 current 指针；若旧 current 处于 running，会自动 suspend 旧 current。",
            blockers: focusVersion.isCurrent
                ? [
                    {
                        code: "TARGET_ALREADY_CURRENT",
                        message: "目标 version 已是 current。",
                        recordIds: [focusVersion.id]
                    }
                ]
                : []
        },
        {
            actionType: "create_todo",
            allowed: true,
            summary: "为当前 version 补充待办。",
            blockers: []
        }
    ];
};
const buildVersionTransitionGuide = (snapshot, input) => {
    const pendingProposalIds = snapshot.pendingOperations
        .filter((operation) => operation.status === "pending")
        .map((operation) => operation.id);
    const notes = [
        "Read-only guide only. It never creates pending proposals; execute the listed existing tools step by step."
    ];
    const currentVersion = snapshot.project.currentVersionId === null
        ? null
        : requireVersion(snapshot, snapshot.project.currentVersionId);
    const resolvedFromVersionId = input.fromVersionId ?? currentVersion?.id;
    if (resolvedFromVersionId === undefined) {
        throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version，且未提供 fromVersionId", {
            projectId: input.projectId
        });
    }
    const fromVersion = requireVersion(snapshot, resolvedFromVersionId);
    const targetVersion = requireVersion(snapshot, input.targetVersionId);
    const currentVersionOpenTodos = currentVersion === null
        ? []
        : snapshot.todos.filter((todo) => todo.versionId === currentVersion.id &&
            (todo.status === "wait" || todo.status === "running"));
    const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
    const residualAudit = resolveCloseResidualAudit(snapshot, fromVersion.id, input.residualAudit);
    const closeGateEvaluation = evaluateCloseGate({
        version: fromVersion,
        todos: snapshot.todos.filter((todo) => todo.versionId === fromVersion.id),
        undos: snapshot.undos.filter((undo) => undo.versionId === fromVersion.id ||
            undo.originVersionId === fromVersion.id ||
            undo.preferredResolutionVersionId === fromVersion.id),
        residualAudit: residualAudit.audit,
        knownVersions: snapshot.versions,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
    });
    const startGateEvaluation = targetVersion.state === "running"
        ? {
            allowed: true,
            blockers: [],
            openTodoIds: currentVersionOpenTodos.map((todo) => todo.id),
            dueUndoIds: dueUndos
                .filter((undo) => undo.preferredResolutionVersionId === targetVersion.id)
                .map((undo) => undo.id),
            selfReferentialUndoIds: dueUndos
                .filter((undo) => isSelfReferentialUndoForVersion(undo, targetVersion.id))
                .map((undo) => undo.id),
            missingDecisionRefs: [],
            dueDeferredIds: snapshot.deferredItems
                .filter((deferred) => deferred.status === "pending" &&
                deferred.targetReviewVersionId === targetVersion.id)
                .map((deferred) => deferred.id),
            blockedConstraintIds: []
        }
        : evaluateStartGate({
            targetVersion,
            currentVersionTodos: currentVersionOpenTodos,
            dueUndos,
            deferredItems: snapshot.deferredItems,
            constraints: snapshot.constraints,
            constraintChecks: []
        });
    const closeGate = {
        versionId: fromVersion.id,
        allowed: fromVersion.state === "close" ? true : closeGateEvaluation.allowed,
        applicable: fromVersion.state !== "close",
        openTodoIds: closeGateEvaluation.unresolvedTodoIds,
        openUndoIds: closeGateEvaluation.unresolvedUndoIds,
        unresolvedDeferredIds: closeGateEvaluation.unresolvedDeferredIds,
        blockedConstraintIds: closeGateEvaluation.blockedConstraintIds,
        residualAuditProvided: residualAudit.audit !== null,
        residualAuditRequired: fromVersion.state !== "close",
        residualAuditSource: residualAudit.source,
        residualAuditProposalId: residualAudit.proposalId,
        blockers: fromVersion.state === "close" ? [] : closeGateEvaluation.blockers
    };
    const startGate = {
        versionId: targetVersion.id,
        allowed: targetVersion.state === "running" && targetVersion.isCurrent
            ? true
            : startGateEvaluation.allowed,
        applicable: targetVersion.state !== "running",
        currentVersionId: currentVersion?.id ?? null,
        openCurrentTodoIds: startGateEvaluation.openTodoIds,
        dueUndoIds: startGateEvaluation.dueUndoIds,
        dueDeferredIds: startGateEvaluation.dueDeferredIds,
        blockedConstraintIds: startGateEvaluation.blockedConstraintIds,
        selfReferentialUndoIds: startGateEvaluation.selfReferentialUndoIds,
        blockers: targetVersion.state === "running" && targetVersion.isCurrent
            ? []
            : startGateEvaluation.blockers
    };
    const recommendedSteps = [];
    const addStep = (step) => {
        recommendedSteps.push(step);
    };
    const buildGuide = (status, steps, guideCloseGate = closeGate, guideStartGate = startGate) => ({
        project: {
            id: snapshot.project.id,
            name: snapshot.project.name,
            currentVersionId: snapshot.project.currentVersionId
        },
        workflowMode: "read_only",
        status,
        fromVersion: summarizeGuideVersion(fromVersion),
        currentVersion: currentVersion === null ? null : summarizeGuideVersion(currentVersion),
        targetVersion: summarizeGuideVersion(targetVersion),
        pendingProposalIds,
        closeGate: guideCloseGate,
        startGate: guideStartGate,
        recommendedSteps: steps,
        notes
    });
    const selfTargetIsCurrent = currentVersion?.id === fromVersion.id && fromVersion.id === targetVersion.id;
    if (pendingProposalIds.length > 0) {
        notes.push("Pending L3 proposals already exist. Resolve them first so the live route and approval chain stay unambiguous.");
        return buildGuide("manual_review", [
            {
                stepId: "review-pending-proposals",
                label: "Review pending L3 proposals",
                status: "ready",
                recommendedTool: "list_l3_proposals",
                createsL3Proposal: false,
                actionType: "review_pending_proposals",
                reason: "现有 pending proposal 会改变 live route，guide 不会替你裁决、复用或生成新的 proposal。",
                blockerIds: pendingProposalIds
            }
        ]);
    }
    if (selfTargetIsCurrent) {
        const selfCloseGate = fromVersion.state === "complete" || fromVersion.state === "close"
            ? closeGate
            : {
                ...closeGate,
                allowed: false,
                applicable: false,
                residualAuditRequired: false,
                blockers: []
            };
        const selfStartGate = targetVersion.state === "ready"
            ? startGate
            : {
                ...startGate,
                allowed: targetVersion.state === "running",
                applicable: false,
                blockers: []
            };
        if (targetVersion.state === "wait") {
            return buildGuide("ready", [
                {
                    stepId: "prepare-current-version",
                    label: "Prepare current version",
                    status: "ready",
                    recommendedTool: "prepare_version",
                    createsL3Proposal: false,
                    actionType: "prepare_version",
                    reason: "current version 仍是 wait；先用 prepare_version 进入 ready，再重新读取 guide。",
                    blockerIds: []
                }
            ], selfCloseGate, selfStartGate);
        }
        if (targetVersion.state === "running") {
            notes.push("fromVersion and targetVersion already identify the current running version; no route operation is needed.");
            return buildGuide("noop", [], selfCloseGate, selfStartGate);
        }
        if (targetVersion.state === "close") {
            notes.push("fromVersion and targetVersion already identify the current closed version; no route operation is needed.");
            return buildGuide("noop", [], selfCloseGate, selfStartGate);
        }
        if (targetVersion.state === "ready") {
            const startStatus = startGate.allowed
                ? "ready"
                : "blocked";
            const selfStartSteps = [
                {
                    stepId: "start-current-version",
                    label: "Start current version",
                    status: startStatus,
                    recommendedTool: "transition_version",
                    createsL3Proposal: true,
                    actionType: "start_version",
                    reason: startGate.allowed
                        ? "current version 已 ready；用 transition_version 生成 start_version proposal。"
                        : "current version start gate 仍有 blockers，transition_version 目前不会创建 proposal。",
                    blockerIds: collectBlockerIds(startGate.blockers)
                },
                {
                    stepId: "approve-start-current-proposal",
                    label: "Approve start proposal",
                    status: startStatus === "ready" ? "waiting" : "not_needed",
                    recommendedTool: "approve_l3_operation",
                    createsL3Proposal: false,
                    actionType: "start_version",
                    reason: "start_version proposal 创建后，再走现有 approve_l3_operation 审批链。",
                    blockerIds: startStatus === "blocked" ? collectBlockerIds(startGate.blockers) : []
                },
                {
                    stepId: "commit-start-current-proposal",
                    label: "Commit start proposal",
                    status: startStatus === "ready" ? "waiting" : "not_needed",
                    recommendedTool: "commit_l3_operation",
                    createsL3Proposal: false,
                    actionType: "start_version",
                    reason: "审批通过后，再提交 start_version proposal。",
                    blockerIds: startStatus === "blocked" ? collectBlockerIds(startGate.blockers) : []
                }
            ];
            return buildGuide(startStatus === "ready" ? "ready" : "blocked", selfStartSteps, selfCloseGate, selfStartGate);
        }
        if (targetVersion.state === "complete") {
            const closeStatus = closeGate.allowed
                ? "ready"
                : "blocked";
            const selfCloseSteps = [
                {
                    stepId: "close-current-version",
                    label: "Close current version boundary",
                    status: closeStatus,
                    recommendedTool: "close_version",
                    createsL3Proposal: true,
                    actionType: "close_version",
                    reason: closeGate.allowed
                        ? "current version 已满足 close gate；用 close_version 生成 close proposal。"
                        : "current version close gate 仍未通过，需先处理 blockers 或补 residual audit。",
                    blockerIds: collectBlockerIds(closeGate.blockers)
                },
                {
                    stepId: "approve-close-current-proposal",
                    label: "Approve close proposal",
                    status: closeStatus === "ready" ? "waiting" : "not_needed",
                    recommendedTool: "approve_l3_operation",
                    createsL3Proposal: false,
                    actionType: "close_version",
                    reason: "close_version proposal 创建后，再走现有 approve_l3_operation 审批链。",
                    blockerIds: closeStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
                },
                {
                    stepId: "commit-close-current-proposal",
                    label: "Commit close proposal",
                    status: closeStatus === "ready" ? "waiting" : "not_needed",
                    recommendedTool: "commit_l3_operation",
                    createsL3Proposal: false,
                    actionType: "close_version",
                    reason: "拿到 approval artifact 后，再用 commit_l3_operation 落地 close。",
                    blockerIds: closeStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
                }
            ];
            return buildGuide(closeStatus === "ready" ? "ready" : "blocked", selfCloseSteps, selfCloseGate, selfStartGate);
        }
    }
    const fromIsCurrent = currentVersion?.id === fromVersion.id;
    const manualTargetStates = ["suspend", "complete", "close"];
    const requiresManualReview = !fromIsCurrent ||
        manualTargetStates.includes(targetVersion.state);
    if (!fromIsCurrent) {
        notes.push("fromVersion 不是当前 current version。请先确认 live current，再决定是否仍按该 from -> target 顺序推进。");
    }
    if (manualTargetStates.includes(targetVersion.state)) {
        notes.push(`target version 目前是 ${targetVersion.state}，已超出本 guide 的常规 close -> start 向导路径。`);
    }
    if (startGate.selfReferentialUndoIds.length > 0) {
        notes.push("Target start gate contains self-referential undo blockers. Treat them as controller judgment items instead of guessing whether they are rollback guardrails or delayed cleanup.");
    }
    const closeProposalStatus = requiresManualReview
        ? "waiting"
        : fromVersion.state === "close"
            ? "not_needed"
            : closeGate.allowed
                ? "ready"
                : "blocked";
    addStep({
        stepId: "close-from-version",
        label: "Close from version boundary",
        status: closeProposalStatus,
        recommendedTool: "close_version",
        createsL3Proposal: true,
        actionType: "close_version",
        reason: fromVersion.state === "close"
            ? "from version 已经 close，无需再次创建 close proposal。"
            : closeGate.allowed
                ? "from version 已满足 close gate，可先用 close_version 生成 close proposal。"
                : "from version close gate 仍未通过，需先处理 blockers 或补 residual audit。",
        blockerIds: collectBlockerIds(closeGate.blockers)
    });
    addStep({
        stepId: "approve-close-proposal",
        label: "Approve close proposal",
        status: closeProposalStatus === "ready" || closeProposalStatus === "waiting"
            ? "waiting"
            : "not_needed",
        recommendedTool: "approve_l3_operation",
        createsL3Proposal: false,
        actionType: "close_version",
        reason: "close_version proposal 创建后，再走现有 approve_l3_operation 审批链。",
        blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
    });
    addStep({
        stepId: "commit-close-proposal",
        label: "Commit close proposal",
        status: closeProposalStatus === "ready" || closeProposalStatus === "waiting"
            ? "waiting"
            : "not_needed",
        recommendedTool: "commit_l3_operation",
        createsL3Proposal: false,
        actionType: "close_version",
        reason: "拿到 approval artifact 后，再用 commit_l3_operation 落地 close。",
        blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
    });
    const canProceedPastClose = !requiresManualReview && (fromVersion.state === "close" || closeGate.allowed);
    const prepareTargetStatus = targetVersion.state === "wait"
        ? canProceedPastClose
            ? fromVersion.state === "close"
                ? "ready"
                : "waiting"
            : "waiting"
        : "not_needed";
    addStep({
        stepId: "prepare-target-version",
        label: "Prepare target version",
        status: prepareTargetStatus,
        recommendedTool: "prepare_version",
        createsL3Proposal: false,
        actionType: "prepare_version",
        reason: targetVersion.state === "wait"
            ? "target version 仍是 wait，需先 prepare_version 才能进入 ready/start 路径。"
            : "target version 不在 wait，无需 prepare。",
        blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
    });
    const transitionEvaluation = targetVersion.state === "wait" || manualTargetStates.includes(targetVersion.state)
        ? null
        : buildTransitionWorkflowEvaluation(snapshot, targetVersion.id);
    const transitionActionType = transitionEvaluation?.nextActionType ??
        (targetVersion.state === "ready"
            ? targetVersion.isCurrent
                ? "start_version"
                : "set_current_version"
            : targetVersion.state === "running" && !targetVersion.isCurrent
                ? "set_current_version"
                : targetVersion.state === "running"
                    ? "start_version"
                    : null);
    const transitionProposalStatus = !canProceedPastClose || requiresManualReview
        ? "waiting"
        : targetVersion.state === "wait"
            ? "waiting"
            : transitionEvaluation === null
                ? "blocked"
                : transitionEvaluation.status === "noop"
                    ? "not_needed"
                    : transitionEvaluation.status === "blocked"
                        ? "blocked"
                        : fromVersion.state === "close"
                            ? "ready"
                            : "waiting";
    const transitionBlockers = transitionEvaluation?.blockers ?? startGate.blockers;
    addStep({
        stepId: "transition-to-target",
        label: transitionActionType === "start_version"
            ? "Start target version"
            : "Set current to target version",
        status: transitionProposalStatus,
        recommendedTool: "transition_version",
        createsL3Proposal: true,
        actionType: transitionActionType,
        reason: transitionEvaluation?.status === "noop"
            ? "target version 已经是 current 且处于 running，本步无需执行。"
            : targetVersion.state === "wait"
                ? "target version 尚未 ready；先 prepare，再重新进入 transition_version。"
                : transitionEvaluation?.status === "blocked"
                    ? "target start gate 仍有 blockers，transition_version 目前不会创建 proposal。"
                    : transitionActionType === "start_version"
                        ? "关闭 from 边界后，用 transition_version 生成 start_version proposal。"
                        : "关闭 from 边界后，用 transition_version 先生成 set_current_version proposal。",
        blockerIds: collectBlockerIds(transitionBlockers)
    });
    addStep({
        stepId: "approve-transition-proposal",
        label: "Approve transition proposal",
        status: transitionProposalStatus === "ready" || transitionProposalStatus === "waiting"
            ? "waiting"
            : "not_needed",
        recommendedTool: "approve_l3_operation",
        createsL3Proposal: false,
        actionType: transitionActionType,
        reason: "transition_version 创建 proposal 后，再审批对应 L3 proposal。",
        blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
    });
    addStep({
        stepId: "commit-transition-proposal",
        label: "Commit transition proposal",
        status: transitionProposalStatus === "ready" || transitionProposalStatus === "waiting"
            ? "waiting"
            : "not_needed",
        recommendedTool: "commit_l3_operation",
        createsL3Proposal: false,
        actionType: transitionActionType,
        reason: "审批通过后，再提交对应的 transition proposal。",
        blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
    });
    const needsStartAfterSetCurrent = transitionEvaluation?.status === "ready" &&
        transitionEvaluation.nextActionType === "set_current_version" &&
        targetVersion.state === "ready";
    addStep({
        stepId: "start-target-after-switch",
        label: "Start target after current switch",
        status: needsStartAfterSetCurrent
            ? "waiting"
            : "not_needed",
        recommendedTool: "transition_version",
        createsL3Proposal: true,
        actionType: "start_version",
        reason: needsStartAfterSetCurrent
            ? "set_current_version 提交后，需要再次执行 transition_version 生成 start_version proposal。"
            : "当前路径不需要额外的二次 start proposal。",
        blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
    });
    addStep({
        stepId: "approve-start-after-switch",
        label: "Approve start proposal",
        status: needsStartAfterSetCurrent ? "waiting" : "not_needed",
        recommendedTool: "approve_l3_operation",
        createsL3Proposal: false,
        actionType: "start_version",
        reason: "二次 transition_version 创建 start proposal 后，再审批。",
        blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
    });
    addStep({
        stepId: "commit-start-after-switch",
        label: "Commit start proposal",
        status: needsStartAfterSetCurrent ? "waiting" : "not_needed",
        recommendedTool: "commit_l3_operation",
        createsL3Proposal: false,
        actionType: "start_version",
        reason: "审批通过后，再提交 start proposal。",
        blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
    });
    const status = requiresManualReview
        ? "manual_review"
        : fromVersion.id === targetVersion.id && targetVersion.isCurrent && targetVersion.state === "running"
            ? "noop"
            : closeProposalStatus === "blocked" || transitionProposalStatus === "blocked"
                ? "blocked"
                : recommendedSteps.some((step) => step.status === "ready")
                    ? "ready"
                    : "noop";
    return buildGuide(status, recommendedSteps);
};
const requireProject = async (storage, projectId) => {
    const snapshot = await storage.loadProjectAggregate(projectId);
    if (snapshot === null) {
        throw new ApplicationError("PROJECT_NOT_FOUND", "project 不存在", {
            projectId
        });
    }
    if (snapshot.project.id !== projectId) {
        throw new ApplicationError("PROJECT_OWNERSHIP_MISMATCH", "storage 返回的 project 与请求 project 不一致", {
            projectId,
            actualProjectId: snapshot.project.id
        });
    }
    return cloneSnapshot(snapshot);
};
const requireVersion = (snapshot, versionId) => {
    const version = snapshot.versions.find((item) => item.id === versionId);
    if (version === undefined) {
        throw new ApplicationError("VERSION_NOT_FOUND", "version 不存在", {
            projectId: snapshot.project.id,
            versionId
        });
    }
    if (version.projectId !== snapshot.project.id) {
        throw new ApplicationError("VERSION_OWNERSHIP_MISMATCH", "version 不属于当前 project", {
            projectId: snapshot.project.id,
            versionId,
            actualProjectId: version.projectId
        });
    }
    return version;
};
const requireTodo = (snapshot, todoId) => {
    const todo = snapshot.todos.find((item) => item.id === todoId);
    if (todo === undefined) {
        throw new ApplicationError("TODO_NOT_FOUND", "todo 不存在", {
            projectId: snapshot.project.id,
            todoId
        });
    }
    if (todo.projectId !== snapshot.project.id) {
        throw new ApplicationError("TODO_OWNERSHIP_MISMATCH", "todo 不属于当前 project", {
            projectId: snapshot.project.id,
            todoId,
            actualProjectId: todo.projectId
        });
    }
    return todo;
};
const requireWorkItem = (snapshot, workItemId) => {
    const workItem = snapshot.workItems.find((item) => item.id === workItemId);
    if (workItem === undefined) {
        throw new ApplicationError("WORK_ITEM_NOT_FOUND", "work_item 不存在", {
            projectId: snapshot.project.id,
            workItemId
        });
    }
    if (workItem.projectId !== snapshot.project.id) {
        throw new ApplicationError("WORK_ITEM_OWNERSHIP_MISMATCH", "work_item 不属于当前 project", {
            projectId: snapshot.project.id,
            workItemId,
            actualProjectId: workItem.projectId
        });
    }
    return workItem;
};
const requireDeferred = (snapshot, deferredId) => {
    const deferred = snapshot.deferredItems.find((item) => item.id === deferredId);
    if (deferred === undefined) {
        throw new ApplicationError("DEFERRED_NOT_FOUND", "deferred item 不存在", {
            projectId: snapshot.project.id,
            deferredId
        });
    }
    if (deferred.projectId !== snapshot.project.id) {
        throw new ApplicationError("DEFERRED_OWNERSHIP_MISMATCH", "deferred item 不属于当前 project", {
            projectId: snapshot.project.id,
            deferredId,
            actualProjectId: deferred.projectId
        });
    }
    return deferred;
};
const requireConstraint = (snapshot, constraintId) => {
    const constraint = snapshot.constraints.find((item) => item.id === constraintId);
    if (constraint === undefined) {
        throw new ApplicationError("CONSTRAINT_NOT_FOUND", "constraint 不存在", {
            projectId: snapshot.project.id,
            constraintId
        });
    }
    if (constraint.projectId !== snapshot.project.id) {
        throw new ApplicationError("CONSTRAINT_OWNERSHIP_MISMATCH", "constraint 不属于当前 project", {
            projectId: snapshot.project.id,
            constraintId,
            actualProjectId: constraint.projectId
        });
    }
    return constraint;
};
const requireDeferredActiveWorkItem = (snapshot, deferred) => {
    const workItem = requireWorkItem(snapshot, deferred.workItemId);
    if (workItem.status !== "active" ||
        workItem.activeRecordType !== "deferred" ||
        workItem.activeRecordId !== deferred.id) {
        throw new ApplicationError("INVALID_WORK_ITEM_ACTIVE", "WorkItem active 指针与 Deferred 不一致", {
            projectId: snapshot.project.id,
            deferredId: deferred.id,
            workItemId: workItem.id,
            status: workItem.status,
            activeRecordType: workItem.activeRecordType,
            activeRecordId: workItem.activeRecordId
        });
    }
    return workItem;
};
const requirePendingOperation = (snapshot, pendingOperationId) => {
    const pendingOperation = snapshot.pendingOperations.find((item) => item.id === pendingOperationId);
    if (pendingOperation === undefined) {
        throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
            projectId: snapshot.project.id,
            pendingOperationId
        });
    }
    return pendingOperation;
};
const requireApprovalArtifact = (snapshot, approvalArtifactId) => {
    const artifact = snapshot.approvalArtifacts.find((item) => item.id === approvalArtifactId);
    if (artifact === undefined) {
        throw new ApplicationError("APPROVAL_ARTIFACT_NOT_FOUND", "approval artifact 不存在", {
            projectId: snapshot.project.id,
            approvalArtifactId
        });
    }
    return artifact;
};
const buildStartGateSnapshot = (result, evaluatedAt) => ({
    kind: "start",
    evaluatedAt,
    allowed: result.allowed,
    blockers: result.blockers,
    openTodoIds: result.openTodoIds,
    dueUndoIds: result.dueUndoIds,
    dueDeferredIds: result.dueDeferredIds,
    missingDecisionRefs: result.missingDecisionRefs,
    blockedConstraintIds: result.blockedConstraintIds
});
const buildCloseGateSnapshot = (result, evaluatedAt, residualAudit) => {
    const resolved = resolveResidualAudit(residualAudit);
    return {
        kind: "close",
        evaluatedAt,
        allowed: result.allowed,
        blockers: result.blockers,
        unresolvedTodoIds: result.unresolvedTodoIds,
        unresolvedUndoIds: result.unresolvedUndoIds,
        unresolvedDeferredIds: result.unresolvedDeferredIds,
        blockedConstraintIds: result.blockedConstraintIds,
        residualAudit: resolved.audit?.items ?? null,
        residualAuditReviewed: resolved.audit !== null
    };
};
const buildShutdownGateSnapshot = (result, evaluatedAt, stateReason) => ({
    kind: "shutdown",
    evaluatedAt,
    allowed: result.allowed,
    blockers: result.blockers,
    forced: true,
    stateReason,
    ordinaryCloseGate: {
        allowed: result.ordinaryCloseGate.allowed,
        blockers: result.ordinaryCloseGate.blockers,
        unresolvedTodoIds: result.ordinaryCloseGate.unresolvedTodoIds,
        unresolvedUndoIds: result.ordinaryCloseGate.unresolvedUndoIds,
        unresolvedDeferredIds: result.ordinaryCloseGate.unresolvedDeferredIds,
        blockedConstraintIds: result.ordinaryCloseGate.blockedConstraintIds
    }
});
const buildNoopGateSnapshot = (evaluatedAt) => ({
    kind: "none",
    evaluatedAt,
    allowed: true,
    blockers: []
});
const DEFAULT_BATCH_PREVIOUS_CURRENT_POLICY = "leave_as_is";
const normalizeBatchText = (value) => value?.trim() ?? "";
const normalizeBatchRef = (value) => {
    const normalized = value?.trim() ?? "";
    return normalized.length === 0 ? null : normalized;
};
const buildBatchPreviewVersionId = (index, clientKey) => `batch-preview:${index}:${clientKey}`;
const buildBatchSummary = (requestedCount, issues) => {
    const invalidIndexes = new Set(issues.filter((issue) => issue.index >= 0).map((issue) => issue.index));
    const invalidCount = invalidIndexes.size === 0 && issues.length > 0 ? 1 : invalidIndexes.size;
    return {
        requestedCount,
        validCount: Math.max(0, requestedCount - invalidIndexes.size),
        invalidCount
    };
};
const buildBatchSuggestion = (code) => {
    switch (code) {
        case "MISSING_REQUIRED_FIELD":
            return "补齐缺失字段后重试。";
        case "PROJECT_VERSION_MISMATCH":
            return "改用同一 parent 和 sibling 链内的锚点。";
        case "INVALID_VERSION_TRANSITION":
            return "检查锚点是否相邻、是否引用了 close version，或改为在可写 sibling 尾部追加。";
        case "VERSION_NOT_FOUND":
            return "确认引用的 version id 仍存在于当前 project。";
        case "PARTIAL_NOT_SUPPORTED":
            return "删除 partialAllowed=true；Batch B 只支持原子批量创建。";
        case "SET_CURRENT_TARGET_INVALID":
            return "把 setCurrentTo 改为某个已声明 item 的 clientKey。";
        default:
            return "检查输入 plan 与当前 route 状态后重试。";
    }
};
const buildBatchIssue = (index, clientKey, target, code, message, details) => ({
    index,
    clientKey,
    target,
    code,
    message,
    suggestion: buildBatchSuggestion(code),
    details
});
const buildBatchSnapshotHash = (snapshot) => crypto
    .createHash("sha256")
    .update(stableStringify({
    projectId: snapshot.project.id,
    currentVersionId: snapshot.project.currentVersionId,
    versions: snapshot.versions
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((version) => ({
        id: version.id,
        state: version.state,
        parentVersionId: version.parentVersionId,
        previousVersionId: version.previousVersionId,
        nextVersionId: version.nextVersionId,
        order: version.order,
        isCurrent: version.isCurrent
    }))
}))
    .digest("hex");
const buildBatchPreview = (items, setCurrentTo) => ({
    createdVersions: items.map((item) => ({
        clientKey: item.clientKey,
        previewVersionId: item.previewVersionId,
        title: item.title,
        description: item.description,
        parentVersionId: item.parentVersionId,
        previousRef: item.previousRef,
        nextRef: item.nextRef
    })),
    createdTodos: items.flatMap((item) => item.initialTodos.map((title) => ({
        versionClientKey: item.clientKey,
        previewVersionId: item.previewVersionId,
        title
    }))),
    setCurrentTo
});
const evaluateBatchCurrentPolicy = (snapshot, setCurrentTo, previousCurrentPolicy) => {
    if (setCurrentTo === null || snapshot.project.currentVersionId === null) {
        return {
            risks: [],
            blockers: []
        };
    }
    const currentVersion = requireVersion(snapshot, snapshot.project.currentVersionId);
    const details = {
        currentVersionId: currentVersion.id,
        currentVersionState: currentVersion.state,
        previousCurrentPolicy,
        setCurrentTo
    };
    if (previousCurrentPolicy === "require_complete_or_close" &&
        currentVersion.state !== "complete" &&
        currentVersion.state !== "close") {
        return {
            risks: [],
            blockers: [
                {
                    code: "PREVIOUS_CURRENT_NOT_COMPLETE_OR_CLOSE",
                    message: "旧 current version 未 complete/close，当前 policy 不允许直接切换 current 指针。",
                    details
                }
            ]
        };
    }
    if (currentVersion.state !== "close") {
        return {
            risks: [
                {
                    code: "PREVIOUS_CURRENT_LEFT_AS_IS",
                    message: "旧 current version 会保持原状态；本批不会隐式 suspend 或 close 旧 current。",
                    details
                }
            ],
            blockers: []
        };
    }
    return {
        risks: [],
        blockers: []
    };
};
const evaluateBatchCreateVersions = (snapshot, input, evaluatedAt) => {
    const issues = [];
    const requestedCount = input.items.length;
    const normalizedAnchor = {
        parentVersionId: normalizeBatchRef(input.anchor?.parentVersionId),
        afterVersionId: normalizeBatchRef(input.anchor?.afterVersionId),
        beforeVersionId: normalizeBatchRef(input.anchor?.beforeVersionId)
    };
    const previousCurrentPolicy = assertBatchPreviousCurrentPolicy(input.previousCurrentPolicy) ??
        DEFAULT_BATCH_PREVIOUS_CURRENT_POLICY;
    const sanitizedItems = [];
    const clientKeys = new Set();
    if (input.partialAllowed === true) {
        issues.push(buildBatchIssue(-1, "*", "plan", "PARTIAL_NOT_SUPPORTED", "Batch B 不支持 partialAllowed=true。"));
    }
    if (requestedCount === 0) {
        issues.push(buildBatchIssue(-1, "*", "items", "MISSING_REQUIRED_FIELD", "items 至少需要包含一个 version。"));
    }
    input.items.forEach((item, index) => {
        const clientKey = normalizeBatchText(item.clientKey);
        const title = normalizeBatchText(item.title);
        const hasDescription = Object.prototype.hasOwnProperty.call(item, "description");
        const hasInitialTodos = Object.prototype.hasOwnProperty.call(item, "initialTodos");
        const description = hasDescription ? normalizeBatchText(item.description) : "";
        const rawTodos = hasInitialTodos ? item.initialTodos : undefined;
        const initialTodos = Array.isArray(rawTodos)
            ? rawTodos.map((todo) => normalizeBatchText(todo))
            : [];
        if (clientKey.length === 0) {
            issues.push(buildBatchIssue(index, "", "version", "MISSING_REQUIRED_FIELD", "clientKey 不能为空。"));
        }
        else if (clientKeys.has(clientKey)) {
            issues.push(buildBatchIssue(index, clientKey, "version", "INVALID_VERSION_TRANSITION", "clientKey 不允许重复。"));
        }
        else {
            clientKeys.add(clientKey);
        }
        if (title.length === 0) {
            issues.push(buildBatchIssue(index, clientKey, "version", "MISSING_REQUIRED_FIELD", "title 不能为空。"));
        }
        if (!hasDescription) {
            issues.push(buildBatchIssue(index, clientKey, "version", "MISSING_REQUIRED_FIELD", "description 字段必须显式提供。"));
        }
        if (!hasInitialTodos) {
            issues.push(buildBatchIssue(index, clientKey, "initial_todos", "MISSING_REQUIRED_FIELD", "initialTodos 字段必须显式提供，可为空数组。"));
        }
        else if (!Array.isArray(rawTodos)) {
            issues.push(buildBatchIssue(index, clientKey, "initial_todos", "MISSING_REQUIRED_FIELD", "initialTodos 必须是数组。"));
        }
        initialTodos.forEach((todoTitle, todoIndex) => {
            if (todoTitle.length === 0) {
                issues.push(buildBatchIssue(index, clientKey, "initial_todo", "MISSING_REQUIRED_FIELD", `initialTodos[${todoIndex}] 不能为空。`));
            }
        });
        sanitizedItems.push({
            clientKey,
            title,
            description,
            initialTodos
        });
    });
    if (issues.length > 0) {
        return {
            ok: false,
            code: "BATCH_VERSION_PLAN_INVALID",
            summary: buildBatchSummary(requestedCount, issues),
            issues,
            risks: [],
            blockers: []
        };
    }
    let plannedVersions = snapshot.versions.slice().sort((left, right) => left.order - right.order);
    let previousRef = normalizedAnchor.afterVersionId ?? null;
    const beforeRef = normalizedAnchor.beforeVersionId ?? null;
    const normalizedItems = [];
    let resolvedParentVersionId = normalizedAnchor.parentVersionId ?? null;
    for (let index = 0; index < sanitizedItems.length; index += 1) {
        const item = sanitizedItems[index];
        const previewVersionId = buildBatchPreviewVersionId(index, item.clientKey);
        const actionType = resolvedParentVersionId === null && previousRef === null && beforeRef === null
            ? "create_version"
            : resolvedParentVersionId === null
                ? "insert_version"
                : "create_child_version";
        const payload = {
            title: item.title,
            description: item.description,
            previousVersionId: previousRef,
            nextVersionId: beforeRef
        };
        if (resolvedParentVersionId !== null) {
            payload.parentVersionId = resolvedParentVersionId;
        }
        try {
            const normalizedPayload = normalizeVersionTreePayload({
                versions: plannedVersions,
                actionType,
                targetId: previewVersionId,
                payload
            });
            resolvedParentVersionId = normalizedPayload.parentVersionId ?? null;
            plannedVersions = applyVersionTreeMutation({
                versions: plannedVersions,
                actionType,
                targetId: previewVersionId,
                payload: normalizedPayload,
                actor: snapshot.project.createdBy,
                now: evaluatedAt
            }).versions;
            normalizedItems.push({
                index,
                clientKey: item.clientKey,
                previewVersionId,
                title: item.title,
                description: item.description,
                parentVersionId: normalizedPayload.parentVersionId ?? null,
                previousRef: normalizedPayload.previousVersionId ?? null,
                nextRef: normalizedPayload.nextVersionId ?? null,
                initialTodos: item.initialTodos
            });
            previousRef = previewVersionId;
        }
        catch (error) {
            const code = typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string"
                ? error.code
                : "BATCH_VERSION_PLAN_INVALID";
            const message = error instanceof Error ? error.message : "批量 version plan 校验失败。";
            const details = typeof error === "object" &&
                error !== null &&
                "details" in error &&
                typeof error.details === "object"
                ? (error.details ?? undefined)
                : undefined;
            issues.push(buildBatchIssue(index, item.clientKey, "version", code, message, details));
            break;
        }
    }
    if (issues.length > 0) {
        return {
            ok: false,
            code: "BATCH_VERSION_PLAN_INVALID",
            summary: buildBatchSummary(requestedCount, issues),
            issues,
            risks: [],
            blockers: []
        };
    }
    const setCurrentTo = normalizeBatchRef(input.setCurrentTo);
    if (setCurrentTo !== null &&
        !normalizedItems.some((item) => item.clientKey === setCurrentTo || item.previewVersionId === setCurrentTo)) {
        issues.push(buildBatchIssue(-1, setCurrentTo, "setCurrentTo", "SET_CURRENT_TARGET_INVALID", "setCurrentTo 必须引用某个新建 item 的 clientKey。"));
    }
    if (issues.length > 0) {
        return {
            ok: false,
            code: "BATCH_VERSION_PLAN_INVALID",
            summary: buildBatchSummary(requestedCount, issues),
            issues,
            risks: [],
            blockers: []
        };
    }
    const resolvedAnchors = {
        parentVersionId: resolvedParentVersionId,
        afterVersionId: normalizedAnchor.afterVersionId ?? null,
        beforeVersionId: normalizedAnchor.beforeVersionId ?? null
    };
    const normalizedPlan = {
        partialAllowed: false,
        anchor: normalizedAnchor,
        items: normalizedItems,
        setCurrentTo,
        previousCurrentPolicy
    };
    const preview = buildBatchPreview(normalizedItems, setCurrentTo);
    const { risks, blockers } = evaluateBatchCurrentPolicy(snapshot, setCurrentTo, previousCurrentPolicy);
    const payload = {
        batchItems: sanitizedItems.map((item) => ({
            clientKey: item.clientKey,
            title: item.title,
            description: item.description,
            initialTodos: item.initialTodos
        })),
        batchAnchor: normalizedAnchor,
        batchNormalizedPlan: normalizedItems,
        batchResolvedAnchors: resolvedAnchors,
        batchSetCurrentTo: setCurrentTo,
        batchPreviousCurrentPolicy: previousCurrentPolicy,
        batchPreflightSnapshotHash: buildBatchSnapshotHash(snapshot)
    };
    const digestPreview = buildDigest(snapshot.project.id, "insert_version", snapshot.project.id, payload, buildNoopGateSnapshot(evaluatedAt));
    return {
        ok: true,
        normalizedPlan,
        resolvedAnchors,
        preview,
        risks,
        blockers,
        digestPreview,
        payload
    };
};
const buildDigestGateSnapshot = (gateSnapshot, includeExtendedGateState) => {
    if (gateSnapshot.kind === "start") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            openTodoIds: gateSnapshot.openTodoIds,
            dueUndoIds: gateSnapshot.dueUndoIds,
            ...(includeExtendedGateState
                ? {
                    dueDeferredIds: gateSnapshot.dueDeferredIds,
                    blockedConstraintIds: gateSnapshot.blockedConstraintIds
                }
                : {}),
            missingDecisionRefs: gateSnapshot.missingDecisionRefs
        };
    }
    if (gateSnapshot.kind === "close") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            unresolvedTodoIds: gateSnapshot.unresolvedTodoIds,
            unresolvedUndoIds: gateSnapshot.unresolvedUndoIds,
            ...(includeExtendedGateState
                ? {
                    unresolvedDeferredIds: gateSnapshot.unresolvedDeferredIds,
                    blockedConstraintIds: gateSnapshot.blockedConstraintIds
                }
                : {}),
            residualAudit: gateSnapshot.residualAudit,
            residualAuditReviewed: gateSnapshot.residualAuditReviewed === true
        };
    }
    if (gateSnapshot.kind === "shutdown") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            forced: gateSnapshot.forced,
            stateReason: gateSnapshot.stateReason,
            ordinaryCloseGate: {
                allowed: gateSnapshot.ordinaryCloseGate.allowed,
                blockers: gateSnapshot.ordinaryCloseGate.blockers,
                unresolvedTodoIds: gateSnapshot.ordinaryCloseGate.unresolvedTodoIds,
                unresolvedUndoIds: gateSnapshot.ordinaryCloseGate.unresolvedUndoIds,
                ...(includeExtendedGateState
                    ? {
                        unresolvedDeferredIds: gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds,
                        blockedConstraintIds: gateSnapshot.ordinaryCloseGate.blockedConstraintIds
                    }
                    : {})
            }
        };
    }
    return {
        kind: gateSnapshot.kind,
        allowed: gateSnapshot.allowed,
        blockers: gateSnapshot.blockers
    };
};
const buildDigestWithGateFormat = (projectId, actionType, targetId, payload, gateSnapshot, includeExtendedGateState) => {
    const digestGateSnapshot = buildDigestGateSnapshot(gateSnapshot, includeExtendedGateState);
    const digestPayload = {
        projectId,
        actionType,
        targetId,
        payload,
        gateSnapshot: digestGateSnapshot
    };
    const canonical = stableStringify(digestPayload);
    return {
        algorithm: "sha256",
        value: crypto.createHash("sha256").update(canonical).digest("hex"),
        payload: digestPayload
    };
};
const buildDigest = (projectId, actionType, targetId, payload, gateSnapshot) => buildDigestWithGateFormat(projectId, actionType, targetId, payload, gateSnapshot, true);
const buildLegacyDigest = (projectId, actionType, targetId, payload, gateSnapshot) => buildDigestWithGateFormat(projectId, actionType, targetId, payload, gateSnapshot, false);
const isNewGateBlocker = (blocker) => blocker.code === "DUE_DEFERRED_REQUIRES_REVIEW" ||
    blocker.code.startsWith("DEFERRED_ROUTE_") ||
    blocker.code.startsWith("CONSTRAINT_") ||
    blocker.code === "UNKNOWN_CONSTRAINT_GATE_CHECK" ||
    blocker.code === "MISMATCHED_CONSTRAINT_GATE_CHECK";
const hasEmptyExtendedGateState = (gateSnapshot) => {
    const isEmptyIdList = (value) => !Array.isArray(value) || value.length === 0;
    if (gateSnapshot.kind === "start") {
        return (isEmptyIdList(gateSnapshot.dueDeferredIds) &&
            isEmptyIdList(gateSnapshot.blockedConstraintIds) &&
            !gateSnapshot.blockers.some(isNewGateBlocker));
    }
    if (gateSnapshot.kind === "close") {
        return (isEmptyIdList(gateSnapshot.unresolvedDeferredIds) &&
            isEmptyIdList(gateSnapshot.blockedConstraintIds) &&
            !gateSnapshot.blockers.some(isNewGateBlocker));
    }
    if (gateSnapshot.kind === "shutdown") {
        return (isEmptyIdList(gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds) &&
            isEmptyIdList(gateSnapshot.ordinaryCloseGate.blockedConstraintIds) &&
            !gateSnapshot.blockers.some(isNewGateBlocker) &&
            !gateSnapshot.ordinaryCloseGate.blockers.some(isNewGateBlocker));
    }
    return !gateSnapshot.blockers.some(isNewGateBlocker);
};
const buildOperationDescription = (snapshot, actionType, targetId, payload, evaluatedAt) => {
    switch (actionType) {
        case "start_version": {
            const targetVersion = requireVersion(snapshot, targetId);
            const currentVersionTodos = snapshot.project.currentVersionId === null
                ? []
                : snapshot.todos.filter((todo) => todo.versionId === snapshot.project.currentVersionId &&
                    (todo.status === "wait" || todo.status === "running"));
            const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
            const gate = evaluateStartGate({
                targetVersion,
                currentVersionTodos,
                dueUndos,
                deferredItems: snapshot.deferredItems,
                constraints: snapshot.constraints,
                constraintChecks: []
            });
            const gateSnapshot = buildStartGateSnapshot(gate, evaluatedAt);
            return {
                actionType,
                targetId,
                payload,
                gateSnapshot,
                digest: buildDigest(snapshot.project.id, actionType, targetId, payload, gateSnapshot)
            };
        }
        case "close_version": {
            const version = requireVersion(snapshot, targetId);
            const payloadAudit = payload.residualAuditReviewed === true
                ? { status: "reviewed", items: payload.residualAudit ?? [] }
                : payload.residualAudit;
            const resolvedAudit = resolveCloseResidualAudit(snapshot, targetId, payloadAudit);
            const normalizedPayload = resolvedAudit.audit === null
                ? payload
                : {
                    ...payload,
                    residualAudit: resolvedAudit.audit.items,
                    residualAuditReviewed: true
                };
            const gate = evaluateCloseGate({
                version,
                todos: snapshot.todos.filter((todo) => todo.versionId === version.id),
                undos: snapshot.undos.filter((undo) => undo.versionId === version.id ||
                    undo.originVersionId === version.id ||
                    undo.preferredResolutionVersionId === version.id),
                residualAudit: resolvedAudit.audit,
                knownVersions: snapshot.versions,
                deferredItems: snapshot.deferredItems,
                constraints: snapshot.constraints,
                constraintChecks: []
            });
            const gateSnapshot = buildCloseGateSnapshot(gate, evaluatedAt, resolvedAudit.audit);
            return {
                actionType,
                targetId,
                payload: normalizedPayload,
                gateSnapshot,
                digest: buildDigest(snapshot.project.id, actionType, targetId, normalizedPayload, gateSnapshot)
            };
        }
        case "shutdown_version": {
            const version = requireVersion(snapshot, targetId);
            const shutdownReason = payload.shutdownReason;
            if (typeof shutdownReason !== "string" || shutdownReason.trim().length === 0) {
                throw new ApplicationError("MISSING_REQUIRED_FIELD", "shutdown_version 需要 shutdownReason", {
                    actionType,
                    targetId
                });
            }
            const payloadAudit = payload.residualAuditReviewed === true
                ? { status: "reviewed", items: payload.residualAudit ?? [] }
                : payload.residualAudit;
            const ordinaryCloseResidualAudit = resolveCloseResidualAudit(snapshot, targetId, payloadAudit);
            const ordinaryCloseGate = evaluateCloseGate({
                version,
                todos: snapshot.todos.filter((todo) => todo.versionId === version.id),
                undos: snapshot.undos.filter((undo) => undo.versionId === version.id ||
                    undo.originVersionId === version.id ||
                    undo.preferredResolutionVersionId === version.id),
                residualAudit: ordinaryCloseResidualAudit.audit,
                knownVersions: snapshot.versions,
                deferredItems: snapshot.deferredItems,
                constraints: snapshot.constraints,
                constraintChecks: []
            });
            const blockers = version.state === "close"
                ? [
                    {
                        code: "VERSION_ALREADY_CLOSED",
                        message: "已 close 的 version 不能再次执行 shutdown_version。",
                        recordIds: [version.id]
                    }
                ]
                : [];
            const gateSnapshot = buildShutdownGateSnapshot({
                allowed: blockers.length === 0,
                blockers,
                ordinaryCloseGate
            }, evaluatedAt, buildShutdownStateReason(shutdownReason));
            const normalizedPayload = {
                ...payload,
                shutdownReason
            };
            return {
                actionType,
                targetId,
                payload: normalizedPayload,
                gateSnapshot,
                digest: buildDigest(snapshot.project.id, actionType, targetId, normalizedPayload, gateSnapshot)
            };
        }
        case "reopen_version":
        case "set_current_version": {
            requireVersion(snapshot, targetId);
            const gateSnapshot = buildNoopGateSnapshot(evaluatedAt);
            return {
                actionType,
                targetId,
                payload,
                gateSnapshot,
                digest: buildDigest(snapshot.project.id, actionType, targetId, payload, gateSnapshot)
            };
        }
        case "create_version":
        case "insert_version":
        case "create_child_version":
        case "reorder_versions": {
            if (actionType === "insert_version" && payload.batchNormalizedPlan !== undefined) {
                if (targetId !== snapshot.project.id) {
                    throw new ApplicationError("PROJECT_VERSION_MISMATCH", "batch_create_versions 的 targetId 必须指向 project.id", {
                        projectId: snapshot.project.id,
                        targetId
                    });
                }
                const evaluated = evaluateBatchCreateVersions(snapshot, {
                    anchor: payload.batchAnchor,
                    items: payload.batchItems ?? [],
                    partialAllowed: false,
                    previousCurrentPolicy: payload.batchPreviousCurrentPolicy,
                    setCurrentTo: payload.batchSetCurrentTo ?? undefined
                }, evaluatedAt);
                if (evaluated.ok === false) {
                    throw new ApplicationError(evaluated.code, "batch_create_versions payload 无法通过 live preflight", {
                        issues: evaluated.issues,
                        blockers: evaluated.blockers
                    });
                }
                return {
                    actionType,
                    targetId,
                    payload: evaluated.payload,
                    gateSnapshot: buildNoopGateSnapshot(evaluatedAt),
                    digest: evaluated.digestPreview
                };
            }
            const normalizedPayload = normalizeVersionTreePayload({
                versions: snapshot.versions,
                actionType,
                targetId,
                payload
            });
            const gateSnapshot = buildNoopGateSnapshot(evaluatedAt);
            return {
                actionType,
                targetId,
                payload: normalizedPayload,
                gateSnapshot,
                digest: buildDigest(snapshot.project.id, actionType, targetId, normalizedPayload, gateSnapshot)
            };
        }
        default: {
            const exhaustiveActionType = actionType;
            throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "未支持的 L3 action", {
                actionType: exhaustiveActionType
            });
        }
    }
};
const applyPendingOperation = (snapshot, operation) => ({
    ...snapshot,
    pendingOperations: appendRecord(snapshot.pendingOperations, operation)
});
const applyApprovalArtifact = (snapshot, artifact) => ({
    ...snapshot,
    approvalArtifacts: appendRecord(snapshot.approvalArtifacts, artifact)
});
export class RouteLedgerService {
    storage;
    deps;
    projectRoot;
    constructor(options) {
        this.storage = options.storage;
        this.deps = options.deps;
        this.projectRoot = options.projectRoot === undefined ? null : path.resolve(options.projectRoot);
    }
    async saveProjectAggregate(snapshot) {
        if (snapshot.project.settings.contentLocale === null) {
            throw new ApplicationError("CONTENT_LOCALE_REQUIRED", "Project content_locale is null. Confirm and set a concrete locale before writing project state.", { projectId: snapshot.project.id });
        }
        await this.storage.saveProjectAggregate(snapshot);
    }
    async initProject(input) {
        const created = createProject({
            name: input.name,
            description: input.description,
            contentLocale: input.contentLocale,
            actor: input.actor,
            deps: this.deps
        });
        const snapshot = {
            project: created.project,
            versions: [created.initialVersion],
            workItems: [],
            todos: [],
            undos: [],
            deferredItems: [],
            constraints: [],
            assets: [],
            events: created.events,
            pendingOperations: [],
            approvalArtifacts: []
        };
        await this.saveProjectAggregate(snapshot);
        return created;
    }
    async setProjectContentLocale(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const updated = setProjectContentLocaleDomain({
            project: snapshot.project,
            contentLocale: input.contentLocale,
            reason: input.reason,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.project = updated.project;
        snapshot.events = snapshot.events.concat(updated.events);
        await this.saveProjectAggregate(snapshot);
        return updated;
    }
    async listVersions(projectId) {
        const snapshot = await requireProject(this.storage, projectId);
        return snapshot.versions.slice().sort((left, right) => left.order - right.order);
    }
    async listVersionsWindow(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        return buildVersionsWindowResult(snapshot, input);
    }
    async prepareVersion(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const version = requireVersion(snapshot, input.versionId);
        const context = createDomainContext(this.deps, input.actor);
        const prepared = prepareVersionDomain(version, context, this.deps);
        snapshot.versions = replaceRecord(snapshot.versions, prepared.version);
        snapshot.events = snapshot.events.concat(prepared.events);
        await this.saveProjectAggregate(snapshot);
        return prepared;
    }
    async markVersionComplete(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const version = requireVersion(snapshot, input.versionId);
        const context = createDomainContext(this.deps, input.actor);
        const completed = markVersionCompleteDomain(version, context, this.deps);
        snapshot.versions = replaceRecord(snapshot.versions, completed.version);
        snapshot.events = snapshot.events.concat(completed.events);
        await this.saveProjectAggregate(snapshot);
        return completed;
    }
    async createTodo(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        requireVersion(snapshot, input.versionId);
        const created = createTodoDomain({
            projectId: input.projectId,
            versionId: input.versionId,
            title: input.title,
            description: input.description,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.workItems = snapshot.workItems.concat(created.workItem);
        snapshot.todos = snapshot.todos.concat(created.todo);
        snapshot.events = snapshot.events.concat(created.events);
        await this.saveProjectAggregate(snapshot);
        return created;
    }
    async closeTodo(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const todo = requireTodo(snapshot, input.todoId);
        const workItem = requireWorkItem(snapshot, todo.workItemId);
        const closed = closeTodoDomain({
            todo,
            workItem,
            reason: input.reason,
            note: input.note,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.todos = replaceRecord(snapshot.todos, closed.todo);
        snapshot.workItems = replaceRecord(snapshot.workItems, closed.workItem);
        snapshot.events = snapshot.events.concat(closed.events);
        await this.saveProjectAggregate(snapshot);
        return closed;
    }
    async deferWork(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        if (input.mode === "new") {
            const originVersionId = input.originVersionId ?? snapshot.project.currentVersionId;
            if (originVersionId === null) {
                throw new ApplicationError("VERSION_NOT_FOUND", "new deferred work 需要 current 或 origin version", {
                    projectId: input.projectId
                });
            }
            const originVersion = requireVersion(snapshot, originVersionId);
            assertDeferredRouteTarget(originVersion, input.targetReviewVersionId, snapshot.versions);
            const deferred = deferWorkWorkflow({
                mode: "new",
                projectId: input.projectId,
                currentVersionId: originVersion.id,
                targetReviewVersionId: input.targetReviewVersionId,
                title: input.title,
                description: input.description,
                reason: input.reason,
                reviewTrigger: input.reviewTrigger,
                actor: input.actor,
                deps: this.deps
            });
            snapshot.workItems = appendRecord(snapshot.workItems, deferred.workItem);
            snapshot.deferredItems = appendRecord(snapshot.deferredItems, deferred.deferred);
            snapshot.events = snapshot.events.concat(deferred.events);
            await this.saveProjectAggregate(snapshot);
            return deferred;
        }
        const todo = requireTodo(snapshot, input.todoId);
        const workItem = requireWorkItem(snapshot, todo.workItemId);
        const originVersion = requireVersion(snapshot, todo.versionId);
        assertDeferredRouteTarget(originVersion, input.targetReviewVersionId, snapshot.versions);
        const deferred = deferWorkWorkflow({
            mode: "todo",
            resolvedRecords: {
                todo,
                workItem
            },
            targetReviewVersionId: input.targetReviewVersionId,
            reason: input.reason,
            note: input.note,
            reviewTrigger: input.reviewTrigger,
            actor: input.actor,
            deps: this.deps
        });
        if (deferred.mode !== "todo") {
            throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "todo defer workflow 返回了错误 mode");
        }
        snapshot.todos = replaceRecord(snapshot.todos, deferred.todo);
        snapshot.workItems = replaceRecord(snapshot.workItems, deferred.workItem);
        snapshot.deferredItems = appendRecord(snapshot.deferredItems, deferred.deferred);
        snapshot.events = snapshot.events.concat(deferred.events);
        await this.saveProjectAggregate(snapshot);
        return deferred;
    }
    async reviewDeferred(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const deferred = requireDeferred(snapshot, input.deferredId);
        const workItem = requireDeferredActiveWorkItem(snapshot, deferred);
        if (input.action === "activate") {
            if (input.targetVersionId !== deferred.targetReviewVersionId) {
                throw new ApplicationError("DEFERRED_ACTIVATE_TARGET_MISMATCH", "activate 必须使用 Deferred 当前 target review Version；换目标请先 defer_again", {
                    projectId: input.projectId,
                    deferredId: deferred.id,
                    expectedTargetVersionId: deferred.targetReviewVersionId,
                    actualTargetVersionId: input.targetVersionId
                });
            }
            const targetVersion = requireVersion(snapshot, input.targetVersionId);
            const reviewed = reviewDeferredWorkflow({
                action: "activate",
                resolvedRecords: {
                    deferred,
                    workItem
                },
                targetVersionId: targetVersion.id,
                reason: input.reason,
                note: input.note,
                actor: input.actor,
                deps: this.deps
            });
            if (reviewed.action !== "activate") {
                throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "activate deferred workflow 返回了错误 action");
            }
            snapshot.deferredItems = replaceRecord(snapshot.deferredItems, reviewed.deferred);
            snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
            snapshot.todos = appendRecord(snapshot.todos, reviewed.todo);
            snapshot.events = snapshot.events.concat(reviewed.events);
            await this.saveProjectAggregate(snapshot);
            return reviewed;
        }
        if (input.action === "defer_again") {
            const currentReviewVersion = requireVersion(snapshot, deferred.targetReviewVersionId);
            assertDeferredRouteTarget(currentReviewVersion, input.targetReviewVersionId, snapshot.versions);
            const reviewed = reviewDeferredWorkflow({
                action: "defer_again",
                resolvedRecords: {
                    deferred,
                    workItem
                },
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger,
                actor: input.actor,
                deps: this.deps
            });
            snapshot.deferredItems = replaceRecord(snapshot.deferredItems, reviewed.deferred);
            snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
            snapshot.events = snapshot.events.concat(reviewed.events);
            await this.saveProjectAggregate(snapshot);
            return reviewed;
        }
        const reviewed = reviewDeferredWorkflow({
            action: "resolve",
            resolvedRecords: {
                deferred,
                workItem
            },
            outcome: input.outcome,
            reason: input.reason,
            note: input.note,
            decisionRef: input.decisionRef,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.deferredItems = replaceRecord(snapshot.deferredItems, reviewed.deferred);
        snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
        snapshot.events = snapshot.events.concat(reviewed.events);
        await this.saveProjectAggregate(snapshot);
        return reviewed;
    }
    async recordConstraint(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        if (input.scope.type === "version") {
            requireVersion(snapshot, input.scope.versionId);
        }
        const recorded = recordConstraintWorkflow({
            projectId: input.projectId,
            rule: input.rule,
            rationale: input.rationale,
            scope: input.scope,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.constraints = appendRecord(snapshot.constraints, recorded.constraint);
        snapshot.events = snapshot.events.concat(recorded.events);
        await this.saveProjectAggregate(snapshot);
        return recorded;
    }
    async retireConstraint(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const constraint = requireConstraint(snapshot, input.constraintId);
        const retired = retireRecordedConstraint({
            constraint,
            reason: input.reason,
            note: input.note,
            actor: input.actor,
            deps: this.deps
        });
        snapshot.constraints = replaceRecord(snapshot.constraints, retired.constraint);
        snapshot.events = snapshot.events.concat(retired.events);
        await this.saveProjectAggregate(snapshot);
        return retired;
    }
    async transitionVersion(input) {
        const mode = assertRouteOperationWorkflowMode(input.mode);
        const snapshot = await requireProject(this.storage, input.projectId);
        const evaluation = buildTransitionWorkflowEvaluation(snapshot, input.versionId);
        const baseResult = {
            mode,
            status: evaluation.status,
            projectId: input.projectId,
            versionId: input.versionId,
            currentVersionId: evaluation.currentVersionId,
            targetVersionState: evaluation.targetVersion.state,
            targetIsCurrent: evaluation.targetVersion.isCurrent,
            nextActionType: evaluation.nextActionType,
            stepsRemaining: evaluation.stepsRemaining,
            blockers: evaluation.blockers,
            dueDeferredIds: evaluation.dueDeferredIds,
            blockedConstraintIds: evaluation.blockedConstraintIds,
            followUpRequired: evaluation.stepsRemaining.length > 1
        };
        if (mode === "dry_run" || evaluation.status !== "ready" || evaluation.nextActionType === null) {
            return baseResult;
        }
        const proposal = evaluation.nextActionType === "set_current_version"
            ? await this.proposeL3Operation({
                projectId: input.projectId,
                actionType: "set_current_version",
                targetId: input.versionId,
                reason: input.reason ?? "transition version requested: set current first",
                payload: {
                    currentVersionId: input.versionId
                },
                actor: input.actor
            })
            : await this.proposeL3Operation({
                projectId: input.projectId,
                actionType: "start_version",
                targetId: input.versionId,
                reason: input.reason ?? "transition version requested: start ready target",
                actor: input.actor
            });
        return {
            ...baseResult,
            pendingOperationId: proposal.id,
            operationDigest: proposal.digest,
            humanReviewText: makeHumanReviewText(proposal),
            proposedActionType: evaluation.nextActionType
        };
    }
    async closeVersionWorkflow(input) {
        const mode = assertRouteOperationWorkflowMode(input.mode);
        const gate = await this.checkCloseGate(input);
        const baseResult = {
            mode,
            status: gate.allowed ? "ready" : "blocked",
            projectId: input.projectId,
            versionId: input.versionId,
            blockers: gate.blockers,
            unresolvedTodoIds: gate.unresolvedTodoIds,
            unresolvedUndoIds: gate.unresolvedUndoIds,
            unresolvedDeferredIds: gate.unresolvedDeferredIds,
            blockedConstraintIds: gate.blockedConstraintIds
        };
        if (mode === "dry_run" || !gate.allowed) {
            return baseResult;
        }
        const resolvedAudit = resolveCloseResidualAudit(await requireProject(this.storage, input.projectId), input.versionId, input.residualAudit);
        const proposal = await this.proposeL3Operation({
            projectId: input.projectId,
            actionType: "close_version",
            targetId: input.versionId,
            reason: input.reason ?? "close version requested",
            payload: {
                residualAudit: resolvedAudit.audit?.items ?? null,
                residualAuditReviewed: resolvedAudit.audit !== null
            },
            actor: input.actor
        });
        return {
            ...baseResult,
            pendingOperationId: proposal.id,
            operationDigest: proposal.digest,
            humanReviewText: makeHumanReviewText(proposal)
        };
    }
    async shutdownVersionWorkflow(input) {
        const mode = assertRouteOperationWorkflowMode(input.mode);
        const snapshot = await requireProject(this.storage, input.projectId);
        const version = requireVersion(snapshot, input.versionId);
        const description = buildOperationDescription(snapshot, "shutdown_version", input.versionId, {
            shutdownReason: input.shutdownReason
        }, this.deps.clock.now());
        if (description.gateSnapshot.kind !== "shutdown") {
            throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "shutdown_version 必须产出 shutdown gate snapshot");
        }
        const baseResult = {
            mode,
            status: version.state === "close" ? "no_op" : description.gateSnapshot.allowed ? "ready" : "blocked",
            projectId: input.projectId,
            versionId: input.versionId,
            forced: true,
            shutdownStateReason: description.gateSnapshot.stateReason,
            blockers: description.gateSnapshot.blockers,
            ordinaryCloseGate: {
                allowed: description.gateSnapshot.ordinaryCloseGate.allowed,
                blockers: description.gateSnapshot.ordinaryCloseGate.blockers,
                unresolvedTodoIds: description.gateSnapshot.ordinaryCloseGate.unresolvedTodoIds,
                unresolvedUndoIds: description.gateSnapshot.ordinaryCloseGate.unresolvedUndoIds,
                unresolvedDeferredIds: description.gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds,
                blockedConstraintIds: description.gateSnapshot.ordinaryCloseGate.blockedConstraintIds
            }
        };
        if (mode === "dry_run" || !description.gateSnapshot.allowed) {
            return baseResult;
        }
        const proposal = await this.proposeL3Operation({
            projectId: input.projectId,
            actionType: "shutdown_version",
            targetId: input.versionId,
            reason: input.reason ?? `emergency shutdown requested (${description.gateSnapshot.stateReason})`,
            payload: {
                shutdownReason: input.shutdownReason
            },
            actor: input.actor
        });
        return {
            ...baseResult,
            pendingOperationId: proposal.id,
            operationDigest: proposal.digest,
            humanReviewText: makeHumanReviewText(proposal)
        };
    }
    async getVersionTransitionGuide(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        return buildVersionTransitionGuide(snapshot, input);
    }
    async getVersionStructure(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const focusVersionId = input.versionId ?? snapshot.project.currentVersionId;
        if (focusVersionId === null) {
            throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
                projectId: input.projectId
            });
        }
        const focusVersion = requireVersion(snapshot, focusVersionId);
        const currentVersion = snapshot.project.currentVersionId === null
            ? null
            : requireVersion(snapshot, snapshot.project.currentVersionId);
        const siblings = snapshot.versions
            .filter((version) => version.parentVersionId === focusVersion.parentVersionId)
            .sort((left, right) => left.order - right.order)
            .map(summarizeVersion);
        const childVersions = snapshot.versions
            .filter((version) => version.parentVersionId === focusVersion.id)
            .sort((left, right) => left.order - right.order)
            .map(summarizeVersion);
        const openTodos = snapshot.todos
            .filter((todo) => todo.versionId === focusVersion.id &&
            (todo.status === "wait" || todo.status === "running"))
            .map(summarizeOpenTodo);
        const openWaitUndos = snapshot.undos
            .filter((undo) => undo.status === "wait")
            .map(summarizeVersionStructureUndo);
        return {
            project: {
                id: snapshot.project.id,
                currentVersionId: snapshot.project.currentVersionId
            },
            focusVersion: summarizeVersionStructureVersion(focusVersion),
            currentVersion: currentVersion === null ? null : summarizeCurrentVersion(currentVersion),
            parentVersion: focusVersion.parentVersionId === null
                ? null
                : summarizeVersion(requireVersion(snapshot, focusVersion.parentVersionId)),
            siblings,
            childVersions,
            openTodos,
            openUndos: {
                owned: openWaitUndos.filter((undo) => undo.versionId === focusVersion.id),
                origin: openWaitUndos.filter((undo) => undo.originVersionId === focusVersion.id),
                preferredResolution: openWaitUndos.filter((undo) => undo.preferredResolutionVersionId === focusVersion.id)
            },
            legalOperations: buildVersionStructureLegalOperations(snapshot, focusVersion, input.residualAudit)
        };
    }
    async checkStartGate(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const targetVersion = requireVersion(snapshot, input.versionId);
        const currentVersionTodos = snapshot.project.currentVersionId === null
            ? []
            : snapshot.todos.filter((todo) => todo.versionId === snapshot.project.currentVersionId &&
                (todo.status === "wait" || todo.status === "running"));
        const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
        const gate = evaluateStartGate({
            targetVersion,
            currentVersionTodos,
            dueUndos,
            deferredItems: snapshot.deferredItems,
            constraints: snapshot.constraints,
            constraintChecks: []
        });
        return {
            allowed: gate.allowed,
            blockers: gate.blockers,
            openTodoIds: gate.openTodoIds,
            dueUndoIds: gate.dueUndoIds,
            dueDeferredIds: gate.dueDeferredIds,
            selfReferentialUndoIds: gate.selfReferentialUndoIds,
            missingDecisionRefs: gate.missingDecisionRefs,
            blockedConstraintIds: gate.blockedConstraintIds
        };
    }
    async checkCloseGate(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const resolvedAudit = resolveCloseResidualAudit(snapshot, input.versionId, input.residualAudit);
        const description = buildOperationDescription(snapshot, "close_version", input.versionId, {
            residualAudit: resolvedAudit.audit?.items ?? null,
            residualAuditReviewed: resolvedAudit.audit !== null
        }, this.deps.clock.now());
        return {
            allowed: description.gateSnapshot.allowed,
            blockers: description.gateSnapshot.blockers,
            unresolvedTodoIds: description.gateSnapshot.kind === "close"
                ? description.gateSnapshot.unresolvedTodoIds
                : [],
            unresolvedUndoIds: description.gateSnapshot.kind === "close"
                ? description.gateSnapshot.unresolvedUndoIds
                : [],
            unresolvedDeferredIds: description.gateSnapshot.kind === "close"
                ? description.gateSnapshot.unresolvedDeferredIds
                : [],
            blockedConstraintIds: description.gateSnapshot.kind === "close"
                ? description.gateSnapshot.blockedConstraintIds
                : []
        };
    }
    async summarizeVersionCloseout(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const versionId = input.versionId ?? snapshot.project.currentVersionId;
        if (versionId === null) {
            throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
                projectId: input.projectId
            });
        }
        const eventLimit = clampCloseoutEventLimit(input.eventLimit);
        const closeoutView = collectVersionCloseoutView({
            snapshot,
            versionId,
            eventLimit
        });
        return {
            data: closeoutView.summary,
            meta: closeoutView.meta
        };
    }
    async planVersionCloseout(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const versionId = input.versionId ?? snapshot.project.currentVersionId;
        if (versionId === null) {
            throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
                projectId: input.projectId
            });
        }
        const eventLimit = clampCloseoutEventLimit(input.eventLimit);
        const closeoutView = collectVersionCloseoutView({
            snapshot,
            versionId,
            eventLimit
        });
        return {
            data: buildVersionCloseoutPlan(closeoutView),
            meta: closeoutView.meta
        };
    }
    async batchCreateVersions(input) {
        const mode = assertBatchCreateVersionsMode(input.mode);
        const previousCurrentPolicy = assertBatchPreviousCurrentPolicy(input.previousCurrentPolicy);
        const snapshot = await requireProject(this.storage, input.projectId);
        const headRevision = getProjectAggregateHeadRevision(snapshot) ?? null;
        const evaluated = evaluateBatchCreateVersions(snapshot, {
            anchor: input.anchor,
            items: input.items,
            partialAllowed: input.partialAllowed,
            previousCurrentPolicy,
            setCurrentTo: input.setCurrentTo
        }, this.deps.clock.now());
        if (evaluated.ok === false) {
            return evaluated;
        }
        if (mode === "preflight") {
            return {
                ok: true,
                headRevision,
                normalizedPlan: evaluated.normalizedPlan,
                resolvedAnchors: evaluated.resolvedAnchors,
                preview: evaluated.preview,
                risks: evaluated.risks,
                blockers: evaluated.blockers,
                digestPreview: evaluated.digestPreview
            };
        }
        if (evaluated.blockers.length > 0) {
            return {
                ok: false,
                code: "BATCH_VERSION_PLAN_BLOCKED",
                headRevision,
                summary: {
                    requestedCount: input.items.length,
                    validCount: input.items.length,
                    invalidCount: 0
                },
                issues: [],
                risks: evaluated.risks,
                blockers: evaluated.blockers,
                normalizedPlan: evaluated.normalizedPlan,
                resolvedAnchors: evaluated.resolvedAnchors,
                preview: evaluated.preview,
                digestPreview: evaluated.digestPreview
            };
        }
        const proposal = await this.proposeL3Operation({
            projectId: input.projectId,
            actionType: "insert_version",
            targetId: input.projectId,
            reason: input.reason ?? `batch create ${input.items.length} versions requested`,
            payload: evaluated.payload,
            actor: input.actor
        });
        return {
            ok: true,
            headRevision,
            pendingOperationId: proposal.id,
            operationDigest: proposal.digest,
            normalizedPlan: evaluated.normalizedPlan,
            preview: evaluated.preview,
            humanReviewText: [
                `RouteLedger batch proposal ${proposal.id}`,
                `action: batch_create_versions`,
                `carrierAction: ${proposal.actionType}`,
                `target: ${proposal.targetId}`,
                `digest: ${proposal.digest.value}`,
                `items: ${evaluated.normalizedPlan.items.length}`,
                evaluated.blockers.length > 0
                    ? `blockers: ${evaluated.blockers.map((blocker) => blocker.code).join(", ")}`
                    : "blockers: none"
            ].join("\n")
        };
    }
    async proposeL3Operation(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const now = this.deps.clock.now();
        const description = buildOperationDescription(snapshot, input.actionType, input.targetId, input.payload ?? {}, now);
        const proposal = {
            id: this.deps.idGenerator.nextId(),
            projectId: input.projectId,
            actionType: description.actionType,
            targetId: description.targetId,
            status: "pending",
            reason: input.reason,
            gateSnapshot: description.gateSnapshot,
            digest: description.digest,
            payload: description.payload,
            createdBy: input.actor,
            createdAt: now,
            updatedAt: now,
            committedAt: null,
            rejectedAt: null,
            rejectionReason: null,
            approvalArtifactId: null
        };
        const context = createDomainContext(this.deps, input.actor);
        const proposalEvents = createAuditEvents([
            {
                targetType: "pending_operation",
                targetId: proposal.id,
                eventType: "pending_operation.proposed",
                toState: proposal.status,
                note: proposal.reason,
                metadata: {
                    actionType: proposal.actionType,
                    targetId: proposal.targetId,
                    digest: proposal.digest.value
                }
            }
        ], snapshot.project.id, input.actor, now, context.operationId, this.deps);
        const updatedSnapshot = applyPendingOperation(snapshot, proposal);
        updatedSnapshot.events = updatedSnapshot.events.concat(proposalEvents);
        await this.saveProjectAggregate(updatedSnapshot);
        return proposal;
    }
    async listL3Proposals(projectId) {
        const snapshot = await requireProject(this.storage, projectId);
        return snapshot.pendingOperations
            .slice()
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    async getL3Proposal(projectId, pendingOperationId) {
        const snapshot = await requireProject(this.storage, projectId);
        return requirePendingOperation(snapshot, pendingOperationId);
    }
    async approveL3Operation(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status !== "pending") {
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是待审批状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status
            });
        }
        const now = this.deps.clock.now();
        const artifact = {
            id: this.deps.idGenerator.nextId(),
            projectId: input.projectId,
            pendingOperationId: pendingOperation.id,
            actionType: pendingOperation.actionType,
            targetId: pendingOperation.targetId,
            digest: pendingOperation.digest,
            status: "approved",
            approver: input.approver,
            decisionRef: input.decisionRef ?? `decision_${this.deps.idGenerator.nextId()}`,
            createdAt: now,
            expiresAt: input.expiresAt ?? addMilliseconds(now, DEFAULT_APPROVAL_WINDOW_MS),
            consumedAt: null
        };
        const context = createDomainContext(this.deps, input.actor);
        const events = createAuditEvents([
            {
                targetType: "approval_artifact",
                targetId: artifact.id,
                eventType: "approval_artifact.approved",
                toState: artifact.status,
                metadata: {
                    pendingOperationId: pendingOperation.id,
                    decisionRef: artifact.decisionRef,
                    expiresAt: artifact.expiresAt,
                    approverId: artifact.approver.id,
                    approverType: artifact.approver.type,
                    approverDisplayName: artifact.approver.displayName ?? null
                }
            }
        ], snapshot.project.id, input.actor, now, context.operationId, this.deps);
        const updatedSnapshot = applyApprovalArtifact(snapshot, artifact);
        updatedSnapshot.events = updatedSnapshot.events.concat(events);
        await this.saveProjectAggregate(updatedSnapshot);
        return artifact;
    }
    async rejectL3Operation(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status !== "pending") {
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是待拒绝状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status
            });
        }
        const now = this.deps.clock.now();
        const rejected = {
            ...pendingOperation,
            status: "rejected",
            updatedAt: now,
            rejectedAt: now,
            rejectionReason: input.reason
        };
        const context = createDomainContext(this.deps, input.actor);
        const events = createAuditEvents([
            {
                targetType: "pending_operation",
                targetId: rejected.id,
                eventType: "pending_operation.rejected",
                fromState: pendingOperation.status,
                toState: rejected.status,
                note: input.reason
            }
        ], snapshot.project.id, input.actor, now, context.operationId, this.deps);
        snapshot.pendingOperations = replaceRecord(snapshot.pendingOperations, rejected);
        snapshot.events = snapshot.events.concat(events);
        await this.saveProjectAggregate(snapshot);
        return rejected;
    }
    async commitL3Operation(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status !== "pending") {
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是可提交状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status
            });
        }
        if (input.approvalArtifactId === undefined || input.approvalArtifactId.trim().length === 0) {
            throw new ApplicationError("CONFIRMATION_REQUIRED", "提交 L3 operation 需要 approval artifact", {
                pendingOperationId: pendingOperation.id,
                confirmBooleanRejected: input.confirm === true
            });
        }
        const artifact = requireApprovalArtifact(snapshot, input.approvalArtifactId);
        if (artifact.pendingOperationId !== pendingOperation.id) {
            throw new ApplicationError("APPROVAL_ARTIFACT_PENDING_OPERATION_MISMATCH", "approval artifact 未绑定到当前 pending operation", {
                expectedPendingOperationId: pendingOperation.id,
                actualPendingOperationId: artifact.pendingOperationId,
                approvalArtifactId: artifact.id
            });
        }
        if (artifact.consumedAt !== null) {
            throw new ApplicationError("APPROVAL_ARTIFACT_ALREADY_CONSUMED", "approval artifact 已被消费", {
                approvalArtifactId: artifact.id,
                consumedAt: artifact.consumedAt
            });
        }
        if (artifact.status !== "approved") {
            if (artifact.status === "consumed") {
                throw new ApplicationError("APPROVAL_ARTIFACT_ALREADY_CONSUMED", "approval artifact 已被消费", {
                    approvalArtifactId: artifact.id,
                    consumedAt: artifact.consumedAt
                });
            }
            if (artifact.status === "expired") {
                throw new ApplicationError("APPROVAL_ARTIFACT_EXPIRED", "approval artifact 已过期", {
                    approvalArtifactId: artifact.id,
                    expiresAt: artifact.expiresAt
                });
            }
            throw new ApplicationError("APPROVAL_ARTIFACT_STATUS_INVALID", "approval artifact 必须处于 approved 状态", {
                approvalArtifactId: artifact.id,
                status: artifact.status
            });
        }
        if (artifact.actionType !== pendingOperation.actionType) {
            throw new ApplicationError("APPROVAL_ARTIFACT_ACTION_MISMATCH", "approval artifact action 与 pending operation 不一致", {
                expectedActionType: pendingOperation.actionType,
                actualActionType: artifact.actionType
            });
        }
        if (artifact.targetId !== pendingOperation.targetId) {
            throw new ApplicationError("APPROVAL_ARTIFACT_TARGET_MISMATCH", "approval artifact target 与 pending operation 不一致", {
                expectedTargetId: pendingOperation.targetId,
                actualTargetId: artifact.targetId
            });
        }
        if (artifact.digest.value !== pendingOperation.digest.value) {
            throw new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "approval artifact digest 与 pending operation 不一致", {
                expectedDigest: pendingOperation.digest.value,
                actualDigest: artifact.digest.value
            });
        }
        const now = this.deps.clock.now();
        if (new Date(artifact.expiresAt).getTime() <= new Date(now).getTime()) {
            const expiredArtifact = {
                ...artifact,
                status: "expired"
            };
            snapshot.approvalArtifacts = replaceRecord(snapshot.approvalArtifacts, expiredArtifact);
            await this.saveProjectAggregate(snapshot);
            throw new ApplicationError("APPROVAL_ARTIFACT_EXPIRED", "approval artifact 已过期", {
                approvalArtifactId: artifact.id,
                expiresAt: artifact.expiresAt
            });
        }
        const liveDescription = buildOperationDescription(snapshot, pendingOperation.actionType, pendingOperation.targetId, pendingOperation.payload, now);
        const liveLegacyDigest = buildLegacyDigest(snapshot.project.id, pendingOperation.actionType, pendingOperation.targetId, pendingOperation.payload, liveDescription.gateSnapshot);
        const storedV2Digest = buildDigest(snapshot.project.id, pendingOperation.actionType, pendingOperation.targetId, pendingOperation.payload, pendingOperation.gateSnapshot);
        const storedLegacyDigest = buildLegacyDigest(snapshot.project.id, pendingOperation.actionType, pendingOperation.targetId, pendingOperation.payload, pendingOperation.gateSnapshot);
        const storedDigestFormat = storedV2Digest.value === pendingOperation.digest.value
            ? "v2"
            : hasEmptyExtendedGateState(pendingOperation.gateSnapshot) &&
                storedLegacyDigest.value === pendingOperation.digest.value
                ? "legacy"
                : null;
        if (storedDigestFormat === null) {
            throw new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "pending operation 的 stored gate/payload 与 digest 不自洽", {
                pendingOperationId: pendingOperation.id,
                storedDigest: pendingOperation.digest.value,
                storedV2Digest: storedV2Digest.value,
                storedLegacyDigest: storedLegacyDigest.value,
                storedExtendedGateStateEmpty: hasEmptyExtendedGateState(pendingOperation.gateSnapshot)
            });
        }
        const liveDigestMatches = storedDigestFormat === "v2"
            ? liveDescription.digest.value === pendingOperation.digest.value
            : hasEmptyExtendedGateState(liveDescription.gateSnapshot) &&
                liveLegacyDigest.value === pendingOperation.digest.value;
        if (!liveDigestMatches) {
            throw new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "live route state 与审批时 digest 不一致", {
                expectedDigest: pendingOperation.digest.value,
                actualDigest: liveDescription.digest.value,
                liveLegacyDigest: liveLegacyDigest.value,
                storedDigestFormat,
                legacyCompatibilityAllowed: storedDigestFormat === "legacy" &&
                    hasEmptyExtendedGateState(liveDescription.gateSnapshot)
            });
        }
        const context = createDomainContext(this.deps, input.actor);
        const applied = this.applyCommittedOperation(snapshot, pendingOperation, liveDescription, {
            actor: input.actor,
            now,
            operationId: context.operationId
        });
        const consumedArtifact = {
            ...artifact,
            status: "consumed",
            consumedAt: now
        };
        const committedOperation = {
            ...pendingOperation,
            status: "committed",
            updatedAt: now,
            committedAt: now,
            approvalArtifactId: artifact.id
        };
        const auditEvents = createAuditEvents([
            {
                targetType: "pending_operation",
                targetId: committedOperation.id,
                eventType: "pending_operation.committed",
                fromState: pendingOperation.status,
                toState: committedOperation.status,
                metadata: {
                    approvalArtifactId: artifact.id
                }
            },
            {
                targetType: "approval_artifact",
                targetId: consumedArtifact.id,
                eventType: "approval_artifact.consumed",
                fromState: artifact.status,
                toState: consumedArtifact.status,
                metadata: {
                    pendingOperationId: committedOperation.id,
                    decisionRef: artifact.decisionRef,
                    approverId: artifact.approver.id,
                    approverType: artifact.approver.type,
                    approverDisplayName: artifact.approver.displayName ?? null
                }
            }
        ], snapshot.project.id, input.actor, now, context.operationId, this.deps, applied.events.length);
        applied.snapshot.pendingOperations = replaceRecord(applied.snapshot.pendingOperations, committedOperation);
        applied.snapshot.approvalArtifacts = replaceRecord(applied.snapshot.approvalArtifacts, consumedArtifact);
        applied.snapshot.events = applied.snapshot.events
            .concat(applied.events)
            .concat(auditEvents);
        await this.saveProjectAggregate(applied.snapshot);
        return {
            pendingOperation: committedOperation,
            approvalArtifact: consumedArtifact
        };
    }
    applyCommittedOperation(snapshot, pendingOperation, liveDescription, context) {
        switch (pendingOperation.actionType) {
            case "start_version": {
                const version = requireVersion(snapshot, pendingOperation.targetId);
                const started = startVersionDomain(version, liveDescription.gateSnapshot.kind === "start"
                    ? {
                        allowed: liveDescription.gateSnapshot.allowed,
                        blockers: liveDescription.gateSnapshot.blockers,
                        openTodoIds: liveDescription.gateSnapshot.openTodoIds,
                        dueUndoIds: liveDescription.gateSnapshot.dueUndoIds,
                        dueDeferredIds: liveDescription.gateSnapshot.dueDeferredIds,
                        selfReferentialUndoIds: [],
                        missingDecisionRefs: liveDescription.gateSnapshot.missingDecisionRefs,
                        blockedConstraintIds: liveDescription.gateSnapshot.blockedConstraintIds
                    }
                    : {
                        allowed: false,
                        blockers: [],
                        openTodoIds: [],
                        dueUndoIds: [],
                        dueDeferredIds: [],
                        selfReferentialUndoIds: [],
                        missingDecisionRefs: [],
                        blockedConstraintIds: []
                    }, context, this.deps);
                snapshot.versions = replaceRecord(snapshot.versions, started.version);
                return {
                    snapshot,
                    events: started.events
                };
            }
            case "close_version": {
                const version = requireVersion(snapshot, pendingOperation.targetId);
                const closed = closeVersionDomain(version, liveDescription.gateSnapshot.kind === "close"
                    ? {
                        allowed: liveDescription.gateSnapshot.allowed,
                        blockers: liveDescription.gateSnapshot.blockers,
                        unresolvedTodoIds: liveDescription.gateSnapshot.unresolvedTodoIds,
                        unresolvedUndoIds: liveDescription.gateSnapshot.unresolvedUndoIds,
                        unresolvedDeferredIds: liveDescription.gateSnapshot.unresolvedDeferredIds,
                        blockedConstraintIds: liveDescription.gateSnapshot.blockedConstraintIds
                    }
                    : {
                        allowed: false,
                        blockers: [],
                        unresolvedTodoIds: [],
                        unresolvedUndoIds: [],
                        unresolvedDeferredIds: [],
                        blockedConstraintIds: []
                    }, context, this.deps);
                snapshot.versions = replaceRecord(snapshot.versions, closed.version);
                return {
                    snapshot,
                    events: closed.events
                };
            }
            case "shutdown_version": {
                const version = requireVersion(snapshot, pendingOperation.targetId);
                const shutdownReason = pendingOperation.payload.shutdownReason;
                if (typeof shutdownReason !== "string" || shutdownReason.trim().length === 0) {
                    throw new ApplicationError("MISSING_REQUIRED_FIELD", "shutdown_version payload 缺少 shutdownReason", {
                        pendingOperationId: pendingOperation.id
                    });
                }
                const shutdown = shutdownVersionDomain(version, shutdownReason, context, this.deps, pendingOperation.reason);
                snapshot.versions = replaceRecord(snapshot.versions, shutdown.version);
                return {
                    snapshot,
                    events: shutdown.events
                };
            }
            case "reopen_version": {
                const version = requireVersion(snapshot, pendingOperation.targetId);
                const reopened = reopenVersionDomain(version, context, this.deps);
                snapshot.versions = replaceRecord(snapshot.versions, reopened.version);
                return {
                    snapshot,
                    events: reopened.events
                };
            }
            case "set_current_version": {
                const nextVersion = requireVersion(snapshot, pendingOperation.targetId);
                const currentVersion = snapshot.project.currentVersionId === null
                    ? null
                    : requireVersion(snapshot, snapshot.project.currentVersionId);
                const switched = setCurrentVersionDomain({
                    project: snapshot.project,
                    currentVersion,
                    nextVersion,
                    actor: context.actor,
                    deps: this.deps
                });
                snapshot.project = switched.project;
                snapshot.versions = snapshot.versions
                    .map((version) => version.id === switched.nextVersion.id
                    ? switched.nextVersion
                    : version)
                    .map((version) => switched.currentVersion !== null && version.id === switched.currentVersion.id
                    ? switched.currentVersion
                    : version);
                return {
                    snapshot,
                    events: switched.events
                };
            }
            case "create_version":
            case "insert_version":
            case "create_child_version":
            case "reorder_versions": {
                if (pendingOperation.actionType === "insert_version" && liveDescription.payload.batchNormalizedPlan) {
                    return this.applyBatchCreateVersions(snapshot, liveDescription.payload, context);
                }
                const appliedVersionTree = applyVersionTreeMutation({
                    versions: snapshot.versions,
                    actionType: pendingOperation.actionType,
                    targetId: pendingOperation.targetId,
                    payload: liveDescription.payload,
                    actor: context.actor,
                    now: context.now
                });
                snapshot.versions = appliedVersionTree.versions;
                return {
                    snapshot,
                    events: createAuditEvents(appliedVersionTree.eventDrafts, snapshot.project.id, context.actor, context.now, context.operationId, this.deps)
                };
            }
            default: {
                const exhaustiveActionType = pendingOperation.actionType;
                throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "未支持的 L3 action", {
                    actionType: exhaustiveActionType
                });
            }
        }
    }
    applyBatchCreateVersions(snapshot, payload, context) {
        const normalizedPlan = payload.batchNormalizedPlan;
        if (normalizedPlan === undefined || normalizedPlan.length === 0) {
            throw new ApplicationError("BATCH_VERSION_PLAN_INVALID", "batch_create_versions 缺少 normalized plan");
        }
        let nextSnapshot = {
            ...snapshot,
            versions: snapshot.versions.slice(),
            workItems: snapshot.workItems.slice(),
            todos: snapshot.todos.slice()
        };
        let events = [];
        const clientKeyToVersionId = new Map();
        const previewVersionIdToVersionId = new Map();
        for (const item of normalizedPlan) {
            const versionId = this.deps.idGenerator.nextId();
            const previousVersionId = item.previousRef === null
                ? null
                : previewVersionIdToVersionId.get(item.previousRef) ?? item.previousRef;
            const nextVersionId = item.nextRef === null
                ? null
                : previewVersionIdToVersionId.get(item.nextRef) ?? item.nextRef;
            const actionType = item.parentVersionId === null && item.previousRef === null && item.nextRef === null
                ? "create_version"
                : item.parentVersionId === null
                    ? "insert_version"
                    : "create_child_version";
            const appliedVersionTree = applyVersionTreeMutation({
                versions: nextSnapshot.versions,
                actionType,
                targetId: versionId,
                payload: {
                    title: item.title,
                    description: item.description,
                    parentVersionId: item.parentVersionId,
                    previousVersionId,
                    nextVersionId
                },
                actor: context.actor,
                now: context.now
            });
            clientKeyToVersionId.set(item.clientKey, versionId);
            previewVersionIdToVersionId.set(item.previewVersionId, versionId);
            nextSnapshot = {
                ...nextSnapshot,
                versions: appliedVersionTree.versions
            };
            events = events.concat(createAuditEvents(appliedVersionTree.eventDrafts, nextSnapshot.project.id, context.actor, context.now, context.operationId, this.deps, events.length));
        }
        for (const item of normalizedPlan) {
            const versionId = clientKeyToVersionId.get(item.clientKey);
            if (versionId === undefined) {
                throw new ApplicationError("BATCH_VERSION_PLAN_INVALID", "clientKey 无法映射到实际 version id", {
                    clientKey: item.clientKey
                });
            }
            for (const title of item.initialTodos) {
                const created = createTodoDomain({
                    projectId: nextSnapshot.project.id,
                    versionId,
                    title,
                    actor: context.actor,
                    deps: this.deps
                });
                nextSnapshot = {
                    ...nextSnapshot,
                    workItems: nextSnapshot.workItems.concat(created.workItem),
                    todos: nextSnapshot.todos.concat(created.todo)
                };
                events = events.concat(createAuditEvents([
                    {
                        targetType: "todo",
                        targetId: created.todo.id,
                        eventType: "todo.created",
                        toState: created.todo.status
                    },
                    {
                        targetType: "work_item",
                        targetId: created.workItem.id,
                        eventType: "work_item.created",
                        toState: created.workItem.status
                    }
                ], nextSnapshot.project.id, context.actor, context.now, context.operationId, this.deps, events.length));
            }
        }
        if (payload.batchSetCurrentTo !== undefined && payload.batchSetCurrentTo !== null) {
            const targetVersionId = clientKeyToVersionId.get(payload.batchSetCurrentTo) ??
                previewVersionIdToVersionId.get(payload.batchSetCurrentTo);
            if (targetVersionId === undefined) {
                throw new ApplicationError("SET_CURRENT_TARGET_INVALID", "batch setCurrentTo 无法映射到实际 version", {
                    setCurrentTo: payload.batchSetCurrentTo
                });
            }
            if (nextSnapshot.project.currentVersionId !== targetVersionId) {
                const previousCurrentVersionId = nextSnapshot.project.currentVersionId;
                nextSnapshot = {
                    ...nextSnapshot,
                    project: {
                        ...nextSnapshot.project,
                        currentVersionId: targetVersionId,
                        updatedAt: context.now
                    },
                    versions: nextSnapshot.versions.map((version) => {
                        if (version.id === targetVersionId) {
                            return {
                                ...version,
                                isCurrent: true,
                                updatedAt: context.now
                            };
                        }
                        if (previousCurrentVersionId !== null && version.id === previousCurrentVersionId) {
                            return {
                                ...version,
                                isCurrent: false,
                                updatedAt: context.now
                            };
                        }
                        return version;
                    })
                };
                events = events.concat(createAuditEvents([
                    {
                        targetType: "project",
                        targetId: nextSnapshot.project.id,
                        eventType: "project.current_version_changed",
                        fromState: previousCurrentVersionId,
                        toState: targetVersionId
                    }
                ], nextSnapshot.project.id, context.actor, context.now, context.operationId, this.deps, events.length));
            }
        }
        return {
            snapshot: nextSnapshot,
            events
        };
    }
    async requestConfirmation(projectId, actionType, targetId, reason, actor, payload = {}) {
        const proposal = await this.proposeL3Operation({
            projectId,
            actionType,
            targetId,
            reason,
            actor,
            payload
        });
        throw new ApplicationError("CONFIRMATION_REQUIRED", "该 L3 操作需要 approval artifact", {
            pendingOperationId: proposal.id,
            actionType,
            targetId,
            digest: proposal.digest.value,
            proposal,
            humanReviewText: makeHumanReviewText(proposal)
        });
    }
    async startVersion(input) {
        return this.requestConfirmation(input.projectId, "start_version", input.versionId, input.reason ?? "start version requested", input.actor);
    }
    async closeVersion(input) {
        const gate = await this.checkCloseGate(input);
        if (!gate.allowed) {
            throw new ApplicationError("CLOSE_GATE_FAILED", "close gate 校验失败", {
                projectId: input.projectId,
                versionId: input.versionId,
                blockers: gate.blockers,
                unresolvedTodoIds: gate.unresolvedTodoIds,
                unresolvedUndoIds: gate.unresolvedUndoIds,
                unresolvedDeferredIds: gate.unresolvedDeferredIds,
                blockedConstraintIds: gate.blockedConstraintIds
            });
        }
        const snapshot = await requireProject(this.storage, input.projectId);
        const resolvedAudit = resolveCloseResidualAudit(snapshot, input.versionId, input.residualAudit);
        return this.requestConfirmation(input.projectId, "close_version", input.versionId, "close version requested", input.actor, {
            residualAudit: resolvedAudit.audit?.items ?? null,
            residualAuditReviewed: resolvedAudit.audit !== null
        });
    }
    async shutdownVersion(input) {
        return this.requestConfirmation(input.projectId, "shutdown_version", input.versionId, input.reason ?? `emergency shutdown requested (${buildShutdownStateReason(input.shutdownReason)})`, input.actor, {
            shutdownReason: input.shutdownReason
        });
    }
    async reopenVersion(input) {
        return this.requestConfirmation(input.projectId, "reopen_version", input.versionId, input.reason ?? "reopen version requested", input.actor);
    }
    async setCurrentVersion(input) {
        return this.requestConfirmation(input.projectId, "set_current_version", input.versionId, input.reason ?? "set current version requested", input.actor, {
            currentVersionId: input.versionId
        });
    }
    async createVersion(input) {
        return this.requestConfirmation(input.projectId, "create_version", this.deps.idGenerator.nextId(), input.reason ?? "create version requested", input.actor, {
            title: input.title,
            description: input.description
        });
    }
    async insertVersion(input) {
        return this.requestConfirmation(input.projectId, "insert_version", this.deps.idGenerator.nextId(), input.reason ?? "insert version requested", input.actor, {
            title: input.title,
            description: input.description,
            previousVersionId: input.afterVersionId ?? null,
            nextVersionId: input.beforeVersionId ?? null
        });
    }
    async createChildVersion(input) {
        return this.requestConfirmation(input.projectId, "create_child_version", this.deps.idGenerator.nextId(), input.reason ?? "create child version requested", input.actor, {
            title: input.title,
            description: input.description,
            parentVersionId: input.parentVersionId,
            previousVersionId: input.afterVersionId ?? null,
            nextVersionId: input.beforeVersionId ?? null
        });
    }
    async reorderVersions(input) {
        return this.requestConfirmation(input.projectId, "reorder_versions", input.versionId, input.reason ?? "reorder versions requested", input.actor, {
            previousVersionId: input.afterVersionId ?? null,
            nextVersionId: input.beforeVersionId ?? null
        });
    }
    async checkDocDrift(input) {
        if (this.projectRoot === null) {
            throw new Error("checkDocDrift requires RouteLedgerServiceOptions.projectRoot");
        }
        const snapshot = await requireProject(this.storage, input.projectId);
        const context = buildDerivedCurrentContextData(snapshot, {});
        return {
            data: await runDocDriftCheck({
                projectRoot: this.projectRoot,
                project: snapshot.project,
                context,
                input
            })
        };
    }
    async getCurrentContext(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        return buildCurrentContextResult(snapshot, input);
    }
    async getNextAction(input) {
        const snapshot = await requireProject(this.storage, input.projectId);
        return buildNextActionResult(snapshot, input);
    }
}
