import type { GateBlocker } from "../services/gate-service.js";

import type {
  VersionCloseoutSummary,
  VersionCloseoutView
} from "./version-closeout-query.js";

export type VersionCloseoutPlanStatus =
  | "no_op"
  | "blocked"
  | "ready_to_complete"
  | "ready_to_close"
  | "needs_pending_decision"
  | "planned";

export type VersionCloseoutPlanStepKind =
  | "close_todo"
  | "create_todo"
  | "mark_version_complete"
  | "close_version"
  | "approve_l3_operation"
  | "commit_l3_operation"
  | "review_pending_proposal"
  | "review_residual_audit"
  | "no_op";

export type VersionCloseoutGovernanceLayer =
  | "manual"
  | "route_write"
  | "l3_proposal"
  | "l3_approval"
  | "l3_commit";

export interface VersionCloseoutPlanRequiredInput {
  field: string;
  value: unknown;
}

export interface VersionCloseoutPlanUnlockPath {
  actionType: string;
  recommendedTool: string | null;
  governanceLayer: VersionCloseoutGovernanceLayer;
  requiresL3Approval: boolean;
  summary: string;
}

export interface VersionCloseoutPlanStep {
  stepId: string;
  kind: VersionCloseoutPlanStepKind;
  recommendedTool: string | null;
  targetId: string | null;
  requiredInputs: VersionCloseoutPlanRequiredInput[];
  governanceLayer: VersionCloseoutGovernanceLayer;
  requiresL3Approval: boolean;
  writesRouteState: boolean;
  summary: string;
  reason: string;
  unlockPaths: VersionCloseoutPlanUnlockPath[];
  warnings?: string[];
}

export interface VersionCloseoutPlan {
  projectId: string;
  version: VersionCloseoutSummary["version"];
  summary: VersionCloseoutSummary;
  status: VersionCloseoutPlanStatus;
  steps: VersionCloseoutPlanStep[];
  warnings: string[];
}

const collectBlockerIds = (blockers: GateBlocker[]): string[] => [
  ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];

const createUnlockPath = (
  actionType: string,
  recommendedTool: string | null,
  governanceLayer: VersionCloseoutGovernanceLayer,
  requiresL3Approval: boolean,
  summary: string
): VersionCloseoutPlanUnlockPath => ({
  actionType,
  recommendedTool,
  governanceLayer,
  requiresL3Approval,
  summary
});

const createStep = (
  step: Omit<VersionCloseoutPlanStep, "unlockPaths"> & {
    unlockPaths?: VersionCloseoutPlanUnlockPath[];
  }
): VersionCloseoutPlanStep => ({
  ...step,
  unlockPaths:
    step.unlockPaths ??
    [
      createUnlockPath(
        step.kind,
        step.recommendedTool,
        step.governanceLayer,
        step.requiresL3Approval,
        step.summary
      )
    ]
});

export const buildVersionCloseoutPlan = (view: VersionCloseoutView): VersionCloseoutPlan => {
  const { version, summary, residualAudit, relatedPendingOperations } = view;
  const warnings: string[] = [];
  const steps: VersionCloseoutPlanStep[] = [];
  const pendingProposal = relatedPendingOperations.find((operation) => operation.status === "pending");

  const addStep = (step: VersionCloseoutPlanStep): void => {
    steps.push(step);
  };

  if (version.state === "close") {
    addStep(
      createStep({
        stepId: "closeout-noop",
        kind: "no_op",
        recommendedTool: null,
        targetId: null,
        requiredInputs: [],
        governanceLayer: "manual",
        requiresL3Approval: false,
        writesRouteState: false,
        summary:
          summary.version.displayState === "shutdown"
            ? "This version is already SHUTDOWN/ABORTED."
            : "This version is already closed.",
        reason:
          summary.version.displayState === "shutdown"
            ? `version ${version.id} was force-closed via ${summary.version.stateReason}.`
            : `version ${version.id} is already at the close boundary.`
      })
    );

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
    addStep(
      createStep({
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
      })
    );

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
    addStep(
      createStep({
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
      })
    );
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
    addStep(
      createStep({
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
      })
    );

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
    addStep(
      createStep({
        stepId: `close-version-${version.id}`,
        kind: "close_version",
        recommendedTool: "preview_or_propose_version_close",
        targetId: version.id,
        requiredInputs: [
          { field: "projectId", value: summary.projectId },
          { field: "versionId", value: version.id },
          { field: "mode", value: "propose" },
          { field: "residualAudit", value: { status: "reviewed", items: residualAudit } },
          { field: "reason", value: "<optional proposal reason>" }
        ],
        governanceLayer: "l3_proposal",
        requiresL3Approval: false,
        writesRouteState: true,
        summary: "Create the ordinary close proposal.",
        reason: `version ${version.id} is complete and the ordinary close gate now passes.`,
        unlockPaths: [
          createUnlockPath(
            "preview_or_propose_version_close",
            "close_version",
            "l3_proposal",
            false,
            "Create the Version close proposal."
          )
        ]
      })
    );
    addStep(
      createStep({
        stepId: `approve-close-version-${version.id}`,
        kind: "approve_l3_operation",
        recommendedTool: "approve_l3_operation",
        targetId: null,
        requiredInputs: [
          { field: "projectId", value: summary.projectId },
          {
            field: "pendingOperationId",
            value: "<from preview_or_propose_version_close.pendingOperationId>"
          }
        ],
        governanceLayer: "l3_approval",
        requiresL3Approval: true,
        writesRouteState: true,
        summary: "Approve the close proposal.",
        reason: "The close_version proposal exists, so the next unlock path is explicit L3 approval."
      })
    );
    addStep(
      createStep({
        stepId: `commit-close-version-${version.id}`,
        kind: "commit_l3_operation",
        recommendedTool: "commit_l3_operation",
        targetId: null,
        requiredInputs: [
          { field: "projectId", value: summary.projectId },
          {
            field: "pendingOperationId",
            value: "<from preview_or_propose_version_close.pendingOperationId>"
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
      })
    );

    return {
      projectId: summary.projectId,
      version: summary.version,
      summary,
      status: "ready_to_close",
      steps,
      warnings
    };
  }

  if (version.state === "complete" && !summary.closeGate.residualAuditReviewed) {
    warnings.push("Close requires an explicit residual audit declaration; an omitted or empty legacy array is not a no-residuals result.");
    addStep(
      createStep({
        stepId: `review-residual-audit-${version.id}`,
        kind: "review_residual_audit",
        recommendedTool: "check_close_gate",
        targetId: version.id,
        requiredInputs: [
          { field: "projectId", value: summary.projectId },
          { field: "versionId", value: version.id },
          { field: "residualAudit", value: { status: "reviewed", items: [] } }
        ],
        governanceLayer: "manual",
        requiresL3Approval: false,
        writesRouteState: false,
        summary: "Review and declare the residual audit before planning close.",
        reason: "The ordinary close gate has no reviewed residual-audit evidence. Supply a reviewed declaration with either empty items or routed residual items, then rerun the plan."
      })
    );
    return {
      projectId: summary.projectId,
      version: summary.version,
      summary,
      status: "blocked",
      steps,
      warnings
    };
  }

  if (version.state === "complete") {
    warnings.push(
      "The ordinary close gate still has unmapped blockers. Resolve them first, or explicitly choose the high-risk preview_or_propose_forced_version_shutdown path outside this ordinary closeout plan."
    );
    addStep(
      createStep({
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
      })
    );

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
  addStep(
    createStep({
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
    })
  );

  return {
    projectId: summary.projectId,
    version: summary.version,
    summary,
    status: "planned",
    steps,
    warnings
  };
};
