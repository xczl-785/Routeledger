import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  L3CanonicalDigestMaterial,
  L3ProposalSecurityPort
} from "../application/l3-proposal-security-port.js";
import {
  attachProjectAggregateHeadRevision,
  getProjectAggregateHeadRevision,
  type ProjectAggregateSnapshot,
  type StoragePort
} from "../ports/storage-port.js";
import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import {
  LossyPendingOperationStorageAdapter,
  MemoryStorageAdapter,
  createPreparedProject
} from "./routeledger-service-test-helpers.js";

class GateTamperingPendingOperationStorageAdapter extends MemoryStorageAdapter {
  override async saveProjectAggregate(snapshot: Parameters<MemoryStorageAdapter["saveProjectAggregate"]>[0]) {
    const tamperedSnapshot = structuredClone(snapshot);

    for (const operation of tamperedSnapshot.pendingOperations) {
      if (operation.gateSnapshot.kind === "start") {
        operation.gateSnapshot = { ...operation.gateSnapshot, allowed: false };
      }
    }

    await super.saveProjectAggregate(tamperedSnapshot);
  }
}

class RevisionAwareLinkedApprovalTamperingStorageAdapter implements StoragePort {
  private readonly snapshots = new Map<string, ProjectAggregateSnapshot>();

  private readonly revisions = new Map<string, number>();

  private readonly proposalSaveRevisions = new Map<string, string>();

  private injectLinkedApproval = true;

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    const snapshot = this.snapshots.get(projectId);

    if (snapshot === undefined) return null;

    return attachProjectAggregateHeadRevision(
      structuredClone(snapshot),
      `revision-${this.revisions.get(projectId)!}`
    );
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    const tamperedSnapshot = structuredClone(snapshot);
    const savesProposal = tamperedSnapshot.pendingOperations.length > 0;

    if (this.injectLinkedApproval && tamperedSnapshot.pendingOperations.length > 0) {
      this.injectLinkedApproval = false;
      for (const operation of tamperedSnapshot.pendingOperations) {
        operation.payload = { fromVersionId: "tampered-after-save" };
        tamperedSnapshot.approvalArtifacts.push({
          id: `linked-${operation.id}`,
          projectId: operation.projectId,
          pendingOperationId: operation.id,
          actionType: operation.actionType,
          targetId: operation.targetId,
          digest: operation.digest,
          status: "approved",
          approver: TEST_ACTOR,
          decisionRef: "concurrent-approval",
          createdAt: operation.createdAt,
          expiresAt: "2026-06-28T00:00:00.000Z",
          consumedAt: null
        });
      }
    }

    const revision = (this.revisions.get(snapshot.project.id) ?? 0) + 1;
    this.revisions.set(snapshot.project.id, revision);
    attachProjectAggregateHeadRevision(snapshot, `revision-${revision}`);
    if (savesProposal) {
      this.proposalSaveRevisions.set(snapshot.project.id, `revision-${revision}`);
    }
    this.snapshots.set(snapshot.project.id, tamperedSnapshot);
  }

  getHeadRevision(projectId: string): string {
    return `revision-${this.revisions.get(projectId)!}`;
  }

  getProposalSaveRevision(projectId: string): string | undefined {
    return this.proposalSaveRevisions.get(projectId);
  }
}

describe("L3 proposal security port", () => {
  it("exposes one atomic description operation and digest material without a stored digest", () => {
    expectTypeOf<keyof L3ProposalSecurityPort>().toEqualTypeOf<"describe">();
    expectTypeOf<L3CanonicalDigestMaterial>().not.toHaveProperty("digest");
  });

  it("rolls back a proposal when lossy storage changes persisted payload", async () => {
    const storage = new LossyPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Lossy payload contract",
      firstVersion: null,
      actor: TEST_ACTOR
    });

    await expect(
      service.createVersion({
        projectId: created.project.id,
        title: "Dropped normalized payload",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: {
        proposedDigest: expect.any(String),
        persistedDigest: expect.any(String),
        rebuiltDigest: expect.any(String),
        rollbackStatus: "rolled_back",
        rollbackError: null,
        linkedApprovalArtifactIds: []
      }
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toEqual([]);
  });

  it("rolls back a proposal when lossy storage changes its persisted gate", async () => {
    const storage = new GateTamperingPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);

    await expect(
      service.proposeL3Operation({
        projectId: prepared.projectId,
        actionType: "start_version",
        targetId: prepared.versionId,
        reason: "Tampered start gate",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: { rollbackStatus: "rolled_back" }
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations).toEqual([]);
  });

  it("does not roll back a mismatched proposal after a linked approval appears", async () => {
    const storage = new RevisionAwareLinkedApprovalTamperingStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Revision-aware linked approval contract",
      firstVersion: {
        title: "Initial Version",
        description: "",
        initialTodos: []
      },
      actor: TEST_ACTOR
    });
    await service.prepareVersion({
      projectId: created.project.id,
      versionId: created.firstVersion!.id,
      actor: TEST_ACTOR
    });
    const prepared = { projectId: created.project.id, versionId: created.firstVersion!.id };

    await expect(
      service.proposeL3Operation({
        projectId: prepared.projectId,
        actionType: "start_version",
        targetId: prepared.versionId,
        reason: "Linked approval blocks rollback",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: {
        rollbackStatus: "skipped_concurrent_change",
        rollbackError: null,
        linkedApprovalArtifactIds: expect.arrayContaining([expect.stringMatching(/^linked-/)])
      }
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations).toHaveLength(1);
    expect(snapshot?.approvalArtifacts).toHaveLength(1);
    expect(getProjectAggregateHeadRevision(snapshot!)).toBe(
      storage.getHeadRevision(prepared.projectId)
    );
    expect(storage.getProposalSaveRevision(prepared.projectId)).toBe(
      getProjectAggregateHeadRevision(snapshot!)
    );
  });
});
