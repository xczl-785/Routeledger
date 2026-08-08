import { DomainError } from "../domain/errors.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import type { Todo } from "../domain/todo.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Undo } from "../domain/undo.js";
import type { ActiveRecordType, WorkItem, WorkItemType } from "../domain/work-item.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { createDomainContext, type DomainDependencies } from "./operation.js";
import type { Actor } from "../domain/actor.js";

const assertReason = (reason: string, note: string): void => {
  if (reason.trim().length === 0 || note.trim().length === 0) {
    throw new DomainError("MISSING_REQUIRED_FIELD", "关闭或转换必须提供 reason 和 note");
  }
};

const assertActivePointer = (
  workItem: WorkItem,
  expectedType: ActiveRecordType,
  expectedId: string
): void => {
  if (
    workItem.activeRecordType !== expectedType ||
    workItem.activeRecordId !== expectedId
  ) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "WorkItem active 指针与目标记录不一致",
      {
        workItemId: workItem.id,
        activeRecordType: workItem.activeRecordType,
        activeRecordId: workItem.activeRecordId,
        expectedType,
        expectedId
      }
    );
  }
};

const createWorkItem = (
  projectId: string,
  title: string,
  type: WorkItemType,
  originVersionId: string,
  activeRecordType: ActiveRecordType,
  activeRecordId: string,
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
  activeRecordType,
  activeRecordId,
  createdBy: actor,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  summary: title
});

export const validateWorkItemActive = (
  workItem: WorkItem,
  todos: Todo[],
  undos: Undo[],
  deferredItems: DeferredItem[] = []
): void => {
  if (workItem.status === "closed") {
    if (workItem.activeRecordType !== null || workItem.activeRecordId !== null) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "closed WorkItem 不应保留 active 指针",
        { workItemId: workItem.id }
      );
    }

    return;
  }

  if (workItem.activeRecordType === null || workItem.activeRecordId === null) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "active WorkItem 必须有 active 指针",
      { workItemId: workItem.id }
    );
  }

  const activeRecordType = workItem.activeRecordType;
  const activeRecordId = workItem.activeRecordId;

  switch (activeRecordType) {
    case "todo": {
      const todo = todos.find((item) => item.id === activeRecordId);

      if (todo === undefined || todo.workItemId !== workItem.id) {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active todo 不存在或不属于该 WorkItem",
          { workItemId: workItem.id, activeRecordId }
        );
      }

      if (todo.status !== "wait" && todo.status !== "running") {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active todo 不能指向 closed 或 converted 记录",
          { todoId: todo.id, status: todo.status }
        );
      }

      return;
    }
    case "undo": {
      const undo = undos.find((item) => item.id === activeRecordId);

      if (undo === undefined || undo.workItemId !== workItem.id) {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active undo 不存在或不属于该 WorkItem",
          { workItemId: workItem.id, activeRecordId }
        );
      }

      if (undo.status !== "wait") {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active undo 不能指向 closed 或 converted 记录",
          { undoId: undo.id, status: undo.status }
        );
      }

      return;
    }
    case "deferred": {
      const deferred = deferredItems.find(
        (item) => item.id === activeRecordId
      );

      if (
        deferred === undefined ||
        deferred.workItemId !== workItem.id
      ) {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active Deferred 不存在或不属于该 WorkItem",
          { workItemId: workItem.id, activeRecordId }
        );
      }

      if (deferred.status !== "pending") {
        throw new DomainError(
          "INVALID_WORK_ITEM_ACTIVE",
          "active Deferred 只能指向 pending 记录",
          { deferredId: deferred.id, status: deferred.status }
        );
      }

      return;
    }
    default: {
      const exhaustiveActiveRecordType: never = activeRecordType;
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        `不支持的 active record type: ${String(exhaustiveActiveRecordType)}`,
        { workItemId: workItem.id }
      );
    }
  }
};

export interface CreateTodoInput {
  projectId: string;
  versionId: string;
  title: string;
  description?: string;
  actor: Actor;
  deps: DomainDependencies;
  workItem?: WorkItem;
  workItemType?: WorkItemType;
}

export interface TodoCreation {
  todo: Todo;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const createTodo = ({
  projectId,
  versionId,
  title,
  description = "",
  actor,
  deps,
  workItem,
  workItemType = "other"
}: CreateTodoInput): TodoCreation => {
  const context = createDomainContext(deps, actor);
  const todoId = deps.idGenerator.nextId();
  const todo: Todo = {
    id: todoId,
    projectId,
    workItemId: workItem?.id ?? deps.idGenerator.nextId(),
    versionId,
    title,
    description,
    status: "wait",
    sourceType: "manual",
    sourceId: null,
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now,
    closedAt: null,
    closeReason: null,
    closeNote: null
  };

  if (workItem?.status === "active") {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "已有 active WorkItem 不能直接创建新的 active todo",
      { workItemId: workItem.id }
    );
  }

  const nextWorkItem: WorkItem =
    workItem === undefined
      ? createWorkItem(
          projectId,
          title,
          workItemType,
          versionId,
          "todo",
          todoId,
          actor,
          context.now,
          todo.workItemId
        )
      : {
          ...workItem,
          title,
          status: "active" as const,
          activeRecordType: "todo" as const,
          activeRecordId: todoId,
          updatedAt: context.now,
          closedAt: null
        };

  return {
    todo,
    workItem: nextWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.created",
          toState: todo.status
        },
        {
          targetType: "work_item",
          targetId: nextWorkItem.id,
          eventType: workItem === undefined ? "work_item.created" : "work_item.reopened",
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

export interface CloseTodoInput {
  todo: Todo;
  workItem: WorkItem;
  reason: string;
  note: string;
  actor: Actor;
  deps: DomainDependencies;
}

export interface TodoClosure {
  todo: Todo;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export interface StartTodoInput {
  todo: Todo;
  workItem: WorkItem;
  actor: Actor;
  deps: DomainDependencies;
}

export interface TodoProgression {
  todo: Todo;
  workItem: WorkItem;
  events: TransitionEvent[];
}

export const startTodo = ({
  todo,
  workItem,
  actor,
  deps
}: StartTodoInput): TodoProgression => {
  if (todo.status !== "wait") {
    throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 wait -> running", {
      todoId: todo.id,
      status: todo.status
    });
  }

  assertActivePointer(workItem, "todo", todo.id);
  const context = createDomainContext(deps, actor);
  const updatedTodo: Todo = {
    ...todo,
    status: "running",
    updatedAt: context.now
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    updatedAt: context.now
  };

  return {
    todo: updatedTodo,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.started",
          fromState: todo.status,
          toState: updatedTodo.status
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

export const closeTodo = ({
  todo,
  workItem,
  reason,
  note,
  actor,
  deps
}: CloseTodoInput): TodoClosure => {
  assertReason(reason, note);

  if (todo.status !== "wait" && todo.status !== "running") {
    throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 wait|running -> closed", {
      todoId: todo.id,
      status: todo.status
    });
  }

  assertActivePointer(workItem, "todo", todo.id);

  const context = createDomainContext(deps, actor);
  const updatedTodo: Todo = {
    ...todo,
    status: "closed",
    updatedAt: context.now,
    closedAt: context.now,
    closeReason: reason,
    closeNote: note
  };

  const updatedWorkItem: WorkItem = {
    ...workItem,
    status: "closed",
    activeRecordType: null,
    activeRecordId: null,
    updatedAt: context.now,
    closedAt: context.now
  };

  return {
    todo: updatedTodo,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.closed",
          fromState: todo.status,
          toState: updatedTodo.status,
          note
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
        projectId: todo.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface ReopenTodoInput {
  todo: Todo;
  workItem: WorkItem;
  actor: Actor;
  deps: DomainDependencies;
}

export const reopenTodo = ({
  todo,
  workItem,
  actor,
  deps
}: ReopenTodoInput): TodoClosure => {
  if (todo.status !== "closed") {
    throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 closed -> wait", {
      todoId: todo.id,
      status: todo.status
    });
  }

  if (workItem.status === "active") {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "reopen todo 前 WorkItem 不能已有 active 记录",
      { workItemId: workItem.id }
    );
  }

  const context = createDomainContext(deps, actor);
  const updatedTodo: Todo = {
    ...todo,
    status: "wait",
    updatedAt: context.now,
    closedAt: null,
    closeReason: null,
    closeNote: null
  };
  const updatedWorkItem: WorkItem = {
    ...workItem,
    status: "active",
    activeRecordType: "todo",
    activeRecordId: todo.id,
    updatedAt: context.now,
    closedAt: null
  };

  return {
    todo: updatedTodo,
    workItem: updatedWorkItem,
    events: createTransitionEvents(
      [
        {
          targetType: "todo",
          targetId: todo.id,
          eventType: "todo.reopened",
          fromState: todo.status,
          toState: updatedTodo.status
        },
        {
          targetType: "work_item",
          targetId: workItem.id,
          eventType: "work_item.reopened",
          fromState: workItem.status,
          toState: updatedWorkItem.status
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
