import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore,
  MemoryExactAuthorizationStore,
  type ExactProposalDecisionRequest,
  type L3AuthorizationGrantContext
} from "@routeledger/core";

import { CodexL3DecisionAdapter } from "../codex-l3-decision-adapter.js";

const request: ExactProposalDecisionRequest = {
  proposalId: "proposal-1",
  projectId: "project-1",
  actionType: "start_version",
  targetId: "version-1",
  operationDigest: "operation-digest-1",
  proposalCreatedAt: "2026-08-12T00:00:00.000Z"
};

const context: L3AuthorizationGrantContext = {
  audience: "routeledger-core",
  subjectId: "codex-approver",
  projectId: request.projectId,
  routeledgerRootDigest: "root-digest-1",
  actionType: request.actionType,
  targetId: request.targetId,
  operationDigest: request.operationDigest,
  now: "2026-08-12T00:00:00.000Z",
  hostKind: "codex",
  clientId: "codex-client",
  sessionId: "codex-session"
};

describe("CodexL3DecisionAdapter", () => {
  it("issues an exact single-use capability after Codex admits the high-risk tool call", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    const exactStore = new MemoryExactAuthorizationStore();
    const ids = ["grant-1", "decision-1", "nonce-1"];
    const adapter = new CodexL3DecisionAdapter({
      authorizationContext: context,
      grantStore: store,
      exactStore,
      sessionId: "codex-session",
      nextId: () => ids.shift()!,
      now: () => new Date("2026-08-12T00:00:00.000Z")
    });

    const resolution = await adapter.resolve(request);
    expect(resolution).toEqual({
      status: "resolved",
      decision: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest,
        source: "host_admission",
        decisionRef: "codex-tool-call-decision-1",
        authorizationGrantId: "grant-1"
      }
    });

    await expect(store.get("grant-1")).resolves.toBeNull();
    await expect(exactStore.get("grant-1")).resolves.toMatchObject({
      issuer: "codex-native-tool-admission",
      binding: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest
      },
      source: "host_admission",
      hostKind: "codex",
      sessionId: null
    });
  });
});
