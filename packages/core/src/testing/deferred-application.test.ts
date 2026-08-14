import { describe, expect, it } from "vitest";

import type {
  ProjectAggregateSnapshot,
  StoragePort
} from "../index.js";
import { RouteLedgerService } from "../index.js";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTestDependencies,
  createTodoFixture,
  createVersionFixture,
  createWorkItemFixture
} from "./builders.js";

class TrackingStorage implements StoragePort {
  saveCalls = 0;
  failNextSave = false;

  constructor(private snapshot: ProjectAggregateSnapshot) {}

  async loadProjectAggregate(
    projectId: string
  ): Promise<ProjectAggregateSnapshot | null> {
    return this.snapshot.project.id === projectId
      ? structuredClone(this.snapshot)
      : null;
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    this.saveCalls += 1;

    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }

    this.snapshot = structuredClone(snapshot);
  }

  async read(): Promise<ProjectAggregateSnapshot> {
    return structuredClone(this.snapshot);
  }

  async mutate(
    mutate: (snapshot: ProjectAggregateSnapshot) => void
  ): Promise<void> {
    const next = structuredClone(this.snapshot);
    mutate(next);
    this.snapshot = next;
  }
}

const createSnapshot = (): ProjectAggregateSnapshot => ({
  project: createProjectFixture({
    currentVersionId: "version-1",
    initialVersionId: "version-1"
  }),
  versions: [
    createVersionFixture({
      id: "version-1",
      state: "running",
      order: 1,
      isCurrent: true,
      nextVersionId: "version-2"
    }),
    createVersionFixture({
      id: "version-2",
      state: "ready",
      order: 2,
      previousVersionId: "version-1",
      nextVersionId: "version-3"
    }),
    createVersionFixture({
      id: "version-3",
      state: "wait",
      order: 3,
      previousVersionId: "version-2"
    }),
    createVersionFixture({
      id: "cross-project-version",
      projectId: "project-2",
      state: "wait",
      order: 4
    })
  ],
  workItems: [],
  todos: [],
  undos: [],
  deferredItems: [],
  constraints: [],
  assets: [],
  events: [],
  pendingOperations: [],
  approvalArtifacts: []
});

const createService = (snapshot = createSnapshot()) => {
  const storage = new TrackingStorage(snapshot);
  const service = new RouteLedgerService({
    storage,
    deps: createTestDependencies()
  });

  return { service, storage };
};

const deferNew = (
  service: RouteLedgerService,
  overrides: Partial<Parameters<RouteLedgerService["deferWork"]>[0]> = {}
) =>
  service.deferWork({
    mode: "new",
    projectId: "project-1",
    originVersionId: "version-1",
    targetReviewVersionId: "version-2",
    title: "Review persistence semantics",
    description: "Deferred product work",
    reason: "Review in the next version",
    actor: TEST_ACTOR,
    ...overrides
  } as Parameters<RouteLedgerService["deferWork"]>[0]);

describe("RouteLedgerService Deferred and Constraint application commands", () => {
  it("persists new and Todo defer workflows with one aggregate save", async () => {
    const newCase = createService();
    const created = await deferNew(newCase.service);

    expect(created).toMatchObject({
      mode: "new",
      deferred: {
        originVersionId: "version-1",
        targetReviewVersionId: "version-2",
        status: "pending"
      },
      workItem: {
        activeRecordType: "deferred"
      }
    });
    expect(newCase.storage.saveCalls).toBe(1);
    await expect(newCase.storage.read()).resolves.toMatchObject({
      deferredItems: [{ id: created.deferred.id }],
      workItems: [{ id: created.workItem.id }]
    });

    const todoSnapshot = createSnapshot();
    todoSnapshot.workItems.push(createWorkItemFixture());
    todoSnapshot.todos.push(createTodoFixture());
    const todoCase = createService(todoSnapshot);
    const converted = await todoCase.service.deferWork({
      mode: "todo",
      projectId: "project-1",
      todoId: "todo-1",
      targetReviewVersionId: "version-2",
      reason: "Review later",
      note: "Convert the current todo",
      actor: TEST_ACTOR
    });

    expect(converted).toMatchObject({
      mode: "todo",
      todo: {
        id: "todo-1",
        status: "converted"
      },
      deferred: {
        workItemId: "work-item-1",
        targetReviewVersionId: "version-2"
      },
      workItem: {
        activeRecordType: "deferred"
      }
    });
    expect(todoCase.storage.saveCalls).toBe(1);
  });

  it.each([
    ["blank", " ", "DEFERRED_ROUTE_TARGET_REQUIRED"],
    ["self", "version-1", "DEFERRED_ROUTE_TARGET_SELF"],
    ["unknown", "missing-version", "DEFERRED_ROUTE_TARGET_UNKNOWN"],
    [
      "cross-project",
      "cross-project-version",
      "DEFERRED_ROUTE_TARGET_CROSS_PROJECT"
    ]
  ])(
    "rejects %s Deferred route without saving",
    async (_label, targetReviewVersionId, code) => {
      const { service, storage } = createService();

      await expect(
        deferNew(service, { targetReviewVersionId })
      ).rejects.toMatchObject({ code });
      expect(storage.saveCalls).toBe(0);
      expect((await storage.read()).deferredItems).toEqual([]);
    }
  );

  it("rejects upstream routes and accepts downstream routes from the selected source", async () => {
    const invalid = createService();
    await expect(
      deferNew(invalid.service, {
        originVersionId: "version-2",
        targetReviewVersionId: "version-1"
      })
    ).rejects.toMatchObject({
      code: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM",
      details: {
        eligibleTargetVersions: [
          expect.objectContaining({
            id: "version-3",
            state: "wait",
            order: 3
          })
        ]
      }
    });
    expect(invalid.storage.saveCalls).toBe(0);

    const valid = createService();
    await expect(
      deferNew(valid.service, {
        originVersionId: "version-2",
        targetReviewVersionId: "version-3"
      })
    ).resolves.toMatchObject({
      deferred: {
        originVersionId: "version-2",
        targetReviewVersionId: "version-3"
      }
    });
  });

  it("validates Todo defer routes against the Todo source version", async () => {
    const snapshot = createSnapshot();
    snapshot.workItems.push(createWorkItemFixture());
    snapshot.todos.push(createTodoFixture());
    const { service, storage } = createService(snapshot);

    await expect(
      service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "version-1",
        reason: "Invalid self route",
        note: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_ROUTE_TARGET_SELF" });
    await expect(
      service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "missing-version",
        reason: "Invalid unknown route",
        note: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_ROUTE_TARGET_UNKNOWN" });
    expect(storage.saveCalls).toBe(0);
  });

  it.each([
    ["blank", " ", "DEFERRED_ROUTE_TARGET_REQUIRED"],
    ["self", "version-1", "DEFERRED_ROUTE_TARGET_SELF"],
    ["unknown", "missing-version", "DEFERRED_ROUTE_TARGET_UNKNOWN"],
    [
      "cross-project",
      "cross-project-version",
      "DEFERRED_ROUTE_TARGET_CROSS_PROJECT"
    ]
  ])(
    "rejects Todo %s route without saving",
    async (_label, targetReviewVersionId, code) => {
      const snapshot = createSnapshot();
      snapshot.workItems.push(createWorkItemFixture());
      snapshot.todos.push(createTodoFixture());
      const { service, storage } = createService(snapshot);

      await expect(
        service.deferWork({
          mode: "todo",
          projectId: "project-1",
          todoId: "todo-1",
          targetReviewVersionId,
          reason: "Invalid route",
          note: "Invalid route",
          actor: TEST_ACTOR
        })
      ).rejects.toMatchObject({ code });
      expect(storage.saveCalls).toBe(0);
    }
  );

  it("validates Todo upstream/downstream routes, missing records, and ownership", async () => {
    const upstreamSnapshot = createSnapshot();
    upstreamSnapshot.workItems.push(
      createWorkItemFixture({ originVersionId: "version-2" })
    );
    upstreamSnapshot.todos.push(createTodoFixture({ versionId: "version-2" }));
    const upstream = createService(upstreamSnapshot);
    await expect(
      upstream.service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "version-1",
        reason: "Cannot route upstream",
        note: "Invalid route",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM" });
    expect(upstream.storage.saveCalls).toBe(0);

    const downstream = createService(upstreamSnapshot);
    await expect(
      downstream.service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "version-3",
        reason: "Route downstream",
        note: "Valid route",
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({
      deferred: {
        originVersionId: "version-2",
        targetReviewVersionId: "version-3"
      }
    });

    const missing = createService();
    await expect(
      missing.service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "missing-todo",
        targetReviewVersionId: "version-2",
        reason: "Missing Todo",
        note: "Missing Todo",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "TODO_NOT_FOUND" });
    expect(missing.storage.saveCalls).toBe(0);

    const foreignTodoSnapshot = createSnapshot();
    foreignTodoSnapshot.workItems.push(createWorkItemFixture());
    foreignTodoSnapshot.todos.push(
      createTodoFixture({ projectId: "project-2" })
    );
    const foreignTodo = createService(foreignTodoSnapshot);
    await expect(
      foreignTodo.service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "version-2",
        reason: "Foreign Todo",
        note: "Foreign Todo",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "TODO_OWNERSHIP_MISMATCH" });
    expect(foreignTodo.storage.saveCalls).toBe(0);

    const foreignWorkItemSnapshot = createSnapshot();
    foreignWorkItemSnapshot.workItems.push(
      createWorkItemFixture({ projectId: "project-2" })
    );
    foreignWorkItemSnapshot.todos.push(createTodoFixture());
    const foreignWorkItem = createService(foreignWorkItemSnapshot);
    await expect(
      foreignWorkItem.service.deferWork({
        mode: "todo",
        projectId: "project-1",
        todoId: "todo-1",
        targetReviewVersionId: "version-2",
        reason: "Foreign WorkItem",
        note: "Foreign WorkItem",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "WORK_ITEM_OWNERSHIP_MISMATCH" });
    expect(foreignWorkItem.storage.saveCalls).toBe(0);
  });

  it("reviews Deferred through activate, defer_again, and resolve actions", async () => {
    const activateCase = createService();
    const activatedSource = await deferNew(activateCase.service);
    const activated = await activateCase.service.reviewDeferred({
      action: "activate",
      projectId: "project-1",
      deferredId: activatedSource.deferred.id,
      targetVersionId: "version-2",
      reason: "Ready to execute",
      note: "Activate in review version",
      actor: TEST_ACTOR
    });
    expect(activated).toMatchObject({
      action: "activate",
      deferred: {
        status: "activated",
        resolutionOutcome: "activated"
      },
      todo: {
        versionId: "version-2",
        sourceType: "conversion",
        sourceId: activatedSource.deferred.id
      },
      workItem: {
        activeRecordType: "todo"
      }
    });
    expect((await activateCase.storage.read()).todos).toHaveLength(1);

    const againCase = createService();
    const againSource = await deferNew(againCase.service);
    const deferredAgain = await againCase.service.reviewDeferred({
      action: "defer_again",
      projectId: "project-1",
      deferredId: againSource.deferred.id,
      targetReviewVersionId: "version-3",
      reason: "Needs another review cycle",
      reviewTrigger: "version-3 start",
      actor: TEST_ACTOR
    });
    expect(deferredAgain).toMatchObject({
      action: "defer_again",
      deferred: {
        id: againSource.deferred.id,
        status: "pending",
        targetReviewVersionId: "version-3"
      }
    });

    const resolveCase = createService();
    const resolveSource = await deferNew(resolveCase.service);
    const resolved = await resolveCase.service.reviewDeferred({
      action: "resolve",
      projectId: "project-1",
      deferredId: resolveSource.deferred.id,
      outcome: "rejected",
      reason: "Product decision rejected it",
      note: "Close the work item",
      decisionRef: "decision://routeledger/reject-1",
      actor: TEST_ACTOR
    });
    expect(resolved).toMatchObject({
      action: "resolve",
      deferred: {
        status: "resolved",
        resolutionOutcome: "rejected",
        decisionRef: "decision://routeledger/reject-1"
      },
      workItem: {
        status: "closed",
        activeRecordType: null,
        activeRecordId: null
      }
    });
  });

  it.each([
    ["upstream", "version-1"],
    ["further downstream", "version-3"],
    ["cross-project", "cross-project-version"],
    ["missing", "missing-version"]
  ])(
    "rejects activate into %s instead of the exact review target without saving",
    async (_label, targetVersionId) => {
      const { service, storage } = createService();
      const source = await deferNew(service);
      const baseline = await storage.read();
      const savesBefore = storage.saveCalls;

      await expect(
        service.reviewDeferred({
          action: "activate",
          projectId: "project-1",
          deferredId: source.deferred.id,
          targetVersionId,
          reason: "Wrong activation target",
          actor: TEST_ACTOR
        })
      ).rejects.toMatchObject({
        code: "DEFERRED_ACTIVATE_TARGET_MISMATCH"
      });
      expect(storage.saveCalls).toBe(savesBefore);
      expect(await storage.read()).toEqual(baseline);
    }
  );

  it("rejects illegal review state, missing decisionRef, and broken active pointer without saving", async () => {
    const decisionCase = createService();
    const source = await deferNew(decisionCase.service);
    const savesBeforeDecision = decisionCase.storage.saveCalls;
    await expect(
      decisionCase.service.reviewDeferred({
        action: "resolve",
        projectId: "project-1",
        deferredId: source.deferred.id,
        outcome: "out_of_scope",
        reason: "Outside scope",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "MISSING_REQUIRED_FIELD" });
    expect(decisionCase.storage.saveCalls).toBe(savesBeforeDecision);

    await decisionCase.service.reviewDeferred({
      action: "activate",
      projectId: "project-1",
      deferredId: source.deferred.id,
      targetVersionId: "version-2",
      reason: "Activate once",
      actor: TEST_ACTOR
    });
    const savesBeforeSecondReview = decisionCase.storage.saveCalls;
    await expect(
      decisionCase.service.reviewDeferred({
        action: "resolve",
        projectId: "project-1",
        deferredId: source.deferred.id,
        outcome: "superseded",
        reason: "Cannot resolve activated Deferred",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "INVALID_WORK_ITEM_ACTIVE" });
    expect(decisionCase.storage.saveCalls).toBe(savesBeforeSecondReview);

    const pointerCase = createService();
    const pointerSource = await deferNew(pointerCase.service);
    await pointerCase.storage.mutate((snapshot) => {
      snapshot.workItems[0]!.activeRecordId = "wrong-id";
    });
    const savesBeforePointer = pointerCase.storage.saveCalls;
    await expect(
      pointerCase.service.reviewDeferred({
        action: "activate",
        projectId: "project-1",
        deferredId: pointerSource.deferred.id,
        targetVersionId: "version-2",
        reason: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "INVALID_WORK_ITEM_ACTIVE" });
    expect(pointerCase.storage.saveCalls).toBe(savesBeforePointer);

    const stateCase = createService();
    const stateSource = await deferNew(stateCase.service);
    await stateCase.storage.mutate((snapshot) => {
      snapshot.deferredItems[0] = {
        ...snapshot.deferredItems[0]!,
        status: "resolved",
        resolutionOutcome: "superseded",
        resolutionReason: "already resolved",
        resolutionNote: "already resolved",
        reviewedAt: "2026-06-27T00:00:00.000Z"
      };
    });
    const savesBeforeState = stateCase.storage.saveCalls;
    await expect(
      stateCase.service.reviewDeferred({
        action: "activate",
        projectId: "project-1",
        deferredId: stateSource.deferred.id,
        targetVersionId: "version-2",
        reason: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "INVALID_DEFERRED_TRANSITION" });
    expect(stateCase.storage.saveCalls).toBe(savesBeforeState);
  });

  it("validates defer_again relative to the current review version", async () => {
    const { service, storage } = createService();
    const source = await deferNew(service);
    const savesBefore = storage.saveCalls;

    await expect(
      service.reviewDeferred({
        action: "defer_again",
        projectId: "project-1",
        deferredId: source.deferred.id,
        targetReviewVersionId: "version-2",
        reason: "Cannot remain on the same review version",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_ROUTE_TARGET_SELF" });
    await expect(
      service.reviewDeferred({
        action: "defer_again",
        projectId: "project-1",
        deferredId: source.deferred.id,
        targetReviewVersionId: "version-1",
        reason: "Cannot move upstream",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM"
    });
    expect(storage.saveCalls).toBe(savesBefore);
  });

  it("records project/version constraints and retires an active constraint", async () => {
    const { service, storage } = createService();
    const projectConstraint = await service.recordConstraint({
      projectId: "project-1",
      rule: "All changes require evidence",
      rationale: "Keep the route auditable",
      scope: {
        type: "project"
      },
      actor: TEST_ACTOR
    });
    const versionConstraint = await service.recordConstraint({
      projectId: "project-1",
      rule: "Review this version before start",
      rationale: "Version-specific gate",
      scope: {
        type: "version",
        versionId: "version-2"
      },
      actor: TEST_ACTOR
    });
    const retired = await service.retireConstraint({
      projectId: "project-1",
      constraintId: projectConstraint.constraint.id,
      reason: "Superseded by policy",
      note: "Retire after review",
      actor: TEST_ACTOR
    });

    expect(versionConstraint.constraint.scope).toEqual({
      type: "version",
      versionId: "version-2"
    });
    expect(retired.constraint).toMatchObject({
      id: projectConstraint.constraint.id,
      status: "retired",
      retireReason: "Superseded by policy"
    });
    expect((await storage.read()).constraints).toHaveLength(2);
    expect(storage.saveCalls).toBe(3);

    const invalidScope = createService();
    await expect(
      invalidScope.service.recordConstraint({
        projectId: "project-1",
        rule: "Invalid missing version scope",
        rationale: "Must fail closed",
        scope: {
          type: "version",
          versionId: "missing-version"
        },
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    await expect(
      invalidScope.service.recordConstraint({
        projectId: "project-1",
        rule: "Invalid foreign version scope",
        rationale: "Must fail closed",
        scope: {
          type: "version",
          versionId: "cross-project-version"
        },
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "VERSION_OWNERSHIP_MISMATCH" });
    expect(invalidScope.storage.saveCalls).toBe(0);
  });

  it("fails closed for missing/cross-project records and leaves aggregate untouched", async () => {
    const { service, storage } = createService();
    await expect(
      service.reviewDeferred({
        action: "activate",
        projectId: "project-1",
        deferredId: "missing",
        targetVersionId: "version-2",
        reason: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_NOT_FOUND" });
    await expect(
      service.retireConstraint({
        projectId: "project-1",
        constraintId: "missing",
        reason: "Must fail",
        note: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "CONSTRAINT_NOT_FOUND" });
    expect(storage.saveCalls).toBe(0);

    const crossDeferredCase = createService();
    const crossDeferred = await deferNew(crossDeferredCase.service);
    await crossDeferredCase.storage.mutate((snapshot) => {
      snapshot.deferredItems[0]!.projectId = "project-2";
    });
    const crossDeferredSaves = crossDeferredCase.storage.saveCalls;
    await expect(
      crossDeferredCase.service.reviewDeferred({
        action: "activate",
        projectId: "project-1",
        deferredId: crossDeferred.deferred.id,
        targetVersionId: "version-2",
        reason: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "DEFERRED_OWNERSHIP_MISMATCH" });
    expect(crossDeferredCase.storage.saveCalls).toBe(crossDeferredSaves);

    const crossSnapshot = createSnapshot();
    crossSnapshot.constraints.push({
      id: "constraint-cross",
      projectId: "project-2",
      rule: "foreign",
      rationale: "foreign",
      scope: { type: "project" },
      status: "active",
      createdBy: TEST_ACTOR,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      retiredAt: null,
      retireReason: null,
      retireNote: null
    });
    const crossCase = createService(crossSnapshot);
    await expect(
      crossCase.service.retireConstraint({
        projectId: "project-1",
        constraintId: "constraint-cross",
        reason: "Must fail",
        note: "Must fail",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "CONSTRAINT_OWNERSHIP_MISMATCH" });
    expect(crossCase.storage.saveCalls).toBe(0);
  });

  it("keeps persistence atomic when aggregate save fails", async () => {
    const { service, storage } = createService();
    storage.failNextSave = true;

    await expect(deferNew(service)).rejects.toThrow("injected save failure");
    expect((await storage.read()).deferredItems).toEqual([]);
    expect((await storage.read()).workItems).toEqual([]);
  });

  it("keeps every Deferred/Constraint command atomic when aggregate save fails", async () => {
    const cases: Array<{
      label: string;
      prepare: () => Promise<{
        storage: TrackingStorage;
        run: () => Promise<unknown>;
      }>;
    }> = [
      {
        label: "Todo defer",
        prepare: async () => {
          const snapshot = createSnapshot();
          snapshot.workItems.push(createWorkItemFixture());
          snapshot.todos.push(createTodoFixture());
          const { service, storage } = createService(snapshot);
          return {
            storage,
            run: () =>
              service.deferWork({
                mode: "todo",
                projectId: "project-1",
                todoId: "todo-1",
                targetReviewVersionId: "version-2",
                reason: "Defer after save",
                note: "Atomic Todo defer",
                actor: TEST_ACTOR
              })
          };
        }
      },
      ...(["activate", "defer_again", "resolve"] as const).map((action) => ({
        label: action,
        prepare: async () => {
          const { service, storage } = createService();
          const source = await deferNew(service);
          return {
            storage,
            run: () =>
              action === "activate"
                ? service.reviewDeferred({
                    action,
                    projectId: "project-1",
                    deferredId: source.deferred.id,
                    targetVersionId: "version-2",
                    reason: "Activate",
                    actor: TEST_ACTOR
                  })
                : action === "defer_again"
                  ? service.reviewDeferred({
                      action,
                      projectId: "project-1",
                      deferredId: source.deferred.id,
                      targetReviewVersionId: "version-3",
                      reason: "Defer again",
                      actor: TEST_ACTOR
                    })
                  : service.reviewDeferred({
                      action,
                      projectId: "project-1",
                      deferredId: source.deferred.id,
                      outcome: "superseded",
                      reason: "Resolve",
                      actor: TEST_ACTOR
                    })
          };
        }
      })),
      {
        label: "record constraint",
        prepare: async () => {
          const { service, storage } = createService();
          return {
            storage,
            run: () =>
              service.recordConstraint({
                projectId: "project-1",
                rule: "Atomic constraint",
                rationale: "Failure must not leak",
                scope: { type: "project" },
                actor: TEST_ACTOR
              })
          };
        }
      },
      {
        label: "retire constraint",
        prepare: async () => {
          const { service, storage } = createService();
          const recorded = await service.recordConstraint({
            projectId: "project-1",
            rule: "Atomic retirement",
            rationale: "Failure must not leak",
            scope: { type: "project" },
            actor: TEST_ACTOR
          });
          return {
            storage,
            run: () =>
              service.retireConstraint({
                projectId: "project-1",
                constraintId: recorded.constraint.id,
                reason: "Retire",
                note: "Atomic retirement",
                actor: TEST_ACTOR
              })
          };
        }
      }
    ];

    for (const testCase of cases) {
      const { storage, run } = await testCase.prepare();
      const baseline = await storage.read();
      storage.failNextSave = true;
      await expect(run(), testCase.label).rejects.toThrow(
        "injected save failure"
      );
      expect(await storage.read(), testCase.label).toEqual(baseline);
    }
  });

  it("blocks start on due Deferred, unblocks after review, and does not invent Constraint blockers", async () => {
    const { service } = createService();
    const source = await deferNew(service);
    const blocked = await service.checkStartGate({
      projectId: "project-1",
      versionId: "version-2",
      actor: TEST_ACTOR
    });
    expect(blocked).toMatchObject({
      allowed: false,
      dueDeferredIds: [source.deferred.id],
      blockedConstraintIds: []
    });
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain(
      "DUE_DEFERRED_REQUIRES_REVIEW"
    );
    const proposal = await service.proposeL3Operation({
      projectId: "project-1",
      actionType: "start_version",
      targetId: "version-2",
      reason: "Capture the blocked start gate",
      actor: TEST_ACTOR
    });
    expect(proposal.gateSnapshot).toMatchObject({
      kind: "start",
      dueDeferredIds: [source.deferred.id],
      blockedConstraintIds: []
    });
    expect(proposal.digest.payload.gateSnapshot).toMatchObject({
      dueDeferredIds: [source.deferred.id],
      blockedConstraintIds: []
    });

    await service.recordConstraint({
      projectId: "project-1",
      rule: "Active constraints need explicit checks to block",
      rationale: "No pseudo blocker",
      scope: { type: "project" },
      actor: TEST_ACTOR
    });
    await service.reviewDeferred({
      action: "resolve",
      projectId: "project-1",
      deferredId: source.deferred.id,
      outcome: "superseded",
      reason: "Handled before start",
      actor: TEST_ACTOR
    });

    await expect(
      service.checkStartGate({
        projectId: "project-1",
        versionId: "version-2",
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({
      allowed: true,
      dueDeferredIds: [],
      blockedConstraintIds: []
    });
  });

  it("allows a routed Deferred at close and blocks an invalid route", async () => {
    const snapshot = createSnapshot();
    snapshot.versions[0]!.state = "complete";
    const { service, storage } = createService(snapshot);
    const source = await deferNew(service);
    await service.recordConstraint({
      projectId: "project-1",
      rule: "Active alone does not block close",
      rationale: "Only explicit checks can block",
      scope: { type: "project" },
      actor: TEST_ACTOR
    });
    const residualAudit = { status: "reviewed" as const, items: [] };

    await expect(
      service.checkCloseGate({
        projectId: "project-1",
        versionId: "version-1",
        residualAudit,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({
      allowed: true,
      unresolvedDeferredIds: [],
      blockedConstraintIds: []
    });

    await storage.mutate((current) => {
      current.deferredItems[0]!.targetReviewVersionId = "version-1";
    });
    const invalid = await service.checkCloseGate({
      projectId: "project-1",
      versionId: "version-1",
      residualAudit,
      actor: TEST_ACTOR
    });
    expect(invalid.allowed).toBe(false);
    expect(invalid.unresolvedDeferredIds).toEqual([source.deferred.id]);
    expect(invalid.blockers.map((blocker) => blocker.code)).toContain(
      "DEFERRED_ROUTE_TARGET_SELF"
    );
  });

  it("uses the real close gate in current context and never recommends close for an invalid Deferred route", async () => {
    const snapshot = createSnapshot();
    snapshot.versions[0]!.state = "complete";
    const { service, storage } = createService(snapshot);
    const source = await deferNew(service);

    await expect(
      service.getCurrentContext({
        projectId: "project-1"
      })
    ).resolves.toMatchObject({
      data: {
        unresolvedDeferredIds: [],
        blockedConstraintIds: [],
        gates: {
          close: {
            allowed: false,
            unresolvedDeferredIds: [],
            blockedConstraintIds: []
          }
        },
        nextAction: {
          actionType: "review_residual_audit"
        }
      }
    });

    await storage.mutate((current) => {
      current.deferredItems[0]!.targetReviewVersionId = "version-1";
    });

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    expect(context).toMatchObject({
      data: {
        unresolvedDeferredIds: [source.deferred.id],
        gates: {
          close: {
            allowed: false,
            unresolvedDeferredIds: [source.deferred.id]
          }
        },
        nextAction: {
          actionType: "review_deferred"
        }
      }
    });
    expect(nextAction).toMatchObject({
      data: {
        unresolvedDeferredIds: [source.deferred.id],
        nextAction: {
          actionType: "review_deferred"
        }
      }
    });
    expect(nextAction.data.nextAction.actionType).not.toBe("close_version");
  });

  it("propagates due Deferred IDs through context, transition dry-run, and transition guide", async () => {
    const snapshot = createSnapshot();
    snapshot.versions[0]!.state = "close";
    const { service } = createService(snapshot);
    const source = await deferNew(service);

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const transition = await service.transitionVersion({
      projectId: "project-1",
      versionId: "version-2",
      mode: "dry_run",
      actor: TEST_ACTOR
    });
    const guide = await service.getVersionTransitionGuide({
      projectId: "project-1",
      fromVersionId: "version-1",
      targetVersionId: "version-2"
    });

    expect(context).toMatchObject({
      data: {
        dueDeferredIds: [source.deferred.id],
        blockedConstraintIds: [],
        gates: {
          start: {
            allowed: false,
            dueDeferredIds: [source.deferred.id],
            blockedConstraintIds: []
          }
        },
        nextAction: {
          actionType: "review_deferred"
        }
      }
    });
    expect(nextAction).toMatchObject({
      data: {
        dueDeferredIds: [source.deferred.id],
        nextAction: {
          actionType: "review_deferred"
        }
      }
    });
    expect(transition).toMatchObject({
      status: "blocked",
      dueDeferredIds: [source.deferred.id],
      blockedConstraintIds: []
    });
    expect(guide.startGate).toMatchObject({
      dueDeferredIds: [source.deferred.id],
      blockedConstraintIds: []
    });
  });
});
