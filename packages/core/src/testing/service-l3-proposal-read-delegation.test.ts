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
    const l3ProposalReadService = new L3ProposalReadService({ storage });
    const listL3Proposals = vi.spyOn(l3ProposalReadService, "listL3Proposals");
    const getL3Proposal = vi.spyOn(l3ProposalReadService, "getL3Proposal");
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies(),
      l3ProposalReadService
    });

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
});
