import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies, createProjectFixture, createTodoFixture, createUndoFixture, createVersionFixture } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("空路线 context 明确建议创建首个真实 Version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "Empty Route",
      contentLocale: "zh-CN",
      firstVersion: null,
      actor: TEST_ACTOR
    });

    const context = await service.getCurrentContext({ projectId: created.project.id });
    expect(context.data).toMatchObject({
      project: { currentVersionId: null },
      currentVersion: null,
      versions: [],
      statusRisks: [{ code: "ROUTE_EMPTY", severity: "info" }],
      nextAction: {
        actionType: "create_version",
        targetId: null,
        requiresL3Approval: true
      }
    });
  });

  it("getCurrentContext 浼氭毚闇插叡浜?statusRisks锛屽苟浼樺厛鎻愮ず pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-1",
      title: "V2.6",
      state: "complete",
      isCurrent: true,
      order: 1
    });
    const probeVersion = createVersionFixture({
      id: "version-probe",
      title: "_probe top-level A",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });
    const nextVersion = createVersionFixture({
      id: "version-2",
      title: "V3",
      state: "wait",
      isCurrent: false,
      order: 3,
      previousVersionId: probeVersion.id
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, probeVersion, nextVersion],
      workItems: [],
      todos: [
        createTodoFixture({
          id: "todo-1",
          projectId: "project-1",
          versionId: currentVersion.id,
          status: "wait"
        })
      ],
      undos: [
        createUndoFixture({
          id: "undo-1",
          projectId: "project-1",
          versionId: currentVersion.id,
          originVersionId: currentVersion.id,
          preferredResolutionVersionId: currentVersion.id,
          status: "wait"
        })
      ],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [
        {
          id: "pending-1",
          projectId: "project-1",
          actionType: "close_version",
          targetId: currentVersion.id,
          status: "pending",
          reason: "close current version",
          gateSnapshot: {
            kind: "close",
            evaluatedAt: "2026-06-27T00:00:00.000Z",
            allowed: false,
            blockers: [],
            unresolvedTodoIds: ["todo-1"],
            unresolvedUndoIds: ["undo-1"],
            unresolvedDeferredIds: [],
            blockedConstraintIds: [],
            residualAudit: []
          },
          digest: {
            algorithm: "sha256",
            value: "digest-1",
            payload: {}
          },
          payload: {},
          createdBy: TEST_ACTOR,
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:00:00.000Z",
          committedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          approvalArtifactId: null
        }
      ],
      approvalArtifacts: []
    });

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const data = context.data as {
      versions: Array<{ id: string; isDiagnostic: boolean }>;
      statusRisks: Array<{ code: string }>;
      nextAction: { actionType: string; targetId: string | null };
      nextVersion: { id: string } | null;
    };
    const meta = context.meta as {
      versionWindow: {
        aroundVersionId: string | null;
        includedCount: number;
        omittedBeforeCount: number;
        omittedAfterCount: number;
      };
    };

    expect(data.statusRisks.map((risk) => risk.code)).toEqual(
      expect.arrayContaining([
        "CURRENT_VERSION_COMPLETE_NOT_CLOSED",
        "OPEN_TODOS_BLOCK_CLOSE",
        "LEGACY_WORK_BLOCKS_CLOSE",
        "PENDING_L3_PROPOSAL_NEEDS_DECISION",
        "DIAGNOSTIC_VERSION_NOISE"
      ])
    );
    expect(data.nextVersion?.id).toBe("version-probe");
    expect(data.versions.find((version) => version.id === "version-probe")).toMatchObject({
      isDiagnostic: true
    });
    expect(data.nextAction).toMatchObject({
      actionType: "review_pending_proposal",
      targetId: "pending-1"
    });
    expect(meta.versionWindow).toMatchObject({
      aroundVersionId: "version-1",
      includedCount: 3,
      omittedBeforeCount: 0,
      omittedAfterCount: 0
    });
  });

  it("getNextAction 涓嶈烦杩?immediate diagnostic next锛屼笖 blockingRiskCodes 鍙繑鍥?blocking risk", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-1",
      title: "V2.6",
      state: "close",
      isCurrent: true,
      order: 1
    });
    const probeVersion = createVersionFixture({
      id: "version-probe",
      title: "_probe child under initial",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });
    const nextVersion = createVersionFixture({
      id: "version-2",
      title: "V3",
      state: "ready",
      isCurrent: false,
      order: 3,
      previousVersionId: probeVersion.id
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, probeVersion, nextVersion],
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

    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const data = nextAction.data as {
      statusRisks: Array<{ code: string }>;
      nextVersion: { id: string } | null;
      nextAction: {
        actionType: string;
        targetId: string | null;
        requiresL3Approval: boolean;
        blockingRiskCodes: string[];
      };
    };

    expect(data.statusRisks.map((risk) => risk.code)).toContain(
      "CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING"
    );
    expect(data.nextVersion?.id).toBe("version-probe");
    expect(data.nextAction).toMatchObject({
      actionType: "prepare_version",
      targetId: "version-probe",
      requiresL3Approval: false
    });
    expect(data.nextAction.blockingRiskCodes).toEqual([]);
  });

  it("fresh current wait version recommends prepare_version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-fresh",
      title: "V1.0",
      state: "wait",
      isCurrent: true,
      order: 1
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion],
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

    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const data = nextAction.data as {
      nextAction: {
        actionType: string;
        targetId: string | null;
        requiresL3Approval: boolean;
        recordIds: string[];
        blockingRiskCodes: string[];
      };
    };

    expect(data.nextAction).toMatchObject({
      actionType: "prepare_version",
      targetId: currentVersion.id,
      requiresL3Approval: false,
      recordIds: [currentVersion.id],
      blockingRiskCodes: []
    });
  });

  it("running current version recommends deterministic current Todo and scopes route Todos", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-running",
      title: "V1.0",
      state: "running",
      isCurrent: true,
      order: 1,
      nextVersionId: "version-future"
    });
    const futureVersion = createVersionFixture({
      id: "version-future",
      title: "V2.0",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });
    const currentTodo = createTodoFixture({
      id: "todo-current",
      versionId: currentVersion.id,
      title: "Implement current slice",
      status: "wait"
    });
    const futureTodo = createTodoFixture({
      id: "todo-future",
      versionId: futureVersion.id,
      title: "Implement future slice",
      status: "wait"
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, futureVersion],
      workItems: [],
      todos: [currentTodo, futureTodo],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    const context = await service.getCurrentContext({ projectId: "project-1" });
    const nextAction = await service.getNextAction({ projectId: "project-1" });

    expect(context.data).toMatchObject({
      currentTodos: [{ id: currentTodo.id, versionId: currentVersion.id }],
      todos: [
        { id: currentTodo.id, versionId: currentVersion.id },
        { id: futureTodo.id, versionId: futureVersion.id }
      ],
      todoScopes: {
        todos: "all_open_route",
        currentTodos: "current_version_open"
      },
      nextAction: {
        actionType: "work_todo",
        targetId: currentTodo.id,
        recordIds: [currentTodo.id]
      }
    });
    expect(nextAction.data).toMatchObject({
      currentTodos: [{ id: currentTodo.id }],
      nextAction: {
        actionType: "work_todo",
        targetId: currentTodo.id
      }
    });
  });

  it("closed current version does not expose a pre-close gate", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-closed",
      title: "V1.0",
      state: "close",
      isCurrent: true,
      order: 1,
      closedAt: "2026-08-10T00:00:00.000Z"
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion],
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

    const context = await service.getCurrentContext({ projectId: "project-1" });

    expect(context.data).toMatchObject({
      currentVersion: { id: currentVersion.id, state: "close" },
      gates: { close: null }
    });
  });

  it("current ready version with an allowed start gate recommends start_version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-ready",
      title: "V1.0",
      state: "ready",
      isCurrent: true,
      order: 1
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion],
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

    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const data = nextAction.data as {
      gates: { start: { allowed: boolean } | null };
      nextAction: {
        actionType: string;
        targetId: string | null;
        requiresL3Approval: boolean;
        recordIds: string[];
        blockingRiskCodes: string[];
      };
    };

    expect(data.gates.start).toMatchObject({ allowed: true });
    expect(data.nextAction).toMatchObject({
      actionType: "start_version",
      targetId: currentVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id],
      blockingRiskCodes: []
    });
  });

  it("鍞竴 running version 涓?current 鎸囬拡婕傜Щ鏃讹紝context 鎶ラ闄╀笖 next_action 寤鸿璧?L3 set_current_version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-40",
      title: "V4.0",
      state: "close",
      isCurrent: true,
      order: 1
    });
    const waitVersion = createVersionFixture({
      id: "version-41",
      title: "V4.1",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });
    const readyVersion = createVersionFixture({
      id: "version-42",
      title: "V4.2",
      state: "ready",
      isCurrent: false,
      order: 3,
      previousVersionId: waitVersion.id
    });
    const runningVersion = createVersionFixture({
      id: "version-43",
      title: "V4.3",
      state: "running",
      isCurrent: false,
      order: 4,
      previousVersionId: readyVersion.id
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, waitVersion, readyVersion, runningVersion],
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

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const contextData = context.data as {
      statusRisks: Array<{ code: string }>;
      nextAction: { actionType: string; targetId: string | null };
    };
    const nextActionData = nextAction.data as {
      nextAction: {
        actionType: string;
        targetId: string | null;
        requiresL3Approval: boolean;
      };
    };
    const riskCodes = contextData.statusRisks.map((risk) => risk.code);

    expect(riskCodes).toContain("CURRENT_POINTER_DRIFT_RUNNING_VERSION");
    expect(riskCodes.indexOf("CURRENT_POINTER_DRIFT_RUNNING_VERSION")).toBeLessThan(
      riskCodes.indexOf("CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING")
    );
    expect(contextData.nextAction).toMatchObject({
      actionType: "set_current_version",
      targetId: "version-43"
    });
    expect(nextActionData.nextAction).toMatchObject({
      actionType: "set_current_version",
      targetId: "version-43",
      requiresL3Approval: true
    });
  });

  it("current 宸叉纭寚鍚?running version 鏃朵笉鎶ュ憡 current pointer drift", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-43",
      title: "V4.3",
      state: "running",
      isCurrent: true,
      order: 1
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion],
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

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const data = context.data as {
      statusRisks: Array<{ code: string }>;
    };

    expect(data.statusRisks.map((risk) => risk.code)).not.toContain(
      "CURRENT_POINTER_DRIFT_RUNNING_VERSION"
    );
  });

  it("娌℃湁 running version 鏃朵笉璇姤 current pointer drift", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-40",
      title: "V4.0",
      state: "close",
      isCurrent: true,
      order: 1
    });
    const nextVersion = createVersionFixture({
      id: "version-41",
      title: "V4.1",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, nextVersion],
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

    const context = await service.getCurrentContext({
      projectId: "project-1"
    });
    const data = context.data as {
      statusRisks: Array<{ code: string }>;
    };

    expect(data.statusRisks.map((risk) => risk.code)).not.toContain(
      "CURRENT_POINTER_DRIFT_RUNNING_VERSION"
    );
  });

  it("澶氫釜 running version 鏃朵笉鑷姩缁欏嚭鍗曚竴 set_current_version target", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const currentVersion = createVersionFixture({
      id: "version-40",
      title: "V4.0",
      state: "close",
      isCurrent: true,
      order: 1
    });
    const waitVersion = createVersionFixture({
      id: "version-41",
      title: "V4.1",
      state: "wait",
      isCurrent: false,
      order: 2,
      previousVersionId: currentVersion.id
    });
    const runningVersionA = createVersionFixture({
      id: "version-42",
      title: "V4.2",
      state: "running",
      isCurrent: false,
      order: 3,
      previousVersionId: waitVersion.id
    });
    const runningVersionB = createVersionFixture({
      id: "version-43",
      title: "V4.3",
      state: "running",
      isCurrent: false,
      order: 4,
      previousVersionId: runningVersionA.id
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: currentVersion.id
      }),
      versions: [currentVersion, waitVersion, runningVersionA, runningVersionB],
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

    const nextAction = await service.getNextAction({
      projectId: "project-1"
    });
    const data = nextAction.data as {
      statusRisks: Array<{ code: string }>;
      nextAction: { actionType: string; targetId: string | null };
    };

    expect(data.statusRisks.map((risk) => risk.code)).not.toContain(
      "CURRENT_POINTER_DRIFT_RUNNING_VERSION"
    );
    expect(data.nextAction).toMatchObject({
      actionType: "none",
      targetId: null
    });
  });

});
