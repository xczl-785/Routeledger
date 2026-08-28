import { describe, expect, it, vi } from "vitest";

import {
  assertL3OperationRequestStateMatchesProposal,
  orchestrateL3Operation,
  type L3DecisionAdapter,
  type PendingOperation
} from "../index.js";

const proposal: PendingOperation = {
  id: "proposal-1",
  projectId: "project-1",
  actionType: "start_version",
  targetId: "version-1",
  status: "pending",
  reason: "Start",
  reasonSource: "explicit_input",
  gateSnapshot: { kind: "none", evaluatedAt: "2026-08-11T00:00:00.000Z", allowed: true, blockers: [] },
  digest: { algorithm: "sha256", value: "digest-1", payload: {} },
  payload: {},
  createdBy: { id: "agent-1", type: "agent" },
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  committedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalArtifactId: null
};

const exact = {
  proposalId: proposal.id,
  projectId: proposal.projectId,
  actionType: proposal.actionType,
  targetId: proposal.targetId,
  operationDigest: proposal.digest.value
};

const port = () => ({
  authorize: vi.fn(async () => ({ id: "artifact-1" })),
  commit: vi.fn(async () => ({ replayed: false })),
  reject: vi.fn(async () => ({ status: "rejected" }))
});

describe("L3 operation orchestrator", () => {
  it("authorizes and commits an exact resolved decision", async () => {
    const adapter: L3DecisionAdapter = {
      id: "automatic",
      resolve: async () => ({
        status: "resolved",
        decision: {
          ...exact,
          source: "delegated_policy",
          decisionRef: "decision-1",
          authorizationId: "grant-1"
        }
      })
    };
    const operations = port();

    const result = await orchestrateL3Operation({ proposal, adapter, port: operations });

    expect(result.status).toBe("committed");
    expect(operations.authorize).toHaveBeenCalledOnce();
    expect(operations.commit).toHaveBeenCalledOnce();
    expect(operations.reject).not.toHaveBeenCalled();
  });

  it("returns an exact recoverable request state without mutation", async () => {
    const adapter: L3DecisionAdapter = {
      id: "deferred-input",
      resolve: async () => ({
        status: "input_required",
        request: { ...exact, reason: "Confirm this exact operation" }
      })
    };
    const operations = port();

    const result = await orchestrateL3Operation({ proposal, adapter, port: operations });

    expect(result).toEqual({
      status: "input_required",
      requestState: {
        schemaVersion: 1,
        adapterId: "deferred-input",
        ...exact,
        reason: "Confirm this exact operation"
      }
    });
    expect(operations.authorize).not.toHaveBeenCalled();
    expect(operations.commit).not.toHaveBeenCalled();
    if (result.status !== "input_required") throw new Error("expected input-required result");
    assertL3OperationRequestStateMatchesProposal(result.requestState, proposal, "deferred-input");
  });

  it("records a denied decision without authorizing or committing", async () => {
    const adapter: L3DecisionAdapter = {
      id: "policy",
      resolve: async () => ({ status: "denied", code: "POLICY_DENIED", reason: "Out of scope" })
    };
    const operations = port();

    const result = await orchestrateL3Operation({ proposal, adapter, port: operations });

    expect(result.status).toBe("denied");
    expect(operations.reject).toHaveBeenCalledOnce();
    expect(operations.authorize).not.toHaveBeenCalled();
    expect(operations.commit).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when an adapter widens the exact request", async () => {
    const adapter: L3DecisionAdapter = {
      id: "bad-adapter",
      resolve: async () => ({
        status: "input_required",
        request: { ...exact, targetId: "version-2", reason: "Wrong target" }
      })
    };
    const operations = port();

    await expect(orchestrateL3Operation({ proposal, adapter, port: operations })).rejects.toMatchObject({
      code: "DECISION_RESOLUTION_BINDING_MISMATCH"
    });
    expect(operations.authorize).not.toHaveBeenCalled();
    expect(operations.commit).not.toHaveBeenCalled();
    expect(operations.reject).not.toHaveBeenCalled();
  });

  it("rejects request-state recovery through another adapter", () => {
    expect(() =>
      assertL3OperationRequestStateMatchesProposal(
        { schemaVersion: 1, adapterId: "old", ...exact, reason: "Confirm" },
        proposal,
        "new"
      )
    ).toThrowError(/does not match the active adapter/);
  });
});
