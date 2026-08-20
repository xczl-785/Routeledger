import { describe, expect, it } from "vitest";

import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import {
  createCommittedVersion,
  FailOnSaveStorageAdapter,
  MemoryStorageAdapter
} from "./routeledger-service-test-helpers.js";

const createProject = async (
  service: RouteLedgerService
): Promise<{ projectId: string; versionId: string }> => {
  const created = await service.initProject({
    contentLocale: "en",
    name: "Ordinary write idempotency",
    firstVersion: {
      title: "Initial Version",
      description: "",
      initialTodos: []
    },
    actor: TEST_ACTOR
  });
  return {
    projectId: created.project.id,
    versionId: created.firstVersion!.id
  };
};

describe("ordinary write idempotency", () => {
  it("replays create_todo and rejects key reuse with different input", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const ids = await createProject(service);
    const command = {
      ...ids,
      title: "Exactly once",
      idempotencyKey: "create-todo-1",
      actor: TEST_ACTOR
    };

    const first = await service.createTodo(command);
    const replay = await service.createTodo(command);

    expect(replay.todo).toEqual(first.todo);
    expect(replay.idempotency).toEqual({
      protected: true,
      receiptId: first.idempotency!.receiptId,
      replayed: true,
      resultScope: "original_commit",
      originalCommittedAt: expect.any(String),
      currentStateRefreshed: false
    });
    await expect(
      service.createTodo({ ...command, title: "Different input" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });
    const snapshot = await storage.loadProjectAggregate(ids.projectId);
    expect(snapshot?.todos).toHaveLength(1);
    expect(snapshot?.ordinaryWriteReceipts).toHaveLength(1);
  });

  it("marks a replayed create result as historical after the resource changes", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const ids = await createProject(service);
    const createCommand = {
      ...ids,
      title: "Historical create result",
      idempotencyKey: "historical-create-result",
      actor: TEST_ACTOR
    };

    const created = await service.createTodo(createCommand);
    await service.closeTodo({
      projectId: ids.projectId,
      todoId: created.todo.id,
      reason: "done",
      note: "closed after creation",
      idempotencyKey: "close-historical-create-result",
      actor: TEST_ACTOR
    });
    const replay = await service.createTodo(createCommand);
    const snapshot = await storage.loadProjectAggregate(ids.projectId);

    expect(replay.todo.status).toBe("wait");
    expect(snapshot?.todos.find((todo) => todo.id === created.todo.id)?.status).toBe("closed");
    expect(replay.idempotency).toMatchObject({
      replayed: true,
      resultScope: "original_commit",
      originalCommittedAt: expect.any(String),
      currentStateRefreshed: false
    });
  });

  it("recovers a same-command concurrent stale save by replaying the committed receipt", async () => {
    class CommitThenStaleStorage extends MemoryStorageAdapter {
      private armed = false;

      arm(): void {
        this.armed = true;
      }

      override async saveProjectAggregate(snapshot: Parameters<MemoryStorageAdapter["saveProjectAggregate"]>[0]) {
        if (!this.armed) return super.saveProjectAggregate(snapshot);
        this.armed = false;
        await super.saveProjectAggregate(snapshot);
        throw Object.assign(new Error("simulated stale snapshot"), {
          code: "STALE_SNAPSHOT"
        });
      }
    }

    const storage = new CommitThenStaleStorage();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const ids = await createProject(service);
    storage.arm();

    const result = await service.createTodo({
      ...ids,
      title: "Concurrent retry",
      idempotencyKey: "concurrent-create-todo",
      actor: TEST_ACTOR
    });

    expect(result.idempotency).toMatchObject({ protected: true, replayed: true });
    const snapshot = await storage.loadProjectAggregate(ids.projectId);
    expect(snapshot?.todos).toHaveLength(1);
    expect(snapshot?.ordinaryWriteReceipts).toHaveLength(1);
  });

  it("does not persist a receipt when the aggregate save fails before commit", async () => {
    const storage = new FailOnSaveStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const ids = await createProject(service);
    const command = {
      ...ids,
      title: "Retry after failed save",
      idempotencyKey: "failed-save-create-todo",
      actor: TEST_ACTOR
    };
    storage.failOnce();

    await expect(service.createTodo(command)).rejects.toThrow("injected save failure");
    expect((await storage.loadProjectAggregate(ids.projectId))?.ordinaryWriteReceipts).toEqual([]);

    const retried = await service.createTodo(command);
    expect(retried.idempotency).toMatchObject({ protected: true, replayed: false });
    const snapshot = await storage.loadProjectAggregate(ids.projectId);
    expect(snapshot?.todos).toHaveLength(1);
    expect(snapshot?.ordinaryWriteReceipts).toHaveLength(1);
  });

  it("protects every ordinary write and replays destructive results after state changes", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const ids = await createProject(service);
    const downstreamVersionId = await createCommittedVersion(
      service,
      ids.projectId,
      "Deferred review"
    );

    const closeCandidate = await service.createTodo({
      ...ids,
      title: "Close exactly once",
      idempotencyKey: "setup-close",
      actor: TEST_ACTOR
    });
    const closeCommand = {
      projectId: ids.projectId,
      todoId: closeCandidate.todo.id,
      reason: "done",
      note: "completed once",
      idempotencyKey: "ordinary-shared-key",
      actor: TEST_ACTOR
    };
    const closed = await service.closeTodo(closeCommand);
    const closedReplay = await service.closeTodo(closeCommand);
    expect(closedReplay.todo).toEqual(closed.todo);
    expect(closedReplay.idempotency).toMatchObject({ replayed: true });
    await expect(
      service.closeTodo({ ...closeCommand, note: "different" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });

    const deferCandidate = await service.createTodo({
      ...ids,
      title: "Defer exactly once",
      idempotencyKey: "setup-defer",
      actor: TEST_ACTOR
    });
    const deferCommand = {
      mode: "todo" as const,
      projectId: ids.projectId,
      todoId: deferCandidate.todo.id,
      targetReviewVersionId: downstreamVersionId,
      reason: "later",
      note: "converted once",
      idempotencyKey: "ordinary-shared-key",
      actor: TEST_ACTOR
    };
    const deferred = await service.deferWork(deferCommand);
    const deferredReplay = await service.deferWork(deferCommand);
    expect(deferredReplay.deferred).toEqual(deferred.deferred);
    expect(deferredReplay.idempotency).toMatchObject({ replayed: true });
    await expect(
      service.deferWork({ ...deferCommand, note: "different" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });

    const reviewSource = await service.deferWork({
      mode: "new",
      projectId: ids.projectId,
      originVersionId: ids.versionId,
      targetReviewVersionId: downstreamVersionId,
      title: "Review exactly once",
      reason: "review downstream",
      idempotencyKey: "setup-review",
      actor: TEST_ACTOR
    });
    const reviewCommand = {
      action: "activate" as const,
      projectId: ids.projectId,
      deferredId: reviewSource.deferred.id,
      targetVersionId: downstreamVersionId,
      reason: "activate",
      note: "activated once",
      idempotencyKey: "ordinary-shared-key",
      actor: TEST_ACTOR
    };
    const reviewed = await service.reviewDeferred(reviewCommand);
    const reviewedReplay = await service.reviewDeferred(reviewCommand);
    expect(reviewedReplay.deferred).toEqual(reviewed.deferred);
    expect(reviewedReplay.idempotency).toMatchObject({ replayed: true });
    await expect(
      service.reviewDeferred({ ...reviewCommand, note: "different" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });

    const recordCommand = {
      projectId: ids.projectId,
      rule: "Keep the default path idempotent",
      rationale: "response loss must be safe",
      scope: { type: "project" as const },
      idempotencyKey: "ordinary-shared-key",
      actor: TEST_ACTOR
    };
    const recorded = await service.recordConstraint(recordCommand);
    const recordedReplay = await service.recordConstraint(recordCommand);
    expect(recordedReplay.constraint).toEqual(recorded.constraint);
    expect(recordedReplay.idempotency).toMatchObject({ replayed: true });
    await expect(
      service.recordConstraint({ ...recordCommand, rationale: "different" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });

    const retireCommand = {
      projectId: ids.projectId,
      constraintId: recorded.constraint.id,
      reason: "superseded",
      note: "retired once",
      idempotencyKey: "ordinary-shared-key",
      actor: TEST_ACTOR
    };
    const retired = await service.retireConstraint(retireCommand);
    const retiredReplay = await service.retireConstraint(retireCommand);
    expect(retiredReplay.constraint).toEqual(retired.constraint);
    expect(retiredReplay.idempotency).toMatchObject({ replayed: true });
    await expect(
      service.retireConstraint({ ...retireCommand, note: "different" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });

    const snapshot = await storage.loadProjectAggregate(ids.projectId);
    expect(snapshot?.ordinaryWriteReceipts).toHaveLength(8);
  });
});
