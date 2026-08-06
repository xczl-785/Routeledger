import { describe, expect, it } from "vitest";

import {
  DomainError,
  createTodo,
  retireConstraint
} from "../index.js";
import {
  deferWork,
  recordConstraint,
  reviewDeferred,
  type DeferTodoWorkInput,
  type ReviewDeferredInput
} from "../services/workflow-service.js";
import type { DomainDependencies } from "../services/operation.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";

const createCountingDependencies = (): {
  deps: DomainDependencies;
  idCalls: () => number;
  clockCalls: () => number;
} => {
  let idCallCount = 0;
  let clockCallCount = 0;

  return {
    deps: {
      clock: {
        now: () => {
          clockCallCount += 1;
          return "2026-06-27T00:00:00.000Z";
        }
      },
      idGenerator: {
        nextId: () => {
          idCallCount += 1;
          return `id-${idCallCount}`;
        }
      }
    },
    idCalls: () => idCallCount,
    clockCalls: () => clockCallCount
  };
};

const createTodoRecords = () => {
  const deps = createTestDependencies();
  const creation = createTodo({
    projectId: "project-1",
    versionId: "version-1",
    title: "Ship workflow facade",
    description: "One workflow call",
    actor: TEST_ACTOR,
    deps
  });

  return {
    deps,
    todo: creation.todo,
    workItem: creation.workItem
  };
};

const createPendingDeferredRecords = () => {
  const deps = createTestDependencies();
  const creation = deferWork({
    mode: "new",
    projectId: "project-1",
    currentVersionId: "version-1",
    title: "Review workflow facade",
    targetReviewVersionId: "version-2",
    reason: "Not required yet",
    reviewTrigger: "evidence-ready",
    actor: TEST_ACTOR,
    deps
  });

  return {
    deps,
    deferred: creation.deferred,
    workItem: creation.workItem
  };
};

describe("workflow-first core facade", () => {
  it("deferWork new 模式一次调用完成 Deferred 与 WorkItem 创建", () => {
    const deps = createTestDependencies();

    const result = deferWork({
      mode: "new",
      projectId: "project-1",
      currentVersionId: "version-1",
      title: "Review durable storage",
      description: "Review after runtime evidence",
      targetReviewVersionId: "version-2",
      reason: "Not required in the current version",
      reviewTrigger: "runtime-evidence-ready",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.mode).toBe("new");
    expect(result.deferred.status).toBe("pending");
    expect(result.deferred.originVersionId).toBe("version-1");
    expect(result.workItem.activeRecordType).toBe("deferred");
    expect(result.workItem.activeRecordId).toBe(result.deferred.id);
    expect(result.events.map((event) => event.eventType)).toEqual([
      "deferred.created",
      "work_item.created"
    ]);
  });

  it.each(["wait", "running"] as const)(
    "deferWork todo 模式原子转换 open Todo (%s)，复用 lineage 并完整审计",
    (status) => {
      const { deps, todo, workItem } = createTodoRecords();

      const result = deferWork({
        mode: "todo",
        resolvedRecords: {
          todo: {
            ...todo,
            status
          },
          workItem
        },
        targetReviewVersionId: "version-3",
        reason: "Wait for production evidence",
        note: "Reviewed in delivery sync",
        reviewTrigger: "production-traffic",
        actor: TEST_ACTOR,
        deps
      });

      expect(result.mode).toBe("todo");
      if (result.mode !== "todo") {
        throw new Error("expected todo defer result");
      }
      expect(result.todo.status).toBe("converted");
      expect(result.todo.closeReason).toBe(
        "Wait for production evidence"
      );
      expect(result.todo.closeNote).toBe("Reviewed in delivery sync");
      expect(result.deferred.workItemId).toBe(todo.workItemId);
      expect(result.deferred.originVersionId).toBe(todo.versionId);
      expect(result.workItem.id).toBe(workItem.id);
      expect(result.workItem.activeRecordType).toBe("deferred");
      expect(result.workItem.activeRecordId).toBe(result.deferred.id);
      expect(result.events.map((event) => event.operationSeq)).toEqual([
        1, 2, 3
      ]);
      expect(
        new Set(result.events.map((event) => event.operationId)).size
      ).toBe(1);
      expect(
        new Set(result.events.map((event) => event.createdAt)).size
      ).toBe(1);
      expect(result.events.map((event) => event.eventType)).toEqual([
        "todo.converted_to_deferred",
        "deferred.created",
        "work_item.active_record_changed"
      ]);
      for (const event of result.events) {
        expect(event.metadata).toMatchObject({
          sourceTodoId: todo.id,
          deferredItemId: result.deferred.id,
          targetReviewVersionId: "version-3",
          reason: "Wait for production evidence",
          reviewTrigger: "production-traffic"
        });
      }
      expect(result.events[2]?.metadata).toMatchObject({
        sourceTodoId: todo.id,
        deferredItemId: result.deferred.id,
        targetReviewVersionId: "version-3",
        reason: "Wait for production evidence",
        reviewTrigger: "production-traffic",
        previousActiveRecordType: "todo",
        previousActiveRecordId: todo.id,
        nextActiveRecordType: "deferred",
        nextActiveRecordId: result.deferred.id
      });
    }
  );

  it("deferWork todo 在非法状态或跨归属时先拒绝，不消费 operation/time/ID", () => {
    const records = createTodoRecords();
    const closedDeps = createCountingDependencies();
    const crossProjectDeps = createCountingDependencies();

    expect(() =>
      deferWork({
        mode: "todo",
        resolvedRecords: {
          todo: {
            ...records.todo,
            status: "closed"
          },
          workItem: records.workItem
        },
        targetReviewVersionId: "version-2",
        reason: "later",
        note: "reviewed",
        actor: TEST_ACTOR,
        deps: closedDeps.deps
      })
    ).toThrow(DomainError);
    expect(closedDeps.idCalls()).toBe(0);
    expect(closedDeps.clockCalls()).toBe(0);

    expect(() =>
      deferWork({
        mode: "todo",
        resolvedRecords: {
          todo: records.todo,
          workItem: {
            ...records.workItem,
            projectId: "project-2"
          }
        },
        targetReviewVersionId: "version-2",
        reason: "later",
        note: "reviewed",
        actor: TEST_ACTOR,
        deps: crossProjectDeps.deps
      })
    ).toThrow(DomainError);
    expect(crossProjectDeps.idCalls()).toBe(0);
    expect(crossProjectDeps.clockCalls()).toBe(0);
  });

  it("deferWork todo 拒绝 converted Todo 且零 clock/ID", () => {
    const records = createTodoRecords();
    const counting = createCountingDependencies();

    expect(() =>
      deferWork({
        mode: "todo",
        resolvedRecords: {
          todo: {
            ...records.todo,
            status: "converted"
          },
          workItem: records.workItem
        },
        targetReviewVersionId: "version-2",
        reason: "later",
        note: "reviewed",
        actor: TEST_ACTOR,
        deps: counting.deps
      })
    ).toThrow(DomainError);
    expect(counting.idCalls()).toBe(0);
    expect(counting.clockCalls()).toBe(0);
  });

  it("deferWork todo 拒绝 todo.workItemId 与 WorkItem.id 不一致且零 clock/ID", () => {
    const records = createTodoRecords();
    const counting = createCountingDependencies();

    expect(() =>
      deferWork({
        mode: "todo",
        resolvedRecords: {
          todo: {
            ...records.todo,
            workItemId: "work-item-other"
          },
          workItem: records.workItem
        },
        targetReviewVersionId: "version-2",
        reason: "later",
        note: "reviewed",
        actor: TEST_ACTOR,
        deps: counting.deps
      })
    ).toThrow(DomainError);
    expect(counting.idCalls()).toBe(0);
    expect(counting.clockCalls()).toBe(0);
  });

  it.each([
    {
      label: "activeRecordType",
      workItemOverrides: {
        activeRecordType: "undo" as const
      }
    },
    {
      label: "activeRecordId",
      workItemOverrides: {
        activeRecordId: "todo-other"
      }
    }
  ])(
    "deferWork todo 拒绝错误 $label 且零 clock/ID",
    ({ workItemOverrides }) => {
      const records = createTodoRecords();
      const counting = createCountingDependencies();

      expect(() =>
        deferWork({
          mode: "todo",
          resolvedRecords: {
            todo: records.todo,
            workItem: {
              ...records.workItem,
              ...workItemOverrides
            }
          },
          targetReviewVersionId: "version-2",
          reason: "later",
          note: "reviewed",
          actor: TEST_ACTOR,
          deps: counting.deps
        })
      ).toThrow(DomainError);
      expect(counting.idCalls()).toBe(0);
      expect(counting.clockCalls()).toBe(0);
    }
  );

  it("deferWork new 缺 currentVersionId 时零 clock/ID", () => {
    const counting = createCountingDependencies();

    expect(() =>
      deferWork({
        mode: "new",
        projectId: "project-1",
        currentVersionId: " ",
        title: "Review durable storage",
        targetReviewVersionId: "version-2",
        reason: "Not required yet",
        actor: TEST_ACTOR,
        deps: counting.deps
      })
    ).toThrow(DomainError);
    expect(counting.idCalls()).toBe(0);
    expect(counting.clockCalls()).toBe(0);
  });

  it.each([
    {
      label: "title",
      mutate: (input: DeferTodoWorkInput): DeferTodoWorkInput => ({
        ...input,
        resolvedRecords: {
          ...input.resolvedRecords,
          todo: {
            ...input.resolvedRecords.todo,
            title: " "
          }
        }
      })
    },
    {
      label: "target",
      mutate: (input: DeferTodoWorkInput): DeferTodoWorkInput => ({
        ...input,
        targetReviewVersionId: " "
      })
    },
    {
      label: "reason",
      mutate: (input: DeferTodoWorkInput): DeferTodoWorkInput => ({
        ...input,
        reason: " "
      })
    },
    {
      label: "note",
      mutate: (input: DeferTodoWorkInput): DeferTodoWorkInput => ({
        ...input,
        note: " "
      })
    }
  ])(
    "deferWork todo 必填字段 $label 缺失时无任何副作用",
    ({ mutate }) => {
      const records = createTodoRecords();
      const counting = createCountingDependencies();
      const input: DeferTodoWorkInput = {
        mode: "todo",
        resolvedRecords: {
          todo: records.todo,
          workItem: records.workItem
        },
        targetReviewVersionId: "version-2",
        reason: "later",
        note: "reviewed",
        actor: TEST_ACTOR,
        deps: counting.deps
      };

      expect(() => deferWork(mutate(input))).toThrow(DomainError);
      expect(counting.idCalls()).toBe(0);
      expect(counting.clockCalls()).toBe(0);
    }
  );

  it("reviewDeferred defer_again 保持 Deferred ID 与 WorkItem lineage", () => {
    const { deps, deferred, workItem } =
      createPendingDeferredRecords();

    const result = reviewDeferred({
      action: "defer_again",
      resolvedRecords: {
        deferred,
        workItem
      },
      targetReviewVersionId: "version-4",
      reason: "Need customer evidence",
      reviewTrigger: "customer-ready",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.action).toBe("defer_again");
    expect(result.deferred.id).toBe(deferred.id);
    expect(result.deferred.workItemId).toBe(deferred.workItemId);
    expect(result.deferred.targetReviewVersionId).toBe("version-4");
    expect(result.workItem.activeRecordId).toBe(deferred.id);
  });

  it("reviewDeferred activate 一次形成 Todo 并切换 active 指针", () => {
    const { deps, deferred, workItem } =
      createPendingDeferredRecords();

    const result = reviewDeferred({
      action: "activate",
      resolvedRecords: {
        deferred,
        workItem
      },
      targetVersionId: "version-2",
      reason: "Due now",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.action).toBe("activate");
    if (result.action !== "activate") {
      throw new Error("expected activate review result");
    }
    expect(result.deferred.status).toBe("activated");
    expect(result.todo.workItemId).toBe(workItem.id);
    expect(result.todo.sourceId).toBe(deferred.id);
    expect(result.workItem.activeRecordType).toBe("todo");
    expect(result.workItem.activeRecordId).toBe(result.todo.id);
  });

  it("reviewDeferred resolve 分发 decisionRef 规则并关闭 lineage", () => {
    const missing = createPendingDeferredRecords();

    expect(() =>
      reviewDeferred({
        action: "resolve",
        resolvedRecords: {
          deferred: missing.deferred,
          workItem: missing.workItem
        },
        outcome: "rejected",
        reason: "Architecture decision",
        actor: TEST_ACTOR,
        deps: missing.deps
      })
    ).toThrow(DomainError);

    const accepted = createPendingDeferredRecords();
    const result = reviewDeferred({
      action: "resolve",
      resolvedRecords: {
        deferred: accepted.deferred,
        workItem: accepted.workItem
      },
      outcome: "rejected",
      reason: "Architecture decision",
      decisionRef: "decision:architecture-42",
      actor: TEST_ACTOR,
      deps: accepted.deps
    });

    expect(result.action).toBe("resolve");
    expect(result.deferred.status).toBe("resolved");
    expect(result.deferred.decisionRef).toBe(
      "decision:architecture-42"
    );
    expect(result.workItem.status).toBe("closed");
  });

  it("reviewDeferred resolve runtime 拒绝 garbage outcome，零 clock/ID 且不修改 records", () => {
    const records = createPendingDeferredRecords();
    const counting = createCountingDependencies();
    const deferredBefore = structuredClone(records.deferred);
    const workItemBefore = structuredClone(records.workItem);

    expect(() =>
      reviewDeferred({
        action: "resolve",
        resolvedRecords: {
          deferred: records.deferred,
          workItem: records.workItem
        },
        outcome: "garbage",
        reason: "invalid runtime input",
        actor: TEST_ACTOR,
        deps: counting.deps
      } as unknown as ReviewDeferredInput)
    ).toThrow(DomainError);
    expect(counting.idCalls()).toBe(0);
    expect(counting.clockCalls()).toBe(0);
    expect(records.deferred).toEqual(deferredBefore);
    expect(records.workItem).toEqual(workItemBefore);
  });

  it("reviewDeferred 对仅含未知 action 的 payload 稳定抛 DomainError", () => {
    const invalid = {
      action: "garbage"
    } as unknown as ReviewDeferredInput;

    expect(() => reviewDeferred(invalid)).toThrow(DomainError);
  });

  it("reviewDeferred 未知 action 不访问 records 且零 clock/ID", () => {
    const records = createPendingDeferredRecords();
    const counting = createCountingDependencies();
    const invalid = {
      action: "retarget",
      actor: TEST_ACTOR,
      deps: counting.deps
    } as unknown as ReviewDeferredInput;

    expect(() => reviewDeferred(invalid)).toThrow(DomainError);
    expect(counting.idCalls()).toBe(0);
    expect(counting.clockCalls()).toBe(0);
    expect(records.deferred.status).toBe("pending");
    expect(records.workItem.activeRecordId).toBe(records.deferred.id);
  });

  it.each(["activate", "defer_again", "resolve"] as const)(
    "reviewDeferred 合法 action %s 缺 resolvedRecords 时抛 DomainError 且零 clock/ID",
    (action) => {
      const counting = createCountingDependencies();
      const invalid = {
        action,
        targetVersionId: "version-2",
        targetReviewVersionId: "version-3",
        outcome: "superseded",
        reason: "review",
        actor: TEST_ACTOR,
        deps: counting.deps
      } as unknown as ReviewDeferredInput;

      expect(() => reviewDeferred(invalid)).toThrow(DomainError);
      expect(counting.idCalls()).toBe(0);
      expect(counting.clockCalls()).toBe(0);
    }
  );

  it("recordConstraint 与 retireConstraint 提供两个 workflow 命名入口", () => {
    const deps = createTestDependencies();
    const recorded = recordConstraint({
      projectId: "project-1",
      rule: "Do not bypass canonical validation",
      rationale: "Keep evidence auditable",
      scope: {
        type: "version",
        versionId: "version-1"
      },
      actor: TEST_ACTOR,
      deps
    });
    const retired = retireConstraint({
      constraint: recorded.constraint,
      reason: "Superseded by project policy",
      note: "decision:policy-2",
      actor: TEST_ACTOR,
      deps
    });

    expect(recorded.constraint.status).toBe("active");
    expect(recorded.events[0]?.eventType).toBe("constraint.created");
    expect(retired.constraint.status).toBe("retired");
    expect(retired.events[0]?.eventType).toBe("constraint.retired");
  });
});
