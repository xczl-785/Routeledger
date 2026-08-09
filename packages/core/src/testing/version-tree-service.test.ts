import { describe, expect, it } from "vitest";

import {
  applyVersionTreeMutation,
  normalizeVersionTreePayload
} from "../services/version-tree-service.js";
import { TEST_ACTOR, createVersionFixture } from "./builders.js";

describe("version tree service", () => {
  it("重算 preorder 全局 order，并维护 sibling / child 指针", () => {
    const initial = createVersionFixture({
      id: "version-1",
      isCurrent: true,
      nextVersionId: "version-2"
    });
    const rootTail = createVersionFixture({
      id: "version-2",
      title: "Version 2",
      order: 2,
      previousVersionId: "version-1"
    });
    const normalizedPayload = normalizeVersionTreePayload({
      versions: [initial, rootTail],
      actionType: "create_child_version",
      targetId: "version-3",
      payload: {
        parentVersionId: "version-1",
        title: "Child 1"
      }
    });

    expect(normalizedPayload).toMatchObject({
      parentVersionId: "version-1",
      previousVersionId: null,
      nextVersionId: null,
      siblingVersionIds: []
    });

    const applied = applyVersionTreeMutation({
      projectId: initial.projectId,
      versions: [initial, rootTail],
      actionType: "create_child_version",
      targetId: "version-3",
      payload: normalizedPayload,
      actor: TEST_ACTOR,
      now: "2026-06-27T00:00:00.000Z"
    });

    expect(applied.versions.map((version) => version.id)).toEqual([
      "version-1",
      "version-3",
      "version-2"
    ]);
    expect(applied.versions.map((version) => version.order)).toEqual([1, 2, 3]);
    expect(applied.versions.find((version) => version.id === "version-3")).toMatchObject({
      parentVersionId: "version-1",
      previousVersionId: null,
      nextVersionId: null,
      state: "wait"
    });
    expect(applied.eventDrafts.map((event) => event.eventType)).toContain("version.created");
  });

  it("允许在顶层 close 尾节点后 append，但仍拒绝改写 close 历史结构", () => {
    const initial = createVersionFixture({
      id: "version-1",
      isCurrent: true,
      nextVersionId: "version-2"
    });
    const closedTail = createVersionFixture({
      id: "version-2",
      title: "Closed Tail",
      state: "close",
      order: 2,
      previousVersionId: "version-1",
      nextVersionId: null
    });

    const normalizedCreate = normalizeVersionTreePayload({
      versions: [initial, closedTail],
      actionType: "create_version",
      targetId: "version-3",
      payload: { title: "Version 3" }
    });
    expect(normalizedCreate).toMatchObject({
      parentVersionId: null,
      previousVersionId: closedTail.id,
      nextVersionId: null
    });

    const appended = applyVersionTreeMutation({
      projectId: initial.projectId,
      versions: [initial, closedTail],
      actionType: "create_version",
      targetId: "version-3",
      payload: normalizedCreate,
      actor: TEST_ACTOR,
      now: "2026-08-09T00:00:00.000Z"
    });
    expect(appended.versions.find((version) => version.id === closedTail.id)).toMatchObject({
      state: "close",
      previousVersionId: initial.id,
      nextVersionId: "version-3",
      order: 2
    });
    expect(appended.versions.find((version) => version.id === "version-3")).toMatchObject({
      state: "wait",
      parentVersionId: null,
      previousVersionId: closedTail.id,
      nextVersionId: null,
      order: 3,
      isCurrent: false
    });
    expect(appended.eventDrafts).toContainEqual(
      expect.objectContaining({
        targetId: closedTail.id,
        eventType: "version.successor_appended",
        metadata: expect.objectContaining({ appendOnlyAfterClosedTail: true })
      })
    );

    expect(() =>
      normalizeVersionTreePayload({
        versions: [initial, closedTail],
        actionType: "insert_version",
        targetId: "version-before-close",
        payload: {
          title: "Invalid insertion",
          previousVersionId: initial.id,
          nextVersionId: closedTail.id
        }
      })
    ).toThrowError(/close version/);

    expect(() =>
      normalizeVersionTreePayload({
        versions: [initial, closedTail],
        actionType: "create_child_version",
        targetId: "closed-child",
        payload: {
          title: "Invalid child",
          parentVersionId: closedTail.id
        }
      })
    ).toThrowError(/close version/);

    try {
      normalizeVersionTreePayload({
        versions: [initial, closedTail],
        actionType: "reorder_versions",
        targetId: "version-1",
        payload: {
          nextVersionId: "version-2"
        }
      });
      throw new Error("expected reorder_versions to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_VERSION_TRANSITION"
      });
    }
  });
});
