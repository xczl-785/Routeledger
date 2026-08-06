const collectBlockerIds = (blockers) => [
    ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];
const mapAlternativeToUnlockPath = (alternative) => ({
    actionType: alternative.actionType,
    recommendedTool: alternative.recommendedTool,
    governanceLayer: alternative.actionType === "carry_forward_undo" ||
        alternative.actionType === "close_undo" ||
        alternative.actionType === "close_undo_then_create_todo"
        ? "route_write"
        : "manual",
    requiresL3Approval: false,
    summary: alternative.summary
});
const createUnlockPath = (actionType, recommendedTool, governanceLayer, requiresL3Approval, summary) => ({
    actionType,
    recommendedTool,
    governanceLayer,
    requiresL3Approval,
    summary
});
const createStep = (step) => ({
    ...step,
    unlockPaths: step.unlockPaths ??
        [
            createUnlockPath(step.kind, step.recommendedTool, step.governanceLayer, step.requiresL3Approval, step.summary)
        ]
});
export const buildVersionCloseoutPlan = (view) => {
    const { version, summary, residualAudit, relatedPendingOperations } = view;
    const warnings = [];
    const steps = [];
    const pendingProposal = relatedPendingOperations.find((operation) => operation.status === "pending");
    const selfReferentialUndoMap = new Map(summary.selfReferentialUndos.map((undo) => [undo.id, undo]));
    const addStep = (step) => {
        steps.push(step);
    };
    if (version.state === "close") {
        addStep(createStep({
            stepId: "closeout-noop",
            kind: "no_op",
            recommendedTool: null,
            targetId: null,
            requiredInputs: [],
            governanceLayer: "manual",
            requiresL3Approval: false,
            writesRouteState: false,
            summary: summary.version.displayState === "shutdown"
                ? "This version is already SHUTDOWN/ABORTED."
                : "This version is already closed.",
            reason: summary.version.displayState === "shutdown"
                ? `version ${version.id} was force-closed via ${summary.version.stateReason}.`
                : `version ${version.id} is already at the close boundary.`
        }));
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "no_op",
            steps,
            warnings
        };
    }
    if (pendingProposal !== undefined) {
        warnings.push("A related pending proposal already exists. Resolve it before planning more closeout writes.");
        addStep(createStep({
            stepId: `review-pending-proposal-${pendingProposal.id}`,
            kind: "review_pending_proposal",
            recommendedTool: "get_l3_proposal",
            targetId: pendingProposal.id,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                { field: "pendingOperationId", value: pendingProposal.id }
            ],
            governanceLayer: "manual",
            requiresL3Approval: false,
            writesRouteState: false,
            summary: "Review the pending proposal first.",
            reason: `proposal ${pendingProposal.id} is still pending, so live closeout state is not final yet.`
        }));
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "needs_pending_decision",
            steps,
            warnings
        };
    }
    for (const todo of summary.openTodos) {
        addStep(createStep({
            stepId: `close-todo-${todo.id}`,
            kind: "close_todo",
            recommendedTool: "close_todo",
            targetId: todo.id,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                { field: "todoId", value: todo.id },
                { field: "reason", value: "<close reason>" },
                { field: "note", value: "<close note>" }
            ],
            governanceLayer: "route_write",
            requiresL3Approval: false,
            writesRouteState: true,
            summary: `Close open todo: ${todo.title}`,
            reason: `todo ${todo.id} is still open, so the ordinary close gate cannot pass.`
        }));
    }
    if (summary.openUndos.length > 0) {
        warnings.push("Open undo defaults to close_undo. If the issue truly belongs downstream, choose carry_forward_undo instead.");
    }
    for (const undo of summary.openUndos) {
        const selfReferentialUndo = selfReferentialUndoMap.get(undo.id);
        if (selfReferentialUndo?.category === "uncertain") {
            addStep(createStep({
                stepId: `review-self-referential-undo-${undo.id}`,
                kind: "review_self_referential_undo",
                recommendedTool: null,
                targetId: undo.id,
                requiredInputs: [
                    { field: "projectId", value: summary.projectId },
                    { field: "undoId", value: undo.id }
                ],
                governanceLayer: "manual",
                requiresL3Approval: false,
                writesRouteState: false,
                summary: `Manually classify self-referential undo: ${undo.title}`,
                reason: selfReferentialUndo.reason,
                warnings: [
                    "Do not treat this as an ordinary close blocker until the controller classifies it.",
                    "Choose whether it should close in place, become a downstream todo, or stay as downstream undo."
                ],
                alternatives: selfReferentialUndo.alternatives,
                unlockPaths: selfReferentialUndo.alternatives.map(mapAlternativeToUnlockPath)
            }));
            continue;
        }
        const stepWarnings = selfReferentialUndo === undefined
            ? undefined
            : [
                `This undo is self-referential (${selfReferentialUndo.category}).`,
                selfReferentialUndo.note
            ];
        const unlockPaths = [
            createUnlockPath("close_undo", "close_undo", "route_write", false, "Close the undo in place so it stops blocking ordinary close.")
        ];
        if (selfReferentialUndo !== undefined) {
            unlockPaths.push(...selfReferentialUndo.alternatives.map(mapAlternativeToUnlockPath));
        }
        else {
            unlockPaths.push(createUnlockPath("carry_forward_undo", "carry_forward_undo", "route_write", false, "If the undo truly belongs to a downstream version, carry it forward without converting lineage."));
        }
        addStep(createStep({
            stepId: `close-undo-${undo.id}`,
            kind: "close_undo",
            recommendedTool: "close_undo",
            targetId: undo.id,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                { field: "undoId", value: undo.id },
                { field: "reason", value: "<close reason>" },
                { field: "note", value: "<close note>" }
            ],
            governanceLayer: "route_write",
            requiresL3Approval: false,
            writesRouteState: true,
            summary: selfReferentialUndo === undefined
                ? `Resolve open undo: ${undo.title}`
                : `Resolve self-referential undo: ${undo.title}`,
            reason: selfReferentialUndo === undefined
                ? `undo ${undo.id} is still open, so planner defaults to close_undo.`
                : selfReferentialUndo.reason,
            warnings: stepWarnings,
            alternatives: selfReferentialUndo?.alternatives,
            unlockPaths
        }));
        if (selfReferentialUndo?.category === "cleanup_like") {
            addStep(createStep({
                stepId: `create-followup-todo-${undo.id}`,
                kind: "create_todo",
                recommendedTool: "create_todo",
                targetId: null,
                requiredInputs: [
                    { field: "projectId", value: summary.projectId },
                    { field: "versionId", value: "<follow-up versionId>" },
                    { field: "title", value: undo.title },
                    {
                        field: "description",
                        value: `Follow-up todo converted from self-referential undo ${undo.id}: ${undo.description}`
                    }
                ],
                governanceLayer: "route_write",
                requiresL3Approval: false,
                writesRouteState: true,
                summary: `Create follow-up todo after closing self-referential cleanup undo: ${undo.title}`,
                reason: "This undo reads like post-close cleanup, so it should move onto an explicit todo path after the blocker is closed.",
                warnings: [
                    "Choose the real downstream owner/version before creating the todo.",
                    "This keeps the cleanup path visible after close_undo removes the blocker."
                ],
                unlockPaths: [
                    createUnlockPath("create_todo", "create_todo", "route_write", false, "Create the downstream follow-up todo explicitly.")
                ]
            }));
        }
    }
    if (steps.length > 0) {
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "blocked",
            steps,
            warnings
        };
    }
    if (version.state === "running") {
        warnings.push("After mark_version_complete, rerun plan_version_closeout before deciding whether to enter the close proposal chain.");
        addStep(createStep({
            stepId: `mark-version-complete-${version.id}`,
            kind: "mark_version_complete",
            recommendedTool: "mark_version_complete",
            targetId: version.id,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                { field: "versionId", value: version.id }
            ],
            governanceLayer: "route_write",
            requiresL3Approval: false,
            writesRouteState: true,
            summary: "Mark the current version complete.",
            reason: `version ${version.id} is still running, so it must enter the complete boundary first.`
        }));
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "ready_to_complete",
            steps,
            warnings
        };
    }
    if (version.state === "complete" && summary.closeGate.ok) {
        if (summary.closeGate.residualAuditSource === "assumed_none") {
            warnings.push("Close gate preview used the default residual audit `none -> close`. If that is not the intended residual handling, provide a real residualAudit before proposing close.");
        }
        addStep(createStep({
            stepId: `close-version-${version.id}`,
            kind: "close_version",
            recommendedTool: "close_version",
            targetId: version.id,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                { field: "versionId", value: version.id },
                { field: "mode", value: "propose" },
                { field: "residualAudit", value: residualAudit },
                { field: "reason", value: "<optional proposal reason>" }
            ],
            governanceLayer: "l3_proposal",
            requiresL3Approval: false,
            writesRouteState: true,
            summary: "Create the ordinary close proposal.",
            reason: `version ${version.id} is complete and the ordinary close gate now passes.`,
            unlockPaths: [
                createUnlockPath("close_version", "close_version", "l3_proposal", false, "Create the close_version proposal.")
            ]
        }));
        addStep(createStep({
            stepId: `approve-close-version-${version.id}`,
            kind: "approve_l3_operation",
            recommendedTool: "approve_l3_operation",
            targetId: null,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                {
                    field: "pendingOperationId",
                    value: "<from close_version.pendingOperationId>"
                }
            ],
            governanceLayer: "l3_approval",
            requiresL3Approval: true,
            writesRouteState: true,
            summary: "Approve the close proposal.",
            reason: "The close_version proposal exists, so the next unlock path is explicit L3 approval."
        }));
        addStep(createStep({
            stepId: `commit-close-version-${version.id}`,
            kind: "commit_l3_operation",
            recommendedTool: "commit_l3_operation",
            targetId: null,
            requiredInputs: [
                { field: "projectId", value: summary.projectId },
                {
                    field: "pendingOperationId",
                    value: "<from close_version.pendingOperationId>"
                },
                {
                    field: "approvalArtifactId",
                    value: "<from approve_l3_operation.id>"
                }
            ],
            governanceLayer: "l3_commit",
            requiresL3Approval: true,
            writesRouteState: true,
            summary: "Commit the approved close proposal.",
            reason: "After approval artifact exists, commit_l3_operation lands the ordinary close."
        }));
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "ready_to_close",
            steps,
            warnings
        };
    }
    if (version.state === "complete") {
        warnings.push("The ordinary close gate still has unmapped blockers. Resolve them first, or explicitly choose the high-risk shutdown_version path outside this ordinary closeout plan.");
        addStep(createStep({
            stepId: `blocked-close-gate-${version.id}`,
            kind: "no_op",
            recommendedTool: null,
            targetId: version.id,
            requiredInputs: [],
            governanceLayer: "manual",
            requiresL3Approval: false,
            writesRouteState: false,
            summary: "Ordinary close remains blocked.",
            reason: `Remaining blocker ids: ${collectBlockerIds(summary.closeGate.blockers).join(", ") || "unknown"}.`
        }));
        return {
            projectId: summary.projectId,
            version: summary.version,
            summary,
            status: "blocked",
            steps,
            warnings
        };
    }
    warnings.push(`version is currently ${version.state}, so there is no direct closeout write step yet.`);
    addStep(createStep({
        stepId: `closeout-not-applicable-${version.id}`,
        kind: "no_op",
        recommendedTool: null,
        targetId: version.id,
        requiredInputs: [],
        governanceLayer: "manual",
        requiresL3Approval: false,
        writesRouteState: false,
        summary: "There is no direct closeout write step yet.",
        reason: `version ${version.id} must first reach running or complete before ordinary closeout planning applies.`
    }));
    return {
        projectId: summary.projectId,
        version: summary.version,
        summary,
        status: "planned",
        steps,
        warnings
    };
};
