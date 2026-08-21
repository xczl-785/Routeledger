import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter, FailOnSaveStorageAdapter, createApprovedArtifact } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("batch_create_versions requires and atomically applies setCurrentTo when an empty route gets its first nodes", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Empty Route",
      firstVersion: null,
      actor: TEST_ACTOR
    });
    const items = [
      {
        clientKey: "first",
        title: "First delivery",
        description: "first real node",
        initialTodos: ["Confirm scope"]
      },
      {
        clientKey: "second",
        title: "Second delivery",
        description: "direct successor",
        initialTodos: []
      }
    ];

    const missingSelection = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      items,
      actor: TEST_ACTOR
    });
    expect(missingSelection).toMatchObject({
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      issues: [expect.objectContaining({ code: "SET_CURRENT_TARGET_INVALID" })]
    });

    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      items,
      setCurrentTo: "first",
      actor: TEST_ACTOR
    });
    expect(proposed).toMatchObject({ ok: true, pendingOperationId: expect.any(String) });
    if (!proposed.ok || !("pendingOperationId" in proposed)) {
      throw new Error("expected proposal");
    }
    const artifact = await createApprovedArtifact(
      service,
      created.project.id,
      proposed.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: proposed.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(created.project.id);

    expect(snapshot?.versions.map((version) => version.title)).toEqual([
      "First delivery",
      "Second delivery"
    ]);
    expect(snapshot?.project.currentVersionId).toBe(snapshot?.versions[0]?.id);
    expect(snapshot?.versions[0]?.isCurrent).toBe(true);
    expect(snapshot?.versions[1]?.isCurrent).toBe(false);
    expect(snapshot?.todos.map((todo) => todo.title)).toEqual(["Confirm scope"]);
  });

  it("batch_create_versions preflight 鎴愬姛鏃惰繑鍥?normalizedPlan/preview/risks 涓斾笉鍒涘缓 proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    const result = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      anchor: {
        afterVersionId: created.firstVersion!.id
      },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: ["write docs"]
        },
        {
          clientKey: "plan-b",
          title: "Plan B",
          description: "batch item B",
          initialTodos: ["prepare review"]
        }
      ],
      setCurrentTo: "plan-b",
      previousCurrentPolicy: "leave_as_is",
      actor: TEST_ACTOR
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("resolvedAnchors" in result)) {
      throw new Error("expected preflight success");
    }

    expect(result.normalizedPlan).toMatchObject({
      partialAllowed: false,
      setCurrentTo: "plan-b",
      previousCurrentPolicy: "leave_as_is"
    });
    expect(result.resolvedAnchors).toEqual({
      parentVersionId: null,
      afterVersionId: created.firstVersion!.id,
      beforeVersionId: null
    });
    expect(result.preview.createdVersions).toHaveLength(2);
    expect(result.preview.createdVersions[0]).toMatchObject({
      clientKey: "plan-a",
      previousRef: created.firstVersion!.id
    });
    expect(result.preview.createdVersions[1]).toMatchObject({
      clientKey: "plan-b",
      previousRef: result.preview.createdVersions[0]?.previewVersionId
    });
    expect(result.preview.createdTodos).toEqual([
      expect.objectContaining({
        versionClientKey: "plan-a",
        title: "write docs"
      }),
      expect.objectContaining({
        versionClientKey: "plan-b",
        title: "prepare review"
      })
    ]);
    expect(result.risks).toContainEqual(
      expect.objectContaining({
        code: "PREVIOUS_CURRENT_LEFT_AS_IS"
      })
    );
    expect(result.blockers).toEqual([]);
    expect(result.headRevision).toBe("memory:1");
    expect(result.digestPreview.value).toHaveLength(64);

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
    expect(snapshot?.versions).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(0);
  });

  it("batch_create_versions can append after a closed top-level tail without reopening history", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    await storage.mutate(created.project.id, (snapshot) => ({
      ...snapshot,
      versions: snapshot.versions.map((version) =>
        version.id === created.firstVersion!.id
          ? {
              ...version,
              state: "close",
              closedAt: "2026-08-09T00:00:00.000Z"
            }
          : version
      )
    }));

    const preflight = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      anchor: {
        afterVersionId: created.firstVersion!.id
      },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: []
        }
      ],
      actor: TEST_ACTOR
    });

    expect(preflight).toMatchObject({
      ok: true,
      normalizedPlan: {
        items: [
          expect.objectContaining({
            clientKey: "plan-a",
            previousRef: created.firstVersion!.id
          })
        ]
      }
    });

    const afterPreflight = await storage.loadProjectAggregate(created.project.id);
    expect(afterPreflight?.pendingOperations).toHaveLength(0);
    expect(afterPreflight?.versions).toHaveLength(1);

    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      anchor: {
        afterVersionId: created.firstVersion!.id
      },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: []
        }
      ],
      actor: TEST_ACTOR
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !("pendingOperationId" in proposed)) {
      throw new Error("expected propose success");
    }

    const artifact = await createApprovedArtifact(
      service,
      created.project.id,
      proposed.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: proposed.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    const versions = snapshot?.versions.slice().sort((left, right) => left.order - right.order) ?? [];
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      id: created.firstVersion!.id,
      state: "close",
      isCurrent: true,
      nextVersionId: versions[1]?.id
    });
    expect(versions[1]).toMatchObject({
      title: "Plan A",
      state: "wait",
      isCurrent: false,
      parentVersionId: null,
      previousVersionId: created.firstVersion!.id,
      nextVersionId: null
    });
    expect(snapshot?.events).toContainEqual(
      expect.objectContaining({
        targetId: created.firstVersion!.id,
        eventType: "version.successor_appended",
        metadata: expect.objectContaining({ appendOnlyAfterClosedTail: true })
      })
    );
  });

  it("batch_create_versions 缂哄け description 鎴?initialTodos 鏃惰繑鍥為€愰」 issue", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    const result = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A"
        } as unknown as {
          clientKey: string;
          title: string;
          description: string;
          initialTodos: string[];
        }
      ],
      actor: TEST_ACTOR
    });

    expect(result).toMatchObject({
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      issues: [
        expect.objectContaining({
          clientKey: "plan-a",
          code: "MISSING_REQUIRED_FIELD",
          message: expect.stringContaining("description")
        }),
        expect.objectContaining({
          clientKey: "plan-a",
          code: "MISSING_REQUIRED_FIELD",
          message: expect.stringContaining("initialTodos")
        })
      ]
    });
  });

  it("batch_create_versions 闈炴硶 mode 浼氭姏鍑虹ǔ瀹氶敊璇爜锛屼笖涓嶅垱寤?pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    await expect(
      service.batchCreateVersions({
        projectId: created.project.id,
        mode: "typo" as unknown as "preflight",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ],
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "BATCH_CREATE_VERSIONS_MODE_INVALID",
      details: {
        receivedMode: "typo",
        allowedModes: ["preflight", "propose"]
      }
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
    expect(snapshot?.versions).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(0);
  });

  it("batch_create_versions 闈炴硶 previousCurrentPolicy 浼氭姏鍑虹ǔ瀹氶敊璇爜锛屼笖涓嶅垱寤?pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    await expect(
      service.batchCreateVersions({
        projectId: created.project.id,
        mode: "propose",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ],
        previousCurrentPolicy: "typo" as unknown as "leave_as_is",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
      details: {
        receivedPreviousCurrentPolicy: "typo",
        allowedPreviousCurrentPolicies: ["leave_as_is", "require_complete_or_close"]
      }
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
    expect(snapshot?.versions).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(0);
  });

  it("batch_create_versions propose/commit 浼氬師瀛愬垱寤?version 閾俱€乮nitialTodos锛屽苟鍙?setCurrentTo 鑰屼笉闅愬紡 suspend 鏃?current", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      anchor: {
        afterVersionId: created.firstVersion!.id
      },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: ["write docs"]
        },
        {
          clientKey: "plan-b",
          title: "Plan B",
          description: "batch item B",
          initialTodos: [
            "define persistence boundary",
            "implement add/list/remove",
            "verify restart persistence"
          ]
        }
      ],
      setCurrentTo: "plan-b",
      previousCurrentPolicy: "leave_as_is",
      actor: TEST_ACTOR
    });

    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !("pendingOperationId" in proposed)) {
      throw new Error("expected propose success");
    }

    const artifact = await createApprovedArtifact(service, created.project.id, proposed.pendingOperationId);
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: proposed.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    const versions = snapshot?.versions.slice().sort((left, right) => left.order - right.order) ?? [];

    expect(snapshot?.pendingOperations).toHaveLength(1);
    expect(snapshot?.pendingOperations[0]).toMatchObject({
      actionType: "insert_version",
      status: "committed"
    });
    expect(snapshot?.approvalArtifacts[0]).toMatchObject({
      status: "consumed"
    });
    expect(versions).toHaveLength(3);
    expect(versions.map((version) => version.title)).toEqual([
      "Initial Version",
      "Plan A",
      "Plan B"
    ]);
    expect(snapshot?.todos.map((todo) => todo.title)).toEqual([
      "write docs",
      "define persistence boundary",
      "implement add/list/remove",
      "verify restart persistence"
    ]);
    expect(snapshot?.project.currentVersionId).toBe(versions[2]?.id);
    expect(versions[0]).toMatchObject({
      id: created.firstVersion!.id,
      state: "wait",
      isCurrent: false
    });
    expect(versions[2]).toMatchObject({
      title: "Plan B",
      state: "wait",
      isCurrent: true
    });

    await storage.saveProjectAggregate({
      ...snapshot!,
      todos: snapshot!.todos.slice().reverse()
    });
    const context = await service.getCurrentContext({
      projectId: created.project.id
    });
    const contextTodos = context.data.todos as Array<{ title: string }>;
    expect(contextTodos.map((todo) => todo.title)).toEqual([
      "write docs",
      "define persistence boundary",
      "implement add/list/remove",
      "verify restart persistence"
    ]);
  });

  it("batch_create_versions 鍦?require_complete_or_close 涓嬩細鍏堥樆姝?propose锛屼笖涓嶅垱寤?pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    const result = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: []
        }
      ],
      setCurrentTo: "plan-a",
      previousCurrentPolicy: "require_complete_or_close",
      actor: TEST_ACTOR
    });

    expect(result).toMatchObject({
      ok: false,
      code: "BATCH_VERSION_PLAN_BLOCKED",
      blockers: [
        expect.objectContaining({
          code: "PREVIOUS_CURRENT_NOT_COMPLETE_OR_CLOSE"
        })
      ]
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
  });

  it("batch_create_versions commit 鑻ヤ繚瀛樺け璐ワ紝涓嶄細鐣欎笅鍗婃潯 version 閾炬垨鍗婂啓 todo锛屼篃涓嶄細娑堣垂瀹℃壒璇佹嵁", async () => {
    const storage = new FailOnSaveStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });
    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: ["write docs"]
        },
        {
          clientKey: "plan-b",
          title: "Plan B",
          description: "batch item B",
          initialTodos: []
        }
      ],
      actor: TEST_ACTOR
    });

    if (!proposed.ok || !("pendingOperationId" in proposed)) {
      throw new Error("expected propose success");
    }

    const artifact = await createApprovedArtifact(service, created.project.id, proposed.pendingOperationId);
    const beforeCommitSnapshot = await storage.loadProjectAggregate(created.project.id);
    storage.failOnce();

    await expect(
      service.commitL3Operation({
        projectId: created.project.id,
        pendingOperationId: proposed.pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toThrow("injected save failure");

    const afterCommitSnapshot = await storage.loadProjectAggregate(created.project.id);
    expect(afterCommitSnapshot).toEqual(beforeCommitSnapshot);
  });

});
