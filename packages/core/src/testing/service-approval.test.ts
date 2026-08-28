import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter, createPreparedProject, createApprovedArtifact } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("bare start_version returns CONFIRMATION_REQUIRED without mutating route state", async () => {
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
    await service.prepareVersion({
      projectId: created.project.id,
      versionId: created.firstVersion!.id,
      actor: TEST_ACTOR
    });

    await expect(
      service.startVersion({
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);

    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(snapshot?.pendingOperations).toHaveLength(1);
    expect(snapshot?.pendingOperations[0]?.actionType).toBe("start_version");
    expect(snapshot?.pendingOperations[0]?.reasonSource).toBe("system_default");
    expect(snapshot?.approvalArtifacts).toHaveLength(0);
  });

  it("proposal only creates a pending operation and does not mutate route state", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);

    expect(proposal.digest.value).toHaveLength(64);
    expect(proposal.reasonSource).toBe("explicit_input");
    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(snapshot?.pendingOperations).toHaveLength(1);
    expect(snapshot?.events.at(-1)?.targetType).toBe("pending_operation");
  });

  it("鏈夋晥 approval artifact 鎵嶈兘 commit锛屽苟鍦ㄦ垚鍔熷悗娑堣垂 artifact", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);

    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);

    expect(committed.pendingOperation.status).toBe("committed");
    expect(committed.approvalArtifact.status).toBe("consumed");
    expect(snapshot?.versions[0]?.state).toBe("running");
    expect(snapshot?.pendingOperations[0]?.approvalArtifactId).toBe(artifact.id);
  });

  it("approval artifact events preserve approver actor type metadata", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });

    const artifact = await service.approveL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approver: {
        id: "agent-reviewer-1",
        type: "agent",
        displayName: "review-bot"
      },
      actor: TEST_ACTOR,
      decisionRef: "decision://agent-review/1"
    });

    await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    const approvalEvent = snapshot?.events.find(
      (event) =>
        event.targetType === "approval_artifact" &&
        event.targetId === artifact.id &&
        event.eventType === "approval_artifact.approved"
    );
    const consumedEvent = snapshot?.events.find(
      (event) =>
        event.targetType === "approval_artifact" &&
        event.targetId === artifact.id &&
        event.eventType === "approval_artifact.consumed"
    );

    expect(artifact.approver).toMatchObject({
      id: "agent-reviewer-1",
      type: "agent"
    });
    expect(approvalEvent?.metadata).toMatchObject({
      approverId: "agent-reviewer-1",
      approverType: "agent"
    });
    expect(consumedEvent?.metadata).toMatchObject({
      approverId: "agent-reviewer-1",
      approverType: "agent"
    });
  });

  it("approval artifact validation rejects missing, expired, mismatched, and reused artifacts", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    const expiredArtifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((artifact) =>
        artifact.id === expiredArtifact.id
          ? {
              ...artifact,
              expiresAt: "2026-06-26T00:00:00.000Z"
            }
          : artifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: expiredArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_EXPIRED"
    });

    const digestMismatchArtifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((artifact) =>
        artifact.id === digestMismatchArtifact.id
          ? {
              ...artifact,
              digest: {
                ...artifact.digest,
                value: "digest-mismatch"
              }
            }
          : artifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: digestMismatchArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH"
    });

    const targetMismatchArtifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((artifact) =>
        artifact.id === targetMismatchArtifact.id
          ? {
              ...artifact,
              targetId: "another-version"
            }
          : artifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: targetMismatchArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_TARGET_MISMATCH"
    });

    const actionMismatchArtifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      proposal.id
    );
    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((artifact) =>
        artifact.id === actionMismatchArtifact.id
          ? {
              ...artifact,
              actionType: "reopen_version"
            }
          : artifact
      )
    }));

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: actionMismatchArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_ACTION_MISMATCH"
    });

    const successArtifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: successArtifact.id,
      actor: TEST_ACTOR
    });
    const snapshotAfterCommit = await storage.loadProjectAggregate(prepared.projectId);

    const replayed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: successArtifact.id,
      actor: TEST_ACTOR
    });

    expect(committed.replayed).toBe(false);
    expect(replayed).toMatchObject({
      pendingOperation: { id: proposal.id, status: "committed" },
      approvalArtifact: { id: successArtifact.id, status: "consumed" },
      replayed: true
    });
    expect(
      (await storage.loadProjectAggregate(prepared.projectId))?.events
    ).toHaveLength(snapshotAfterCommit?.events.length ?? 0);

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: actionMismatchArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "COMMIT_REPLAY_MISMATCH" });
  });

  it("approval artifact 蹇呴』缁戝畾鍏蜂綋 pending operation锛屼笉鑳藉鐢ㄥ彟涓€涓?proposal 鐨?artifact", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const firstProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "start current version",
      actor: TEST_ACTOR
    });
    const secondProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "start current version again",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, secondProposal.id);

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: firstProposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_PENDING_OPERATION_MISMATCH"
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(
      snapshot?.pendingOperations.find((operation) => operation.id === firstProposal.id)?.status
    ).toBe("pending");
    expect(snapshot?.approvalArtifacts.find((entry) => entry.id === artifact.id)?.status).toBe(
      "approved"
    );
  });

  it("approval artifact must be in approved status", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((entry) =>
        entry.id === artifact.id
          ? {
              ...entry,
              status: "pending"
            }
          : entry
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
      code: "APPROVAL_ARTIFACT_STATUS_INVALID"
    });

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((entry) =>
        entry.id === artifact.id
          ? {
              ...entry,
              status: "rejected"
            }
          : entry
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
      code: "APPROVAL_ARTIFACT_STATUS_INVALID"
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(snapshot?.pendingOperations[0]?.status).toBe("pending");
  });

  it("approval artifact with consumedAt set is rejected even if status is approved", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });
    const artifact = await createApprovedArtifact(service, prepared.projectId, proposal.id);

    await storage.mutate(prepared.projectId, (snapshot) => ({
      ...snapshot,
      approvalArtifacts: snapshot.approvalArtifacts.map((entry) =>
        entry.id === artifact.id
          ? {
              ...entry,
              status: "approved",
              consumedAt: "2026-06-27T01:00:00.000Z"
            }
          : entry
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
      code: "APPROVAL_ARTIFACT_ALREADY_CONSUMED"
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(snapshot?.pendingOperations[0]?.status).toBe("pending");
    expect(snapshot?.approvalArtifacts[0]?.status).toBe("approved");
  });

  it("confirm=true 涓嶈兘浣滀负鏈夋晥纭", async () => {
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
      reason: "start current version",
      actor: TEST_ACTOR
    });

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        confirm: true,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });
  });

  it("get_current_context 鍖呭惈 pending proposal 鎽樿骞舵寜棰勭畻鎴柇", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);

    await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "Very long todo",
      description: "x".repeat(12000),
      actor: TEST_ACTOR
    });
    await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "y".repeat(6000),
      actor: TEST_ACTOR
    });

    const context = await service.getCurrentContext({
      projectId: prepared.projectId,
      budgetBytes: 8192
    });

    expect(context.data.pendingL3Proposals).toBeDefined();
    expect(context.meta.truncated).toBe(true);
    expect(context.meta.truncatedFields).toContain("todos.description");
    expect(context.meta.truncatedFields).toContain("pendingL3Proposals.reason");
  });

});
