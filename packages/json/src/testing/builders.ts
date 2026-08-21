import type {
  ApprovalArtifact,
  PendingOperation,
  ProjectAggregateSnapshot,
  TransitionEvent
} from "@routeledger/core";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTodoFixture,
  createUndoFixture,
  createVersionFixture,
  createWorkItemFixture
} from "@routeledger/core/testing";

const TEST_APPROVER = {
  id: "user-1",
  type: "user" as const,
  displayName: "owner"
};

const createDigestPayloadFixture = () => ({
  projectId: "project-1",
  actionType: "close_version" as const,
  targetId: "version-2",
  payload: {
    residualAudit: [
      {
        kind: "debt" as const,
        summary: "capture follow-up",
        destination: "create_undo" as const,
        preferredResolutionVersionId: "version-3"
      }
    ],
    description: "close current version",
    currentVersionId: "version-2",
    siblingVersionIds: ["version-1", "version-2"],
    nextVersionId: null
  },
  gateSnapshot: {
    kind: "close" as const,
    allowed: false,
    blockers: [
      {
        code: "OPEN_TODOS",
        message: "存在未关闭 todo",
        recordIds: ["todo-1"]
      }
    ],
    unresolvedTodoIds: ["todo-1"],
    unresolvedUndoIds: ["undo-1"],
    unresolvedDeferredIds: [],
    blockedConstraintIds: [],
    residualAudit: [
      {
        kind: "debt" as const,
        summary: "capture follow-up",
        destination: "create_undo" as const,
        preferredResolutionVersionId: "version-3"
      }
    ]
  }
});

const createPendingOperationFixture = (): PendingOperation => ({
  id: "pending-1",
  projectId: "project-1",
  actionType: "close_version",
  targetId: "version-2",
  status: "pending",
  reason: "close current version",
  gateSnapshot: {
    kind: "close",
    evaluatedAt: "2026-06-27T01:00:00.000Z",
    allowed: false,
    blockers: [
      {
        code: "OPEN_TODOS",
        message: "存在未关闭 todo",
        recordIds: ["todo-1"]
      }
    ],
    unresolvedTodoIds: ["todo-1"],
    unresolvedUndoIds: ["undo-1"],
    unresolvedDeferredIds: [],
    blockedConstraintIds: [],
    residualAudit: [
      {
        kind: "debt",
        summary: "capture follow-up",
        destination: "create_undo",
        preferredResolutionVersionId: "version-3"
      }
    ]
  },
  digest: {
    algorithm: "sha256",
    value: "abcd1234",
    payload: createDigestPayloadFixture()
  },
  payload: {
    residualAudit: [
      {
        summary: "capture follow-up",
        preferredResolutionVersionId: "version-3",
        destination: "create_undo",
        kind: "debt"
      }
    ],
    description: "close current version",
    currentVersionId: "version-2",
    siblingVersionIds: ["version-1", "version-2"]
  },
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T01:00:00.000Z",
  updatedAt: "2026-06-27T01:05:00.000Z",
  committedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalArtifactId: "approval-1"
});

const createApprovalArtifactFixture = (): ApprovalArtifact => ({
  id: "approval-1",
  projectId: "project-1",
  pendingOperationId: "pending-1",
  actionType: "close_version",
  targetId: "version-2",
  digest: {
    algorithm: "sha256",
    value: "abcd1234",
    payload: createDigestPayloadFixture()
  },
  status: "approved",
  approver: TEST_APPROVER,
  decisionRef: "decision://routeledger/1",
  createdAt: "2026-06-27T01:10:00.000Z",
  expiresAt: "2026-06-28T01:10:00.000Z",
  consumedAt: null
});

const createTransitionEventFixture = (): TransitionEvent => ({
  id: "event-1",
  projectId: "project-1",
  operationId: "operation-1",
  operationSeq: 2,
  targetType: "pending_operation",
  targetId: "pending-1",
  eventType: "pending_operation.created",
  fromState: null,
  toState: "pending",
  note: "proposal created",
  actorId: TEST_ACTOR.id,
  actorType: TEST_ACTOR.type,
  actorDisplayName: TEST_ACTOR.displayName ?? null,
  createdAt: "2026-06-27T01:00:00.000Z",
  metadata: {
    approvalMetadata: {
      decisionRef: "decision://routeledger/1",
      expiresAt: "2026-06-28T01:10:00.000Z",
      pendingOperationId: "pending-1"
    },
    zebra: true,
    nested: {
      actionType: "close_version",
      targetId: "version-2",
      zebra: "z",
      alpha: "a",
      approvals: [
        {
          decisionRef: "decision://routeledger/1",
          pendingOperationId: "pending-1"
        }
      ]
    },
    alpha: 1
  }
});

export const createJsonCodecSnapshot = (): ProjectAggregateSnapshot => {
  const project = createProjectFixture({
    currentVersionId: "version-2"
  });
  const rootVersion = createVersionFixture({
    id: "version-1",
    isCurrent: false,
    nextVersionId: "version-2"
  });
  const currentVersion = createVersionFixture({
    id: "version-2",
    title: "Version 2",
    state: "running",
    previousVersionId: "version-1",
    isCurrent: true
  });
  const workItem = createWorkItemFixture({
    id: "work-item-1",
    originVersionId: "version-1",
    activeRecordType: "todo",
    activeRecordId: "todo-1",
    summary: "Track JSON contract"
  });
  const todo = createTodoFixture({
    id: "todo-1",
    versionId: "version-2",
    title: "Implement JSON codec",
    description: "Encode deterministic file set"
  });
  const undo = createUndoFixture({
    id: "undo-1",
    versionId: "version-1",
    preferredResolutionVersionId: "version-2",
    title: "Backfill validate",
    reason: "defer validate",
    status: "closed",
    closedAt: "2026-06-27T00:10:00.000Z",
    closeReason: "historical",
    closeNote: "Retained as audit history"
  });
  const asset = {
    id: "asset-1",
    projectId: "project-1",
    workItemIds: ["work-item-1"],
    pathBase: "project_root" as const,
    relativePath: "docs/json-contract.md",
    status: "active" as const,
    pathHistory: [
      {
        pathBase: "project_root" as const,
        relativePath: "docs/drafts/json-contract.md",
        recordedAt: "2026-06-26T23:00:00.000Z"
      },
      {
        pathBase: "project_root" as const,
        relativePath: "docs/json-contract.md",
        recordedAt: "2026-06-27T00:30:00.000Z"
      }
    ],
    createdBy: TEST_ACTOR,
    createdAt: "2026-06-27T00:30:00.000Z",
    updatedAt: "2026-06-27T00:45:00.000Z"
  };

  return {
    headRevision: null,
    project,
    versions: [currentVersion, rootVersion],
    workItems: [workItem],
    todos: [todo],
    undos: [undo],
    deferredItems: [],
    constraints: [],
    assets: [asset],
    events: [createTransitionEventFixture()],
    pendingOperations: [createPendingOperationFixture()],
    approvalArtifacts: [createApprovalArtifactFixture()]
  };
};

export const createDeferredConstraintJsonSnapshot = (): ProjectAggregateSnapshot => {
  const snapshot = createJsonCodecSnapshot();
  const deferredWorkItem = createWorkItemFixture({
    id: "work-item-deferred-1",
    title: "Review deferred persistence",
    originVersionId: "version-1",
    activeRecordType: "deferred",
    activeRecordId: "deferred-1",
    summary: "Review deferred persistence"
  });

  return {
    ...snapshot,
    workItems: [...snapshot.workItems, deferredWorkItem],
    deferredItems: [
      {
        id: "deferred-1",
        projectId: snapshot.project.id,
        workItemId: deferredWorkItem.id,
        originVersionId: "version-1",
        targetReviewVersionId: "version-2",
        title: "Review deferred persistence",
        description: "Validate canonical JSON and SQLite persistence",
        status: "pending",
        reason: "review at the next version",
        reviewTrigger: "version-2 starts",
        resolutionOutcome: null,
        resolutionReason: null,
        resolutionNote: null,
        decisionRef: null,
        activatedTodoId: null,
        createdBy: TEST_ACTOR,
        createdAt: "2026-06-27T00:40:00.000Z",
        updatedAt: "2026-06-27T00:40:00.000Z",
        reviewedAt: null
      }
    ],
    constraints: [
      {
        id: "constraint-1",
        projectId: snapshot.project.id,
        rule: "Keep canonical JSON deterministic",
        rationale: "Merge review depends on stable documents",
        scope: {
          type: "version",
          versionId: "version-2"
        },
        status: "active",
        createdBy: TEST_ACTOR,
        createdAt: "2026-06-27T00:41:00.000Z",
        updatedAt: "2026-06-27T00:41:00.000Z",
        retiredAt: null,
        retireReason: null,
        retireNote: null
      }
    ]
  };
};

export const shuffleSnapshotCollections = (
  snapshot: ProjectAggregateSnapshot
): ProjectAggregateSnapshot => ({
  ...snapshot,
  versions: [...snapshot.versions].reverse(),
  workItems: [...snapshot.workItems].reverse(),
  todos: [...snapshot.todos].reverse(),
  undos: [...snapshot.undos].reverse(),
  deferredItems: [...snapshot.deferredItems].reverse(),
  constraints: [...snapshot.constraints].reverse(),
  assets: [...snapshot.assets].reverse(),
  events: [...snapshot.events].reverse(),
  pendingOperations: [...snapshot.pendingOperations].reverse(),
  approvalArtifacts: [...snapshot.approvalArtifacts].reverse()
});
