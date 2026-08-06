import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import {
  activateDeferred,
  createDeferred,
  deferAgain,
  resolveDeferred
} from "../services/deferred-service.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";

const createPendingDeferred = () => {
  const deps = createTestDependencies();
  const creation = createDeferred({
    projectId: "project-1",
    originVersionId: "version-1",
    targetReviewVersionId: "version-2",
    title: "Review durable storage",
    reason: "Not required in the current version",
    actor: TEST_ACTOR,
    deps
  });

  return { deps, creation };
};

describe("deferred service", () => {
  it("创建 Deferred 时建立 WorkItem lineage 与原子事件序列", () => {
    const { creation } = createPendingDeferred();

    expect(creation.deferred.status).toBe("pending");
    expect(creation.deferred.workItemId).toBe(creation.workItem.id);
    expect(creation.workItem.originVersionId).toBe("version-1");
    expect(creation.workItem.activeRecordType).toBe("deferred");
    expect(creation.workItem.activeRecordId).toBe(creation.deferred.id);
    expect(creation.events.map((event) => event.operationSeq)).toEqual([1, 2]);
    expect(new Set(creation.events.map((event) => event.operationId)).size).toBe(1);
    expect(creation.events.map((event) => event.eventType)).toEqual([
      "deferred.created",
      "work_item.created"
    ]);
    expect(creation.events[0]).toMatchObject({
      targetType: "deferred_item",
      targetId: creation.deferred.id
    });
    expect(creation.events[0]?.metadata).toMatchObject({
      deferredItemId: creation.deferred.id,
      reason: "Not required in the current version",
      reviewTrigger: null
    });
  });

  it("创建 Deferred 必须提供标题、目标 Version 和延后原因", () => {
    const deps = createTestDependencies();
    const base = {
      projectId: "project-1",
      originVersionId: "version-1",
      title: "Review durable storage",
      actor: TEST_ACTOR,
      deps
    };

    expect(() =>
      createDeferred({
        ...base,
        targetReviewVersionId: " ",
        reason: "not now"
      })
    ).toThrow(DomainError);

    expect(() =>
      createDeferred({
        ...base,
        title: " ",
        targetReviewVersionId: "version-2",
        reason: "not now"
      })
    ).toThrow(DomainError);

    expect(() =>
      createDeferred({
        ...base,
        targetReviewVersionId: "version-2",
        reason: " "
      })
    ).toThrow(DomainError);
  });

  it("再次延期保留 Deferred ID、WorkItem lineage 与 active 指针", () => {
    const { deps, creation } = createPendingDeferred();

    const result = deferAgain({
      deferred: creation.deferred,
      workItem: creation.workItem,
      targetReviewVersionId: "version-4",
      reason: "Needs production evidence",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.deferred.id).toBe(creation.deferred.id);
    expect(result.deferred.workItemId).toBe(creation.deferred.workItemId);
    expect(result.deferred.targetReviewVersionId).toBe("version-4");
    expect(result.workItem.id).toBe(creation.workItem.id);
    expect(result.workItem.activeRecordType).toBe("deferred");
    expect(result.workItem.activeRecordId).toBe(creation.deferred.id);
    expect(result.events[0]?.eventType).toBe("deferred.deferred_again");
  });

  it("多次延期事件完整保留每一跳的 reason 与 reviewTrigger", () => {
    const deps = createTestDependencies();
    const creation = createDeferred({
      projectId: "project-1",
      originVersionId: "version-1",
      targetReviewVersionId: "version-2",
      title: "Review durable storage",
      reason: "Need baseline evidence",
      reviewTrigger: "baseline-ready",
      actor: TEST_ACTOR,
      deps
    });
    const first = deferAgain({
      deferred: creation.deferred,
      workItem: creation.workItem,
      targetReviewVersionId: "version-3",
      reason: "Need production evidence",
      reviewTrigger: "production-traffic",
      actor: TEST_ACTOR,
      deps
    });
    const second = deferAgain({
      deferred: first.deferred,
      workItem: first.workItem,
      targetReviewVersionId: "version-4",
      reason: "Need customer evidence",
      reviewTrigger: null,
      actor: TEST_ACTOR,
      deps
    });

    expect(creation.events[0]?.metadata).toMatchObject({
      targetReviewVersionId: "version-2",
      reason: "Need baseline evidence",
      reviewTrigger: "baseline-ready"
    });
    expect(first.events[0]?.metadata).toMatchObject({
      deferredItemId: creation.deferred.id,
      previousTargetReviewVersionId: "version-2",
      nextTargetReviewVersionId: "version-3",
      previousReason: "Need baseline evidence",
      nextReason: "Need production evidence",
      previousReviewTrigger: "baseline-ready",
      nextReviewTrigger: "production-traffic"
    });
    expect(second.events[0]?.metadata).toMatchObject({
      deferredItemId: creation.deferred.id,
      previousTargetReviewVersionId: "version-3",
      nextTargetReviewVersionId: "version-4",
      previousReason: "Need production evidence",
      nextReason: "Need customer evidence",
      previousReviewTrigger: "production-traffic",
      nextReviewTrigger: null
    });
    expect(second.deferred.id).toBe(creation.deferred.id);
  });

  it("再次延期必须提供新目标与原因，且仅允许 pending Deferred", () => {
    const { deps, creation } = createPendingDeferred();

    expect(() =>
      deferAgain({
        deferred: creation.deferred,
        workItem: creation.workItem,
        targetReviewVersionId: "",
        reason: "later",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    expect(() =>
      deferAgain({
        deferred: {
          ...creation.deferred,
          status: "resolved"
        },
        workItem: creation.workItem,
        targetReviewVersionId: "version-3",
        reason: "later",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("激活 Deferred 会生成 Todo 并把 WorkItem active 指针切到 Todo", () => {
    const { deps, creation } = createPendingDeferred();

    const result = activateDeferred({
      deferred: creation.deferred,
      workItem: creation.workItem,
      versionId: "version-2",
      reason: "Due for implementation",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.deferred.status).toBe("activated");
    expect(result.deferred.resolutionOutcome).toBe("activated");
    expect(result.deferred.activatedTodoId).toBe(result.todo.id);
    expect(result.todo.status).toBe("wait");
    expect(result.todo.versionId).toBe("version-2");
    expect(result.todo.workItemId).toBe(creation.workItem.id);
    expect(result.todo.sourceId).toBe(creation.deferred.id);
    expect(result.workItem.id).toBe(creation.workItem.id);
    expect(result.workItem.activeRecordType).toBe("todo");
    expect(result.workItem.activeRecordId).toBe(result.todo.id);
    expect(result.events.map((event) => event.operationSeq)).toEqual([1, 2, 3]);
    expect(new Set(result.events.map((event) => event.operationId)).size).toBe(1);
    expect(result.events[0]).toMatchObject({
      targetType: "deferred_item",
      targetId: result.deferred.id
    });
  });

  it("激活要求 pending 状态和匹配的 WorkItem active 指针", () => {
    const { deps, creation } = createPendingDeferred();

    expect(() =>
      activateDeferred({
        deferred: {
          ...creation.deferred,
          status: "activated"
        },
        workItem: creation.workItem,
        versionId: "version-2",
        reason: "due",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    expect(() =>
      activateDeferred({
        deferred: creation.deferred,
        workItem: {
          ...creation.workItem,
          activeRecordId: "another-deferred"
        },
        versionId: "version-2",
        reason: "due",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it.each(["rejected", "out_of_scope"] as const)(
    "%s resolution 必须提供 decisionRef",
    (outcome) => {
      const { deps, creation } = createPendingDeferred();

      expect(() =>
        resolveDeferred({
          deferred: creation.deferred,
          workItem: creation.workItem,
          outcome,
          reason: "Decision made",
          decisionRef: " ",
          actor: TEST_ACTOR,
          deps
        })
      ).toThrow(DomainError);
    }
  );

  it("rejected resolution 保存 decisionRef 作为裁决证据", () => {
    const { deps, creation } = createPendingDeferred();

    const result = resolveDeferred({
      deferred: creation.deferred,
      workItem: creation.workItem,
      outcome: "rejected",
      reason: "Architecture review rejected the option",
      decisionRef: "decision:architecture-review-42",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.deferred.status).toBe("resolved");
    expect(result.deferred.resolutionOutcome).toBe("rejected");
    expect(result.deferred.decisionRef).toBe(
      "decision:architecture-review-42"
    );
  });

  it("superseded resolution 关闭 Deferred 与 WorkItem，不要求 decisionRef", () => {
    const { deps, creation } = createPendingDeferred();

    const result = resolveDeferred({
      deferred: creation.deferred,
      workItem: creation.workItem,
      outcome: "superseded",
      reason: "Covered by a newer capability",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.deferred.status).toBe("resolved");
    expect(result.deferred.resolutionOutcome).toBe("superseded");
    expect(result.deferred.decisionRef).toBeNull();
    expect(result.workItem.status).toBe("closed");
    expect(result.workItem.activeRecordType).toBeNull();
    expect(result.workItem.activeRecordId).toBeNull();
    expect(result.events.map((event) => event.eventType)).toEqual([
      "deferred.resolved",
      "work_item.closed"
    ]);
    expect(result.events[0]).toMatchObject({
      targetType: "deferred_item",
      targetId: result.deferred.id
    });
  });

  it("resolve 不允许重复处理终态 Deferred", () => {
    const { deps, creation } = createPendingDeferred();

    expect(() =>
      resolveDeferred({
        deferred: {
          ...creation.deferred,
          status: "resolved"
        },
        workItem: creation.workItem,
        outcome: "superseded",
        reason: "duplicate",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });
});
