import type { Actor } from "../domain/actor.js";
import type {
  DeferredItem,
  DeferredResolutionOutcome
} from "../domain/deferred-item.js";
import { DomainError } from "../domain/errors.js";
import type { Todo } from "../domain/todo.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type {
  WorkItem,
  WorkItemType
} from "../domain/work-item.js";
import { createDomainContext, type DomainDependencies } from "./operation.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { assertDeferredItemInvariant } from "./deferred-constraint-invariants.js";

const assertRequired = (value: string, field: string, action: string): void => {
  if (value.trim().length === 0) {
    throw new DomainError(
      "MISSING_REQUIRED_FIELD",
      `${action} 必须提供 ${field}`
    );
  }
};

const assertReviewInput = (
  targetReviewVersionId: string,
  reason: string,
  action: string
): void => {
  assertRequired(targetReviewVersionId, "target_review_version_id", action);
  assertRequired(reason, "reason", action);
};

const assertPending = (deferred: DeferredItem, action: string): void => {
  if (deferred.status !== "pending") {
    throw new DomainError(
      "INVALID_DEFERRED_TRANSITION",
      `${action} 仅允许处理 pending Deferred`,
      {
        deferredId: deferred.id,
        status: deferred.status
      }
    );
  }
};

const assertActivePointer = (
  workItem: WorkItem,
  deferred: DeferredItem
): void => {
  if (
    workItem.status !== "active" ||
    workItem.id !== deferred.workItemId ||
    workItem.activeRecordType !== "deferred" ||
    workItem.activeRecordId !== deferred.id
  ) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "WorkItem active 指针与 Deferred 不一致",
      {
        workItemId: workItem.id,
        deferredId: deferred.id,
        activeRecordType: workItem.activeRecordType,
        activeRecordId: workItem.activeRecordId
      }
    );
  }
};

const assertTodoActivePointer = (
  workItem: WorkItem,
  todo: Todo
): void => {
  if (
    workItem.status !== "active" ||
    workItem.projectId !== todo.projectId ||
    workItem.id !== todo.workItemId ||
    workItem.activeRecordType !== "todo" ||
    workItem.activeRecordId !== todo.id
  ) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "WorkItem active 指针或归属与 Todo 不一致",
      {
        todoId: todo.id,
        todoProjectId: todo.projectId,
        todoWorkItemId: todo.workItemId,
        workItemId: workItem.id,
        workItemProjectId: workItem.projectId,
        activeRecordType: workItem.activeRecordType,
        activeRecordId: workItem.activeRecordId
      }
    );
  }
};

const createWorkItem = (
  projectId: string,
  title: string,
  type: WorkItemType,
  originVersionId: string,
  deferredId: string,
  actor: Actor,
  now: string,
  id: string
): WorkItem => ({
  id,
  projectId,
  title,
  type,
  status: "active",
  originVersionId,
  activeRecordType: "deferred",
  activeRecordId: deferredId,
  createdBy: actor,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  summary: title
});

export interface CreateDeferredInput {
  projectId: string;
  originVersionId: string;
  targetReviewVersionId: string;
  title: string;
  reason: string;
  description?: string;
  reviewTrigger?: string | null;
  actor: Actor;
  deps: DomainDependencies;
  workItem?: WorkItem;
  workItemType?: WorkItemType;
}

export interface DeferredCreation {
  deferred: DeferredItem;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const createDeferred = ({
  projectId,
  originVersionId,
  targetReviewVersionId,
  title,
  reason,
  description = "",
  reviewTrigger = null,
  actor,
  deps,
  workItem,
  workItemType = "other"
}: CreateDeferredInput): DeferredCreation => {
  assertRequired(originVersionId, "origin_version_id", "create deferred");
  assertRequired(title, "title", "create deferred");
  assertReviewInput(targetReviewVersionId, reason, "create deferred");

  if (workItem?.status === "active") {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "已有 active WorkItem 不能直接创建新的 active Deferred",
      { workItemId: workItem.id }
    );
  }

  const context = createDomainContext(deps, actor);
  const deferredId = deps.idGenerator.nextId();
  const workItemId = workItem?.id ?? deps.idGenerator.nextId();
  const deferred: DeferredItem = {
    id: deferredId,
    projectId,
    workItemId,
    originVersionId,
    targetReviewVersionId,
    title,
    description,
    status: "pending",
    reason,
    reviewTrigger,
    resolutionOutcome: null,
    resolutionReason: null,
    resolutionNote: null,
    decisionRef: null,
    activatedTodoId: null,
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now,
    reviewedAt: null
  };
  const nextWorkItem =
    workItem === undefined
      ? createWorkItem(
          projectId,
          title,
          workItemType,
          originVersionId,
          deferredId,
          actor,
          context.now,
          workItemId
        )
      : {
          ...workItem,
          projectId,
          title,
          status: "active" as const,
          activeRecordType: "deferred" as const,
          activeRecordId: deferredId,
          updatedAt: context.now,
          closedAt: null
        };

  assertDeferredItemInvariant(deferred);

  return {
    deferred,
    workItem: nextWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "deferred_item",
          targetId: deferred.id,
          eventType: "deferred.created",
          toState: deferred.status,
          metadata: {
            deferredItemId: deferred.id,
            originVersionId,
            targetReviewVersionId,
            reason,
            reviewTrigger
          }
        },
        {
          targetType: "work_item",
          targetId: nextWorkItem.id,
          eventType:
            workItem === undefined
              ? "work_item.created"
              : "work_item.reopened",
          toState: nextWorkItem.status
        }
      ],
      {
        projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface DeferTodoInput {
  todo: Todo;
  workItem: WorkItem;
  targetReviewVersionId: string;
  reason: string;
  note: string;
  reviewTrigger?: string | null;
  actor: Actor;
  deps: DomainDependencies;
}

export interface TodoToDeferredConversion {
  todo: Todo;
  deferred: DeferredItem;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const deferTodo = ({
  todo,
  workItem,
  targetReviewVersionId,
  reason,
  note,
  reviewTrigger = null,
  actor,
  deps
}: DeferTodoInput): TodoToDeferredConversion => {
  assertRequired(todo.title, "title", "defer todo");
  assertReviewInput(targetReviewVersionId, reason, "defer todo");
  assertRequired(note, "note", "defer todo");

  if (todo.status !== "wait" && todo.status !== "running") {
    throw new DomainError(
      "INVALID_TODO_TRANSITION",
      "仅 open Todo 可以转为 Deferred",
      {
        todoId: todo.id,
        status: todo.status
      }
    );
  }

  assertTodoActivePointer(workItem, todo);

  const context = createDomainContext(deps, actor);
  const deferredId = deps.idGenerator.nextId();
  const updatedTodo: Todo = {
    ...todo,
    status: "converted",
    updatedAt: context.now,
    closeReason: reason,
    closeNote: note
  };
  const deferred: DeferredItem = {
    id: deferredId,
    projectId: todo.projectId,
    workItemId: todo.workItemId,
    originVersionId: todo.versionId,
    targetReviewVersionId,
    title: todo.title,
    description: todo.description,
    status: "pending",
    reason,
    reviewTrigger,
    resolutionOutcome: null,
    resolutionReason: null,
    resolutionNote: null,
    decisionRef: null,
    activatedTodoId: null,
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now,
    reviewedAt: null
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    title: todo.title,
    activeRecordType: "deferred",
    activeRecordId: deferred.id,
    updatedAt: context.now
  };
  const auditMetadata = {
    sourceTodoId: todo.id,
    deferredItemId: deferred.id,
    targetReviewVersionId,
    reason,
    reviewTrigger
  };

  assertDeferredItemInvariant(deferred);

  return {
    todo: updatedTodo,
    deferred,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.converted_to_deferred",
          fromState: todo.status,
          toState: updatedTodo.status,
          note,
          metadata: auditMetadata
        },
        {
          targetType: "deferred_item",
          targetId: deferred.id,
          eventType: "deferred.created",
          toState: deferred.status,
          note: reason,
          metadata: auditMetadata
        },
        {
          targetType: "work_item",
          targetId: workItem.id,
          eventType: "work_item.active_record_changed",
          fromState: workItem.activeRecordType,
          toState: updatedWorkItem.activeRecordType,
          note,
          metadata: {
            ...auditMetadata,
            previousActiveRecordType: workItem.activeRecordType,
            previousActiveRecordId: workItem.activeRecordId,
            nextActiveRecordType: updatedWorkItem.activeRecordType,
            nextActiveRecordId: updatedWorkItem.activeRecordId
          }
        }
      ],
      {
        projectId: todo.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface DeferAgainInput {
  deferred: DeferredItem;
  workItem: WorkItem;
  targetReviewVersionId: string;
  reason: string;
  note?: string;
  reviewTrigger?: string | null;
  actor: Actor;
  deps: DomainDependencies;
}

export interface DeferredUpdate {
  deferred: DeferredItem;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const deferAgain = ({
  deferred,
  workItem,
  targetReviewVersionId,
  reason,
  note,
  reviewTrigger = deferred.reviewTrigger,
  actor,
  deps
}: DeferAgainInput): DeferredUpdate => {
  assertPending(deferred, "defer again");
  assertActivePointer(workItem, deferred);
  assertReviewInput(targetReviewVersionId, reason, "defer again");

  const context = createDomainContext(deps, actor);
  const updatedDeferred: DeferredItem = {
    ...deferred,
    targetReviewVersionId,
    reason,
    reviewTrigger,
    updatedAt: context.now,
    reviewedAt: context.now
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    updatedAt: context.now
  };

  assertDeferredItemInvariant(updatedDeferred);

  return {
    deferred: updatedDeferred,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "deferred_item",
          targetId: deferred.id,
          eventType: "deferred.deferred_again",
          fromState: deferred.status,
          toState: updatedDeferred.status,
          note: note ?? reason,
          metadata: {
            deferredItemId: deferred.id,
            previousTargetReviewVersionId: deferred.targetReviewVersionId,
            nextTargetReviewVersionId: targetReviewVersionId,
            previousReason: deferred.reason,
            nextReason: reason,
            previousReviewTrigger: deferred.reviewTrigger,
            nextReviewTrigger: reviewTrigger
          }
        }
      ],
      {
        projectId: deferred.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface ActivateDeferredInput {
  deferred: DeferredItem;
  workItem: WorkItem;
  versionId: string;
  reason: string;
  note?: string;
  actor: Actor;
  deps: DomainDependencies;
}

export interface DeferredActivation {
  deferred: DeferredItem;
  todo: Todo;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const activateDeferred = ({
  deferred,
  workItem,
  versionId,
  reason,
  note = reason,
  actor,
  deps
}: ActivateDeferredInput): DeferredActivation => {
  assertPending(deferred, "activate deferred");
  assertActivePointer(workItem, deferred);
  assertRequired(versionId, "version_id", "activate deferred");
  assertRequired(reason, "reason", "activate deferred");
  assertRequired(note, "note", "activate deferred");

  const context = createDomainContext(deps, actor);
  const todoId = deps.idGenerator.nextId();
  const todo: Todo = {
    id: todoId,
    projectId: deferred.projectId,
    workItemId: deferred.workItemId,
    versionId,
    title: deferred.title,
    description: deferred.description,
    status: "wait",
    sourceType: "conversion",
    sourceId: deferred.id,
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now,
    closedAt: null,
    closeReason: null,
    closeNote: null
  };
  const updatedDeferred: DeferredItem = {
    ...deferred,
    status: "activated",
    resolutionOutcome: "activated",
    resolutionReason: reason,
    resolutionNote: note,
    activatedTodoId: todoId,
    updatedAt: context.now,
    reviewedAt: context.now
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    title: todo.title,
    activeRecordType: "todo",
    activeRecordId: todo.id,
    updatedAt: context.now
  };

  assertDeferredItemInvariant(updatedDeferred, [todo]);

  return {
    deferred: updatedDeferred,
    todo,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "deferred_item",
          targetId: deferred.id,
          eventType: "deferred.activated",
          fromState: deferred.status,
          toState: updatedDeferred.status,
          note,
          metadata: {
            deferredItemId: deferred.id,
            reason,
            todoId: todo.id,
            versionId
          }
        },
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.created",
          toState: todo.status,
          metadata: {
            sourceDeferredId: deferred.id
          }
        },
        {
          targetType: "work_item",
          targetId: workItem.id,
          eventType: "work_item.active_record_changed",
          fromState: workItem.activeRecordType,
          toState: updatedWorkItem.activeRecordType,
          metadata: {
            previousActiveRecordId: deferred.id,
            nextActiveRecordId: todo.id
          }
        }
      ],
      {
        projectId: deferred.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export type DeferredResolveOutcome = Exclude<
  DeferredResolutionOutcome,
  "activated"
>;

export interface ResolveDeferredInput {
  deferred: DeferredItem;
  workItem: WorkItem;
  outcome: DeferredResolveOutcome;
  reason: string;
  note?: string;
  decisionRef?: string | null;
  actor: Actor;
  deps: DomainDependencies;
}

export interface DeferredResolution {
  deferred: DeferredItem;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const resolveDeferred = ({
  deferred,
  workItem,
  outcome,
  reason,
  note = reason,
  decisionRef = null,
  actor,
  deps
}: ResolveDeferredInput): DeferredResolution => {
  if (
    outcome !== "superseded" &&
    outcome !== "rejected" &&
    outcome !== "out_of_scope"
  ) {
    throw new DomainError(
      "INVALID_DEFERRED_TRANSITION",
      "resolve deferred outcome 仅允许 superseded、rejected 或 out_of_scope",
      {
        deferredId: deferred.id,
        outcome
      }
    );
  }

  assertPending(deferred, "resolve deferred");
  assertActivePointer(workItem, deferred);
  assertRequired(reason, "reason", "resolve deferred");
  assertRequired(note, "note", "resolve deferred");

  if (
    (outcome === "rejected" || outcome === "out_of_scope") &&
    (decisionRef === null || decisionRef.trim().length === 0)
  ) {
    throw new DomainError(
      "MISSING_REQUIRED_FIELD",
      `${outcome} resolution 必须提供 decision_ref`,
      {
        deferredId: deferred.id,
        outcome
      }
    );
  }

  const context = createDomainContext(deps, actor);
  const updatedDeferred: DeferredItem = {
    ...deferred,
    status: "resolved",
    resolutionOutcome: outcome,
    resolutionReason: reason,
    resolutionNote: note,
    decisionRef,
    updatedAt: context.now,
    reviewedAt: context.now
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    status: "closed",
    activeRecordType: null,
    activeRecordId: null,
    updatedAt: context.now,
    closedAt: context.now
  };

  assertDeferredItemInvariant(updatedDeferred);

  return {
    deferred: updatedDeferred,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "deferred_item",
          targetId: deferred.id,
          eventType: "deferred.resolved",
          fromState: deferred.status,
          toState: updatedDeferred.status,
          note,
          metadata: {
            deferredItemId: deferred.id,
            outcome,
            reason,
            decisionRef
          }
        },
        {
          targetType: "work_item",
          targetId: workItem.id,
          eventType: "work_item.closed",
          fromState: workItem.status,
          toState: updatedWorkItem.status,
          note: reason
        }
      ],
      {
        projectId: deferred.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};
