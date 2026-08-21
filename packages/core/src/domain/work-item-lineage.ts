import { DomainError } from "./errors.js";
import type { DeferredItem } from "./deferred-item.js";
import type { Todo } from "./todo.js";
import type { Undo } from "./undo.js";
import type { ActiveRecordType, WorkItem } from "./work-item.js";

interface CurrentActiveChildRecord {
  type: Exclude<ActiveRecordType, "undo">;
  id: string;
}

/**
 * Validates the in-aggregate lineage relationship between one WorkItem and its
 * Todo, legacy Undo, and Deferred records. WorkItem is not a separate
 * aggregate: it is the stable identity shared by those records across
 * conversion, closure, and reopen transitions.
 */
export const validateWorkItemLineage = (
  workItem: WorkItem,
  todos: readonly Todo[],
  undos: readonly Undo[],
  deferredItems: readonly DeferredItem[] = []
): void => {
  // Todo and Deferred are the current writable work records. Retained legacy
  // Undo records are audit/gate history and therefore must not turn a current
  // Todo/Deferred lineage into an invalid multi-active lineage merely because
  // they remain in `wait`.
  const currentActiveChildren: CurrentActiveChildRecord[] = [];

  for (const todo of todos) {
    if (todo.workItemId !== workItem.id) {
      continue;
    }

    if (todo.projectId !== workItem.projectId) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "Todo.workItemId 必须指向同一 Project aggregate 内的 WorkItem",
        { workItemId: workItem.id, todoId: todo.id }
      );
    }

    if (todo.status === "wait" || todo.status === "running") {
      currentActiveChildren.push({ type: "todo", id: todo.id });
    }
  }

  for (const undo of undos) {
    if (undo.workItemId !== workItem.id) {
      continue;
    }

    if (undo.projectId !== workItem.projectId) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "Undo.workItemId 必须指向同一 Project aggregate 内的 WorkItem",
        { workItemId: workItem.id, undoId: undo.id }
      );
    }

  }

  for (const deferredItem of deferredItems) {
    if (deferredItem.workItemId !== workItem.id) {
      continue;
    }

    if (deferredItem.projectId !== workItem.projectId) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "DeferredItem.workItemId 必须指向同一 Project aggregate 内的 WorkItem",
        { workItemId: workItem.id, deferredItemId: deferredItem.id }
      );
    }

    if (deferredItem.status === "pending") {
      currentActiveChildren.push({ type: "deferred", id: deferredItem.id });
    }
  }

  if (workItem.status === "closed") {
    if (workItem.activeRecordType !== null || workItem.activeRecordId !== null) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "closed WorkItem 不应保留 active 指针",
        { workItemId: workItem.id }
      );
    }

    if (currentActiveChildren.length !== 0) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "closed WorkItem 不应保留 active 子记录",
        { workItemId: workItem.id, activeChildren: currentActiveChildren }
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

  if (workItem.activeRecordType === "undo") {
    const legacyActiveUndo = undos.find(
      (undo) =>
        undo.id === workItem.activeRecordId &&
        undo.workItemId === workItem.id &&
        undo.projectId === workItem.projectId &&
        undo.status === "wait"
    );

    if (currentActiveChildren.length !== 0 || legacyActiveUndo === undefined) {
      throw new DomainError(
        "INVALID_WORK_ITEM_ACTIVE",
        "legacy Undo 指针必须指向同 Project 的 wait Undo，且不得同时存在 current Todo/Deferred",
        {
          workItemId: workItem.id,
          activeRecordId: workItem.activeRecordId,
          currentActiveChildren
        }
      );
    }

    return;
  }

  if (currentActiveChildren.length !== 1) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "active WorkItem 必须恰有一个 active 子记录",
      { workItemId: workItem.id, activeChildren: currentActiveChildren }
    );
  }

  const [activeChild] = currentActiveChildren;

  if (
    activeChild!.type !== workItem.activeRecordType ||
    activeChild!.id !== workItem.activeRecordId
  ) {
    throw new DomainError(
      "INVALID_WORK_ITEM_ACTIVE",
      "WorkItem active 指针必须指向唯一的 active 子记录",
      {
        workItemId: workItem.id,
        activeRecordType: workItem.activeRecordType,
        activeRecordId: workItem.activeRecordId,
        activeChild
      }
    );
  }
};

/** @deprecated Compatibility export. Prefer validateWorkItemLineage. */
export const validateWorkItemActive = validateWorkItemLineage;
