import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import { createDeferred } from "../services/deferred-service.js";
import {
  closeTodo,
  closeUndo,
  convertTodoToUndo,
  convertUndoToTodo,
  createTodo,
  createUndo,
  reassignUndo,
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

  it("create undo 必须有 origin_version_id 和 preferred_resolution_version_id", () => {
    const deps = createTestDependencies();

    expect(() =>
      createUndo({
        projectId: "project-1",
        versionId: "version-1",
        originVersionId: "",
        preferredResolutionVersionId: "version-2",
        title: "undo-1",
        reason: "deferred",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    expect(() =>
      createUndo({
        projectId: "project-1",
        versionId: "version-1",
        originVersionId: "version-1",
        preferredResolutionVersionId: "",
        title: "undo-1",
        reason: "deferred",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("Undo 不进入 running，且 reassign 只改 preferred resolution version", () => {
    const deps = createTestDependencies();
    const undo = createUndoFixture();
    const reassigned = reassignUndo({
      undo,
      preferredResolutionVersionId: "version-9",
      reason: "defer again",
      note: "defer again",
      actor: TEST_ACTOR,
      deps
    });

    expect(reassigned.undo.status).toBe("wait");
    expect(reassigned.undo.preferredResolutionVersionId).toBe("version-9");
    expect(reassigned.undo.carriedForwardAt).toBe("2026-06-27T00:00:00.000Z");
    expect(reassigned.undo.carriedForwardToVersionId).toBe("version-9");
  });

  it("reassign undo 不允许把 preferred resolution version 改成空值", () => {
    const deps = createTestDependencies();

    expect(() =>
      reassignUndo({
        undo: createUndoFixture(),
        preferredResolutionVersionId: "   ",
        reason: "defer again",
        note: "defer again",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("todo -> undo 转换会复用 work_item_id 并切换 active 指针", () => {
    const deps = createTestDependencies();
    const todo = createTodoFixture();
    const workItem = createWorkItemFixture();

    const result = convertTodoToUndo({
      todo,
      workItem,
      preferredResolutionVersionId: "version-2",
      reason: "deferred",
      note: "deferred",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.todo.status).toBe("converted");
    expect(result.undo.workItemId).toBe(todo.workItemId);
    expect(result.workItem.activeRecordType).toBe("undo");
    expect(result.workItem.activeRecordId).toBe(result.undo.id);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.operationSeq)).toEqual([1, 2, 3]);
    expect(new Set(result.events.map((event) => event.operationId)).size).toBe(1);
  });

  it("undo -> todo 转换会复用 work_item_id 并切换 active 指针", () => {
    const deps = createTestDependencies();
    const undo = createUndoFixture();
    const workItem = createWorkItemFixture({
      activeRecordType: "undo",
      activeRecordId: undo.id
    });

    const result = convertUndoToTodo({
      undo,
      workItem,
      reason: "resume",
      note: "resume",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.undo.status).toBe("converted");
    expect(result.todo.workItemId).toBe(undo.workItemId);
    expect(result.todo.versionId).toBe(undo.preferredResolutionVersionId);
    expect(result.workItem.activeRecordType).toBe("todo");
    expect(result.workItem.activeRecordId).toBe(result.todo.id);
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

  it("close undo 会关闭 WorkItem active", () => {
    const deps = createTestDependencies();
    const undo = createUndoFixture();
    const workItem = createWorkItemFixture({
      activeRecordType: "undo",
      activeRecordId: undo.id
    });
    const result = closeUndo({
      undo,
      workItem,
      reason: "done",
      note: "done",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.undo.status).toBe("closed");
    expect(result.workItem.status).toBe("closed");
    expect(result.workItem.activeRecordId).toBeNull();
  });
});
