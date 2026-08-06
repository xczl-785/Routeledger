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
  type LegacyResidualAuditItem
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

export type SelfReferentialUndoCategory = "guardrail_like" | "cleanup_like" | "uncertain";

export type SelfReferentialUndoRecommendedResolution =
  | "close_undo"
  | "close_undo_then_create_todo"
  | "manual_review";

export interface SelfReferentialUndoAlternative {
  actionType: "close_undo" | "close_undo_then_create_todo" | "carry_forward_undo";
  recommendedTool: string | null;
  summary: string;
  reason: string;
}

export interface SelfReferentialUndoSummary extends CloseoutOpenUndoSummary {
  code:
    | "SELF_REFERENTIAL_UNDO_GUARDRAIL"
    | "SELF_REFERENTIAL_UNDO_CLEANUP"
    | "SELF_REFERENTIAL_UNDO_NEEDS_REVIEW";
  category: SelfReferentialUndoCategory;
  matchedKeywords: string[];
  recommendedResolution: SelfReferentialUndoRecommendedResolution;
  reason: string;
  note: string;
  alternatives: SelfReferentialUndoAlternative[];
}

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

type CloseoutResidualAuditSource = "assumed_none" | "proposal_payload";

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
    residualAuditSource: CloseoutResidualAuditSource;
    residualAuditProposalId: string | null;
  };
  openTodos: CloseoutOpenTodoSummary[];
  openUndos: CloseoutOpenUndoSummary[];
  selfReferentialUndos: SelfReferentialUndoSummary[];
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
  residualAudit: LegacyResidualAuditItem[];
  relatedPendingOperations: PendingOperation[];
  summary: VersionCloseoutSummary;
  meta: Record<string, unknown>;
};

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
] as const;
const SELF_REFERENTIAL_CLEANUP_KEYWORDS = [
  "after close",
  "afterwards",
  "cleanup",
  "delete",
  "migrate",
  "follow-up"
] as const;
const DEFAULT_CLOSEOUT_RESIDUAL_AUDIT: LegacyResidualAuditItem[] = [
  {
    kind: "debt",
    summary: "none",
    destination: "close"
  }
];

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

const collectKeywordMatches = (text: string, keywords: readonly string[]): string[] => {
  const normalized = text.toLowerCase();

  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
};

const buildSelfReferentialUndoAlternatives = (
  category: SelfReferentialUndoCategory
): SelfReferentialUndoAlternative[] => {
  if (category === "guardrail_like") {
    return [
      {
        actionType: "carry_forward_undo",
        recommendedTool: "carry_forward_undo",
        summary: "Only carry it forward if the rollback really belongs to a downstream version.",
        reason:
          "Guardrail-like self undo usually closes better as a documented closeout condition than as a fresh downstream blocker."
      }
    ];
  }

  if (category === "cleanup_like") {
    return [
      {
        actionType: "carry_forward_undo",
        recommendedTool: "carry_forward_undo",
        summary:
          "Keep it as undo only if the downstream owner and preferred resolution version are already explicit.",
        reason:
          "Cleanup-like self undo usually reads more clearly as a follow-up todo than as an open undo pointing back to itself."
      }
    ];
  }

  return [
    {
      actionType: "close_undo",
      recommendedTool: "close_undo",
      summary: "Close the self-referential undo in place.",
      reason:
        "Use this when the record is really a guardrail or a note that should stop blocking the route."
    },
    {
      actionType: "close_undo_then_create_todo",
      recommendedTool: null,
      summary: "Close the undo, then create a downstream todo.",
      reason:
        "Use this when the text actually describes post-close cleanup instead of a true rollback guardrail."
    },
    {
      actionType: "carry_forward_undo",
      recommendedTool: "carry_forward_undo",
      summary: "Carry the undo forward unchanged.",
      reason:
        "Use this only when the issue is still an undo and a downstream preferred resolution version is already clear."
    }
  ];
};

const summarizeSelfReferentialUndo = (undo: Undo): SelfReferentialUndoSummary => {
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
      reason:
        "This self-referential undo reads like a guardrail. Close it and keep the conditional rollback in the closeout record instead of blocking start/close as a due undo.",
      note:
        "Recommended path: close_undo, then copy the guardrail into residual audit or the closeout note so the controller still sees the rollback condition without treating it as an open undo.",
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
      reason:
        "This self-referential undo reads like post-close cleanup. It should stop blocking the current version and move onto an explicit follow-up todo path.",
      note:
        "Recommended path: close_undo, then create_todo on the chosen follow-up version or backlog owner. Do not keep a cleanup note as a self-referential undo.",
      alternatives: buildSelfReferentialUndoAlternatives("cleanup_like")
    };
  }

  return {
    ...base,
    code: "SELF_REFERENTIAL_UNDO_NEEDS_REVIEW",
    category: "uncertain",
    matchedKeywords: [...guardrailMatches, ...cleanupMatches],
    recommendedResolution: "manual_review",
    reason:
      "This self-referential undo still blocks the route, but the text does not cleanly say whether it is a guardrail or a follow-up cleanup item.",
    note:
      "Manual review required. Decide whether to close_undo, close_undo then create_todo, or carry_forward_undo before treating it as an ordinary blocker.",
    alternatives: buildSelfReferentialUndoAlternatives("uncertain")
  };
};

const resolveCloseoutResidualAudit = (
  pendingOperations: PendingOperation[],
  versionId: string
): {
  residualAudit: LegacyResidualAuditItem[];
  source: CloseoutResidualAuditSource;
  proposalId: string | null;
} => {
  const closeProposal = pendingOperations
    .filter(
      (operation) =>
        operation.actionType === "close_version" &&
        operation.targetId === versionId &&
        Array.isArray(operation.payload.residualAudit) &&
        operation.payload.residualAudit.length > 0
    )
    .slice()
    .sort(comparePendingOperationsDesc)[0];

  if (closeProposal !== undefined) {
    return {
      residualAudit: structuredClone(
        closeProposal.payload.residualAudit as LegacyResidualAuditItem[]
      ),
      source: "proposal_payload",
      proposalId: closeProposal.id
    };
  }

  return {
    residualAudit: structuredClone(DEFAULT_CLOSEOUT_RESIDUAL_AUDIT),
    source: "assumed_none",
    proposalId: null
  };
};

const buildCloseoutNextAction = (options: {
  version: Version;
  closeGate: {
    ok: boolean;
    blockers: GateBlocker[];
  };
  openTodos: CloseoutOpenTodoSummary[];
  openUndos: CloseoutOpenUndoSummary[];
  pendingOperations: PendingOperation[];
}): CloseoutNextActionSummary => {
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

  if (openUndos.length > 0) {
    const undo = openUndos[0]!;

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
  const residualAudit = resolveCloseoutResidualAudit(relatedPendingOperations, version.id);
  const closeGateEvaluation = evaluateCloseGate({
    version,
    todos: versionTodos,
    undos: versionUndos,
    residualAudit: residualAudit.residualAudit,
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
    residualAuditProposalId: residualAudit.proposalId
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
    openUndos,
    pendingOperations: relatedPendingOperations
  });
  const summary: VersionCloseoutSummary = {
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
