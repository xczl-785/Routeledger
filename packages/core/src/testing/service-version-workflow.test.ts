import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies, createUndoFixture, createVersionFixture } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter, FailOnSaveStorageAdapter, LossyPendingOperationStorageAdapter, MissingPendingOperationStorageAdapter, legacyStartDigestValue, createPreparedProject, createApprovedArtifact, startPreparedVersion, closeVersionThroughL3, completeCurrentVersion, createCommittedVersion, createUnresolvedDeferredForCloseout, expectConfirmationRequired } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("markVersionComplete reports the remaining close blockers without rejecting completion", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    const todo = await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "Still open at completion",
      actor: TEST_ACTOR
    });

    const completed = await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });

    expect(completed).toMatchObject({
      version: { state: "complete" },
      closeReadiness: {
        allowed: false,
        unresolvedTodoIds: [todo.todo.id],
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "OPEN_TODOS" }),
          expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })
        ])
      },
      warnings: [
        expect.objectContaining({
          code: "VERSION_COMPLETE_CLOSE_BLOCKED",
          recommendedTool: "check_close_gate"
        })
      ]
    });
  });

  it("markVersionComplete derives close readiness without reloading after the write", async () => {
    class FailOnSecondLoadStorageAdapter extends MemoryStorageAdapter {
      private armed = false;
      private loadCount = 0;

      arm(): void {
        this.armed = true;
        this.loadCount = 0;
      }

      override async loadProjectAggregate(projectId: string) {
        if (this.armed && this.loadCount++ > 0) {
          throw new Error("unexpected aggregate reload after completion write");
        }

        return super.loadProjectAggregate(projectId);
      }
    }

    const storage = new FailOnSecondLoadStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    storage.arm();

    const completed = await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });

    expect(completed).toMatchObject({
      version: { state: "complete" },
      closeReadiness: { allowed: false }
    });
  });

  it("initProject can atomically create an explicit first Version and its initial Todos", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });

    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: {
        title: "Define the first delivery",
        description: "A real route node selected by the user",
        initialTodos: ["Confirm scope", "Record acceptance"]
      },
      actor: TEST_ACTOR
    });

    expect(created.firstVersion).toMatchObject({
      title: "Define the first delivery",
      description: "A real route node selected by the user",
      state: "wait",
      isCurrent: true
    });
    expect(created.todos.map((todo) => todo.title)).toEqual([
      "Confirm scope",
      "Record acceptance"
    ]);
    expect(created.workItems).toHaveLength(2);
    expect(created.project.currentVersionId).toBe(created.firstVersion!.id);

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.versions).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(2);
    expect(snapshot?.workItems).toHaveLength(2);
  });

  it("create_version turns an empty route into its first current Version in one approved commit", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Empty Route",
      firstVersion: null,
      actor: TEST_ACTOR
    });
    const details = await expectConfirmationRequired(
      service.createVersion({
        projectId: created.project.id,
        title: "First delivery",
        description: "The first real route node",
        actor: TEST_ACTOR
      })
    );

    expect(details.proposal.payload).toMatchObject({ setAsCurrent: true });
    const artifact = await createApprovedArtifact(
      service,
      created.project.id,
      details.pendingOperationId
    );
    const committed = await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: details.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(created.project.id);

    expect(snapshot?.project.currentVersionId).toBe(details.proposal.targetId);
    expect(snapshot?.versions).toEqual([
      expect.objectContaining({
        id: details.proposal.targetId,
        title: "First delivery",
        state: "wait",
        isCurrent: true
      })
    ]);
    expect(snapshot?.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["version.created", "project.current_version_changed"])
    );
    expect(committed.replayed).toBe(false);
    await expect(
      service.commitL3Operation({
        projectId: created.project.id,
        pendingOperationId: details.pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

  it("create_version appends after a closed top-level tail without reopening or replacing current history", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Closed Tail Route",
      firstVersion: {
        title: "Delivered Version",
        description: "Already closed history",
        initialTodos: []
      },
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

    const details = await expectConfirmationRequired(
      service.createVersion({
        projectId: created.project.id,
        title: "Next delivery",
        description: "Continue the route without reopening history",
        actor: TEST_ACTOR
      })
    );
    expect(details.proposal).toMatchObject({
      actionType: "create_version",
      payload: {
        parentVersionId: null,
        previousVersionId: created.firstVersion!.id,
        nextVersionId: null
      }
    });

    const artifact = await createApprovedArtifact(
      service,
      created.project.id,
      details.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: details.pendingOperationId,
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
      nextVersionId: details.proposal.targetId
    });
    expect(versions[1]).toMatchObject({
      id: details.proposal.targetId,
      title: "Next delivery",
      state: "wait",
      isCurrent: false,
      previousVersionId: created.firstVersion!.id,
      nextVersionId: null
    });
    expect(snapshot?.project.currentVersionId).toBe(created.firstVersion!.id);
    expect(snapshot?.events).toContainEqual(
      expect.objectContaining({
        targetId: created.firstVersion!.id,
        eventType: "version.successor_appended",
        metadata: expect.objectContaining({ appendOnlyAfterClosedTail: true })
      })
    );
  });

  it("fails proposal creation immediately and rolls back when persisted payload bytes change its digest", async () => {
    const storage = new LossyPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Empty Route",
      firstVersion: null,
      actor: TEST_ACTOR
    });

    await expect(
      service.createVersion({
        projectId: created.project.id,
        title: "First delivery",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "PENDING_OPERATION_PERSISTENCE_MISMATCH" });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toEqual([]);
    expect(
      snapshot?.events.filter(
        (event) => event.eventType === "pending_operation.proposed"
      )
    ).toEqual([]);
  });

  it("rolls back the proposal event when persistence drops the complete pending operation", async () => {
    const storage = new MissingPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Empty Route",
      firstVersion: null,
      actor: TEST_ACTOR
    });

    await expect(
      service.createVersion({
        projectId: created.project.id,
        title: "First delivery",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: { rollbackStatus: "rolled_back", persistedDigest: null }
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toEqual([]);
    expect(
      snapshot?.events.filter(
        (event) => event.eventType === "pending_operation.proposed"
      )
    ).toEqual([]);
  });

  it("advance_to_version atomically switches a closed current Version and starts its direct successor", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next delivery"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);

    const workflow = await service.advanceToVersion({
      projectId: prepared.projectId,
      fromVersionId: prepared.versionId,
      versionId: targetVersionId,
      reason: "continue the approved route",
      actor: TEST_ACTOR
    });
    expect(workflow).toMatchObject({
      status: "confirmation_required",
      allowed: true,
      projectId: prepared.projectId,
      versionId: targetVersionId,
      fromVersionId: prepared.versionId,
      pendingOperationId: expect.any(String),
      digest: expect.any(String),
      humanReviewText: expect.any(String),
      recommendedNextActions: [
        {
          action: "approve",
          tool: "approve_l3_operation",
          input: {
            projectId: prepared.projectId,
            pendingOperationId: expect.any(String)
          }
        },
        {
          action: "reject",
          tool: "reject_l3_operation",
          input: {
            projectId: prepared.projectId,
            pendingOperationId: expect.any(String)
          },
          requiredInputs: ["reason"]
        }
      ]
    });
    if (workflow.status !== "confirmation_required") {
      throw new Error("expected advance confirmation workflow");
    }
    const proposal = await service.getL3Proposal(
      prepared.projectId,
      workflow.pendingOperationId
    );
    expect(proposal).toMatchObject({
      actionType: "advance_to_version",
      targetId: targetVersionId,
      payload: { fromVersionId: prepared.versionId }
    });
    expect(workflow.digest).toBe(proposal.digest.value);
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      workflow.pendingOperationId
    );
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: workflow.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    const currentChanged = snapshot?.events.slice().reverse().find(
      (event) => event.eventType === "project.current_version_changed"
    );
    const targetStarted = snapshot?.events.slice().reverse().find(
      (event) =>
        event.eventType === "version.state_changed" &&
        event.targetId === targetVersionId &&
        event.toState === "running"
    );

    expect(snapshot?.project.currentVersionId).toBe(targetVersionId);
    expect(snapshot?.versions.find((version) => version.id === prepared.versionId)).toMatchObject({
      state: "close",
      isCurrent: false
    });
    expect(snapshot?.versions.find((version) => version.id === targetVersionId)).toMatchObject({
      state: "running",
      isCurrent: true
    });
    expect(currentChanged?.operationId).toBe(targetStarted?.operationId);
    expect(currentChanged?.operationSeq).toBeLessThan(targetStarted!.operationSeq);
    expect(committed).toMatchObject({ replayed: false });
    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: workflow.pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

  it("advance_to_version leaves the entire route and approval state unchanged when persistence fails", async () => {
    const storage = new FailOnSaveStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next delivery"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);
    const details = await service.advanceToVersion({
      projectId: prepared.projectId,
      fromVersionId: prepared.versionId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    if (details.status !== "confirmation_required") {
      throw new Error("expected advance confirmation workflow");
    }
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      details.pendingOperationId
    );
    const beforeCommit = await storage.loadProjectAggregate(prepared.projectId);
    storage.failOnce();

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: details.pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toThrow("injected save failure");
    expect(await storage.loadProjectAggregate(prepared.projectId)).toEqual(beforeCommit);
  });

  it("advance_to_version records closed-current and direct-successor blockers and cannot partially commit", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    await createCommittedVersion(service, prepared.projectId, "Immediate successor");
    const laterVersionId = await createCommittedVersion(service, prepared.projectId, "Later successor");
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: laterVersionId,
      actor: TEST_ACTOR
    });

    const beforeBlockedAdvance = await storage.loadProjectAggregate(
      prepared.projectId
    );
    const blocked = await service.advanceToVersion({
      projectId: prepared.projectId,
      fromVersionId: prepared.versionId,
      versionId: laterVersionId,
      actor: TEST_ACTOR
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      allowed: false,
      fromVersionId: prepared.versionId,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "CURRENT_VERSION_NOT_CLOSED" }),
        expect.objectContaining({ code: "TARGET_VERSION_NOT_NEXT" })
      ])
    });
    expect(
      (await storage.loadProjectAggregate(prepared.projectId))?.pendingOperations
    ).toEqual(beforeBlockedAdvance?.pendingOperations);

    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "advance_to_version",
      targetId: laterVersionId,
      reason: "invalid shortcut",
      payload: { fromVersionId: prepared.versionId },
      actor: TEST_ACTOR
    });

    expect(proposal.gateSnapshot.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["CURRENT_VERSION_NOT_CLOSED", "TARGET_VERSION_NOT_NEXT"])
    );
    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    const beforeCommit = await storage.loadProjectAggregate(prepared.projectId);
    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "START_GATE_FAILED" });
    expect(await storage.loadProjectAggregate(prepared.projectId)).toEqual(beforeCommit);
  });

  it("advance_to_version rejects approval replay when the approved direct-next topology drifts", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(service, prepared.projectId, "Next delivery");
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "advance_to_version",
      targetId: targetVersionId,
      reason: "approved direct successor",
      payload: { fromVersionId: prepared.versionId },
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      versions: snapshot.versions.map((version) =>
        version.id === prepared.versionId ? { ...version, nextVersionId: null } : version
      )
    }));
    const beforeCommit = await storage.loadProjectAggregate(prepared.projectId);

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH" });
    expect(await storage.loadProjectAggregate(prepared.projectId)).toEqual(beforeCommit);
  });

  it("advance_to_version reports a due Deferred without creating cleanup proposal noise", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Deferred review target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    await service.deferWork({
      mode: "new",
      projectId: prepared.projectId,
      originVersionId: prepared.versionId,
      targetReviewVersionId: targetVersionId,
      title: "Review before target start",
      reason: "Exercise advance gate preflight",
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);
    const beforeAdvance = await storage.loadProjectAggregate(prepared.projectId);

    const blocked = await service.advanceToVersion({
      projectId: prepared.projectId,
      fromVersionId: prepared.versionId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      allowed: false,
      dueDeferredIds: expect.arrayContaining([expect.any(String)]),
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "DUE_DEFERRED_REQUIRES_REVIEW" })
      ])
    });
    expect(await storage.loadProjectAggregate(prepared.projectId)).toEqual(
      beforeAdvance
    );
  });

  it("transition_version 浼氭寜 live 鐘舵€佺粰鍑轰笅涓€姝ワ紝骞跺湪闇€瑕佹椂鍙垱寤哄綋鍓嶅悎娉?proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next Version",
      "transition target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    const dryRun = await service.transitionVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    expect(dryRun).toMatchObject({
      mode: "dry_run",
      status: "ready",
      nextActionType: "set_current_version",
      stepsRemaining: ["set_current_version", "start_version"],
      followUpRequired: true
    });

    const firstProposal = await service.transitionVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      mode: "propose",
      actor: TEST_ACTOR
    });

    expect(firstProposal).toMatchObject({
      status: "confirmation_required",
      proposedActionType: "set_current_version",
      pendingOperationId: expect.any(String)
    });

    const firstArtifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      firstProposal.pendingOperationId!
    );
    await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: firstProposal.pendingOperationId!,
      approvalArtifactId: firstArtifact.id,
      actor: TEST_ACTOR
    });

    const secondDryRun = await service.transitionVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    expect(secondDryRun).toMatchObject({
      status: "ready",
      nextActionType: "start_version",
      stepsRemaining: ["start_version"],
      followUpRequired: false
    });

    const secondProposal = await service.transitionVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      mode: "propose",
      actor: TEST_ACTOR
    });

    expect(secondProposal).toMatchObject({
      proposedActionType: "start_version",
      pendingOperationId: expect.any(String)
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(
      snapshot?.pendingOperations
        .filter((operation) => operation.status === "pending")
        .map((operation) => operation.actionType)
    ).toEqual(["start_version"]);
  });

  it("get_version_transition_guide 鍦?blocked close 鏃跺彧杩斿洖 blockers锛屼笉鍒涘缓 pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next Version",
      "transition target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    const guide = await service.getVersionTransitionGuide({
      projectId: prepared.projectId,
      targetVersionId
    });

    expect(guide.status).toBe("blocked");
    expect(guide.closeGate).toMatchObject({
      versionId: prepared.versionId,
      residualAuditProvided: false,
      blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
    });
    expect(guide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "close-from-version",
          status: "blocked",
          recommendedTool: "preview_or_propose_version_close",
          createsL3Proposal: true
        })
      ])
    );

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([]);
  });

  it("get_version_transition_guide 覆盖 current 自身目标的完整 lifecycle，且不创建 proposal", async () => {
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
    const projectId = created.project.id;
    const versionId = created.firstVersion!.id;

    const waitGuide = await service.getVersionTransitionGuide({
      projectId,
      targetVersionId: versionId
    });

    expect(waitGuide).toMatchObject({
      status: "ready",
      closeGate: { applicable: false, allowed: false },
      startGate: { applicable: false, allowed: false }
    });
    expect(waitGuide.recommendedSteps).toEqual([
      expect.objectContaining({
        stepId: "prepare-current-version",
        status: "ready",
        recommendedTool: "prepare_version",
        actionType: "prepare_version",
        createsL3Proposal: false
      })
    ]);

    await service.prepareVersion({ projectId, versionId, actor: TEST_ACTOR });

    const readyGuide = await service.getVersionTransitionGuide({
      projectId,
      targetVersionId: versionId
    });

    expect(readyGuide).toMatchObject({
      status: "ready",
      closeGate: { applicable: false, allowed: false },
      startGate: { applicable: true, allowed: true }
    });
    expect(readyGuide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "start-current-version",
          status: "ready",
          recommendedTool: "preview_or_propose_version_transition",
          actionType: "start_version"
        })
      ])
    );
    expect(readyGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
      "close_version"
    );

    await startPreparedVersion(service, projectId, versionId);
    const runningGuide = await service.getVersionTransitionGuide({
      projectId,
      targetVersionId: versionId
    });

    expect(runningGuide).toMatchObject({
      status: "noop",
      closeGate: { applicable: false, allowed: false },
      startGate: { applicable: false, allowed: true }
    });
    expect(runningGuide.recommendedSteps).toEqual([]);

    await service.markVersionComplete({
      projectId,
      versionId,
      actor: TEST_ACTOR
    });
    const completeGuide = await service.getVersionTransitionGuide({
      projectId,
      targetVersionId: versionId,
      residualAudit: [
        {
          kind: "debt",
          summary: "no residual work",
          destination: "close"
        }
      ]
    });

    expect(completeGuide).toMatchObject({
      status: "ready",
      closeGate: { applicable: true, allowed: true },
      startGate: { applicable: false, allowed: false }
    });
    expect(completeGuide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "close-current-version",
          status: "ready",
          recommendedTool: "preview_or_propose_version_close",
          actionType: "close_version"
        })
      ])
    );
    expect(completeGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
      "start_version"
    );

    await closeVersionThroughL3(service, projectId, versionId);
    const closedGuide = await service.getVersionTransitionGuide({
      projectId,
      targetVersionId: versionId
    });

    expect(closedGuide).toMatchObject({
      status: "noop",
      closeGate: { applicable: false, allowed: true },
      startGate: { applicable: false, allowed: false }
    });
    expect(closedGuide.recommendedSteps).toEqual([]);

    const snapshot = await storage.loadProjectAggregate(projectId);
    expect(snapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([]);
  });

  it("get_version_transition_guide resolves existing pending proposals before self ready or complete guidance", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);

    const readyPending = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "existing ready start proposal",
      actor: TEST_ACTOR
    });
    const readyGuide = await service.getVersionTransitionGuide({
      projectId: prepared.projectId,
      targetVersionId: prepared.versionId
    });

    expect(readyGuide).toMatchObject({
      status: "manual_review",
      pendingProposalIds: [readyPending.id],
      recommendedSteps: [
        expect.objectContaining({
          stepId: "review-pending-proposals",
          recommendedTool: "list_l3_proposals",
          createsL3Proposal: false
        })
      ]
    });
    expect(readyGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
      "start_version"
    );
    expect(readyGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
      "close_version"
    );

    const completeStorage = new MemoryStorageAdapter();
    const completeService = new RouteLedgerService({
      storage: completeStorage,
      deps: createTestDependencies()
    });
    const completePrepared = await createPreparedProject(completeService, completeStorage);
    await startPreparedVersion(
      completeService,
      completePrepared.projectId,
      completePrepared.versionId
    );
    await completeService.markVersionComplete({
      projectId: completePrepared.projectId,
      versionId: completePrepared.versionId,
      actor: TEST_ACTOR
    });
    const completePending = await completeService.closeVersionWorkflow({
      projectId: completePrepared.projectId,
      versionId: completePrepared.versionId,
      mode: "propose",
      residualAudit: [
        {
          kind: "debt",
          summary: "no residual work",
          destination: "close"
        }
      ],
      actor: TEST_ACTOR
    });
    const completeGuide = await completeService.getVersionTransitionGuide({
      projectId: completePrepared.projectId,
      targetVersionId: completePrepared.versionId,
      residualAudit: [
        {
          kind: "debt",
          summary: "no residual work",
          destination: "close"
        }
      ]
    });

    expect(completeGuide).toMatchObject({
      status: "manual_review",
      pendingProposalIds: [completePending.pendingOperationId],
      recommendedSteps: [
        expect.objectContaining({
          stepId: "review-pending-proposals",
          recommendedTool: "list_l3_proposals",
          createsL3Proposal: false
        })
      ]
    });
    expect(completeGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
      "close_version"
    );

    const readySnapshot = await storage.loadProjectAggregate(prepared.projectId);
    const completeSnapshot = await completeStorage.loadProjectAggregate(completePrepared.projectId);
    expect(readySnapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([
      expect.objectContaining({ id: readyPending.id })
    ]);
    expect(completeSnapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([
      expect.objectContaining({ id: completePending.pendingOperationId })
    ]);
  });

  it("get_version_transition_guide 浼氭樉绀虹洰鏍?start gate 鐨?due undo blocker", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next Version",
      "transition target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    snapshot!.undos = snapshot!.undos.concat(
      createUndoFixture({
        id: "due-undo-1",
        projectId: prepared.projectId,
        versionId: targetVersionId,
        originVersionId: targetVersionId,
        preferredResolutionVersionId: targetVersionId,
        title: "due undo",
        reason: "must resolve before start"
      })
    );
    await storage.saveProjectAggregate(snapshot!);

    const guide = await service.getVersionTransitionGuide({
      projectId: prepared.projectId,
      targetVersionId
    });

    expect(guide.status).toBe("blocked");
    expect(guide.closeGate).toMatchObject({
      applicable: false,
      allowed: true
    });
    expect(guide.startGate).toMatchObject({
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "OPEN_DUE_UNDOS" }),
        expect.objectContaining({ code: "SELF_REFERENTIAL_UNDO_BLOCKS_START" })
      ]),
      selfReferentialUndoIds: [expect.any(String)]
    });
    expect(guide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "transition-to-target",
          status: "blocked",
          recommendedTool: "propose_version_advance",
          toolInput: {
            projectId: prepared.projectId,
            fromVersionId: prepared.versionId,
            versionId: targetVersionId
          },
          requiredInputs: []
        })
      ])
    );
  });

  it("ordinary non self-referential undo stays visible as open undo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const downstreamVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Downstream Version",
      "preferred resolution target"
    );

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    snapshot!.undos = snapshot!.undos.concat(
      createUndoFixture({
        id: "ordinary-undo-1",
        projectId: prepared.projectId,
        versionId: prepared.versionId,
        originVersionId: prepared.versionId,
        preferredResolutionVersionId: downstreamVersionId,
        title: "Carry to downstream",
        reason: "next version should own it",
        description: "ordinary non self-referential undo"
      })
    );
    await storage.saveProjectAggregate(snapshot!);

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const summaryData = summary.data as {
      openUndos: Array<{ preferredResolutionVersionId: string }>;
    };

    expect(summaryData.openUndos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ preferredResolutionVersionId: downstreamVersionId })
      ])
    );
  });

  it("get_version_transition_guide 鍦?close-ready + target-ready 鏃惰繑鍥炲彧璇绘帹鑽愭楠や笖涓嶅垱寤?proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Next Version",
      "transition target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });

    const guide = await service.getVersionTransitionGuide({
      projectId: prepared.projectId,
      targetVersionId,
      residualAudit: [
        {
          kind: "debt",
          summary: "no residual work",
          destination: "close"
        }
      ]
    });

    expect(guide.status).toBe("ready");
    expect(guide.pendingProposalIds).toEqual([]);
    expect(guide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "close-from-version",
          status: "ready",
          actionType: "close_version",
          createsL3Proposal: true
        }),
        expect.objectContaining({
          stepId: "transition-to-target",
          status: "waiting",
          actionType: "set_current_version",
          createsL3Proposal: true
        }),
        expect.objectContaining({
          stepId: "start-target-after-switch",
          status: "waiting",
          actionType: "start_version",
          createsL3Proposal: true
        })
      ])
    );

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([]);
  });

  it("get_version_transition_guide does not recommend advance_to_version for a non-direct successor", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    await createCommittedVersion(service, prepared.projectId, "Immediate successor");
    const laterVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Later successor"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: laterVersionId,
      actor: TEST_ACTOR
    });
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    await closeVersionThroughL3(service, prepared.projectId, prepared.versionId);

    const guide = await service.getVersionTransitionGuide({
      projectId: prepared.projectId,
      targetVersionId: laterVersionId
    });

    expect(guide.recommendedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "transition-to-target",
          actionType: "set_current_version",
          recommendedTool: "preview_or_propose_version_transition"
        })
      ])
    );
    expect(guide.recommendedSteps.map((step) => step.recommendedTool)).not.toContain(
      "advance_to_version"
    );
  });

  it("close_version workflow 鍦?gate blocked 鏃跺彧杩斿洖 blockers锛屼笉鍒涘缓 pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });

    const result = await service.closeVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      mode: "propose",
      residualAudit: [],
      actor: TEST_ACTOR
    });

    expect(result).toMatchObject({
      mode: "propose",
      status: "blocked",
      blockers: [
        expect.objectContaining({
          code: "MISSING_RESIDUAL_AUDIT"
        })
      ]
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations.filter((operation) => operation.status === "pending")).toEqual([]);
  });

  it("get_version_structure 杩斿洖 topology銆乷pen items 涓?legal operation hints", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const siblingVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Sibling",
      "sibling target"
    );
    await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "open todo",
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    snapshot!.undos = snapshot!.undos.concat(
      createUndoFixture({
        id: "open-undo-1",
        projectId: prepared.projectId,
        versionId: prepared.versionId,
        originVersionId: prepared.versionId,
        preferredResolutionVersionId: siblingVersionId,
        title: "open undo",
        reason: "needs later handling"
      })
    );
    await storage.saveProjectAggregate(snapshot!);

    const structure = await service.getVersionStructure({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });

    expect(structure.focusVersion).toMatchObject({
      id: prepared.versionId,
      parentVersionId: null
    });
    expect(structure.siblings.map((version) => version.id)).toEqual([
      prepared.versionId,
      siblingVersionId
    ]);
    expect(structure.openTodos).toHaveLength(1);
    expect(structure.openUndos.owned).toHaveLength(1);
    expect(structure.openUndos.origin).toHaveLength(1);
    expect(structure.openUndos.preferredResolution).toEqual([]);
    expect(structure.legalOperations).toContainEqual(
      expect.objectContaining({
        actionType: "transition_version"
      })
    );
    expect(structure.legalOperations).not.toContainEqual(
      expect.objectContaining({
        actionType: "carry_forward_undo"
      })
    );
  });

  it("close_version 璧板畬鏁?L3 闂幆", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    const residualAudit = [
      {
        kind: "debt" as const,
        summary: "none",
        destination: "close" as const
      }
    ];

    await expect(
      service.closeVersion({
        projectId: prepared.projectId,
        versionId: prepared.versionId,
        residualAudit,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    let snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("complete");

    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "close_version",
      targetId: prepared.versionId,
      reason: "close current version",
      payload: {
        residualAudit
      },
      actor: TEST_ACTOR
    });
    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("complete");

    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("close");
    expect(committed.pendingOperation.status).toBe("committed");
    expect(committed.approvalArtifact.status).toBe("consumed");

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

  it("direct closeVersion uses the ordinary close gate before creating a pending proposal", async () => {
    const assertNoPendingClose = async (
      setup: (input: {
        service: RouteLedgerService;
        storage: MemoryStorageAdapter;
        projectId: string;
        versionId: string;
      }) => Promise<void>,
      residualAudit?: Parameters<RouteLedgerService["closeVersion"]>[0]["residualAudit"]
    ) => {
      const storage = new MemoryStorageAdapter();
      const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
      const prepared = await completeCurrentVersion(service, storage);
      await setup({ ...prepared, service, storage });

      await expect(
        service.closeVersion({
          projectId: prepared.projectId,
          versionId: prepared.versionId,
          residualAudit,
          actor: TEST_ACTOR
        })
      ).rejects.toMatchObject({ code: "CLOSE_GATE_FAILED" });
      expect(
        (await storage.loadProjectAggregate(prepared.projectId))?.pendingOperations.filter(
          (operation) =>
            operation.status === "pending" && operation.actionType === "close_version"
        )
      ).toEqual([]);
    };

    await assertNoPendingClose(async () => undefined);
    await assertNoPendingClose(async () => undefined, {
      status: "reviewed",
      items: [{ kind: "debt", summary: "missing destination", destination: null }]
    });
    await assertNoPendingClose(
      async ({ service, projectId, versionId }) => {
        await service.createTodo({
          projectId,
          versionId,
          title: "still open",
          actor: TEST_ACTOR
        });
      },
      { status: "reviewed", items: [] }
    );
    await assertNoPendingClose(
      async ({ service, storage, projectId, versionId }) => {
        await createUnresolvedDeferredForCloseout(service, storage, projectId, versionId);
      },
      { status: "reviewed", items: [] }
    );

    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await completeCurrentVersion(service, storage);
    const originalCheckCloseGate = service.checkCloseGate.bind(service);
    service.checkCloseGate = async () => ({
      allowed: false,
      blockers: [
        {
          code: "CONSTRAINT_VIOLATED",
          message: "constraint proof failed",
          recordIds: ["constraint-1"]
        }
      ],
      unresolvedTodoIds: [],
      unresolvedUndoIds: [],
      unresolvedDeferredIds: [],
      blockedConstraintIds: ["constraint-1"]
    });
    await expect(
      service.closeVersion({
        projectId: prepared.projectId,
        versionId: prepared.versionId,
        residualAudit: { status: "reviewed", items: [] },
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "CLOSE_GATE_FAILED" });
    service.checkCloseGate = originalCheckCloseGate;
    expect(
      (await storage.loadProjectAggregate(prepared.projectId))?.pendingOperations.filter(
        (operation) => operation.status === "pending" && operation.actionType === "close_version"
      )
    ).toEqual([]);
  });

  it("reopen_version 璧板畬鏁?L3 闂幆", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.markVersionComplete({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      actor: TEST_ACTOR
    });
    const closeProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "close_version",
      targetId: prepared.versionId,
      reason: "close current version",
      payload: {
        residualAudit: [
          {
            kind: "debt" as const,
            summary: "none",
            destination: "close" as const
          }
        ]
      },
      actor: TEST_ACTOR
    });
    const closeArtifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      closeProposal.id
    );
    await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: closeProposal.id,
      approvalArtifactId: closeArtifact.id,
      actor: TEST_ACTOR
    });

    await expect(
      service.reopenVersion({
        projectId: prepared.projectId,
        versionId: prepared.versionId,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    let snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("close");

    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "reopen_version",
      targetId: prepared.versionId,
      reason: "reopen current version",
      actor: TEST_ACTOR
    });
    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("close");

    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(committed.pendingOperation.status).toBe("committed");
    expect(committed.approvalArtifact.status).toBe("consumed");

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

  it("set_current_version 璧板畬鏁?L3 闂幆", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);

    await storage.mutate(prepared.projectId, (snapshot) => {
      const currentVersion = snapshot.versions[0]!;
      const nextVersion = createVersionFixture({
        id: "version-2",
        projectId: prepared.projectId,
        state: "ready",
        isCurrent: false,
        order: 2
      });

      return {
        ...snapshot,
        versions: [
          {
            ...currentVersion,
            state: "running",
            isCurrent: true
          },
          nextVersion
        ]
      };
    });

    await expect(
      service.setCurrentVersion({
        projectId: prepared.projectId,
        versionId: "version-2",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    let snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.project.currentVersionId).toBe(prepared.versionId);

    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "set_current_version",
      targetId: "version-2",
      reason: "switch current version",
      actor: TEST_ACTOR
    });
    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.project.currentVersionId).toBe(prepared.versionId);

    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.project.currentVersionId).toBe("version-2");
    expect(snapshot?.versions.find((version) => version.id === prepared.versionId)?.state).toBe(
      "suspend"
    );
    expect(snapshot?.versions.find((version) => version.id === "version-2")?.isCurrent).toBe(
      true
    );
    expect(committed.pendingOperation.status).toBe("committed");
    expect(committed.approvalArtifact.status).toBe("consumed");

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

  it("version tree 鍥涗釜 L3 action 鍙畬鎴?commit锛屼笖涓嶆敼鍙?current 鐪熸簮", async () => {
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

    const createDetails = await expectConfirmationRequired(
      service.createVersion({
        projectId: created.project.id,
        title: "Version 2",
        description: "top level tail",
        actor: TEST_ACTOR
      })
    );
    expect(createDetails.proposal.actionType).toBe("create_version");
    expect(createDetails.proposal.payload).toMatchObject({
      title: "Version 2",
      description: "top level tail",
      parentVersionId: null,
      previousVersionId: created.firstVersion!.id,
      nextVersionId: null,
      siblingVersionIds: [created.firstVersion!.id]
    });
    const createArtifact = await createApprovedArtifact(
      service,
      created.project.id,
      createDetails.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: createDetails.pendingOperationId,
      approvalArtifactId: createArtifact.id,
      actor: TEST_ACTOR
    });

    const insertDetails = await expectConfirmationRequired(
      service.insertVersion({
        projectId: created.project.id,
        title: "Version 1.5",
        description: "between roots",
        afterVersionId: created.firstVersion!.id,
        actor: TEST_ACTOR
      })
    );
    const insertArtifact = await createApprovedArtifact(
      service,
      created.project.id,
      insertDetails.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: insertDetails.pendingOperationId,
      approvalArtifactId: insertArtifact.id,
      actor: TEST_ACTOR
    });

    const childDetails = await expectConfirmationRequired(
      service.createChildVersion({
        projectId: created.project.id,
        parentVersionId: created.firstVersion!.id,
        title: "Child 1",
        description: "child tail",
        actor: TEST_ACTOR
      })
    );
    const childArtifact = await createApprovedArtifact(
      service,
      created.project.id,
      childDetails.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: childDetails.pendingOperationId,
      approvalArtifactId: childArtifact.id,
      actor: TEST_ACTOR
    });

    const reorderDetails = await expectConfirmationRequired(
      service.reorderVersions({
        projectId: created.project.id,
        versionId: createDetails.proposal.targetId,
        beforeVersionId: insertDetails.proposal.targetId,
        actor: TEST_ACTOR
      })
    );
    const reorderArtifact = await createApprovedArtifact(
      service,
      created.project.id,
      reorderDetails.pendingOperationId
    );
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: reorderDetails.pendingOperationId,
      approvalArtifactId: reorderArtifact.id,
      actor: TEST_ACTOR
    });

    const versions = await service.listVersions(created.project.id);
    const snapshot = await storage.loadProjectAggregate(created.project.id);
    const committedOperations =
      snapshot?.pendingOperations.filter((operation) => operation.status === "committed") ?? [];
    const consumedArtifacts =
      snapshot?.approvalArtifacts.filter((artifact) => artifact.status === "consumed") ?? [];
    const eventTypes = snapshot?.events.map((event) => event.eventType) ?? [];

    expect(snapshot?.project.currentVersionId).toBe(created.firstVersion!.id);
    expect(snapshot?.pendingOperations).toHaveLength(4);
    expect(committedOperations).toHaveLength(4);
    expect(committedOperations.map((operation) => operation.actionType)).toEqual([
      "create_version",
      "insert_version",
      "create_child_version",
      "reorder_versions"
    ]);
    expect(snapshot?.approvalArtifacts).toHaveLength(4);
    expect(consumedArtifacts).toHaveLength(4);
    expect(consumedArtifacts.map((artifact) => artifact.actionType)).toEqual([
      "create_version",
      "insert_version",
      "create_child_version",
      "reorder_versions"
    ]);
    expect(eventTypes).toContain("version.created");
    expect(eventTypes).toContain("version.tree_changed");
    expect(eventTypes).toContain("pending_operation.committed");
    expect(eventTypes).toContain("approval_artifact.consumed");
    expect(versions.map((version) => version.id)).toEqual([
      created.firstVersion!.id,
      childDetails.proposal.targetId,
      createDetails.proposal.targetId,
      insertDetails.proposal.targetId
    ]);
    expect(versions.map((version) => version.order)).toEqual([1, 2, 3, 4]);
    expect(versions.find((version) => version.id === created.firstVersion!.id)).toMatchObject({
      parentVersionId: null,
      previousVersionId: null,
      nextVersionId: createDetails.proposal.targetId,
      isCurrent: true
    });
    expect(versions.find((version) => version.id === childDetails.proposal.targetId)).toMatchObject({
      parentVersionId: created.firstVersion!.id,
      previousVersionId: null,
      nextVersionId: null,
      state: "wait",
      isCurrent: false
    });
    expect(versions.find((version) => version.id === createDetails.proposal.targetId)).toMatchObject({
      parentVersionId: null,
      previousVersionId: created.firstVersion!.id,
      nextVersionId: insertDetails.proposal.targetId,
      state: "wait",
      isCurrent: false
    });
    expect(versions.find((version) => version.id === insertDetails.proposal.targetId)).toMatchObject({
      parentVersionId: null,
      previousVersionId: createDetails.proposal.targetId,
      nextVersionId: null,
      state: "wait",
      isCurrent: false
    });
  });

  it("version tree proposal 鍚?sibling scope 婕傜Щ浼氬鑷?digest mismatch", async () => {
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

    const createDetails = await expectConfirmationRequired(
      service.createVersion({
        projectId: created.project.id,
        title: "Version 2",
        actor: TEST_ACTOR
      })
    );

    await storage.mutate(created.project.id, (snapshot) => {
      const currentRoot = snapshot.versions.find((version) => version.id === created.firstVersion!.id)!;
      const extraVersion = createVersionFixture({
        id: "version-extra",
        projectId: created.project.id,
        title: "Extra Root",
        order: 2,
        parentVersionId: null,
        previousVersionId: created.firstVersion!.id,
        nextVersionId: null,
        isCurrent: false
      });

      return {
        ...snapshot,
        versions: [
          {
            ...currentRoot,
            nextVersionId: extraVersion.id
          },
          extraVersion
        ]
      };
    });

    const artifact = await createApprovedArtifact(
      service,
      created.project.id,
      createDetails.pendingOperationId
    );

    await expect(
      service.commitL3Operation({
        projectId: created.project.id,
        pendingOperationId: createDetails.pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH"
    });
  });

  it.each(["dueDeferredIds", "blockedConstraintIds"] as const)(
    "rejects a v2 start proposal when stored %s is tampered without updating the digest",
    async (field) => {
      const storage = new MemoryStorageAdapter();
      const service = new RouteLedgerService({
        storage,
        deps: createTestDependencies()
      });
      const prepared = await createPreparedProject(service, storage);
      const proposal = await service.proposeL3Operation({
        projectId: prepared.projectId,
        actionType: "start_version",
        targetId: prepared.versionId,
        reason: "stored gate integrity",
        actor: TEST_ACTOR
      });
      const artifact = await createApprovedArtifact(
        service,
        prepared.projectId,
        proposal.id
      );

      await storage.mutate(prepared.projectId, (snapshot) => ({
        ...snapshot,
        pendingOperations: snapshot.pendingOperations.map((operation) =>
          operation.id === proposal.id &&
          operation.gateSnapshot.kind === "start"
            ? {
                ...operation,
                gateSnapshot: {
                  ...operation.gateSnapshot,
                  [field]: ["tampered-record"]
                }
              }
            : operation
        )
      }));

      await expect(
        service.commitL3Operation({
          projectId: prepared.projectId,
          pendingOperationId: proposal.id,
          approvalArtifactId: artifact.id,
          actor: TEST_ACTOR
        })
      ).rejects.toMatchObject({
        code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH",
        details: {
          pendingOperationId: proposal.id
        }
      });
      const after = await storage.loadProjectAggregate(prepared.projectId);
      expect(
        after?.pendingOperations.find(
          (operation) => operation.id === proposal.id
        )?.status
      ).toBe("pending");
      expect(
        after?.approvalArtifacts.find(
          (currentArtifact) => currentArtifact.id === artifact.id
        )?.status
      ).toBe("approved");
    }
  );

  it("rejects a v2 close proposal when stored unresolvedDeferredIds is tampered without updating the digest", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "close_version",
      targetId: prepared.versionId,
      reason: "stored close gate integrity",
      payload: {
        residualAudit: [
          {
            kind: "debt",
            summary: "No residual work",
            destination: "close"
          }
        ]
      },
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      pendingOperations: snapshot.pendingOperations.map((operation) =>
        operation.id === proposal.id &&
        operation.gateSnapshot.kind === "close"
          ? {
              ...operation,
              gateSnapshot: {
                ...operation.gateSnapshot,
                unresolvedDeferredIds: ["tampered-deferred"]
              }
            }
          : operation
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH",
      details: {
        pendingOperationId: proposal.id
      }
    });
  });

  it("accepts a provably legacy start digest only while the extended gate state remains empty", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy digest compatibility",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    const legacyDigest = legacyStartDigestValue(proposal.digest.payload);

    expect(proposal.digest.payload.gateSnapshot).toMatchObject({
      kind: "start",
      dueDeferredIds: [],
      blockedConstraintIds: []
    });
    expect(proposal.digest.value).not.toBe(legacyDigest);

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      pendingOperations: snapshot.pendingOperations.map((operation) =>
        operation.id === proposal.id
          ? {
              ...operation,
              digest: {
                ...operation.digest,
                value: legacyDigest
              }
            }
          : operation
      ),
      approvalArtifacts: snapshot.approvalArtifacts.map((currentArtifact) =>
        currentArtifact.id === artifact.id
          ? {
              ...currentArtifact,
              digest: {
                ...currentArtifact.digest,
                value: legacyDigest
              }
            }
          : currentArtifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({
      pendingOperation: {
        status: "committed"
      }
    });
  });

  it("rejects the same legacy proposal when a Deferred becomes due before commit", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const targetVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Deferred review target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      actor: TEST_ACTOR
    });
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: targetVersionId,
      reason: "legacy digest must fail closed",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    const legacyDigest = legacyStartDigestValue(proposal.digest.payload);

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      pendingOperations: snapshot.pendingOperations.map((operation) =>
        operation.id === proposal.id
          ? {
              ...operation,
              digest: { ...operation.digest, value: legacyDigest }
            }
          : operation
      ),
      approvalArtifacts: snapshot.approvalArtifacts.map((currentArtifact) =>
        currentArtifact.id === artifact.id
          ? {
              ...currentArtifact,
              digest: { ...currentArtifact.digest, value: legacyDigest }
            }
          : currentArtifact
      )
    }));
    await service.deferWork({
      mode: "new",
      projectId: prepared.projectId,
      originVersionId: prepared.versionId,
      targetReviewVersionId: targetVersionId,
      title: "Due after approval",
      description: "Must invalidate legacy compatibility",
      reason: "Review at target start",
      actor: TEST_ACTOR
    });

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH"
    });
  });

  it("rejects legacy compatibility when the stored gate carries a Constraint blocker ID", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy digest must not hide constraint blockers",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    const legacyDigest = legacyStartDigestValue(proposal.digest.payload);

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      pendingOperations: snapshot.pendingOperations.map((operation) =>
        operation.id === proposal.id &&
        operation.gateSnapshot.kind === "start"
          ? {
              ...operation,
              gateSnapshot: {
                ...operation.gateSnapshot,
                blockedConstraintIds: ["constraint-blocker"]
              },
              digest: {
                ...operation.digest,
                value: legacyDigest
              }
            }
          : operation
      ),
      approvalArtifacts: snapshot.approvalArtifacts.map((currentArtifact) =>
        currentArtifact.id === artifact.id
          ? {
              ...currentArtifact,
              digest: {
                ...currentArtifact.digest,
                value: legacyDigest
              }
            }
          : currentArtifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH"
    });
  });

});
