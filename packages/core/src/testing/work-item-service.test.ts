import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import { createDeferred } from "../services/deferred-service.js";
import {
  closeTodo,
  createTodo,
  reopenTodo,
  startTodo,
  validateWorkItemActive
} from "../services/work-item-service.js";
import {
  TEST_ACTOR,
  createTestDependencies,
  createTodoFixture,
  createUndoFixture,
  createWorkItemFixture
} from "./builders.js";

describe("todo / undo / work item service", () => {
  it("create todo 后自动创建 WorkItem 并指向 todo", () => {
    const deps = createTestDependencies();

    const result = createTodo({
      projectId: "project-1",
      versionId: "version-1",
      title: "todo-1",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.todo.workItemId).toBe(result.workItem.id);
    expect(result.workItem.activeRecordType).toBe("todo");
    expect(result.workItem.activeRecordId).toBe(result.todo.id);
  });

  it("todo 支持 wait -> closed -> wait reopen", () => {
    const deps = createTestDependencies();
    const creation = createTodo({
      projectId: "project-1",
      versionId: "version-1",
      title: "todo-1",
      actor: TEST_ACTOR,
      deps
    });
    const closed = closeTodo({
      todo: creation.todo,
      workItem: creation.workItem,
      reason: "done",
      note: "done",
      actor: TEST_ACTOR,
      deps
    });
    const reopened = reopenTodo({
      todo: closed.todo,
      workItem: closed.workItem,
      actor: TEST_ACTOR,
      deps
    });

    expect(closed.todo.status).toBe("closed");
    expect(closed.workItem.status).toBe("closed");
    expect(reopened.todo.status).toBe("wait");
    expect(reopened.workItem.activeRecordId).toBe(reopened.todo.id);
  });

  it("todo 支持 wait -> running 并产出 TransitionEvent", () => {
    const deps = createTestDependencies();
    const todo = createTodoFixture();
    const workItem = createWorkItemFixture();

    const result = startTodo({
      todo,
      workItem,
      actor: TEST_ACTOR,
      deps
    });

    expect(result.todo.status).toBe("running");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("todo.started");
    expect(result.events[0]?.fromState).toBe("wait");
    expect(result.events[0]?.toState).toBe("running");
  });

  it("todo 只有 wait 才能进入 running", () => {
    const deps = createTestDependencies();

    expect(() =>
      startTodo({
        todo: createTodoFixture({ status: "closed" }),
        workItem: createWorkItemFixture(),
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("active 指针不能指向 closed 或 converted 记录", () => {
    expect(() =>
      validateWorkItemActive(
        createWorkItemFixture(),
        [createTodoFixture({ status: "closed" })],
        []
      )
    ).toThrow(DomainError);

    expect(() =>
      validateWorkItemActive(
        createWorkItemFixture({
          activeRecordType: "undo",
          activeRecordId: "undo-1"
        }),
        [],
        [createUndoFixture({ status: "converted" })]
      )
    ).toThrow(DomainError);
  });

  it("active WorkItem 必须恰有一个 active 子记录并由指针指向它", () => {
    const workItem = createWorkItemFixture();
    const activeTodo = createTodoFixture();

    expect(() => validateWorkItemActive(workItem, [activeTodo], [])).not.toThrow();

    expect(() =>
      validateWorkItemActive(workItem, [
        activeTodo,
        createTodoFixture({ id: "todo-second", status: "running" })
      ], [])
    ).toThrow(DomainError);
  });

  it("closed WorkItem 不得保留 active 子记录", () => {
    expect(() =>
      validateWorkItemActive(
        createWorkItemFixture({
          status: "closed",
          activeRecordType: null,
          activeRecordId: null
        }),
        [createTodoFixture()],
        []
      )
    ).toThrow(DomainError);
  });

  it("lineage 允许保留关闭和转换历史，但转换后 WorkItem ID 稳定", () => {
    const deps = createTestDependencies();
    const creation = createDeferred({
      projectId: "project-1",
      originVersionId: "version-1",
      targetReviewVersionId: "version-2",
      title: "Review durable storage",
      reason: "Not required yet",
      actor: TEST_ACTOR,
      deps
    });
    const historicalTodo = createTodoFixture({
      id: "todo-converted",
      workItemId: creation.workItem.id,
      status: "converted"
    });
    const historicalUndo = createUndoFixture({
      id: "undo-closed",
      workItemId: creation.workItem.id,
      status: "closed"
    });

    expect(creation.deferred.workItemId).toBe(creation.workItem.id);
    expect(() =>
      validateWorkItemActive(
        creation.workItem,
        [historicalTodo],
        [historicalUndo],
        [creation.deferred]
      )
    ).not.toThrow();
  });

  it("createDeferred 返回的 WorkItem 可通过统一 active validator", () => {
    const deps = createTestDependencies();
    const creation = createDeferred({
      projectId: "project-1",
      originVersionId: "version-1",
      targetReviewVersionId: "version-2",
      title: "Review durable storage",
      reason: "Not required yet",
      actor: TEST_ACTOR,
      deps
    });

    expect(() =>
      validateWorkItemActive(
        creation.workItem,
        [],
        [],
        [creation.deferred]
      )
    ).not.toThrow();
  });

  it("active Deferred 指针必须指向所属 WorkItem 的 pending 记录", () => {
    const deps = createTestDependencies();
    const creation = createDeferred({
      projectId: "project-1",
      originVersionId: "version-1",
      targetReviewVersionId: "version-2",
      title: "Review durable storage",
      reason: "Not required yet",
      actor: TEST_ACTOR,
      deps
    });

    expect(() =>
      validateWorkItemActive(
        creation.workItem,
        [],
        [],
        [{ ...creation.deferred, status: "resolved" }]
      )
    ).toThrow(DomainError);

    expect(() =>
      validateWorkItemActive(creation.workItem, [], [], [])
    ).toThrow(DomainError);
  });
});
