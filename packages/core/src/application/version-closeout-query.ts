import {
  describeVersionState,
  isShutdownStateReason,
  isUndoBlockingCloseForVersion
} from "../domain/route-semantics.js";
import type { Todo } from "../domain/todo.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";
import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";
import {
  evaluateCloseGate,
  type GateBlocker,
  resolveResidualAudit,
  type ResidualAuditSource,
  type ResidualAuditItem
} from "../services/gate-service.js";

import { ApplicationError } from "./errors.js";
import type {
  GateSnapshot,
  PendingOperation,
  RouteOperationWorkflowMode
} from "./types.js";

type CloseoutOpenTodoSummary = {
  id: string;
  versionId: string;
  title: string;
  status: Todo["status"];
  description: string;
  updatedAt: string;
};

type CloseoutOpenUndoSummary = {
  id: string;
  versionId: string;
  originVersionId: string;
  preferredResolutionVersionId: string;
  carriedForwardAt: string | null;
  carriedForwardToVersionId: string | null;
  title: string;
  reason: string;
  description: string;
  updatedAt: string;
};

type CloseoutVersionSummary = {
  id: string;
  title: string;
  state: Version["state"];
  stateReason: string | null;
  displayState: Version["state"] | "shutdown";
  displayLabel: string;
  isShutdown: boolean;
  isCurrent: boolean;
};

type CloseoutPendingOperationSummary = {
  id: string;
  actionType: PendingOperation["actionType"];
  targetId: string;
  status: PendingOperation["status"];
  reason: string;
  reasonSource: PendingOperation["reasonSource"];
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  rejectedAt: string | null;
  approvalArtifactId: string | null;
  gate: {
    kind: GateSnapshot["kind"];
    allowed: boolean;
    blockerCodes: string[];
    blockerCount: number;
  };
};

type CloseoutRecentEventSummary = {
  id: string;
  eventType: string;
  targetType: TransitionEvent["targetType"];
  targetId: string;
  operationId: string;
  createdAt: string;
  fromState: string | null;
  toState: string | null;
  note: string | null;
  relatedPendingOperationId: string | null;
  metadata: Record<string, unknown>;
};

type CloseoutNextActionSummary = {
  actionType: string;
  recommendedTool: string | null;
  mode?: RouteOperationWorkflowMode;
  summary: string;
  reason: string;
  targetId: string | null;
  requiresL3Approval: boolean;
  blockerIds: string[];
};

export interface VersionCloseoutSummary {
  projectId: string;
  version: CloseoutVersionSummary;
  canClose: boolean;
  closeGate: {
    ok: boolean;
    applicable: boolean;
    blockers: GateBlocker[];
    unresolvedTodoIds: string[];
    unresolvedUndoIds: string[];
    unresolvedDeferredIds: string[];
    blockedConstraintIds: string[];
    residualAuditSource: ResidualAuditSource;
    residualAuditProposalId: string | null;
    residualAuditReviewed: boolean;
  };
  openTodos: CloseoutOpenTodoSummary[];
  openUndos: CloseoutOpenUndoSummary[];
  pendingOperations: CloseoutPendingOperationSummary[];
  recentEvents: CloseoutRecentEventSummary[];
  reopenSummary: {
    hasReopened: boolean;
    count: number;
    latestReason: string | null;
    latestEvent: CloseoutRecentEventSummary | null;
  };
  nextAction: CloseoutNextActionSummary;
}

export type VersionCloseoutView = {
  version: Version;
  residualAudit: ResidualAuditItem[];
  relatedPendingOperations: PendingOperation[];
  summary: VersionCloseoutSummary;
  meta: Record<string, unknown>;
};

const DEFAULT_CLOSEOUT_EVENT_LIMIT = 10;
const MAX_CLOSEOUT_EVENT_LIMIT = 50;
const requireVersion = (snapshot: ProjectAggregateSnapshot, versionId: string): Version => {
  const version = snapshot.versions.find((item) => item.id === versionId);

  if (version === undefined) {
    throw new ApplicationError("VERSION_NOT_FOUND", "version not found", {
      projectId: snapshot.project.id,
      versionId
    });
  }

  return version;
};

const summarizeOpenTodo = (todo: Todo): CloseoutOpenTodoSummary => ({
  id: todo.id,
  versionId: todo.versionId,
  title: todo.title,
  status: todo.status,
  description: todo.description,
  updatedAt: todo.updatedAt
});

const summarizeOpenUndo = (undo: Undo): CloseoutOpenUndoSummary => ({
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

const collectBlockerIds = (blockers: GateBlocker[]): string[] => [
  ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];

const compareIsoDesc = (left: string | null, right: string | null): number =>
  (right ?? "").localeCompare(left ?? "");

const comparePendingOperationsDesc = (
  left: PendingOperation,
  right: PendingOperation
): number =>
  compareIsoDesc(left.updatedAt, right.updatedAt) ||
  compareIsoDesc(left.createdAt, right.createdAt) ||
  right.id.localeCompare(left.id);

const extractRelatedPendingOperationId = (event: TransitionEvent): string | null => {
  if (event.targetType === "pending_operation") {
    return event.targetId;
  }

  const pendingOperationId = event.metadata.pendingOperationId;
  return typeof pendingOperationId === "string" ? pendingOperationId : null;
};

const summarizeCloseoutVersion = (version: Version): CloseoutVersionSummary => ({
  ...describeVersionState(version),
  id: version.id,
  title: version.title,
  state: version.state,
  isCurrent: version.isCurrent
});

const summarizeCloseoutPendingOperation = (
  operation: PendingOperation
): CloseoutPendingOperationSummary => ({
  id: operation.id,
  actionType: operation.actionType,
  targetId: operation.targetId,
  status: operation.status,
  reason: operation.reason,
  reasonSource: operation.reasonSource,
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

const summarizeCloseoutRecentEvent = (
  event: TransitionEvent
): CloseoutRecentEventSummary => ({
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

const isProjectCurrentVersionEventForVersion = (
  event: TransitionEvent,
  versionId: string
): boolean =>
  event.targetType === "project" &&
  event.eventType === "project.current_version_changed" &&
  (event.fromState === versionId || event.toState === versionId);

const resolveCloseoutResidualAudit = (
  pendingOperations: PendingOperation[],
  versionId: string,
  preferCommitted: boolean
): {
  residualAudit: ResidualAuditItem[];
  source: ResidualAuditSource;
  proposalId: string | null;
  reviewed: boolean;
} => {
  const candidates = pendingOperations
    .filter(
      (operation) =>
        (operation.status === "committed" || operation.status === "pending") &&
        operation.actionType === "close_version" &&
        operation.targetId === versionId
    )
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === (preferCommitted ? "committed" : "pending") ? -1 : 1;
      }
      return comparePendingOperationsDesc(left, right);
    });
  const resolved = resolveResidualAudit(
    undefined,
    candidates.map((operation) => ({
      id: operation.id,
      residualAudit: operation.payload.residualAudit,
      residualAuditReviewed: operation.payload.residualAuditReviewed
    }))
  );

  return {
    residualAudit: structuredClone(resolved.audit?.items ?? []),
    source:
      resolved.source === "proposal_payload" && candidates[0]?.status === "committed"
        ? "committed_close_proposal"
        : resolved.source,
    proposalId: resolved.proposalId,
    reviewed: resolved.audit !== null
  };
};

const buildCloseoutNextAction = (options: {
  version: Version;
  closeGate: {
    ok: boolean;
    blockers: GateBlocker[];
  };
  openTodos: CloseoutOpenTodoSummary[];
  pendingOperations: PendingOperation[];
}): CloseoutNextActionSummary => {
  const { version, closeGate, openTodos, pendingOperations } = options;
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
    const todo = openTodos[0]!;

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

  if (
    version.state === "complete" &&
    closeGate.blockers.some((blocker) => blocker.code === "MISSING_RESIDUAL_AUDIT")
  ) {
    return {
      actionType: "review_residual_audit",
      recommendedTool: "check_close_gate",
      summary: "Review and declare the residual audit first.",
      reason:
        "No reviewed residual-audit declaration exists. Supply { status: reviewed, items: [] } only after reviewing that no residuals remain, or include routed residual items.",
      targetId: version.id,
      requiresL3Approval: false,
      blockerIds: []
    };
  }

  if (version.state === "complete" && closeGate.ok) {
    return {
      actionType: "close_version",
      recommendedTool: "preview_or_propose_version_close",
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
    reason:
      version.state === "complete"
        ? "The ordinary close gate still has unresolved blockers."
        : `version is currently ${version.state}, so it is not at a closeout boundary yet.`,
    targetId: null,
    requiresL3Approval: false,
    blockerIds: collectBlockerIds(closeGate.blockers)
  };
};

export const clampCloseoutEventLimit = (value: number | undefined): number =>
  Math.max(1, Math.min(MAX_CLOSEOUT_EVENT_LIMIT, value ?? DEFAULT_CLOSEOUT_EVENT_LIMIT));

export const isSelfReferentialUndoForVersion = (undo: Undo, versionId: string): boolean =>
  undo.status === "wait" &&
  undo.versionId === versionId &&
  undo.preferredResolutionVersionId === versionId;

export const collectVersionCloseoutView = (options: {
  snapshot: ProjectAggregateSnapshot;
  versionId: string;
  eventLimit: number;
}): VersionCloseoutView => {
  const { snapshot, versionId, eventLimit } = options;
  const version = requireVersion(snapshot, versionId);
  const versionTodos = snapshot.todos.filter((todo) => todo.versionId === version.id);
  const versionUndos = snapshot.undos.filter(
    (undo) =>
      undo.versionId === version.id ||
      undo.originVersionId === version.id ||
      undo.preferredResolutionVersionId === version.id
  );
  const openTodos = versionTodos
    .filter((todo) => todo.status === "wait" || todo.status === "running")
    .map(summarizeOpenTodo);
  const openUndos = versionUndos
    .filter((undo) => isUndoBlockingCloseForVersion(undo, version.id))
    .map(summarizeOpenUndo);
  const relatedTodoIds = new Set(versionTodos.map((todo) => todo.id));
  const relatedUndoIds = new Set(versionUndos.map((undo) => undo.id));
  const relatedWorkItemIds = new Set([
    ...versionTodos.map((todo) => todo.workItemId),
    ...versionUndos.map((undo) => undo.workItemId)
  ]);
  const relatedPendingOperations = snapshot.pendingOperations
    .filter(
      (operation) =>
        operation.targetId === version.id ||
        relatedTodoIds.has(operation.targetId) ||
        relatedUndoIds.has(operation.targetId) ||
        relatedWorkItemIds.has(operation.targetId) ||
        operation.payload.currentVersionId === version.id
    )
    .slice()
    .sort(comparePendingOperationsDesc);
  const relatedPendingOperationIds = new Set(
    relatedPendingOperations.map((operation) => operation.id)
  );
  const newestEvents = snapshot.events.slice().reverse();
  const residualAudit = resolveCloseoutResidualAudit(
    relatedPendingOperations,
    version.id,
    version.state === "close"
  );
  const closeGateEvaluation = evaluateCloseGate({
    version,
    todos: versionTodos,
    knownTodos: snapshot.todos,
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
    unresolvedDeferredIds:
      version.state === "close" ? [] : closeGateEvaluation.unresolvedDeferredIds,
    blockedConstraintIds:
      version.state === "close" ? [] : closeGateEvaluation.blockedConstraintIds,
    residualAuditSource: residualAudit.source,
    residualAuditProposalId: residualAudit.proposalId,
    residualAuditReviewed: residualAudit.reviewed
  };
  const recentEvents = newestEvents
    .filter(
      (event) =>
        (event.targetType === "version" && event.targetId === version.id) ||
        (event.targetType === "todo" && relatedTodoIds.has(event.targetId)) ||
        (event.targetType === "undo" && relatedUndoIds.has(event.targetId)) ||
        (event.targetType === "work_item" && relatedWorkItemIds.has(event.targetId)) ||
        (event.targetType === "pending_operation" &&
          relatedPendingOperationIds.has(event.targetId)) ||
        (event.targetType === "approval_artifact" &&
          typeof event.metadata.pendingOperationId === "string" &&
          relatedPendingOperationIds.has(event.metadata.pendingOperationId)) ||
        isProjectCurrentVersionEventForVersion(event, version.id)
    )
    .slice(0, eventLimit)
    .map(summarizeCloseoutRecentEvent);
  const reopenEvents = newestEvents.filter(
    (event) =>
      event.targetType === "version" &&
      event.targetId === version.id &&
      event.eventType === "version.state_changed" &&
      event.toState === "ready" &&
      (event.fromState === "close" || event.fromState === "suspend")
  );
  const latestReopenOperation =
    relatedPendingOperations.find(
      (operation) =>
        operation.actionType === "reopen_version" &&
        operation.targetId === version.id &&
        operation.status === "committed"
    ) ??
    relatedPendingOperations.find(
      (operation) => operation.actionType === "reopen_version" && operation.targetId === version.id
    ) ??
    null;
  const latestReopenEvent =
    reopenEvents.length === 0 ? null : summarizeCloseoutRecentEvent(reopenEvents[0]!);
  const nextAction = buildCloseoutNextAction({
    version,
    closeGate,
    openTodos,
    pendingOperations: relatedPendingOperations
  });
  const summary: VersionCloseoutSummary = {
    projectId: snapshot.project.id,
    version: summarizeCloseoutVersion(version),
    canClose: version.state !== "close" && closeGate.ok,
    closeGate,
    openTodos,
    openUndos,
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
