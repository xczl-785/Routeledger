import { describe, expect, it } from "vitest";

import {
  createExactProposalDecisionRequest,
  digestL3AuthorizationProfile,
  MemoryExactAuthorizationStore,
  type ExactAuthorizationCandidate,
  type ExactAuthorizationContext,
  type L3AuthorizationProfileV2,
  type PendingOperation
} from "@routeledger/core";

import {
  ExistingL3DecisionAdapter,
  requireResolvedExistingL3Decision
} from "../existing-l3-decision-adapter.js";

const proposal: PendingOperation = {
  id: "proposal-1",
  projectId: "project-1",
  actionType: "start_version",
  targetId: "version-1",
  status: "pending",
  reason: "Start accepted version",
  reasonSource: "explicit_input",
  gateSnapshot: {
    kind: "none",
    evaluatedAt: "2026-08-11T00:00:00.000Z",
    allowed: true,
    blockers: []
  },
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

const context: ExactAuthorizationContext = {
  audience: "routeledger-core",
  subjectId: "user-1",
  projectId: "project-1",
  routeledgerRootDigest: "root-digest-1",
  actionType: "start_version",
  targetId: "version-1",
  operationDigest: "digest-1",
  now: "2026-08-11T00:00:10.000Z",
  hostKind: "generic",
  clientId: "client-1"
};

const adapter = (
  overrides: Partial<ConstructorParameters<typeof ExistingL3DecisionAdapter>[0]> = {}
) => new ExistingL3DecisionAdapter({
  proposal,
  authorizationContext: context,
  exactStore: new MemoryExactAuthorizationStore(),
  interaction: {
    requestAuthorization: async () => {
      throw new Error("interaction must not be used");
    }
  },
  hostProfile: "generic",
  trustedClientId: "client-1",
  getEvaluationContext: async () => {
    throw new Error("delegated evaluation must not be used");
  },
  ...overrides
});

describe("ExistingL3DecisionAdapter", () => {
  const delegatedCandidate = (): ExactAuthorizationCandidate => ({
    schemaVersion: 2,
    authorizationId: "exact-delegated-1",
    binding: {
      proposalId: proposal.id,
      projectId: proposal.projectId,
      routeledgerRootDigest: context.routeledgerRootDigest,
      actionType: proposal.actionType,
      targetId: proposal.targetId,
      operationDigest: proposal.digest.value
    },
    source: "delegated_policy",
    decisionRef: "trusted-decision-1",
    issuer: "trusted-host",
    audience: context.audience,
    subjectId: context.subjectId,
    policyId: "policy-1",
    policyDigest: "policy-digest-1",
    profileId: null,
    modeEpoch: null,
    profileDigest: null,
    hostKind: context.hostKind,
    clientId: context.clientId ?? null,
    createdAt: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T01:00:00.000Z"
  });

  it.each([
    ["issuer", (value: ExactAuthorizationCandidate) => ({ ...value, issuer: "forged" })],
    ["policy id", (value: ExactAuthorizationCandidate) => ({ ...value, policyId: "forged" })],
    ["policy digest", (value: ExactAuthorizationCandidate) => ({
      ...value,
      policyDigest: "forged"
    })],
    ["audience", (value: ExactAuthorizationCandidate) => ({ ...value, audience: "forged" })],
    ["subject", (value: ExactAuthorizationCandidate) => ({ ...value, subjectId: "forged" })],
    ["host", (value: ExactAuthorizationCandidate) => ({ ...value, hostKind: "forged" })],
    ["client", (value: ExactAuthorizationCandidate) => ({ ...value, clientId: "forged" })],
    ["profile", (value: ExactAuthorizationCandidate) => ({
      ...value,
      profileId: "forged",
      modeEpoch: 1,
      profileDigest: "forged"
    })],
    ["time", (value: ExactAuthorizationCandidate) => ({
      ...value,
      createdAt: "2026-08-11T00:00:11.000Z"
    })]
  ])("rejects delegated %s provenance mismatch before persistence", async (_label, mutate) => {
    const exactStore = new MemoryExactAuthorizationStore();
    const candidate = mutate(delegatedCandidate());
    const resolver = adapter({
      exactStore,
      delegatedAuthority: {
        authorityHandle: "host-vault://policy-1",
        issuerId: "trusted-host",
        policyId: "policy-1",
        policyDigest: "policy-digest-1",
        requestExactDecision: async () => ({ effect: "allow", authorization: candidate })
      },
      getEvaluationContext: async () => ({
        projectId: proposal.projectId,
        currentVersionId: null,
        targetRelation: "other",
        gateAllowed: true,
        actionType: proposal.actionType,
        targetId: proposal.targetId,
        operationDigest: proposal.digest.value,
        routeledgerRootDigest: context.routeledgerRootDigest,
        now: context.now,
        subjectId: context.subjectId,
        hostKind: context.hostKind,
        clientId: context.clientId
      })
    });
    await expect(resolver.resolve(createExactProposalDecisionRequest(proposal)))
      .rejects.toMatchObject({ code: "EXACT_AUTHORIZATION_REJECTED" });
    await expect(exactStore.get(candidate.authorizationId)).resolves.toBeNull();
  });

  it("rejects legacy scope content without minting exact authority", async () => {
    const exactStore = new MemoryExactAuthorizationStore();
    const resolver = adapter({
      exactStore,
      interaction: {
        requestAuthorization: async () => ({
          action: "accept",
          content: { approve: true, scope: "operation" }
        })
      }
    });

    await expect(resolver.resolve(createExactProposalDecisionRequest(proposal)))
      .rejects.toMatchObject({
        code: "EXACT_AUTHORIZATION_REJECTED",
        details: { reason: "INVALID_DECISION_RESPONSE" }
      });
    await expect(exactStore.get("grant-user_interaction")).resolves.toBeNull();
  });

  it("preserves delegated denial details for the compatibility handler", async () => {
    const resolver = adapter({
      delegatedAuthority: {
        authorityHandle: "host-vault://policy-1",
        issuerId: "trusted-host",
        policyId: "policy-1",
        policyDigest: "policy-digest-1",
        requestExactDecision: async () => ({
          effect: "deny",
          code: "POLICY_DENIED",
          policyId: "policy-1",
          policyDigest: "policy-digest-1",
          matchedRuleId: "deny-start"
        })
      },
      getEvaluationContext: async () => ({
        projectId: proposal.projectId,
        currentVersionId: null,
        targetRelation: "other",
        gateAllowed: true,
        actionType: proposal.actionType,
        targetId: proposal.targetId,
        operationDigest: proposal.digest.value,
        routeledgerRootDigest: context.routeledgerRootDigest,
        now: context.now,
        subjectId: context.subjectId,
        hostKind: context.hostKind,
        clientId: context.clientId
      })
    });
    const resolution = await resolver.resolve(createExactProposalDecisionRequest(proposal));
    expect(resolution).toMatchObject({
      status: "denied",
      code: "AUTHORIZATION_POLICY_DENIED",
      details: { decisionCode: "POLICY_DENIED", matchedRuleId: "deny-start" }
    });
    expect(() => requireResolvedExistingL3Decision(resolution)).toThrowError(
      /denied this operation/
    );
  });

  it("fails closed before any source lookup when the request does not match the proposal", async () => {
    await expect(
      adapter().resolve({
        ...createExactProposalDecisionRequest(proposal),
        targetId: "version-other"
      })
    ).rejects.toMatchObject({
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "PROPOSAL_REQUEST_MISMATCH" }
    });
  });

  it("fails closed when a direct caller supplies a disabled profile", async () => {
    const profileBase: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
      schemaVersion: 3,
      profileId: "profile-disabled",
      status: "disabled",
      binding: {
        projectId: proposal.projectId,
        workspaceRootDigest: context.routeledgerRootDigest,
        routeledgerRootDigest: context.routeledgerRootDigest,
        subjectId: context.subjectId,
        hostKind: context.hostKind,
        trustedClientId: context.clientId ?? null
      },
      mode: "interactive",
      modeEpoch: 2,
      profileRevision: 1,
      delegatedPolicy: null,
      limits: { maxAuthorizationTtlSeconds: 300 },
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
    const profile = {
      ...profileBase,
      profileDigest: digestL3AuthorizationProfile(profileBase)
    };

    await expect(
      adapter({ profile }).resolve(createExactProposalDecisionRequest(proposal))
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_PROFILE_DISABLED",
      details: { profileId: "profile-disabled", modeEpoch: 2 }
    });
  });
});
