import type { Constraint } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import { DomainError } from "../domain/errors.js";
import { isUndoBlockingCloseForVersion } from "../domain/route-semantics.js";
import type { Todo } from "../domain/todo.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";

export interface GateBlocker {
  code: string;
  message: string;
  recordIds: string[];
}

export interface StartGateResult {
  allowed: boolean;
  blockers: GateBlocker[];
  openTodoIds: string[];
  dueUndoIds: string[];
  dueDeferredIds: string[];
  selfReferentialUndoIds: string[];
  missingDecisionRefs: string[];
  blockedConstraintIds: string[];
}

export interface StartGateInput {
  targetVersion: Version;
  currentVersionTodos: Todo[];
  dueUndos: Undo[];
  requiredDecisionRefs?: string[];
  deferredItems?: DeferredItem[];
  constraints?: Constraint[];
  constraintChecks?: ConstraintGateCheck[];
}

export type LegacyResidualDestination =
  | "close"
  | "create_undo"
  | "create_todo";

export type ResidualDestination =
  | LegacyResidualDestination
  | "defer_work"
  | "record_constraint";

export interface ResidualAuditItem {
  kind: "bug" | "risk" | "open_question" | "debt";
  summary: string;
  destination: ResidualDestination | null;
  preferredResolutionVersionId?: string | null;
  targetReviewVersionId?: string | null;
  destinationRecordId?: string | null;
}

/**
 * The close boundary is only satisfied after someone has explicitly reviewed
 * residuals. `items: []` therefore means "reviewed and empty", not "missing".
 */
export interface ReviewedResidualAudit {
  status: "reviewed";
  items: ResidualAuditItem[];
}

/**
 * Non-empty arrays are kept for old callers and stored proposals. Empty
 * arrays deliberately carry no review assertion; new callers should send a
 * ReviewedResidualAudit when they reviewed an empty result.
 */
export type ResidualAuditInput =
  | ReviewedResidualAudit
  | ResidualAuditItem[]
  | null
  | undefined;

export interface ResidualAuditStoredEvidence {
  id: string;
  residualAudit?: ResidualAuditInput;
  residualAuditReviewed?: boolean;
}

export type ResidualAuditSource =
  | "input"
  | "proposal_payload"
  | "committed_close_proposal"
  | "missing";

export interface ResolvedResidualAudit {
  audit: ReviewedResidualAudit | null;
  source: ResidualAuditSource;
  proposalId: string | null;
  legacy: boolean;
}

const isReviewedResidualAudit = (value: unknown): value is ReviewedResidualAudit =>
  value !== null &&
  typeof value === "object" &&
  (value as { status?: unknown }).status === "reviewed" &&
  Array.isArray((value as { items?: unknown }).items);

export const normalizeResidualAudit = (
  value: ResidualAuditInput,
  reviewed = false
): { audit: ReviewedResidualAudit | null; legacy: boolean } => {
  if (isReviewedResidualAudit(value)) {
    return {
      audit: { status: "reviewed", items: value.items },
      legacy: false
    };
  }

  if (Array.isArray(value) && (reviewed || value.length > 0)) {
    return {
      audit: { status: "reviewed", items: value },
      legacy: !reviewed
    };
  }

  return { audit: null, legacy: false };
};

/** Resolve the one close-audit truth without upgrading absent or empty legacy data. */
export const resolveResidualAudit = (
  input: ResidualAuditInput,
  pendingCloseEvidence: ResidualAuditStoredEvidence[] = []
): ResolvedResidualAudit => {
  const direct = normalizeResidualAudit(input);

  if (direct.audit !== null) {
    return {
      audit: direct.audit,
      source: "input",
      proposalId: null,
      legacy: direct.legacy
    };
  }

  for (const candidate of pendingCloseEvidence) {
    const normalized = normalizeResidualAudit(
      candidate.residualAudit,
      candidate.residualAuditReviewed === true
    );

    if (normalized.audit !== null) {
      return {
        audit: normalized.audit,
        source: "proposal_payload",
        proposalId: candidate.id,
        legacy: normalized.legacy
      };
    }
  }

  return {
    audit: null,
    source: "missing",
    proposalId: null,
    legacy: false
  };
};

export type LegacyResidualAuditItem = Omit<
  ResidualAuditItem,
  "destination" | "targetReviewVersionId"
> & {
  destination: LegacyResidualDestination | null;
};

export type ConstraintGateCheckStatus =
  | "satisfied"
  | "violated"
  | "evidence_missing";

export interface ConstraintGateCheck {
  constraintId: string;
  status: ConstraintGateCheckStatus;
  evidenceRef?: string | null;
}

export interface CloseGateInput {
  version: Version;
  todos: Todo[];
  knownTodos?: Todo[];
  undos: Undo[];
  residualAudit: ResidualAuditInput;
  knownVersions?: Version[];
  deferredItems?: DeferredItem[];
  constraints?: Constraint[];
  constraintChecks?: ConstraintGateCheck[];
}

export interface CloseGateResult {
  allowed: boolean;
  blockers: GateBlocker[];
  unresolvedTodoIds: string[];
  unresolvedUndoIds: string[];
  unresolvedDeferredIds: string[];
  blockedConstraintIds: string[];
}

interface ConstraintCheckEvaluation {
  blockers: GateBlocker[];
  blockedConstraintIds: string[];
}

export type DeferredRouteFailureCode =
  | "DEFERRED_ROUTE_CONTEXT_REQUIRED"
  | "DEFERRED_ROUTE_TARGET_REQUIRED"
  | "DEFERRED_ROUTE_TARGET_SELF"
  | "DEFERRED_ROUTE_TARGET_UNKNOWN"
  | "DEFERRED_ROUTE_TARGET_CROSS_PROJECT"
  | "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM";

export interface DeferredRouteFailure {
  code: DeferredRouteFailureCode;
  message: string;
}

export const validateDeferredRouteTarget = (
  sourceVersion: Version,
  targetReviewVersionId: string | null | undefined,
  knownVersions: Version[] | undefined
): DeferredRouteFailure | null => {
  const targetId = targetReviewVersionId?.trim() ?? "";

  if (targetId.length === 0) {
    return {
      code: "DEFERRED_ROUTE_TARGET_REQUIRED",
      message: "Deferred 路由必须指定目标 Version"
    };
  }

  if (targetId === sourceVersion.id) {
    return {
      code: "DEFERRED_ROUTE_TARGET_SELF",
      message: "Deferred 路由不能指回来源 Version 自身"
    };
  }

  if (knownVersions === undefined) {
    return {
      code: "DEFERRED_ROUTE_CONTEXT_REQUIRED",
      message: "验证 Deferred 路由需要完整 knownVersions 上下文"
    };
  }

  const targetVersion = knownVersions.find(
    (candidate) => candidate.id === targetId
  );

  if (targetVersion === undefined) {
    return {
      code: "DEFERRED_ROUTE_TARGET_UNKNOWN",
      message: "Deferred 路由目标 Version 不存在"
    };
  }

  if (targetVersion.projectId !== sourceVersion.projectId) {
    return {
      code: "DEFERRED_ROUTE_TARGET_CROSS_PROJECT",
      message: "Deferred 路由目标 Version 不属于来源 Project"
    };
  }

  if (targetVersion.order <= sourceVersion.order) {
    return {
      code: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM",
      message: "Deferred 路由目标必须位于来源 Version 下游"
    };
  }

  return null;
};

export const assertDeferredRouteTarget = (
  sourceVersion: Version,
  targetReviewVersionId: string | null | undefined,
  knownVersions: Version[] | undefined
): void => {
  const failure = validateDeferredRouteTarget(
    sourceVersion,
    targetReviewVersionId,
    knownVersions
  );

  if (failure !== null) {
    const eligibleTargetVersions = (knownVersions ?? [])
      .filter(
        (candidate) =>
          candidate.projectId === sourceVersion.projectId &&
          candidate.order > sourceVersion.order
      )
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        state: candidate.state,
        order: candidate.order
      }));

    throw new DomainError(failure.code, failure.message, {
      sourceVersionId: sourceVersion.id,
      targetReviewVersionId: targetReviewVersionId ?? null,
      eligibleTargetVersions
    });
  }
};

const addDeferredRouteFailure = (
  failures: Map<DeferredRouteFailureCode, GateBlocker>,
  failure: DeferredRouteFailure,
  recordId: string
): void => {
  const blocker = failures.get(failure.code);

  if (blocker === undefined) {
    failures.set(failure.code, {
      code: failure.code,
      message: failure.message,
      recordIds: [recordId]
    });
    return;
  }

  blocker.recordIds.push(recordId);
};

const evaluateConstraintChecks = (
  version: Version,
  constraints: Constraint[],
  checks: ConstraintGateCheck[]
): ConstraintCheckEvaluation => {
  const constraintById = new Map(
    constraints.map((constraint) => [constraint.id, constraint])
  );
  const unknownIds: string[] = [];
  const mismatchedIds: string[] = [];
  const violatedIds: string[] = [];
  const missingEvidenceIds: string[] = [];

  for (const check of checks) {
    const constraint = constraintById.get(check.constraintId);

    if (constraint === undefined) {
      unknownIds.push(check.constraintId);
      continue;
    }

    if (constraint.status === "retired") {
      continue;
    }

    const scopeMatches =
      constraint.projectId === version.projectId &&
      (constraint.scope.type === "project" ||
        constraint.scope.versionId === version.id);

    if (!scopeMatches) {
      mismatchedIds.push(check.constraintId);
      continue;
    }

    if (check.status === "violated") {
      violatedIds.push(check.constraintId);
    } else if (check.status === "evidence_missing") {
      missingEvidenceIds.push(check.constraintId);
    }
  }

  const blockers: GateBlocker[] = [];

  if (unknownIds.length > 0) {
    blockers.push({
      code: "UNKNOWN_CONSTRAINT_GATE_CHECK",
      message: "constraint gate check 引用了未知 Constraint",
      recordIds: unknownIds
    });
  }

  if (mismatchedIds.length > 0) {
    blockers.push({
      code: "MISMATCHED_CONSTRAINT_GATE_CHECK",
      message: "constraint gate check 与目标 Project 或 Version scope 不匹配",
      recordIds: mismatchedIds
    });
  }

  if (violatedIds.length > 0) {
    blockers.push({
      code: "CONSTRAINT_VIOLATED",
      message: "存在已明确违反的 Constraint",
      recordIds: violatedIds
    });
  }

  if (missingEvidenceIds.length > 0) {
    blockers.push({
      code: "CONSTRAINT_EVIDENCE_MISSING",
      message: "Constraint 要求的验证证据缺失",
      recordIds: missingEvidenceIds
    });
  }

  return {
    blockers,
    blockedConstraintIds: [
      ...new Set([
        ...unknownIds,
        ...mismatchedIds,
        ...violatedIds,
        ...missingEvidenceIds
      ])
    ]
  };
};

export const evaluateStartGate = ({
  targetVersion,
  currentVersionTodos,
  dueUndos,
  requiredDecisionRefs = [],
  deferredItems = [],
  constraints = [],
  constraintChecks = []
}: StartGateInput): StartGateResult => {
  const blockers: GateBlocker[] = [];

  if (targetVersion.state !== "ready") {
    blockers.push({
      code: "TARGET_VERSION_NOT_READY",
      message: "start gate 仅允许 ready version 进入 running",
      recordIds: [targetVersion.id]
    });
  }

  const dueUndoIds = dueUndos
    .filter(
      (undo) =>
        undo.preferredResolutionVersionId === targetVersion.id &&
        undo.status === "wait"
    )
    .map((undo) => undo.id);
  const selfReferentialUndoIds = dueUndos
    .filter(
      (undo) =>
        undo.status === "wait" &&
        undo.versionId === targetVersion.id &&
        undo.preferredResolutionVersionId === targetVersion.id
    )
    .map((undo) => undo.id);

  if (dueUndoIds.length > 0) {
    blockers.push({
      code: "OPEN_DUE_UNDOS",
      message: "存在指向目标 version 的待处理 undo",
      recordIds: dueUndoIds
    });
  }

  if (selfReferentialUndoIds.length > 0) {
    blockers.push({
      code: "SELF_REFERENTIAL_UNDO_BLOCKS_START",
      message: "存在由目标 version 自身指回自身的待处理 undo",
      recordIds: selfReferentialUndoIds
    });
  }

  const dueDeferredIds = deferredItems
    .filter(
      (deferred) =>
        deferred.status === "pending" &&
        deferred.targetReviewVersionId === targetVersion.id
    )
    .map((deferred) => deferred.id);

  if (dueDeferredIds.length > 0) {
    blockers.push({
      code: "DUE_DEFERRED_REQUIRES_REVIEW",
      message:
        "存在到期 Deferred；启动目标 Version 前请调用 review_deferred 完成评审",
      recordIds: dueDeferredIds
    });
  }

  if (requiredDecisionRefs.length > 0) {
    blockers.push({
      code: "MISSING_DECISION_REFS",
      message: "缺少路线裁决引用",
      recordIds: requiredDecisionRefs
    });
  }

  const constraintEvaluation = evaluateConstraintChecks(
    targetVersion,
    constraints,
    constraintChecks
  );
  blockers.push(...constraintEvaluation.blockers);

  return {
    allowed: blockers.length === 0,
    blockers,
    openTodoIds: currentVersionTodos
      .filter((todo) => todo.status === "wait" || todo.status === "running")
      .map((todo) => todo.id),
    dueUndoIds,
    dueDeferredIds,
    selfReferentialUndoIds,
    missingDecisionRefs: requiredDecisionRefs,
    blockedConstraintIds: constraintEvaluation.blockedConstraintIds
  };
};

export const assertStartGate = (result: StartGateResult): void => {
  if (!result.allowed) {
    throw new DomainError("START_GATE_FAILED", "start gate 校验失败", {
      blockers: result.blockers
    });
  }
};

export const evaluateCloseGate = ({
  version,
  todos,
  knownTodos = todos,
  undos,
  residualAudit,
  knownVersions,
  deferredItems = [],
  constraints = [],
  constraintChecks = []
}: CloseGateInput): CloseGateResult => {
  const blockers: GateBlocker[] = [];
  const routeFailures = new Map<
    DeferredRouteFailureCode,
    GateBlocker
  >();

  if (version.state !== "complete") {
    blockers.push({
      code: "TARGET_VERSION_NOT_COMPLETE",
      message: "close gate 仅允许 complete version 进入 close",
      recordIds: [version.id]
    });
  }

  const unresolvedTodoIds = todos
    .filter((todo) => todo.status === "wait" || todo.status === "running")
    .map((todo) => todo.id);

  if (unresolvedTodoIds.length > 0) {
    blockers.push({
      code: "OPEN_TODOS",
      message: "存在未关闭 todo",
      recordIds: unresolvedTodoIds
    });
  }

  const unresolvedUndoIds = undos
    .filter((undo) => isUndoBlockingCloseForVersion(undo, version.id))
    .map((undo) => undo.id);

  if (unresolvedUndoIds.length > 0) {
    blockers.push({
      code: "OPEN_UNDOS",
      message: "存在未处理 undo",
      recordIds: unresolvedUndoIds
    });
  }

  const unresolvedDeferredIds: string[] = [];

  for (const deferred of deferredItems) {
    if (
      deferred.status !== "pending" ||
      deferred.originVersionId !== version.id
    ) {
      continue;
    }

    const failure = validateDeferredRouteTarget(
      version,
      deferred.targetReviewVersionId,
      knownVersions
    );

    if (failure !== null) {
      unresolvedDeferredIds.push(deferred.id);
      addDeferredRouteFailure(routeFailures, failure, deferred.id);
    }
  }

  const resolvedAudit = normalizeResidualAudit(residualAudit);

  if (resolvedAudit.audit === null) {
    blockers.push({
      code: "MISSING_RESIDUAL_AUDIT",
      message: "close gate 需要 residual audit",
      recordIds: []
    });
  } else {
    const invalidAuditIndexes = resolvedAudit.audit.items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          item.destination === null ||
          (item.destination === "create_undo" &&
            !item.preferredResolutionVersionId)
      )
      .map(({ index }) => String(index));

    if (invalidAuditIndexes.length > 0) {
      blockers.push({
        code: "INVALID_RESIDUAL_AUDIT_DESTINATION",
        message: "residual audit item 必须有结构化去向",
        recordIds: invalidAuditIndexes
      });
    }

    for (const [index, item] of resolvedAudit.audit.items.entries()) {
      if (
        item.destination !== "create_todo" &&
        item.destination !== "defer_work" &&
        item.destination !== "record_constraint"
      ) {
        continue;
      }

      const itemId = String(index);
      const destinationRecordId = item.destinationRecordId?.trim() ?? "";
      if (destinationRecordId.length === 0) {
        blockers.push({
          code: "RESIDUAL_DESTINATION_RECORD_REQUIRED",
          message:
            "non-close residual destination 必须引用已存在的承接记录；close commit 不会隐式创建 Todo、Deferred 或 Constraint",
          recordIds: [itemId]
        });
        continue;
      }

      if (item.destination === "create_todo") {
        const todo = knownTodos.find((candidate) => candidate.id === destinationRecordId);
        if (todo === undefined) {
          blockers.push({
            code: "RESIDUAL_DESTINATION_RECORD_NOT_FOUND",
            message: "create_todo residual destination 必须引用已存在的 Todo",
            recordIds: [itemId, destinationRecordId]
          });
          continue;
        }
        if (todo.status !== "wait" && todo.status !== "running") {
          blockers.push({
            code: "RESIDUAL_DESTINATION_RECORD_NOT_ACTIONABLE",
            message: "create_todo residual destination 必须引用仍开放的 Todo",
            recordIds: [itemId, destinationRecordId]
          });
          continue;
        }
        const failure = validateDeferredRouteTarget(version, todo.versionId, knownVersions);
        if (failure !== null) {
          addDeferredRouteFailure(routeFailures, failure, destinationRecordId);
        }
        continue;
      }

      if (item.destination === "record_constraint") {
        const constraint = constraints.find(
          (candidate) => candidate.id === destinationRecordId
        );
        if (constraint === undefined) {
          blockers.push({
            code: "RESIDUAL_DESTINATION_RECORD_NOT_FOUND",
            message: "record_constraint residual destination 必须引用已存在的 Constraint",
            recordIds: [itemId, destinationRecordId]
          });
        } else if (constraint.status !== "active") {
          blockers.push({
            code: "RESIDUAL_DESTINATION_RECORD_NOT_ACTIONABLE",
            message: "record_constraint residual destination 必须引用 active Constraint",
            recordIds: [itemId, destinationRecordId]
          });
        }
        continue;
      }

      const deferred = deferredItems.find(
        (candidate) => candidate.id === destinationRecordId
      );
      if (deferred === undefined) {
        blockers.push({
          code: "RESIDUAL_DESTINATION_RECORD_NOT_FOUND",
          message: "defer_work residual destination 必须引用已存在的 Deferred",
          recordIds: [itemId, destinationRecordId]
        });
        continue;
      }
      if (
        deferred.status !== "pending" ||
        deferred.originVersionId !== version.id ||
        deferred.targetReviewVersionId !== item.targetReviewVersionId
      ) {
        blockers.push({
          code: "RESIDUAL_DESTINATION_RECORD_MISMATCH",
          message:
            "defer_work residual destination 必须引用来自当前 Version、仍 pending 且目标一致的 Deferred",
          recordIds: [itemId, destinationRecordId]
        });
        continue;
      }

      const failure = validateDeferredRouteTarget(
        version,
        deferred.targetReviewVersionId,
        knownVersions
      );

      if (failure !== null) {
        addDeferredRouteFailure(
          routeFailures,
          failure,
          destinationRecordId
        );
      }
    }
  }

  blockers.push(...routeFailures.values());

  const constraintEvaluation = evaluateConstraintChecks(
    version,
    constraints,
    constraintChecks
  );
  blockers.push(...constraintEvaluation.blockers);

  return {
    allowed: blockers.length === 0,
    blockers,
    unresolvedTodoIds,
    unresolvedUndoIds,
    unresolvedDeferredIds,
    blockedConstraintIds: constraintEvaluation.blockedConstraintIds
  };
};

export const assertCloseGate = (result: CloseGateResult): void => {
  if (!result.allowed) {
    throw new DomainError("CLOSE_GATE_FAILED", "close gate 校验失败", {
      blockers: result.blockers
    });
  }
};
