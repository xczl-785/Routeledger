import { DomainError } from "../domain/errors.js";
export { validateWorkItemActive, validateWorkItemLineage } from "../domain/work-item-lineage.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { createDomainContext } from "./operation.js";
const assertReason = (reason, note) => {
    if (reason.trim().length === 0 || note.trim().length === 0) {
        throw new DomainError("MISSING_REQUIRED_FIELD", "关闭或转换必须提供 reason 和 note");
    }
};
const assertActivePointer = (workItem, expectedType, expectedId) => {
    if (workItem.activeRecordType !== expectedType ||
        workItem.activeRecordId !== expectedId) {
        throw new DomainError("INVALID_WORK_ITEM_ACTIVE", "WorkItem active 指针与目标记录不一致", {
            workItemId: workItem.id,
            activeRecordType: workItem.activeRecordType,
            activeRecordId: workItem.activeRecordId,
            expectedType,
            expectedId
        });
    }
};
const createWorkItem = (projectId, title, type, originVersionId, activeRecordType, activeRecordId, actor, now, id) => ({
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
export const createTodo = ({ projectId, versionId, title, description = "", actor, deps, workItem, workItemType = "other" }) => {
    const context = createDomainContext(deps, actor);
    const todoId = deps.idGenerator.nextId();
    const todo = {
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
        throw new DomainError("INVALID_WORK_ITEM_ACTIVE", "已有 active WorkItem 不能直接创建新的 active todo", { workItemId: workItem.id });
    }
    const nextWorkItem = workItem === undefined
        ? createWorkItem(projectId, title, workItemType, versionId, "todo", todoId, actor, context.now, todo.workItemId)
        : {
            ...workItem,
            title,
            status: "active",
            activeRecordType: "todo",
            activeRecordId: todoId,
            updatedAt: context.now,
            closedAt: null
        };
    return {
        todo,
        workItem: nextWorkItem,
        events: createTransitionEvents([
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
        ], {
            projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const startTodo = ({ todo, workItem, actor, deps }) => {
    if (todo.status !== "wait") {
        throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 wait -> running", {
            todoId: todo.id,
            status: todo.status
        });
    }
    assertActivePointer(workItem, "todo", todo.id);
    const context = createDomainContext(deps, actor);
    const updatedTodo = {
        ...todo,
        status: "running",
        updatedAt: context.now
    };
    const updatedWorkItem = {
        ...workItem,
        updatedAt: context.now
    };
    return {
        todo: updatedTodo,
        workItem: updatedWorkItem,
        events: createTransitionEvents([
            {
                targetType: "todo",
                targetId: todo.id,
                eventType: "todo.started",
                fromState: todo.status,
                toState: updatedTodo.status
            }
        ], {
            projectId: todo.projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const closeTodo = ({ todo, workItem, reason, note, actor, deps }) => {
    assertReason(reason, note);
    if (todo.status !== "wait" && todo.status !== "running") {
        throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 wait|running -> closed", {
            todoId: todo.id,
            status: todo.status
        });
    }
    assertActivePointer(workItem, "todo", todo.id);
    const context = createDomainContext(deps, actor);
    const updatedTodo = {
        ...todo,
        status: "closed",
        updatedAt: context.now,
        closedAt: context.now,
        closeReason: reason,
        closeNote: note
    };
    const updatedWorkItem = {
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
        events: createTransitionEvents([
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
        ], {
            projectId: todo.projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const reopenTodo = ({ todo, workItem, actor, deps }) => {
    if (todo.status !== "closed") {
        throw new DomainError("INVALID_TODO_TRANSITION", "todo 仅允许从 closed -> wait", {
            todoId: todo.id,
            status: todo.status
        });
    }
    if (workItem.status === "active") {
        throw new DomainError("INVALID_WORK_ITEM_ACTIVE", "reopen todo 前 WorkItem 不能已有 active 记录", { workItemId: workItem.id });
    }
    const context = createDomainContext(deps, actor);
    const updatedTodo = {
        ...todo,
        status: "wait",
        updatedAt: context.now,
        closedAt: null,
        closeReason: null,
        closeNote: null
    };
    const updatedWorkItem = {
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
        events: createTransitionEvents([
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
        ], {
            projectId: todo.projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
