import type {
  ApprovalArtifactStatus,
  Constraint,
  ConstraintStatus,
  DeferredItem,
  DeferredStatus,
  L3ActionType,
  PendingOperationStatus,
  ProjectAggregateSnapshot,
  Todo,
  TodoStatus,
  TransitionEvent,
  Undo,
  UndoStatus,
  VersionState
} from "@routeledger/core";

type ReviewRecordTitle = {
  id: string;
  title: string;
};

type StatusChange<TStatus extends string> = ReviewRecordTitle & {
  fromStatus: TStatus;
  toStatus: TStatus;
};

type VersionStateChange = ReviewRecordTitle & {
  fromState: VersionState;
  toState: VersionState;
};

type DeferredReviewTargetChange = ReviewRecordTitle & {
  fromTargetReviewVersionId: string;
  toTargetReviewVersionId: string;
};

type ReviewConstraint = {
  id: string;
  rule: string;
  scope: Constraint["scope"];
};

type RefLabel = string | null;

type CountMap<TKey extends string> = Partial<Record<TKey, number>>;

export type RouteLedgerJsonReviewSummaryErrorCode = "PROJECT_ID_MISMATCH";

export class RouteLedgerJsonReviewSummaryError extends Error {
  readonly code: RouteLedgerJsonReviewSummaryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: RouteLedgerJsonReviewSummaryErrorCode,
    message: string,
    details: Record<string, unknown>
  ) {
    super(message);
    this.name = "RouteLedgerJsonReviewSummaryError";
    this.code = code;
    this.details = details;
  }
}

export interface BuildProjectAggregateReviewSummaryOptions {
  baseLabel?: RefLabel;
  headLabel?: RefLabel;
}

export interface ProjectAggregateReviewSummary {
  overview: {
    baseRef: RefLabel;
    headRef: RefLabel;
    projectId: string;
    hasSemanticChanges: boolean;
  };
  versions: {
    createdCount: number;
    created: Array<ReviewRecordTitle & { state: VersionState }>;
    stateChangedCount: number;
    stateChanged: VersionStateChange[];
    currentPointerChanged: boolean;
    currentPointer: {
      fromVersionId: string | null;
      fromTitle: string | null;
      toVersionId: string | null;
      toTitle: string | null;
    };
    reopenedCount: number;
    reopened: VersionStateChange[];
  };
  todos: {
    createdCount: number;
    created: ReviewRecordTitle[];
    closedCount: number;
    closed: ReviewRecordTitle[];
    statusChangedCount: number;
    statusChanged: StatusChange<TodoStatus>[];
    convertedCount: number;
    converted: ReviewRecordTitle[];
    reassignedCount: number;
    reassigned: Array<ReviewRecordTitle & { fromVersionId: string; toVersionId: string }>;
  };
  deferred: {
    createdCount: number;
    created: Array<ReviewRecordTitle & {
      status: DeferredStatus;
      targetReviewVersionId: string;
    }>;
    statusChangedCount: number;
    statusChanged: StatusChange<DeferredStatus>[];
    reviewTargetChangedCount: number;
    reviewTargetChanged: DeferredReviewTargetChange[];
  };
  constraints: {
    createdCount: number;
    created: Array<ReviewConstraint & { status: ConstraintStatus }>;
    retiredCount: number;
    retired: ReviewConstraint[];
    statusChangedCount: number;
    statusChanged: Array<
      ReviewConstraint & {
        fromStatus: ConstraintStatus;
        toStatus: ConstraintStatus;
      }
    >;
  };
  legacyCompatibility: {
    undos: {
      createdCount: number;
      created: ReviewRecordTitle[];
      closedCount: number;
      closed: ReviewRecordTitle[];
      statusChangedCount: number;
      statusChanged: StatusChange<UndoStatus>[];
      convertedCount: number;
      converted: ReviewRecordTitle[];
      reassignedCount: number;
      reassigned: Array<
        ReviewRecordTitle & {
          fromPreferredResolutionVersionId: string;
          toPreferredResolutionVersionId: string;
        }
      >;
    };
  };
  pendingOperations: {
    proposedCount: number;
    committedCount: number;
    rejectedCount: number;
    statusChangedCount: number;
    statusChanged: Array<
      ReviewRecordTitle & {
        actionType: L3ActionType;
        fromStatus: PendingOperationStatus;
        toStatus: PendingOperationStatus;
      }
    >;
    statusCounts: {
      base: CountMap<PendingOperationStatus>;
      head: CountMap<PendingOperationStatus>;
    };
    actionCounts: {
      base: CountMap<L3ActionType>;
      head: CountMap<L3ActionType>;
    };
  };
  approvalArtifacts: {
    approvedCount: number;
    consumedCount: number;
    statusChangedCount: number;
    statusChanged: Array<
      ReviewRecordTitle & {
        actionType: L3ActionType;
        fromStatus: ApprovalArtifactStatus;
        toStatus: ApprovalArtifactStatus;
      }
    >;
    statusCounts: {
      base: CountMap<ApprovalArtifactStatus>;
      head: CountMap<ApprovalArtifactStatus>;
    };
  };
  assets: {
    createdCount: number;
    created: Array<{ id: string; relativePath: string; status: string }>;
    statusChangedCount: number;
    statusChanged: Array<{
      id: string;
      relativePath: string;
      fromStatus: string;
      toStatus: string;
    }>;
    pathChangedCount: number;
    pathChanged: Array<{
      id: string;
      fromRelativePath: string;
      toRelativePath: string;
      status: string;
    }>;
  };
  eventsDigest: {
    totalAdded: number;
    byType: Record<string, number>;
  };
  warnings: string[];
  summaryText: string;
}

const MAX_LIST_ITEMS = 5;

const toMap = <T extends { id: string }>(records: T[]): Map<string, T> =>
  new Map(records.map((record) => [record.id, record]));

const sortByTitle = <T extends { title: string; id: string }>(records: T[]): T[] =>
  [...records].sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en") || left.id.localeCompare(right.id, "en")
  );

const takeTopItems = <T>(records: T[]): T[] => records.slice(0, MAX_LIST_ITEMS);

const buildCountMap = <TKey extends string>(
  values: TKey[]
): CountMap<TKey> => {
  const counts: CountMap<TKey> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
};

const isTodoOpen = (todo: Todo): boolean => todo.status === "wait" || todo.status === "running";

const isUndoOpen = (undo: Undo): boolean => undo.status === "wait";

const isDeferredPending = (deferred: DeferredItem): boolean =>
  deferred.status === "pending";

const isVersionReopened = (fromState: VersionState, toState: VersionState): boolean =>
  ["close", "complete", "suspend"].includes(fromState) &&
  ["wait", "ready", "running"].includes(toState);

const summarizeVersionRef = (
  snapshot: ProjectAggregateSnapshot,
  versionId: string | null
): { versionId: string | null; title: string | null } => {
  if (versionId === null) {
    return {
      versionId: null,
      title: null
    };
  }

  const version = snapshot.versions.find((item) => item.id === versionId) ?? null;

  return {
    versionId,
    title: version?.title ?? null
  };
};

const buildEventsDigest = (
  baseEvents: TransitionEvent[],
  headEvents: TransitionEvent[]
): ProjectAggregateReviewSummary["eventsDigest"] => {
  const baseIds = new Set(baseEvents.map((event) => event.id));
  const addedEvents = headEvents.filter((event) => !baseIds.has(event.id));
  const byTypeEntries = Object.entries(
    addedEvents.reduce<Record<string, number>>((counts, event) => {
      counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
      return counts;
    }, {})
  ).sort(([left], [right]) => left.localeCompare(right, "en"));

  return {
    totalAdded: addedEvents.length,
    byType: Object.fromEntries(byTypeEntries)
  };
};

const buildWarnings = (headSnapshot: ProjectAggregateSnapshot): string[] => {
  const warnings: string[] = [];
  const pendingOperations = headSnapshot.pendingOperations.filter(
    (operation) => operation.status === "pending"
  );

  if (pendingOperations.length > 0) {
    warnings.push(
      `head 存在 ${pendingOperations.length} 个 pending proposal: ${pendingOperations
        .slice(0, MAX_LIST_ITEMS)
        .map((operation) => operation.id)
        .join(", ")}`
    );
  }

  const openTodos = headSnapshot.todos.filter(isTodoOpen);

  if (openTodos.length > 0) {
    warnings.push(
      `head 仍有 ${openTodos.length} 个 open todo: ${openTodos
        .slice(0, MAX_LIST_ITEMS)
        .map((todo) => todo.title)
        .join(", ")}`
    );
  }

  const pendingDeferred = headSnapshot.deferredItems.filter(isDeferredPending);

  if (pendingDeferred.length > 0) {
    warnings.push(
      `head 仍有 ${pendingDeferred.length} 个 Deferred 等待复评: ${pendingDeferred
        .slice(0, MAX_LIST_ITEMS)
        .map((deferred) => deferred.title)
        .join(", ")}`
    );
  }

  const openUndos = headSnapshot.undos.filter(isUndoOpen);

  if (openUndos.length > 0) {
    warnings.push(
      `Legacy compatibility: head 仍有 ${openUndos.length} 个 open Undo audit record: ${openUndos
        .slice(0, MAX_LIST_ITEMS)
        .map((undo) => undo.title)
        .join(", ")}`
    );
  }

  const runningVersions = headSnapshot.versions.filter((version) => version.state === "running");

  if (runningVersions.length > 1) {
    warnings.push(
      `head 存在 ${runningVersions.length} 个 running version: ${runningVersions
        .slice(0, MAX_LIST_ITEMS)
        .map((version) => version.title)
        .join(", ")}`
    );
  }

  if (runningVersions.length === 1 && headSnapshot.project.currentVersionId !== null) {
    const runningVersion = runningVersions[0]!;
    const currentVersion = headSnapshot.versions.find(
      (version) => version.id === headSnapshot.project.currentVersionId
    );

    if (currentVersion !== undefined && currentVersion.id !== runningVersion.id) {
      warnings.push(
        `head current pointer drift: current=${currentVersion.title} (${currentVersion.id}), running=${runningVersion.title} (${runningVersion.id})`
      );
    }
  }

  const selfReferentialUndos = headSnapshot.undos.filter(
    (undo) =>
      undo.status === "wait" &&
      undo.versionId === undo.preferredResolutionVersionId
  );

  if (selfReferentialUndos.length > 0) {
    warnings.push(
      `Legacy compatibility: head 存在 ${selfReferentialUndos.length} 个 self-referential Undo blocker: ${selfReferentialUndos
        .slice(0, MAX_LIST_ITEMS)
        .map((undo) => undo.title)
        .join(", ")}`
    );
  }

  return warnings;
};

const buildSummaryText = (
  summary: Omit<ProjectAggregateReviewSummary, "summaryText">,
  labels: { baseLabel: RefLabel; headLabel: RefLabel }
): string => {
  const baseLabel = labels.baseLabel ?? "base";
  const headLabel = labels.headLabel ?? "head";
  const lines = [`RouteLedger review summary: ${baseLabel} -> ${headLabel}`];

  if (!summary.overview.hasSemanticChanges) {
    lines.push("No semantic RouteLedger changes detected; only event/audit churn changed.");
  } else {
    if (summary.versions.createdCount > 0 || summary.versions.stateChangedCount > 0) {
      lines.push(
        `Versions: +${summary.versions.createdCount} created, ${summary.versions.stateChangedCount} state changes, ${summary.versions.reopenedCount} reopened.`
      );
    }

    if (
      summary.todos.createdCount > 0 ||
      summary.todos.closedCount > 0 ||
      summary.todos.convertedCount > 0
    ) {
      lines.push(
        `Todos: +${summary.todos.createdCount} created, ${summary.todos.closedCount} closed, ${summary.todos.convertedCount} converted.`
      );
    }

    if (
      summary.deferred.createdCount > 0 ||
      summary.deferred.statusChangedCount > 0 ||
      summary.deferred.reviewTargetChangedCount > 0
    ) {
      lines.push(
        `Deferred: +${summary.deferred.createdCount} created, ${summary.deferred.statusChangedCount} status changes, ${summary.deferred.reviewTargetChangedCount} review-target changes.`
      );
    }

    if (
      summary.constraints.createdCount > 0 ||
      summary.constraints.retiredCount > 0
    ) {
      lines.push(
        `Constraints: +${summary.constraints.createdCount} created, ${summary.constraints.retiredCount} retired.`
      );
    }

    const legacyUndos = summary.legacyCompatibility.undos;

    if (
      legacyUndos.createdCount > 0 ||
      legacyUndos.closedCount > 0 ||
      legacyUndos.reassignedCount > 0 ||
      legacyUndos.convertedCount > 0
    ) {
      lines.push(
        `Legacy compatibility - Undo audit records: +${legacyUndos.createdCount} created, ${legacyUndos.closedCount} closed, ${legacyUndos.reassignedCount} reassigned, ${legacyUndos.convertedCount} converted.`
      );
    }

    if (
      summary.pendingOperations.proposedCount > 0 ||
      summary.pendingOperations.committedCount > 0 ||
      summary.pendingOperations.rejectedCount > 0
    ) {
      lines.push(
        `Pending operations: ${summary.pendingOperations.proposedCount} proposed, ${summary.pendingOperations.committedCount} committed, ${summary.pendingOperations.rejectedCount} rejected in range.`
      );
    }

    if (
      summary.approvalArtifacts.approvedCount > 0 ||
      summary.approvalArtifacts.consumedCount > 0
    ) {
      lines.push(
        `Approval artifacts: ${summary.approvalArtifacts.approvedCount} approved, ${summary.approvalArtifacts.consumedCount} consumed in range.`
      );
    }

    if (
      summary.assets.createdCount > 0 ||
      summary.assets.statusChangedCount > 0 ||
      summary.assets.pathChangedCount > 0
    ) {
      lines.push(
        `Assets: +${summary.assets.createdCount} created, ${summary.assets.statusChangedCount} status changes, ${summary.assets.pathChangedCount} path changes.`
      );
    }
  }

  lines.push(
    `Events added: ${summary.eventsDigest.totalAdded} (${Object.entries(summary.eventsDigest.byType)
      .map(([eventType, count]) => `${eventType}=${count}`)
      .join(", ") || "none"}).`
  );

  if (summary.warnings.length > 0) {
    lines.push(`Warnings: ${summary.warnings.join(" | ")}`);
  }

  return lines.join("\n");
};

export const buildProjectAggregateReviewSummary = (
  baseSnapshot: ProjectAggregateSnapshot,
  headSnapshot: ProjectAggregateSnapshot,
  options: BuildProjectAggregateReviewSummaryOptions = {}
): ProjectAggregateReviewSummary => {
  if (baseSnapshot.project.id !== headSnapshot.project.id) {
    throw new RouteLedgerJsonReviewSummaryError(
      "PROJECT_ID_MISMATCH",
      "两个 ref 的 projectId 不一致，无法做语义 review summary",
      {
        baseProjectId: baseSnapshot.project.id,
        headProjectId: headSnapshot.project.id
      }
    );
  }

  const baseVersions = toMap(baseSnapshot.versions);
  const baseTodos = toMap(baseSnapshot.todos);
  const baseDeferred = toMap(baseSnapshot.deferredItems);
  const baseConstraints = toMap(baseSnapshot.constraints);
  const baseUndos = toMap(baseSnapshot.undos);
  const basePendingOperations = toMap(baseSnapshot.pendingOperations);
  const baseApprovalArtifacts = toMap(baseSnapshot.approvalArtifacts);
  const baseAssets = toMap(baseSnapshot.assets);

  const createdVersions = takeTopItems(
    headSnapshot.versions
      .filter((version) => !baseVersions.has(version.id))
      .sort((left, right) => left.order - right.order)
      .map((version) => ({
        id: version.id,
        title: version.title,
        state: version.state
      }))
  );
  const changedVersionStates = takeTopItems(
    sortByTitle(
      headSnapshot.versions
        .filter((version) => baseVersions.has(version.id))
        .map((version) => ({
          version,
          baseVersion: baseVersions.get(version.id)!
        }))
        .filter(({ version, baseVersion }) => version.state !== baseVersion.state)
        .map(({ version, baseVersion }) => ({
          id: version.id,
          title: version.title,
          fromState: baseVersion.state,
          toState: version.state
        }))
    )
  );
  const reopenedVersions = changedVersionStates.filter((change) =>
    isVersionReopened(change.fromState, change.toState)
  );
  const baseCurrentPointer = summarizeVersionRef(baseSnapshot, baseSnapshot.project.currentVersionId);
  const headCurrentPointer = summarizeVersionRef(headSnapshot, headSnapshot.project.currentVersionId);

  const createdTodos = takeTopItems(
    sortByTitle(headSnapshot.todos.filter((todo) => !baseTodos.has(todo.id))).map((todo) => ({
      id: todo.id,
      title: todo.title
    }))
  );
  const todoStatusChanges = takeTopItems(
    sortByTitle(
      headSnapshot.todos
        .filter((todo) => baseTodos.has(todo.id))
        .map((todo) => ({
          todo,
          baseTodo: baseTodos.get(todo.id)!
        }))
        .filter(({ todo, baseTodo }) => todo.status !== baseTodo.status)
        .map(({ todo, baseTodo }) => ({
          id: todo.id,
          title: todo.title,
          fromStatus: baseTodo.status,
          toStatus: todo.status
        }))
    )
  );
  const closedTodos = todoStatusChanges
    .filter((todo) => todo.toStatus === "closed")
    .map(({ id, title }) => ({ id, title }));
  const convertedTodos = todoStatusChanges
    .filter((todo) => todo.toStatus === "converted")
    .map(({ id, title }) => ({ id, title }));
  const reassignedTodos = takeTopItems(
    sortByTitle(
      headSnapshot.todos
        .filter((todo) => baseTodos.has(todo.id))
        .map((todo) => ({
          todo,
          baseTodo: baseTodos.get(todo.id)!
        }))
        .filter(({ todo, baseTodo }) => todo.versionId !== baseTodo.versionId)
        .map(({ todo, baseTodo }) => ({
          id: todo.id,
          title: todo.title,
          fromVersionId: baseTodo.versionId,
          toVersionId: todo.versionId
        }))
    )
  );

  const createdDeferred = takeTopItems(
    sortByTitle(
      headSnapshot.deferredItems.filter(
        (deferred) => !baseDeferred.has(deferred.id)
      )
    ).map((deferred) => ({
      id: deferred.id,
      title: deferred.title,
      status: deferred.status,
      targetReviewVersionId: deferred.targetReviewVersionId
    }))
  );
  const deferredStatusChanges = takeTopItems(
    sortByTitle(
      headSnapshot.deferredItems
        .filter((deferred) => baseDeferred.has(deferred.id))
        .map((deferred) => ({
          deferred,
          baseDeferred: baseDeferred.get(deferred.id)!
        }))
        .filter(
          ({ deferred, baseDeferred: baseRecord }) =>
            deferred.status !== baseRecord.status
        )
        .map(({ deferred, baseDeferred: baseRecord }) => ({
          id: deferred.id,
          title: deferred.title,
          fromStatus: baseRecord.status,
          toStatus: deferred.status
        }))
    )
  );
  const deferredReviewTargetChanges = takeTopItems(
    sortByTitle(
      headSnapshot.deferredItems
        .filter((deferred) => baseDeferred.has(deferred.id))
        .map((deferred) => ({
          deferred,
          baseDeferred: baseDeferred.get(deferred.id)!
        }))
        .filter(
          ({ deferred, baseDeferred: baseRecord }) =>
            deferred.targetReviewVersionId !== baseRecord.targetReviewVersionId
        )
        .map(({ deferred, baseDeferred: baseRecord }) => ({
          id: deferred.id,
          title: deferred.title,
          fromTargetReviewVersionId: baseRecord.targetReviewVersionId,
          toTargetReviewVersionId: deferred.targetReviewVersionId
        }))
    )
  );

  const createdConstraints = takeTopItems(
    headSnapshot.constraints
      .filter((constraint) => !baseConstraints.has(constraint.id))
      .sort(
        (left, right) =>
          left.rule.localeCompare(right.rule, "en") ||
          left.id.localeCompare(right.id, "en")
      )
      .map((constraint) => ({
        id: constraint.id,
        rule: constraint.rule,
        scope: constraint.scope,
        status: constraint.status
      }))
  );
  const constraintStatusChanges = takeTopItems(
    headSnapshot.constraints
      .filter((constraint) => baseConstraints.has(constraint.id))
      .map((constraint) => ({
        constraint,
        baseConstraint: baseConstraints.get(constraint.id)!
      }))
      .filter(
        ({ constraint, baseConstraint }) =>
          constraint.status !== baseConstraint.status
      )
      .sort(
        (left, right) =>
          left.constraint.rule.localeCompare(right.constraint.rule, "en") ||
          left.constraint.id.localeCompare(right.constraint.id, "en")
      )
      .map(({ constraint, baseConstraint }) => ({
        id: constraint.id,
        rule: constraint.rule,
        scope: constraint.scope,
        fromStatus: baseConstraint.status,
        toStatus: constraint.status
      }))
  );
  const retiredConstraints = constraintStatusChanges
    .filter((constraint) => constraint.toStatus === "retired")
    .map(({ id, rule, scope }) => ({ id, rule, scope }));

  const createdUndos = takeTopItems(
    sortByTitle(headSnapshot.undos.filter((undo) => !baseUndos.has(undo.id))).map((undo) => ({
      id: undo.id,
      title: undo.title
    }))
  );
  const undoStatusChanges = takeTopItems(
    sortByTitle(
      headSnapshot.undos
        .filter((undo) => baseUndos.has(undo.id))
        .map((undo) => ({
          undo,
          baseUndo: baseUndos.get(undo.id)!
        }))
        .filter(({ undo, baseUndo }) => undo.status !== baseUndo.status)
        .map(({ undo, baseUndo }) => ({
          id: undo.id,
          title: undo.title,
          fromStatus: baseUndo.status,
          toStatus: undo.status
        }))
    )
  );
  const closedUndos = undoStatusChanges
    .filter((undo) => undo.toStatus === "closed")
    .map(({ id, title }) => ({ id, title }));
  const convertedUndos = undoStatusChanges
    .filter((undo) => undo.toStatus === "converted")
    .map(({ id, title }) => ({ id, title }));
  const reassignedUndos = takeTopItems(
    sortByTitle(
      headSnapshot.undos
        .filter((undo) => baseUndos.has(undo.id))
        .map((undo) => ({
          undo,
          baseUndo: baseUndos.get(undo.id)!
        }))
        .filter(
          ({ undo, baseUndo }) =>
            undo.preferredResolutionVersionId !== baseUndo.preferredResolutionVersionId
        )
        .map(({ undo, baseUndo }) => ({
          id: undo.id,
          title: undo.title,
          fromPreferredResolutionVersionId: baseUndo.preferredResolutionVersionId,
          toPreferredResolutionVersionId: undo.preferredResolutionVersionId
        }))
    )
  );

  const createdPending = headSnapshot.pendingOperations.filter(
    (operation) => !basePendingOperations.has(operation.id)
  );
  const pendingStatusChanges = takeTopItems(
    headSnapshot.pendingOperations
      .filter((operation) => basePendingOperations.has(operation.id))
      .map((operation) => ({
        operation,
        baseOperation: basePendingOperations.get(operation.id)!
      }))
      .filter(({ operation, baseOperation }) => operation.status !== baseOperation.status)
      .sort(
        (left, right) =>
          left.operation.createdAt.localeCompare(right.operation.createdAt, "en") ||
          left.operation.id.localeCompare(right.operation.id, "en")
      )
      .map(({ operation, baseOperation }) => ({
        id: operation.id,
        title: operation.reason,
        actionType: operation.actionType,
        fromStatus: baseOperation.status,
        toStatus: operation.status
      }))
  );

  const createdApprovalArtifacts = headSnapshot.approvalArtifacts.filter(
    (artifact) => !baseApprovalArtifacts.has(artifact.id)
  );
  const approvalStatusChanges = takeTopItems(
    headSnapshot.approvalArtifacts
      .filter((artifact) => baseApprovalArtifacts.has(artifact.id))
      .map((artifact) => ({
        artifact,
        baseArtifact: baseApprovalArtifacts.get(artifact.id)!
      }))
      .filter(({ artifact, baseArtifact }) => artifact.status !== baseArtifact.status)
      .sort(
        (left, right) =>
          left.artifact.createdAt.localeCompare(right.artifact.createdAt, "en") ||
          left.artifact.id.localeCompare(right.artifact.id, "en")
      )
      .map(({ artifact, baseArtifact }) => ({
        id: artifact.id,
        title: artifact.decisionRef,
        actionType: artifact.actionType,
        fromStatus: baseArtifact.status,
        toStatus: artifact.status
      }))
  );

  const createdAssets = takeTopItems(
    headSnapshot.assets
      .filter((asset) => !baseAssets.has(asset.id))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))
      .map((asset) => ({
        id: asset.id,
        relativePath: asset.relativePath,
        status: asset.status
      }))
  );
  const assetStatusChanges = takeTopItems(
    headSnapshot.assets
      .filter((asset) => baseAssets.has(asset.id))
      .map((asset) => ({
        asset,
        baseAsset: baseAssets.get(asset.id)!
      }))
      .filter(({ asset, baseAsset }) => asset.status !== baseAsset.status)
      .sort(
        (left, right) => left.asset.relativePath.localeCompare(right.asset.relativePath, "en")
      )
      .map(({ asset, baseAsset }) => ({
        id: asset.id,
        relativePath: asset.relativePath,
        fromStatus: baseAsset.status,
        toStatus: asset.status
      }))
  );
  const assetPathChanges = takeTopItems(
    headSnapshot.assets
      .filter((asset) => baseAssets.has(asset.id))
      .map((asset) => ({
        asset,
        baseAsset: baseAssets.get(asset.id)!
      }))
      .filter(({ asset, baseAsset }) => asset.relativePath !== baseAsset.relativePath)
      .sort(
        (left, right) => left.asset.relativePath.localeCompare(right.asset.relativePath, "en")
      )
      .map(({ asset, baseAsset }) => ({
        id: asset.id,
        fromRelativePath: baseAsset.relativePath,
        toRelativePath: asset.relativePath,
        status: asset.status
      }))
  );

  const pendingStatusesInRange = [...createdPending, ...pendingStatusChanges.map((item) => ({ status: item.toStatus }))];
  const approvalStatusesInRange = [
    ...createdApprovalArtifacts,
    ...approvalStatusChanges.map((item) => ({ status: item.toStatus }))
  ];

  const semanticChangeSignals = [
    createdVersions.length > 0,
    changedVersionStates.length > 0,
    baseSnapshot.project.currentVersionId !== headSnapshot.project.currentVersionId,
    createdTodos.length > 0,
    todoStatusChanges.length > 0,
    reassignedTodos.length > 0,
    createdDeferred.length > 0,
    deferredStatusChanges.length > 0,
    deferredReviewTargetChanges.length > 0,
    createdConstraints.length > 0,
    constraintStatusChanges.length > 0,
    createdUndos.length > 0,
    undoStatusChanges.length > 0,
    reassignedUndos.length > 0,
    createdPending.length > 0,
    pendingStatusChanges.length > 0,
    createdApprovalArtifacts.length > 0,
    approvalStatusChanges.length > 0,
    createdAssets.length > 0,
    assetStatusChanges.length > 0,
    assetPathChanges.length > 0
  ];

  const partialSummary: Omit<ProjectAggregateReviewSummary, "summaryText"> = {
    overview: {
      baseRef: options.baseLabel ?? null,
      headRef: options.headLabel ?? null,
      projectId: headSnapshot.project.id,
      hasSemanticChanges: semanticChangeSignals.some(Boolean)
    },
    versions: {
      createdCount: headSnapshot.versions.filter((version) => !baseVersions.has(version.id)).length,
      created: createdVersions,
      stateChangedCount: headSnapshot.versions.filter((version) => {
        const baseVersion = baseVersions.get(version.id);
        return baseVersion !== undefined && baseVersion.state !== version.state;
      }).length,
      stateChanged: changedVersionStates,
      currentPointerChanged: baseSnapshot.project.currentVersionId !== headSnapshot.project.currentVersionId,
      currentPointer: {
        fromVersionId: baseCurrentPointer.versionId,
        fromTitle: baseCurrentPointer.title,
        toVersionId: headCurrentPointer.versionId,
        toTitle: headCurrentPointer.title
      },
      reopenedCount: headSnapshot.versions.filter((version) => {
        const baseVersion = baseVersions.get(version.id);
        return (
          baseVersion !== undefined &&
          baseVersion.state !== version.state &&
          isVersionReopened(baseVersion.state, version.state)
        );
      }).length,
      reopened: reopenedVersions
    },
    todos: {
      createdCount: headSnapshot.todos.filter((todo) => !baseTodos.has(todo.id)).length,
      created: createdTodos,
      closedCount: headSnapshot.todos.filter((todo) => {
        const baseTodo = baseTodos.get(todo.id);
        return baseTodo !== undefined && baseTodo.status !== "closed" && todo.status === "closed";
      }).length,
      closed: takeTopItems(closedTodos),
      statusChangedCount: headSnapshot.todos.filter((todo) => {
        const baseTodo = baseTodos.get(todo.id);
        return baseTodo !== undefined && baseTodo.status !== todo.status;
      }).length,
      statusChanged: todoStatusChanges,
      convertedCount: headSnapshot.todos.filter((todo) => {
        const baseTodo = baseTodos.get(todo.id);
        return baseTodo !== undefined && baseTodo.status !== "converted" && todo.status === "converted";
      }).length,
      converted: takeTopItems(convertedTodos),
      reassignedCount: headSnapshot.todos.filter((todo) => {
        const baseTodo = baseTodos.get(todo.id);
        return baseTodo !== undefined && baseTodo.versionId !== todo.versionId;
      }).length,
      reassigned: reassignedTodos
    },
    deferred: {
      createdCount: headSnapshot.deferredItems.filter(
        (deferred) => !baseDeferred.has(deferred.id)
      ).length,
      created: createdDeferred,
      statusChangedCount: headSnapshot.deferredItems.filter((deferred) => {
        const baseRecord = baseDeferred.get(deferred.id);
        return baseRecord !== undefined && baseRecord.status !== deferred.status;
      }).length,
      statusChanged: deferredStatusChanges,
      reviewTargetChangedCount: headSnapshot.deferredItems.filter((deferred) => {
        const baseRecord = baseDeferred.get(deferred.id);
        return (
          baseRecord !== undefined &&
          baseRecord.targetReviewVersionId !== deferred.targetReviewVersionId
        );
      }).length,
      reviewTargetChanged: deferredReviewTargetChanges
    },
    constraints: {
      createdCount: headSnapshot.constraints.filter(
        (constraint) => !baseConstraints.has(constraint.id)
      ).length,
      created: createdConstraints,
      retiredCount: headSnapshot.constraints.filter((constraint) => {
        const baseConstraint = baseConstraints.get(constraint.id);
        return (
          baseConstraint !== undefined &&
          baseConstraint.status !== "retired" &&
          constraint.status === "retired"
        );
      }).length,
      retired: takeTopItems(retiredConstraints),
      statusChangedCount: headSnapshot.constraints.filter((constraint) => {
        const baseConstraint = baseConstraints.get(constraint.id);
        return (
          baseConstraint !== undefined &&
          baseConstraint.status !== constraint.status
        );
      }).length,
      statusChanged: constraintStatusChanges
    },
    legacyCompatibility: {
      undos: {
        createdCount: headSnapshot.undos.filter((undo) => !baseUndos.has(undo.id)).length,
        created: createdUndos,
        closedCount: headSnapshot.undos.filter((undo) => {
          const baseUndo = baseUndos.get(undo.id);
          return baseUndo !== undefined && baseUndo.status !== "closed" && undo.status === "closed";
        }).length,
        closed: takeTopItems(closedUndos),
        statusChangedCount: headSnapshot.undos.filter((undo) => {
          const baseUndo = baseUndos.get(undo.id);
          return baseUndo !== undefined && baseUndo.status !== undo.status;
        }).length,
        statusChanged: undoStatusChanges,
        convertedCount: headSnapshot.undos.filter((undo) => {
          const baseUndo = baseUndos.get(undo.id);
          return baseUndo !== undefined && baseUndo.status !== "converted" && undo.status === "converted";
        }).length,
        converted: takeTopItems(convertedUndos),
        reassignedCount: headSnapshot.undos.filter((undo) => {
          const baseUndo = baseUndos.get(undo.id);
          return (
            baseUndo !== undefined &&
            baseUndo.preferredResolutionVersionId !== undo.preferredResolutionVersionId
          );
        }).length,
        reassigned: reassignedUndos
      }
    },
    pendingOperations: {
      proposedCount: createdPending.length,
      committedCount: pendingStatusesInRange.filter((operation) => operation.status === "committed").length,
      rejectedCount: pendingStatusesInRange.filter((operation) => operation.status === "rejected").length,
      statusChangedCount: pendingStatusChanges.length,
      statusChanged: pendingStatusChanges,
      statusCounts: {
        base: buildCountMap(baseSnapshot.pendingOperations.map((operation) => operation.status)),
        head: buildCountMap(headSnapshot.pendingOperations.map((operation) => operation.status))
      },
      actionCounts: {
        base: buildCountMap(baseSnapshot.pendingOperations.map((operation) => operation.actionType)),
        head: buildCountMap(headSnapshot.pendingOperations.map((operation) => operation.actionType))
      }
    },
    approvalArtifacts: {
      approvedCount: approvalStatusesInRange.filter((artifact) => artifact.status === "approved").length,
      consumedCount: approvalStatusesInRange.filter((artifact) => artifact.status === "consumed").length,
      statusChangedCount: approvalStatusChanges.length,
      statusChanged: approvalStatusChanges,
      statusCounts: {
        base: buildCountMap(baseSnapshot.approvalArtifacts.map((artifact) => artifact.status)),
        head: buildCountMap(headSnapshot.approvalArtifacts.map((artifact) => artifact.status))
      }
    },
    assets: {
      createdCount: headSnapshot.assets.filter((asset) => !baseAssets.has(asset.id)).length,
      created: createdAssets,
      statusChangedCount: headSnapshot.assets.filter((asset) => {
        const baseAsset = baseAssets.get(asset.id);
        return baseAsset !== undefined && baseAsset.status !== asset.status;
      }).length,
      statusChanged: assetStatusChanges,
      pathChangedCount: headSnapshot.assets.filter((asset) => {
        const baseAsset = baseAssets.get(asset.id);
        return baseAsset !== undefined && baseAsset.relativePath !== asset.relativePath;
      }).length,
      pathChanged: assetPathChanges
    },
    eventsDigest: buildEventsDigest(baseSnapshot.events, headSnapshot.events),
    warnings: buildWarnings(headSnapshot)
  };

  return {
    ...partialSummary,
    summaryText: buildSummaryText(partialSummary, {
      baseLabel: options.baseLabel ?? null,
      headLabel: options.headLabel ?? null
    })
  };
};
