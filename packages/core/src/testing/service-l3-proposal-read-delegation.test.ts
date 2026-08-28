import { describe, expect, it, vi } from "vitest";

import { L3ProposalReadService } from "../application/l3-proposal-read-service.js";
import type { PendingOperation } from "../application/types.js";
import { RouteLedgerService } from "../index.js";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTestDependencies,
  createVersionFixture
} from "./builders.js";
import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";

const createProposal = (id: string, createdAt: string): PendingOperation => ({
  id,
  projectId: "project-1",
  actionType: "start_version",
  targetId: "version-1",
  status: "pending",
  reason: id,
  reasonSource: "explicit_input",
  gateSnapshot: {
    kind: "none",
    evaluatedAt: createdAt,
    allowed: true,
    blockers: []
  },
  digest: {
    algorithm: "sha256",
    value: id.padEnd(64, "0"),
    payload: {}
  },
  payload: {},
  createdBy: TEST_ACTOR,
  createdAt,
  updatedAt: createdAt,
  committedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalArtifactId: null
});

describe("RouteLedgerService L3 proposal read delegation", () => {
  it("delegates proposal reads while preserving ordering and not-found errors", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProjectAggregate({
      headRevision: null,
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [createVersionFixture({ id: "version-1", isCurrent: true })],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [
        createProposal("proposal-late", "2026-06-27T02:00:00.000Z"),
        createProposal("proposal-early", "2026-06-27T01:00:00.000Z")
      ],
      approvalArtifacts: []
    });
    const deps = createTestDependencies();
    const listL3Proposals = vi.spyOn(L3ProposalReadService.prototype, "listL3Proposals");
    const getL3Proposal = vi.spyOn(L3ProposalReadService.prototype, "getL3Proposal");
    const service = new RouteLedgerService({ storage, deps });

    const proposals = await service.listL3Proposals("project-1");
    const proposal = await service.getL3Proposal("project-1", "proposal-late");

    expect(listL3Proposals).toHaveBeenCalledWith("project-1");
    expect(getL3Proposal).toHaveBeenCalledWith("project-1", "proposal-late");
    expect(proposals.map((item) => item.id)).toEqual([
      "proposal-early",
      "proposal-late"
    ]);
    expect(proposal.id).toBe("proposal-late");

    await expect(
      service.getL3Proposal("project-1", "proposal-missing")
    ).rejects.toMatchObject({
      name: "ApplicationError",
      code: "PENDING_OPERATION_NOT_FOUND",
      details: {
        projectId: "project-1",
        pendingOperationId: "proposal-missing"
      }
    });
    expect(getL3Proposal).toHaveBeenLastCalledWith(
      "project-1",
      "proposal-missing"
    );
  });

  it("projects persisted proposal authorization facts through the read facade without saving", async () => {
    const storage = new MemoryStorageAdapter();
    const storedProposal = createProposal("proposal-stored", "2026-06-27T01:00:00.000Z");
    storedProposal.targetId = "version-2";
    storedProposal.gateSnapshot = {
      kind: "start",
      evaluatedAt: "persisted-gate-time",
      allowed: true,
      blockers: [
        {
          code: "PERSISTED_BLOCKER",
          message: "keep the stored gate",
          recordIds: ["persisted-record"]
        }
      ],
      openTodoIds: ["persisted-record"],
      dueUndoIds: [],
      dueDeferredIds: [],
      missingDecisionRefs: [],
      blockedConstraintIds: []
    };
    storedProposal.digest = {
      algorithm: "sha256",
      value: "persisted-digest-value",
      payload: { intentionally: "not rebuilt" }
    };
    await storage.saveProjectAggregate({
      headRevision: null,
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [
        createVersionFixture({ id: "version-1", isCurrent: true, nextVersionId: "version-2" }),
        createVersionFixture({ id: "version-2", order: 2, previousVersionId: "version-1" })
      ],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [storedProposal],
      approvalArtifacts: []
    });
    const deps = createTestDependencies();
    deps.clock = { now: () => "2026-06-27T03:00:00.000Z" };
    const getContext = vi.spyOn(
      L3ProposalReadService.prototype,
      "getL3AuthorizationEvaluationContext"
    );
    const recommendPolicy = vi.spyOn(
      L3ProposalReadService.prototype,
      "recommendBalancedL3AuthorizationPolicy"
    );
    const saveProjectAggregate = vi.spyOn(storage, "saveProjectAggregate");
    const service = new RouteLedgerService({ storage, deps });

    const context = await service.getL3AuthorizationEvaluationContext({
      projectId: "project-1",
      pendingOperationId: "proposal-stored",
      routeledgerRootDigest: "root-digest",
      profileId: "profile-1",
      modeEpoch: 3,
      profileDigest: "profile-digest",
      subjectId: "subject-1",
      hostKind: "codex",
      clientId: "client-1"
    });
    const policy = await service.recommendBalancedL3AuthorizationPolicy({
      projectId: "project-1",
      policyId: "balanced-1",
      routeledgerRootDigest: "root-digest",
      expiresAt: "2026-06-28T00:00:00.000Z",
      decisionBudget: 4,
      subjectId: "subject-1",
      hostKind: "codex",
      clientId: "client-1"
    });

    expect(getContext).toHaveBeenCalledOnce();
    expect(recommendPolicy).toHaveBeenCalledOnce();
    expect(context).toMatchObject({
      actionType: storedProposal.actionType,
      targetId: "version-2",
      currentVersionId: "version-1",
      targetRelation: "legal-successor",
      gateAllowed: true,
      operationDigest: "persisted-digest-value",
      now: "2026-06-27T03:00:00.000Z",
      profileId: "profile-1",
      modeEpoch: 3,
      profileDigest: "profile-digest",
      subjectId: "subject-1",
      hostKind: "codex",
      clientId: "client-1"
    });
    expect(policy).toMatchObject({
      policyId: "balanced-1",
      binding: {
        projectId: "project-1",
        routeledgerRootDigest: "root-digest",
        subjectId: "subject-1",
        hostKind: "codex",
        clientId: "client-1"
      },
      rules: expect.arrayContaining([
        expect.objectContaining({
          resources: { targetIds: ["version-1", "version-2"] },
          conditions: expect.objectContaining({
            requiredCurrentVersionId: "version-1",
            expiresAt: "2026-06-28T00:00:00.000Z",
            decisionBudget: 4
          })
        })
      ])
    });
    expect(saveProjectAggregate).not.toHaveBeenCalled();
  });
});
