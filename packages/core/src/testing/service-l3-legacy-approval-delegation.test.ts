import { afterEach, describe, expect, it, vi } from "vitest";

import { L3LegacyApprovalService } from "../application/l3-legacy-approval-service.js";
import {
  MemoryExactAuthorizationStore,
  MemoryExactCommitCoordinator,
  RouteLedgerService
} from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { MemoryStorageAdapter, createPreparedProject } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService L3 legacy approval delegation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates legacy approval and rejection to the cohesive application service", async () => {
    const approveL3Operation = vi.spyOn(L3LegacyApprovalService.prototype, "approveL3Operation");
    const rejectL3Operation = vi.spyOn(L3LegacyApprovalService.prototype, "rejectL3Operation");
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const approvalProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy approval delegation",
      actor: TEST_ACTOR
    });
    const approvalInput = {
      projectId: prepared.projectId,
      pendingOperationId: approvalProposal.id,
      approver: TEST_ACTOR,
      actor: TEST_ACTOR
    };

    await service.approveL3Operation(approvalInput);

    const rejectionProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy rejection delegation",
      actor: TEST_ACTOR
    });
    const rejectionInput = {
      projectId: prepared.projectId,
      pendingOperationId: rejectionProposal.id,
      reason: "review declined",
      actor: TEST_ACTOR
    };

    await service.rejectL3Operation(rejectionInput);

    expect(approveL3Operation).toHaveBeenCalledWith(approvalInput);
    expect(rejectL3Operation).toHaveBeenCalledWith(rejectionInput);
  });

  it("preserves legacy artifact defaults, audit metadata, rejection fields, and trusted-plane denial", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const approvalProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy approval contract",
      actor: TEST_ACTOR
    });

    const artifact = await service.approveL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: approvalProposal.id,
      approver: TEST_ACTOR,
      actor: TEST_ACTOR
    });

    expect(artifact).toMatchObject({
      projectId: prepared.projectId,
      pendingOperationId: approvalProposal.id,
      actionType: approvalProposal.actionType,
      targetId: approvalProposal.targetId,
      digest: approvalProposal.digest,
      status: "approved",
      approver: TEST_ACTOR,
      decisionRef: expect.stringMatching(/^decision_id-/),
      createdAt: "2026-06-27T00:00:00.000Z",
      expiresAt: "2026-06-27T01:00:00.000Z",
      consumedAt: null
    });
    let snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.events).toContainEqual(
      expect.objectContaining({
        targetId: artifact.id,
        eventType: "approval_artifact.approved",
        operationSeq: 1,
        createdAt: artifact.createdAt,
        metadata: {
          pendingOperationId: approvalProposal.id,
          decisionRef: artifact.decisionRef,
          expiresAt: artifact.expiresAt,
          approverId: TEST_ACTOR.id,
          approverType: TEST_ACTOR.type,
          approverDisplayName: TEST_ACTOR.displayName
        }
      })
    );
    const rejectionProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy rejection contract",
      actor: TEST_ACTOR
    });
    const rejected = await service.rejectL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: rejectionProposal.id,
      reason: "review declined",
      actor: TEST_ACTOR
    });

    expect(rejected).toMatchObject({
      id: rejectionProposal.id,
      status: "rejected",
      updatedAt: "2026-06-27T00:00:00.000Z",
      rejectedAt: "2026-06-27T00:00:00.000Z",
      rejectionReason: "review declined"
    });
    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.events).toContainEqual(
      expect.objectContaining({
        targetId: rejected.id,
        eventType: "pending_operation.rejected",
        fromState: "pending",
        toState: "rejected",
        note: "review declined",
        operationSeq: 1,
        createdAt: rejected.updatedAt
      })
    );
    await expect(
      service.rejectL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: rejected.id,
        reason: "reject twice",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_NOT_PENDING",
      message: "pending operation 不是待拒绝状态",
      details: { pendingOperationId: rejected.id, status: "rejected" }
    });

    const localeGuardProposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "legacy approval locale guard",
      actor: TEST_ACTOR
    });
    await storage.mutate(prepared.projectId, (current) => ({
      ...current,
      project: { ...current.project, settings: { ...current.project.settings, contentLocale: null } }
    }));
    await expect(
      service.approveL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: localeGuardProposal.id,
        approver: TEST_ACTOR,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "CONTENT_LOCALE_REQUIRED",
      message:
        "Project content_locale is null. Confirm and set a concrete locale before writing project state.",
      details: { projectId: prepared.projectId }
    });
    snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations.find((item) => item.id === localeGuardProposal.id)).toMatchObject({
      status: "pending"
    });

    const trustedStorage = new MemoryStorageAdapter();
    const trustedService = new RouteLedgerService({
      storage: trustedStorage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: new MemoryExactAuthorizationStore(),
        commitCoordinator: new MemoryExactCommitCoordinator({
          currentProcess: {
            processId: 1,
            processStartedAt: "2026-06-27T00:00:00.000Z",
            instanceId: "legacy-approval-contract"
          },
          leaseDurationMs: 60_000,
          now: () => "2026-06-27T00:00:00.000Z",
          resolveOwnerLiveness: async () => "alive"
        }),
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root",
        hostKind: "codex"
      }
    });
    const trustedPrepared = await createPreparedProject(trustedService, trustedStorage);
    const trustedProposal = await trustedService.proposeL3Operation({
      projectId: trustedPrepared.projectId,
      actionType: "start_version",
      targetId: trustedPrepared.versionId,
      reason: "trusted legacy denial",
      actor: TEST_ACTOR
    });

    await expect(
      trustedService.approveL3Operation({
        projectId: trustedPrepared.projectId,
        pendingOperationId: trustedProposal.id,
        approver: TEST_ACTOR,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "EXACT_AUTHORIZATION_REJECTED",
      message: "Legacy L3 approval cannot bypass the configured trusted authorization control plane",
      details: {
        pendingOperationId: trustedProposal.id,
        reason: "LEGACY_APPROVAL_DISABLED"
      }
    });
  });
});
