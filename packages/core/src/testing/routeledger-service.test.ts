import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ApprovalArtifact,
  ProjectAggregateSnapshot,
  StoragePort
} from "../index.js";
import { RouteLedgerService } from "../index.js";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTestDependencies,
  createTodoFixture,
  createUndoFixture,
  createVersionFixture
} from "./builders.js";

class MemoryStorageAdapter implements StoragePort {
  private snapshots = new Map<string, ProjectAggregateSnapshot>();

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    const snapshot = this.snapshots.get(projectId);

    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    this.snapshots.set(snapshot.project.id, structuredClone(snapshot));
  }

  async mutate(
    projectId: string,
    updater: (snapshot: ProjectAggregateSnapshot) => ProjectAggregateSnapshot
  ): Promise<void> {
    const snapshot = this.snapshots.get(projectId);

    if (snapshot === undefined) {
      throw new Error(`missing project ${projectId}`);
    }

    this.snapshots.set(projectId, structuredClone(updater(structuredClone(snapshot))));
  }
}

class FailOnSaveStorageAdapter extends MemoryStorageAdapter {
  private failNextSave = false;

  failOnce(): void {
    this.failNextSave = true;
  }

  override async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }

    await super.saveProjectAggregate(snapshot);
  }
}

const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-core-"));

const cleanupProjectRoot = (projectRoot: string): void => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
};

const stableTestStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableTestStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableTestStringify(entry)}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const legacyStartDigestValue = (
  digestPayload: ApprovalArtifact["digest"]["payload"]
): string => {
  const legacyPayload = structuredClone(digestPayload);
  const gateSnapshot = legacyPayload.gateSnapshot as {
    kind?: string;
  };

  if (gateSnapshot.kind !== "start") {
    throw new Error("expected start gate digest");
  }

  const legacyGate = gateSnapshot as unknown as Record<
    string,
    unknown
  >;
  delete legacyGate.dueDeferredIds;
  delete legacyGate.blockedConstraintIds;

  return crypto
    .createHash("sha256")
    .update(stableTestStringify(legacyPayload))
    .digest("hex");
};

const createPreparedProject = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter
) => {
  const created = await service.initProject({
    name: "RouteLedger",
    actor: TEST_ACTOR
  });
  await service.prepareVersion({
    projectId: created.project.id,
    versionId: created.initialVersion.id,
    actor: TEST_ACTOR
  });
  const snapshot = await storage.loadProjectAggregate(created.project.id);

  return {
    created,
    projectId: created.project.id,
    versionId: created.initialVersion.id,
    snapshot: snapshot!
  };
};

const createApprovedArtifact = async (
  service: RouteLedgerService,
  projectId: string,
  pendingOperationId: string
): Promise<ApprovalArtifact> =>
  service.approveL3Operation({
    projectId,
    pendingOperationId,
    approver: {
      id: "user-1",
      type: "user",
      displayName: "owner"
    },
    actor: TEST_ACTOR
  });

const startPreparedVersion = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string
) => {
  const proposal = await service.proposeL3Operation({
    projectId,
    actionType: "start_version",
    targetId: versionId,
    reason: "start current version",
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.id);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.id,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

const closeVersionThroughL3 = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string,
  residualAudit = [
    {
      kind: "debt" as const,
      summary: "none",
      destination: "close" as const
    }
  ]
) => {
  const proposal = await service.closeVersionWorkflow({
    projectId,
    versionId,
    mode: "propose",
    residualAudit,
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.pendingOperationId!);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.pendingOperationId!,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

const completeCurrentVersion = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter,
  setupWhileRunning?: (input: { projectId: string; versionId: string }) => Promise<void>
) => {
  const prepared = await createPreparedProject(service, storage);
  await startPreparedVersion(service, prepared.projectId, prepared.versionId);

  if (setupWhileRunning !== undefined) {
    await setupWhileRunning({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
  }

  await service.markVersionComplete({
    projectId: prepared.projectId,
    versionId: prepared.versionId,
    actor: TEST_ACTOR
  });

  return prepared;
};

const createCommittedVersion = async (
  service: RouteLedgerService,
  projectId: string,
  title: string,
  description = ""
): Promise<string> => {
  const details = await expectConfirmationRequired(
    service.createVersion({
      projectId,
      title,
      description,
      actor: TEST_ACTOR
    })
  );
  const artifact = await createApprovedArtifact(service, projectId, details.pendingOperationId);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: details.pendingOperationId,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });

  return details.proposal.targetId;
};

const createUnresolvedDeferredForCloseout = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter,
  projectId: string,
  versionId: string
): Promise<string> => {
  const downstreamVersionId = await createCommittedVersion(
    service,
    projectId,
    "Deferred review destination"
  );
  const deferred = await service.deferWork({
    mode: "new",
    projectId,
    originVersionId: versionId,
    targetReviewVersionId: downstreamVersionId,
    title: "Deferred with invalidated route",
    reason: "Create a valid route before simulating persisted route drift",
    actor: TEST_ACTOR
  });

  await storage.mutate(projectId, (snapshot) => ({
    ...snapshot,
    deferredItems: snapshot.deferredItems.map((item) =>
      item.id === deferred.deferred.id
        ? {
            ...item,
            targetReviewVersionId: versionId
          }
        : item
    )
  }));

  return deferred.deferred.id;
};

const setCurrentVersionForTest = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string
): Promise<void> => {
  const proposal = await service.transitionVersion({
    projectId,
    versionId,
    mode: "propose",
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.pendingOperationId!);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.pendingOperationId!,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

const expectConfirmationRequired = async (
  promise: Promise<unknown>
): Promise<{
  pendingOperationId: string;
  proposal: {
    id: string;
    targetId: string;
    actionType: string;
    payload: Record<string, unknown>;
  };
}> => {
  try {
    await promise;
    throw new Error("expected CONFIRMATION_REQUIRED");
  } catch (error) {
    expect(error).toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    const details = (error as {
      details: {
        pendingOperationId: string;
        proposal: {
          id: string;
          targetId: string;
          actionType: string;
          payload: Record<string, unknown>;
        };
      };
    }).details;

    return details;
  }
};

describe("route ledger service", () => {
  it("bare start_version returns CONFIRMATION_REQUIRED without mutating route state", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      name: "RouteLedger",
      actor: TEST_ACTOR
    });
    await service.prepareVersion({
      projectId: created.project.id,
      versionId: created.initialVersion.id,
      actor: TEST_ACTOR
    });

    await expect(
      service.startVersion({
        projectId: created.project.id,
        versionId: created.initialVersion.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);

    expect(snapshot?.versions[0]?.state).toBe("ready");
    expect(snapshot?.pendingOperations).toHaveLength(1);
    expect(snapshot?.pendingOperations[0]?.actionType).toBe("start_version");
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
    await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: successArtifact.id,
      actor: TEST_ACTOR
    });

    await expect(
      service.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: successArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_NOT_PENDING"
    });
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
      status: "ready",
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
          recommendedTool: "close_version",
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
      name: "RouteLedger",
      actor: TEST_ACTOR
    });
    const projectId = created.project.id;
    const versionId = created.initialVersion.id;

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
          recommendedTool: "transition_version",
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
          recommendedTool: "close_version",
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
    await service.createUndo({
      projectId: prepared.projectId,
      versionId: targetVersionId,
      originVersionId: targetVersionId,
      preferredResolutionVersionId: targetVersionId,
      title: "due undo",
      reason: "must resolve before start",
      actor: TEST_ACTOR
    });

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
          recommendedTool: "transition_version"
        })
      ])
    );
  });

  it("summarizeVersionCloseout / planVersionCloseout 浼氭妸 guardrail-like self undo 鏍囨敞涓哄缓璁?close_undo 骞惰褰?residual audit 鎻愮ず", async () => {
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
        title: "Rollback if QA failed",
        reason: "Use this as a guardrail when verification failed",
        description: "Record the fallback in the closeout note and residual audit.",
        actor: TEST_ACTOR
      });
      undoId = created.undo.id;
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const summaryData = summary.data as {
      selfReferentialUndos: Array<{
        id: string;
        category: string;
        recommendedResolution: string;
        reason: string;
        note: string;
      }>;
    };

    expect(summaryData.selfReferentialUndos).toEqual([
      expect.objectContaining({
        id: undoId,
        category: "guardrail_like",
        recommendedResolution: "close_undo",
        reason: expect.stringContaining("guardrail"),
        note: expect.stringContaining("residual audit")
      })
    ]);
    expect(summary.meta).toMatchObject({
      eventLimit: 10,
      relatedPendingOperationCount: 1,
      residualAuditSource: "missing",
      residualAuditProposalId: null
    });

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const planData = plan.data as {
      steps: Array<{
        kind: string;
        targetId: string | null;
        warnings?: string[];
        alternatives?: Array<{ actionType: string }>;
      }>;
    };
    const undoStep = planData.steps.find((step) => step.kind === "close_undo" && step.targetId === undoId);

    expect(undoStep).toMatchObject({
      kind: "close_undo",
      targetId: undoId,
      warnings: expect.arrayContaining([
        expect.stringContaining("self-referential"),
        expect.stringContaining("residual audit")
      ])
    });
    expect(undoStep?.alternatives).toEqual(
      expect.arrayContaining([expect.objectContaining({ actionType: "carry_forward_undo" })])
    );
  });

  it("summarizeVersionCloseout / planVersionCloseout 浼氭妸 cleanup-like self undo 鏍囨敞涓?close_undo + create_todo 璺緞", async () => {
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
        title: "Cleanup after close",
        reason: "clean up after close",
        description: "migrate to a formal todo later",
        actor: TEST_ACTOR
      });
      undoId = created.undo.id;
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const summaryData = summary.data as {
      selfReferentialUndos: Array<{
        id: string;
        category: string;
        recommendedResolution: string;
        note: string;
      }>;
    };

    expect(summaryData.selfReferentialUndos).toEqual([
      expect.objectContaining({
        id: undoId,
        category: "cleanup_like",
        recommendedResolution: "close_undo_then_create_todo",
        note: expect.stringContaining("create_todo")
      })
    ]);

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const planData = plan.data as {
      steps: Array<{
        kind: string;
        targetId: string | null;
        warnings?: string[];
      }>;
    };

    expect(planData.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "close_undo",
          targetId: undoId,
          warnings: expect.arrayContaining([expect.stringContaining("create_todo")])
        }),
        expect.objectContaining({
          kind: "create_todo",
          warnings: expect.arrayContaining([expect.stringContaining("cleanup path visible")])
        })
      ])
    );
  });

  it("summarizeVersionCloseout / planVersionCloseout 浼氭妸 uncertain self undo 鏍囨敞涓轰汉宸ヨ鍐冲苟鍒楀嚭鍊欓€?alternatives", async () => {
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
        title: "Needs another decision",
        reason: "needs another decision",
        description: "controller decides next",
        actor: TEST_ACTOR
      });
      undoId = created.undo.id;
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const summaryData = summary.data as {
      selfReferentialUndos: Array<{
        id: string;
        category: string;
        recommendedResolution: string;
        alternatives: Array<{ actionType: string }>;
      }>;
    };

    expect(summaryData.selfReferentialUndos).toEqual([
      expect.objectContaining({
        id: undoId,
        category: "uncertain",
        recommendedResolution: "manual_review",
        alternatives: expect.arrayContaining([
          expect.objectContaining({ actionType: "close_undo" }),
          expect.objectContaining({ actionType: "close_undo_then_create_todo" }),
          expect.objectContaining({ actionType: "carry_forward_undo" })
        ])
      })
    ]);

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const planData = plan.data as {
      steps: Array<{
        kind: string;
        warnings?: string[];
        alternatives?: Array<{ actionType: string }>;
      }>;
    };

    expect(planData.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "review_self_referential_undo",
          warnings: expect.arrayContaining([
            expect.stringContaining("Do not treat this as an ordinary close blocker"),
            expect.stringContaining("Choose whether it should close in place")
          ]),
          alternatives: expect.arrayContaining([
            expect.objectContaining({ actionType: "close_undo" }),
            expect.objectContaining({ actionType: "close_undo_then_create_todo" }),
            expect.objectContaining({ actionType: "carry_forward_undo" })
          ])
        })
      ])
    );
  });
  it("ordinary non self-referential undo is not classified as selfReferentialUndos", async () => {
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

    await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: downstreamVersionId,
      title: "Carry to downstream",
      reason: "next version should own it",
      description: "ordinary non self-referential undo",
      actor: TEST_ACTOR
    });

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const summaryData = summary.data as {
      openUndos: Array<{ preferredResolutionVersionId: string }>;
      selfReferentialUndos: Array<{ id: string }>;
    };

    expect(summaryData.openUndos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ preferredResolutionVersionId: downstreamVersionId })
      ])
    );
    expect(summaryData.selfReferentialUndos).toEqual([]);
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

  it("carry_forward_undo 浼氫繚鐣欏悓涓€鏉?undo lineage锛屽彧鏀?preferred resolution", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    const downstreamVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Downstream",
      "downstream target"
    );
    const createdUndo = await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: prepared.versionId,
      title: "carry me",
      reason: "defer downstream",
      actor: TEST_ACTOR
    });

    const carried = await service.carryForwardUndo({
      projectId: prepared.projectId,
      undoId: createdUndo.undo.id,
      preferredResolutionVersionId: downstreamVersionId,
      reason: "route to downstream version",
      note: "keep as downstream undo",
      actor: TEST_ACTOR
    });

    expect(carried).toMatchObject({
      status: "reassigned",
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      previousPreferredResolutionVersionId: prepared.versionId,
      preferredResolutionVersionId: downstreamVersionId
    });
    expect(carried.undo.id).toBe(createdUndo.undo.id);
    expect(carried.undo.preferredResolutionVersionId).toBe(downstreamVersionId);
    expect(carried.undo.status).toBe("wait");
    expect(carried.undo.carriedForwardAt).toBe("2026-06-27T00:00:00.000Z");
    expect(carried.undo.carriedForwardToVersionId).toBe(downstreamVersionId);

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.undos).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(0);
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
    await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: siblingVersionId,
      title: "open undo",
      reason: "needs later handling",
      actor: TEST_ACTOR
    });

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
    expect(structure.legalOperations).toContainEqual(
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
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_NOT_PENDING"
    });
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
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_NOT_PENDING"
    });
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
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_NOT_PENDING"
    });
  });

  it("version tree 鍥涗釜 L3 action 鍙畬鎴?commit锛屼笖涓嶆敼鍙?current 鐪熸簮", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "RouteLedger",
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
      previousVersionId: created.initialVersion.id,
      nextVersionId: null,
      siblingVersionIds: [created.initialVersion.id]
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
        afterVersionId: created.initialVersion.id,
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
        parentVersionId: created.initialVersion.id,
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

    expect(snapshot?.project.currentVersionId).toBe(created.initialVersion.id);
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
      created.initialVersion.id,
      childDetails.proposal.targetId,
      createDetails.proposal.targetId,
      insertDetails.proposal.targetId
    ]);
    expect(versions.map((version) => version.order)).toEqual([1, 2, 3, 4]);
    expect(versions.find((version) => version.id === created.initialVersion.id)).toMatchObject({
      parentVersionId: null,
      previousVersionId: null,
      nextVersionId: createDetails.proposal.targetId,
      isCurrent: true
    });
    expect(versions.find((version) => version.id === childDetails.proposal.targetId)).toMatchObject({
      parentVersionId: created.initialVersion.id,
      previousVersionId: null,
      nextVersionId: null,
      state: "wait",
      isCurrent: false
    });
    expect(versions.find((version) => version.id === createDetails.proposal.targetId)).toMatchObject({
      parentVersionId: null,
      previousVersionId: created.initialVersion.id,
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
      name: "RouteLedger",
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
      const currentRoot = snapshot.versions.find((version) => version.id === created.initialVersion.id)!;
      const extraVersion = createVersionFixture({
        id: "version-extra",
        projectId: created.project.id,
        title: "Extra Root",
        order: 2,
        parentVersionId: null,
        previousVersionId: created.initialVersion.id,
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

  it("batch_create_versions preflight 鎴愬姛鏃惰繑鍥?normalizedPlan/preview/risks 涓斾笉鍒涘缓 proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "RouteLedger",
      actor: TEST_ACTOR
    });

    const result = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      anchor: {
        afterVersionId: created.initialVersion.id
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
      afterVersionId: created.initialVersion.id,
      beforeVersionId: null
    });
    expect(result.preview.createdVersions).toHaveLength(2);
    expect(result.preview.createdVersions[0]).toMatchObject({
      clientKey: "plan-a",
      previousRef: created.initialVersion.id
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
    expect(result.headRevision).toBeNull();
    expect(result.digestPreview.value).toHaveLength(64);

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
    expect(snapshot?.versions).toHaveLength(1);
    expect(snapshot?.todos).toHaveLength(0);
  });

  it("batch_create_versions preflight 澶辫触鏃惰繑鍥為€愰」 issues 涓斾笉鍒涘缓 proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "RouteLedger",
      actor: TEST_ACTOR
    });

    await storage.mutate(created.project.id, (snapshot) => ({
      ...snapshot,
      versions: snapshot.versions.map((version) =>
        version.id === created.initialVersion.id
          ? {
              ...version,
              state: "close"
            }
          : version
      )
    }));

    const result = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "preflight",
      anchor: {
        afterVersionId: created.initialVersion.id
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

    expect(result).toMatchObject({
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      issues: [
        expect.objectContaining({
          index: 0,
          clientKey: "plan-a"
        })
      ]
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toHaveLength(0);
    expect(snapshot?.versions).toHaveLength(1);
  });

  it("batch_create_versions 缂哄け description 鎴?initialTodos 鏃惰繑鍥為€愰」 issue", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "RouteLedger",
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
      name: "RouteLedger",
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
      name: "RouteLedger",
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
      name: "RouteLedger",
      actor: TEST_ACTOR
    });

    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      anchor: {
        afterVersionId: created.initialVersion.id
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
    expect(snapshot?.todos.map((todo) => todo.title)).toEqual(["write docs", "prepare review"]);
    expect(snapshot?.project.currentVersionId).toBe(versions[2]?.id);
    expect(versions[0]).toMatchObject({
      id: created.initialVersion.id,
      state: "wait",
      isCurrent: false
    });
    expect(versions[2]).toMatchObject({
      title: "Plan B",
      state: "wait",
      isCurrent: true
    });
  });

  it("batch_create_versions 鍦?require_complete_or_close 涓嬩細鍏堥樆姝?propose锛屼笖涓嶅垱寤?pending proposal", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      name: "RouteLedger",
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
      name: "RouteLedger",
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

  it("getCurrentContext returns a default version window and can include all versions", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const versions = Array.from({ length: 8 }, (_, index) =>
      createVersionFixture({
        id: `version-${index + 1}`,
        title: index === 5 ? "_probe top-level B" : `V${index + 1}`,
        state: index === 3 ? "running" : "wait",
        isCurrent: index === 3,
        order: index + 1,
        previousVersionId: index === 0 ? null : `version-${index}`,
        nextVersionId: index === 7 ? null : `version-${index + 2}`
      })
    );

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-4"
      }),
      versions,
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

    const defaultContext = await service.getCurrentContext({
      projectId: "project-1"
    });
    const fullContext = await service.getCurrentContext({
      projectId: "project-1",
      includeAllVersions: true
    });
    const listWindow = await service.listVersionsWindow({
      projectId: "project-1"
    });

    expect((defaultContext.data as { versions: Array<{ id: string }> }).versions.map((version) => version.id)).toEqual([
      "version-1",
      "version-2",
      "version-3",
      "version-4",
      "version-5",
      "version-6",
      "version-7"
    ]);
    expect(
      (
        defaultContext.meta as {
          versionWindow: {
            aroundVersionId: string | null;
            before: number;
            after: number;
            includeAllVersions: boolean;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      aroundVersionId: "version-4",
      before: 3,
      after: 3,
      includeAllVersions: false,
      totalCount: 8,
      includedCount: 7,
      omittedBeforeCount: 0,
      omittedAfterCount: 1
    });
    expect((fullContext.data as { versions: Array<{ id: string }> }).versions).toHaveLength(8);
    expect(
      (
        fullContext.meta as {
          versionWindow: {
            includeAllVersions: boolean;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      includeAllVersions: true,
      totalCount: 8,
      includedCount: 8,
      omittedBeforeCount: 0,
      omittedAfterCount: 0
    });
    expect(listWindow).toMatchObject({
      data: {
        aroundVersionId: "version-4"
      },
      meta: {
        versionWindow: {
          aroundVersionId: "version-4",
          totalCount: 8,
          includedCount: 7
        }
      }
    });
  });

  it("listVersionsWindow 鍦ㄥ熬閮?anchor 涓婅繑鍥炴纭殑 head-tail 杈圭晫缁熻", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const versions = Array.from({ length: 8 }, (_, index) =>
      createVersionFixture({
        id: `version-${index + 1}`,
        title: `V${index + 1}`,
        state: index === 3 ? "running" : "wait",
        isCurrent: index === 3,
        order: index + 1,
        previousVersionId: index === 0 ? null : `version-${index}`,
        nextVersionId: index === 7 ? null : `version-${index + 2}`
      })
    );

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-4"
      }),
      versions,
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

    const window = await service.listVersionsWindow({
      projectId: "project-1",
      aroundVersionId: "version-8",
      before: 2,
      after: 3
    });

    expect((window.data as { aroundVersionId: string | null }).aroundVersionId).toBe("version-8");
    expect((window.data as { versions: Array<{ id: string }> }).versions.map((version) => version.id)).toEqual([
      "version-6",
      "version-7",
      "version-8"
    ]);
    expect(
      (
        window.meta as {
          versionWindow: {
            aroundVersionId: string | null;
            before: number;
            after: number;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      aroundVersionId: "version-8",
      before: 2,
      after: 3,
      totalCount: 8,
      includedCount: 3,
      omittedBeforeCount: 5,
      omittedAfterCount: 0
    });
  });

  it("listVersionsWindow 鍦?aroundVersionId 鏃犳晥鏃舵姏鍑?VERSION_NOT_FOUND", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-1"
      }),
      versions: [
        createVersionFixture({
          id: "version-1",
          title: "V1",
          state: "running",
          isCurrent: true,
          order: 1
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

    await expect(
      service.listVersionsWindow({
        projectId: "project-1",
        aroundVersionId: "version-missing",
        before: 1,
        after: 1
      })
    ).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
      details: {
        aroundVersionId: "version-missing"
      }
    });
  });

  it("checkDocDrift flags stale current-version text, missing pointers, and missing files", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version is still Initial Version.",
          "The mainline description has not been updated yet."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        [
          "# Agent Entry",
          "",
          "QA entry still points to `docs/qa/legacy-checklist.md`."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });

      expect(result.data.routeTruth.currentVersion).toMatchObject({
        id: nextVersionId,
        title: "Version Closeout Plan"
      });
      expect(result.data.routeTruth).toMatchObject({
        openTodoCount: 0,
        openUndoCount: 0,
        pendingProposalCount: 0,
        statusRiskCodes: []
      });
      expect(result.data.checkedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            matchedWarningCount: 1
          }),
          expect.objectContaining({
            path: "AGENTS.md",
            matchedWarningCount: 0
          })
        ])
      );
      expect(result.data.unreadableFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "docs/missing.md",
            code: "ENOENT"
          })
        ])
      );
      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_CURRENT_VERSION",
            file: "README.md"
          }),
          expect.objectContaining({
            code: "MISSING_EXPECTED_POINTER",
            file: null,
            expected: "docs/qa/current-checklist.md"
          })
        ])
      );
      expect(result.data.suggestedTodos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining("README.md"),
            file: "README.md",
            reason: expect.stringContaining("current")
          }),
          expect.objectContaining({
            title: expect.stringContaining("docs/qa/current-checklist.md"),
            file: null,
            reason: expect.stringContaining("docs/qa/current-checklist.md")
          })
        ])
      );
      expect(result.data.summaryText).toContain("Checked 2 entry files for project RouteLedger.");
      expect(result.data.summaryText).toContain(
        `Current version: Version Closeout Plan (${nextVersionId}).`
      );
      expect(result.data.summaryText).toContain(
        "Found 2 warnings and 1 unreadable files."
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鍦ㄧ己灏?projectRoot 鏃朵粛鐩存帴鎶ラ敊", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      name: "RouteLedger",
      actor: TEST_ACTOR
    });

    await expect(
      service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      })
    ).rejects.toThrow("checkDocDrift requires RouteLedgerServiceOptions.projectRoot");
  });

  it("checkDocDrift 鍦?SQLite 琚啓鎴愬敮涓€鐪熸簮鏃惰繑鍥?STALE_TRUTH_SOURCE", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        "SQLite is the source of truth for the runtime route state.",
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_TRUTH_SOURCE",
            file: "README.md"
          })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鍦?entry docs 宸插悓姝ユ椂涓嶈繑鍥?warning", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      fs.mkdirSync(path.join(projectRoot, "docs", "capabilities"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          `褰撳墠鐗堟湰: Initial Version (${created.initialVersion.id})`,
          "Runtime truth lives in `.routeledger/` canonical JSON.",
          "Capability entrypoint: `docs/capabilities/cap-mcp-route-operations.md`."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "docs/capabilities/cap-mcp-route-operations.md"),
        "currentVersion -> Initial Version\n",
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "docs/capabilities/cap-mcp-route-operations.md"],
        expectedPointers: [
          {
            kind: "capability",
            path: "docs/capabilities/cap-mcp-route-operations.md"
          }
        ]
      });

      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鎶?canonical current pointer 鏂囨。瑙嗕负宸插悓姝ワ紝浣嗘棫 current 鏂囨湰浠嶄細鎶?drift", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger/refs/current.json`."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        [
          "# Agent Entry",
          "",
          "Current version is still Initial Version."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "AGENTS.md"]
      });

      expect(result.data.warnings).toEqual([
        expect.objectContaining({
          code: "STALE_CURRENT_VERSION",
          file: "AGENTS.md"
        })
      ]);
      expect(result.data.unreadableFiles).toEqual([]);
      expect(result.data.checkedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            matchedWarningCount: 0
          }),
          expect.objectContaining({
            path: "AGENTS.md",
            matchedWarningCount: 1
          })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift accepts Windows-style canonical current pointers as synchronized", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger\\refs\\current.json`."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([]);
      expect(result.data.checkedFiles).toEqual([
        expect.objectContaining({
          path: "README.md",
          matchedWarningCount: 0
        })
      ]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 浼氭嫆缁濊秺鐣?entry file path", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      await expect(
        service.checkDocDrift({
          projectId: created.project.id,
          entryFiles: ["../README.md"]
        })
      ).rejects.toMatchObject({
        code: "INVALID_ASSET_PATH",
        details: {
          field: "entryFiles[0]",
          path: "../README.md"
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift does not follow symlinks outside the project root", async () => {
    const projectRoot = createTempProjectRoot();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-core-outside-"));
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      const outsideFilePath = path.join(outsideRoot, "outside-entry.md");
      fs.writeFileSync(outsideFilePath, "褰撳墠鐗堟湰浠嶆槸 leaked version銆俓n", "utf8");
      fs.symlinkSync(outsideFilePath, path.join(projectRoot, "README.md"));

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.checkedFiles).toEqual([]);
      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([
        expect.objectContaining({
          path: "README.md",
          code: "ENTRY_FILE_OUTSIDE_PROJECT_ROOT"
        })
      ]);
    } finally {
      cleanupProjectRoot(projectRoot);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
  it("carry_forward_undo clears the source close gate but still blocks target start as a due undo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const downstreamVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Downstream",
      "downstream target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: downstreamVersionId,
      actor: TEST_ACTOR
    });
    const createdUndo = await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: prepared.versionId,
      title: "carry me",
      reason: "defer downstream",
      actor: TEST_ACTOR
    });

    await service.carryForwardUndo({
      projectId: prepared.projectId,
      undoId: createdUndo.undo.id,
      preferredResolutionVersionId: downstreamVersionId,
      reason: "route to downstream version",
      note: "keep as downstream undo",
      actor: TEST_ACTOR
    });

    const closeGate = await service.checkCloseGate({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      residualAudit: [
        {
          kind: "debt",
          summary: "none",
          destination: "close"
        }
      ],
      actor: TEST_ACTOR
    });
    const startGate = await service.checkStartGate({
      projectId: prepared.projectId,
      versionId: downstreamVersionId,
      actor: TEST_ACTOR
    });

    expect(closeGate.allowed).toBe(true);
    expect(closeGate.unresolvedUndoIds).toEqual([]);
    expect(startGate.allowed).toBe(false);
    expect(startGate.dueUndoIds).toEqual([createdUndo.undo.id]);

    await closeVersionThroughL3(
      service,
      prepared.projectId,
      prepared.versionId
    );
    const defaultContext = await service.getCurrentContext({
      projectId: prepared.projectId
    });
    const auditContext = await service.getCurrentContext({
      projectId: prepared.projectId,
      includeLegacyUndo: true
    });
    const nextAction = await service.getNextAction({
      projectId: prepared.projectId
    });
    const defaultData = defaultContext.data as Record<string, any>;
    const auditData = auditContext.data as Record<string, any>;
    const nextActionData = nextAction.data as Record<string, any>;

    expect(defaultData).not.toHaveProperty("openUndos");
    expect(defaultData).not.toHaveProperty("legacyUndo");
    expect(defaultData.gates.start).toMatchObject({
      allowed: false,
      blockers: [
        expect.objectContaining({
          code: "LEGACY_WORK_REQUIRES_AUDIT",
          recordIds: [createdUndo.undo.id]
        })
      ]
    });
    expect(defaultData.statusRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "START_GATE_BLOCKED",
          severity: "blocking",
          recordIds: [createdUndo.undo.id]
        })
      ])
    );
    expect(defaultData.nextAction).toMatchObject({
      actionType: "review_context",
      targetId: downstreamVersionId,
      blockingRiskCodes: ["START_GATE_BLOCKED"]
    });
    expect(auditData.legacyUndo).toEqual([
      expect.objectContaining({
        id: createdUndo.undo.id
      })
    ]);
    expect(auditData.nextAction).toEqual(defaultData.nextAction);
    expect(nextActionData.nextAction).toEqual(defaultData.nextAction);
    expect(JSON.stringify(nextActionData.gates.start)).not.toContain(
      "OPEN_DUE_UNDOS"
    );
  });

  it("propagates unresolved Deferred IDs through version closeout summary and plan", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const deferredId = await createUnresolvedDeferredForCloseout(
      service,
      storage,
      prepared.projectId,
      prepared.versionId
    );

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });

    expect(summary.data).toMatchObject({
      canClose: false,
      closeGate: {
        ok: false,
        unresolvedDeferredIds: [deferredId],
        blockedConstraintIds: []
      }
    });
    expect(summary.data.closeGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_SELF",
          recordIds: [deferredId]
        })
      ])
    );
    expect(plan.data).toMatchObject({
      status: "blocked",
      summary: {
        canClose: false,
        closeGate: {
          ok: false,
          unresolvedDeferredIds: [deferredId],
          blockedConstraintIds: []
        }
      }
    });
  });

  it("propagates unresolved Deferred IDs through shutdown ordinaryCloseGate", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const deferredId = await createUnresolvedDeferredForCloseout(
      service,
      storage,
      prepared.projectId,
      prepared.versionId
    );

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "route_integrity_failure",
      mode: "dry_run",
      actor: TEST_ACTOR
    });

    expect(workflow).toMatchObject({
      status: "ready",
      forced: true,
      ordinaryCloseGate: {
        allowed: false,
        unresolvedDeferredIds: [deferredId],
        blockedConstraintIds: []
      }
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_SELF",
          recordIds: [deferredId]
        })
      ])
    );
  });

  it("shutdown_version ordinaryCloseGate keeps missing residual audit visible", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "emergency_stop",
      mode: "dry_run",
      actor: TEST_ACTOR
    });

    expect(workflow.status).toBe("ready");
    expect(workflow.ordinaryCloseGate).toMatchObject({
      allowed: false,
      unresolvedTodoIds: [],
      unresolvedUndoIds: []
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })])
    );
  });

  it("shutdown_version creates a forced L3 path and commits as SHUTDOWN close", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "still open",
      actor: TEST_ACTOR
    });

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "emergency_stop",
      reason: "force close after severe runtime failure",
      mode: "propose",
      actor: TEST_ACTOR
    });

    expect(workflow).toMatchObject({
      status: "ready",
      forced: true,
      shutdownStateReason: "shutdown:emergency_stop"
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TARGET_VERSION_NOT_COMPLETE" })])
    );

    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      workflow.pendingOperationId!
    );
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: workflow.pendingOperationId!,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    const version = snapshot?.versions.find((item) => item.id === prepared.versionId);
    const shutdownEvent = snapshot?.events.find(
      (event) =>
        event.targetType === "version" &&
        event.targetId === prepared.versionId &&
        event.eventType === "version.shutdown"
    );

    expect(committed.pendingOperation.actionType).toBe("shutdown_version");
    expect(version).toMatchObject({
      state: "close",
      stateReason: "shutdown:emergency_stop"
    });
    expect(shutdownEvent?.metadata).toMatchObject({
      forced: true,
      shutdownReason: "emergency_stop",
      stateReason: "shutdown:emergency_stop"
    });

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    expect(plan.data.version).toMatchObject({
      displayState: "shutdown",
      isShutdown: true,
      stateReason: "shutdown:emergency_stop"
    });
    expect(plan.data.steps[0]).toMatchObject({
      kind: "no_op"
    });
  });
});
