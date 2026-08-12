import { describe, expect, it } from "vitest";

import {
  createExactProposalDecisionRequest,
  digestL3AuthorizationProfile,
  MemoryL3AuthorizationGrantStore,
  type L3AuthorizationConsumptionReceipt,
  type L3AuthorizationGrant,
  type L3AuthorizationGrantContext,
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

const context: L3AuthorizationGrantContext = {
  audience: "routeledger-core",
  subjectId: "user-1",
  projectId: "project-1",
  routeledgerRootDigest: "root-digest-1",
  actionType: "start_version",
  targetId: "version-1",
  operationDigest: "digest-1",
  now: "2026-08-11T00:00:10.000Z",
  hostKind: "generic",
  clientId: "client-1",
  sessionId: "session-1"
};

const grant = (
  source: L3AuthorizationGrant["source"] = "preauthorized"
): L3AuthorizationGrant => ({
  id: `grant-${source}`,
  issuer: "trusted-host",
  subjectId: context.subjectId,
  audience: context.audience,
  projectId: context.projectId,
  routeledgerRootDigest: context.routeledgerRootDigest,
  allowedActions: [context.actionType],
  allowedTargetIds: [context.targetId],
  operationDigest: context.operationDigest,
  scope: "operation",
  source,
  policyId: source === "delegated_policy" ? "policy-1" : null,
  policyDigest: source === "delegated_policy" ? "policy-digest-1" : null,
  decisionId: `decision-${source}`,
  hostKind: context.hostKind,
  clientId: context.clientId ?? null,
  sessionId: context.sessionId ?? null,
  nonce: `nonce-${source}`,
  createdAt: "2026-08-11T00:00:00.000Z",
  expiresAt: "2026-08-11T01:00:00.000Z",
  maxUses: 1,
  uses: 0,
  status: "active",
  revokedAt: null
});

const adapter = (
  store: MemoryL3AuthorizationGrantStore,
  overrides: Partial<ConstructorParameters<typeof ExistingL3DecisionAdapter>[0]> = {}
) =>
  new ExistingL3DecisionAdapter({
    proposal,
    authorizationContext: context,
    grantStore: store,
    interaction: {
      requestAuthorization: async () => {
        throw new Error("interaction must not be used");
      }
    },
    sessionId: "session-1",
    hostProfile: "generic",
    trustedClientId: "client-1",
    getEvaluationContext: async () => {
      throw new Error("delegated evaluation must not be used");
    },
    ...overrides
  });

const receiptFor = (
  consumedGrant: L3AuthorizationGrant,
  consumedUse: number
): L3AuthorizationConsumptionReceipt => ({
  approvalArtifactId: "artifact-1",
  pendingOperationId: proposal.id,
  grantId: consumedGrant.id,
  audience: context.audience,
  subjectId: context.subjectId,
  projectId: context.projectId,
  routeledgerRootDigest: context.routeledgerRootDigest,
  actionType: context.actionType,
  targetId: context.targetId,
  operationDigest: context.operationDigest,
  approvalSource: consumedGrant.source,
  decisionRef: consumedGrant.decisionId,
  approverId: "user-1",
  approverType: "user",
  approverDisplayName: undefined,
  policyId: consumedGrant.policyId,
  policyDigest: consumedGrant.policyDigest,
  hostKind: context.hostKind,
  clientId: context.clientId,
  sessionId: context.sessionId,
  createdAt: "2026-08-11T00:00:10.000Z",
  expiresAt: consumedGrant.expiresAt,
  consumedUse,
  status: "authorized",
  commitClaimId: null,
  commitClaimedAt: null,
  committedAt: null,
  revokedAt: null
});

describe("ExistingL3DecisionAdapter", () => {
  it("resolves a consumed authorization replay before consulting other sources", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    const replayGrant = grant();
    await store.issue(replayGrant);
    const consumed = await store.consumeAndRecordReceipt(
      replayGrant.id,
      context,
      proposal.id,
      ({ grant: exactGrant, consumedUse }) => receiptFor(exactGrant, consumedUse)
    );
    expect(consumed.ok).toBe(true);

    await expect(adapter(store).resolve(createExactProposalDecisionRequest(proposal))).resolves.toMatchObject({
      status: "resolved",
      decision: {
        proposalId: proposal.id,
        source: "preauthorized",
        authorizationGrantId: replayGrant.id
      }
    });
  });

  it("resolves a matching finite preauthorization without delegated or interactive fallback", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    const preauthorized = grant();
    await store.issue(preauthorized);

    await expect(adapter(store).resolve(createExactProposalDecisionRequest(proposal))).resolves.toMatchObject({
      status: "resolved",
      decision: {
        source: "preauthorized",
        authorizationGrantId: preauthorized.id
      }
    });
  });

  it("preserves delegated denial details for the compatibility handler", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    const resolver = adapter(store, {
      delegatedAuthority: {
        authorityHandle: "host-vault://policy-1",
        requestGrant: async () => ({
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
    const store = new MemoryL3AuthorizationGrantStore();
    await expect(
      adapter(store).resolve({
        ...createExactProposalDecisionRequest(proposal),
        targetId: "version-other"
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "PROPOSAL_REQUEST_MISMATCH" }
    });
  });

  it("fails closed when a direct caller supplies a disabled profile", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
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
      adapter(store, { profile }).resolve(createExactProposalDecisionRequest(proposal))
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_PROFILE_DISABLED",
      details: { profileId: "profile-disabled", modeEpoch: 2 }
    });
  });
});
