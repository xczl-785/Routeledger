import { describe, expect, it } from "vitest";

import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import {
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
      replayed: true
    });
    await expect(
      service.createTodo({ ...command, title: "Different input" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE_MISMATCH" });
    const snapshot = await storage.loadProjectAggregate(ids.projectId);
    expect(snapshot?.todos).toHaveLength(1);
    expect(snapshot?.ordinaryWriteReceipts).toHaveLength(1);
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
});
