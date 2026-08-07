import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter, createPreparedProject, createApprovedArtifact, startPreparedVersion, closeVersionThroughL3, completeCurrentVersion, createCommittedVersion } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("summarizeVersionCloseout 鍦?open todo 闃诲 close 鏃惰繑鍥?controller-facing 鎽樿骞跺缓璁?close_todo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    let todoId = "";
    const prepared = await completeCurrentVersion(service, storage, async ({ projectId, versionId }) => {
      const created = await service.createTodo({
        projectId,
        versionId,
        title: "Finish closeout note",
        description: "controller should see this open todo",
        actor: TEST_ACTOR
      });
      todoId = created.todo.id;
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId
    });
    const data = summary.data as {
      projectId: string;
      version: { id: string; state: string; isCurrent: boolean };
      canClose: boolean;
      closeGate: {
        ok: boolean;
        blockers: Array<{ code: string }>;
        unresolvedTodoIds: string[];
      };
      openTodos: Array<{ id: string; title: string }>;
      nextAction: {
        actionType: string;
        recommendedTool: string | null;
        targetId: string | null;
      };
    };

    expect(data.projectId).toBe(prepared.projectId);
    expect(data.version).toMatchObject({
      id: prepared.versionId,
      state: "complete",
      isCurrent: true
    });
    expect(data.canClose).toBe(false);
    expect(data.closeGate.ok).toBe(false);
    expect(data.closeGate.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["OPEN_TODOS"])
    );
    expect(data.closeGate.unresolvedTodoIds).toEqual([todoId]);
    expect(data.openTodos).toEqual([
      expect.objectContaining({
        id: todoId,
        title: "Finish closeout note"
      })
    ]);
    expect(data.nextAction).toMatchObject({
      actionType: "close_todo",
      recommendedTool: "close_todo",
      targetId: todoId
    });
  });

  it("summarizeVersionCloseout 鍦?open undo 闃诲 close 鏃跺垪鍑?openUndos 骞朵繚瀹堝缓璁?close_undo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    let undoId = "";
    const prepared = await completeCurrentVersion(service, storage, async ({ projectId, versionId }) => {
      const created = await service.createUndo({
        projectId,
        versionId,
        originVersionId: versionId,
        preferredResolutionVersionId: versionId,
        title: "Resolve QA routeback",
        reason: "QA flagged downstream mismatch",
        description: "controller should see this undo",
        actor: TEST_ACTOR
      });
      undoId = created.undo.id;
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = summary.data as {
      canClose: boolean;
      closeGate: {
        ok: boolean;
        blockers: Array<{ code: string }>;
        unresolvedUndoIds: string[];
      };
      openUndos: Array<{ id: string; title: string }>;
      nextAction: {
        actionType: string;
        recommendedTool: string | null;
        targetId: string | null;
      };
    };

    expect(data.canClose).toBe(false);
    expect(data.closeGate.ok).toBe(false);
    expect(data.closeGate.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["OPEN_UNDOS"])
    );
    expect(data.closeGate.unresolvedUndoIds).toEqual([undoId]);
    expect(data.openUndos).toEqual([
      expect.objectContaining({
        id: undoId,
        title: "Resolve QA routeback"
      })
    ]);
    expect(data.nextAction).toMatchObject({
      actionType: "close_undo",
      recommendedTool: "close_undo",
      targetId: undoId
    });
  });

  it("summarizeVersionCloseout 瀵?complete 涓?close-ready 鐨?version 鎺ㄨ崘璧?close_version propose flow", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = summary.data as {
      canClose: boolean;
      closeGate: {
        ok: boolean;
        blockers: Array<{ code: string }>;
      };
      nextAction: {
        actionType: string;
        recommendedTool: string | null;
        mode?: string;
        targetId: string | null;
      };
    };

    expect(data.canClose).toBe(false);
    expect(data.closeGate.ok).toBe(false);
    expect(data.closeGate.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })])
    );
    expect(data.nextAction).toMatchObject({
      actionType: "review_residual_audit",
      recommendedTool: "check_close_gate",
      targetId: prepared.versionId
    });
    expect(summary.meta).toMatchObject({
      eventLimit: 10,
      relatedPendingOperationCount: 1,
      residualAuditSource: "missing",
      residualAuditProposalId: null
    });
  });

  it("summarizeVersionCloseout 杩斿洖 reopen 鍘嗗彶涓庢渶杩?reopen 浜嬩欢/鍘熷洜", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);

    const reopenProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "reopen_version",
      targetId: prepared.versionId,
      reason: "reopen after QA routeback",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, reopenProposal.id);

    await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: reopenProposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      eventLimit: 3
    });
    const data = summary.data as {
      reopenSummary: {
        hasReopened: boolean;
        count: number;
        latestReason: string | null;
        latestEvent: { eventType: string; targetId: string } | null;
      };
      recentEvents: Array<{ eventType: string; targetType: string }>;
    };

    expect(data.reopenSummary).toMatchObject({
      hasReopened: true,
      count: 1,
      latestReason: "reopen after QA routeback",
      latestEvent: {
        eventType: "version.state_changed",
        targetId: prepared.versionId
      }
    });
    expect(data.recentEvents).toHaveLength(3);
    expect(data.recentEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["pending_operation.committed", "version.state_changed"])
    );
  });

  it("summarizeVersionCloseout 瀵瑰凡 close version 涓嶅啀寤鸿缁х画 close", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = summary.data as {
      version: { state: string };
      canClose: boolean;
      closeGate: { ok: boolean };
      nextAction: {
        actionType: string;
        recommendedTool: string | null;
        targetId: string | null;
      };
    };

    expect(data.version.state).toBe("close");
    expect(data.canClose).toBe(false);
    expect(data.closeGate.ok).toBe(true);
    expect(data.nextAction).toMatchObject({
      actionType: "none",
      recommendedTool: null,
      targetId: null
    });
  });

  it("planVersionCloseout 瀵瑰凡 close version 杩斿洖 no_op锛屼笖 summary.canClose=false", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      summary: { canClose: boolean };
      steps: Array<{ kind: string; recommendedTool: string | null }>;
    };

    expect(data.status).toBe("no_op");
    expect(data.summary.canClose).toBe(false);
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "no_op",
        recommendedTool: null
      })
    ]);
  });

  it("planVersionCloseout 鍦?open todo 鏃跺垪鍑?close_todo step锛屼笖涓嶇户缁缓璁?close_version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    let todoId = "";
    const prepared = await completeCurrentVersion(service, storage, async ({ projectId, versionId }) => {
      const created = await service.createTodo({
        projectId,
        versionId,
        title: "Finish closeout note",
        description: "controller should close this first",
        actor: TEST_ACTOR
      });
      todoId = created.todo.id;
    });

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      steps: Array<{ kind: string; targetId: string | null }>;
    };

    expect(data.status).toBe("blocked");
    expect(data.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "close_todo",
          targetId: todoId
        })
      ])
    );
    expect(data.steps.map((step) => step.kind)).not.toContain("close_version");
  });

  it("planVersionCloseout 鍦?open undo 鏃跺垪鍑?close_undo step锛屽苟鎻愰啋鍙汉宸ユ敼璧?carry_forward_undo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    let undoId = "";
    const prepared = await completeCurrentVersion(service, storage);
    const downstreamVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Downstream Version",
      "ordinary undo target"
    );

    const created = await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: downstreamVersionId,
      title: "Resolve QA routeback",
      reason: "QA flagged downstream mismatch",
      description: "controller should decide how to route this undo",
      actor: TEST_ACTOR
    });
    undoId = created.undo.id;

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      warnings: string[];
      steps: Array<{ kind: string; targetId: string | null }>;
    };

    expect(data.status).toBe("blocked");
    expect(data.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "close_undo",
          targetId: undoId
        })
      ])
    );
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("carry_forward_undo")])
    );
  });

  it("planVersionCloseout 鍦?running 涓旀棤 open blocker 鏃跺缓璁?mark_version_complete", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);

    await startPreparedVersion(service, prepared.projectId, prepared.versionId);

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      warnings: string[];
      steps: Array<{
        kind: string;
        recommendedTool: string | null;
        targetId: string | null;
      }>;
    };

    expect(data.status).toBe("ready_to_complete");
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "mark_version_complete",
        recommendedTool: "mark_version_complete",
        targetId: prepared.versionId
      })
    ]);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("plan_version_closeout")])
    );
  });

  it("planVersionCloseout 鍦?complete 涓?close-ready 鏃剁粰鍑?close proposal -> approve -> commit 椤哄簭璁″垝", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      steps: Array<{
        kind: string;
        requiredInputs: Array<{ field: string; value: unknown }>;
      }>;
    };

    expect(data.status).toBe("blocked");
    expect(data.steps.map((step) => step.kind)).toEqual(["review_residual_audit"]);
    expect(data.steps[0]?.requiredInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "residualAudit",
          value: { status: "reviewed", items: [] }
        })
      ])
    );
  });

  it("planVersionCloseout 鍦ㄥ瓨鍦?pending proposal 鏃朵紭鍏堣姹?review_pending_proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const proposal = await service.closeVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      mode: "propose",
      residualAudit: [
        {
          kind: "debt",
          summary: "none",
          destination: "close"
        }
      ],
      actor: TEST_ACTOR
    });

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const data = plan.data as {
      status: string;
      steps: Array<{ kind: string; targetId: string | null }>;
    };

    expect(proposal.pendingOperationId).toBeTruthy();
    expect(data.status).toBe("needs_pending_decision");
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "review_pending_proposal",
        targetId: proposal.pendingOperationId
      })
    ]);
    expect(plan.meta).toMatchObject({
      eventLimit: 10,
      relatedPendingOperationCount: 2,
      residualAuditSource: "proposal_payload",
      residualAuditProposalId: proposal.pendingOperationId
    });
  });

});
