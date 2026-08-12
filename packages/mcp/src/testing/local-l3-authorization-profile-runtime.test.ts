import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBalancedL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  type ExactAuthorizationCandidate,
  type L3AuthorizationConsumptionReceipt,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationProfileV2,
  type PendingOperation
} from "@routeledger/core";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocalL3AuthorityProfileRuntime } from "../local-l3-authorization.js";
import { buildLocalL3AuthorityBindingIdentity } from "../local-l3-authority-registry.js";

const roots: string[] = [];

const createFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-profile-runtime-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const routeledgerRoot = path.join(root, "routeledger-data");
  const authorityRoot = path.join(root, "host-authority");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(routeledgerRoot, { recursive: true });
  await fs.mkdir(authorityRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(authorityRoot, 0o700);
  const binding = await buildLocalL3AuthorityBindingIdentity({
    projectId: "project-1",
    workspaceRoot,
    routeledgerRoot,
    subjectId: "local-user",
    hostKind: "codex",
    trustedClientId: "codex-desktop"
  });
  const policy = buildBalancedL3AuthorizationPolicy({
    policyId: "policy-1",
    projectId: binding.projectId,
    routeledgerRootDigest: binding.routeledgerRootDigest,
    currentVersionId: "version-1",
    routeVersionIds: ["version-1", "version-2"],
    expiresAt: "2026-08-12T00:00:00.000Z",
    maxUses: 2,
    subjectId: binding.subjectId,
    hostKind: binding.hostKind,
    clientId: binding.trustedClientId ?? undefined
  });
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 3,
    profileId: "profile-1",
    status: "active",
    binding,
    mode: "delegated",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: policy,
    limits: { maxAuthorizationTtlSeconds: 300 },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
  const profile = { ...base, profileDigest: digestL3AuthorizationProfile(base) };
  return {
    workspaceRoot,
    routeledgerRoot,
    statePath: path.join(authorityRoot, "state.json"),
    profile
  };
};

const contextFor = (profile: L3AuthorizationProfileV2): L3AuthorizationEvaluationContext => ({
  projectId: profile.binding.projectId,
  routeledgerRootDigest: profile.binding.routeledgerRootDigest,
  profileId: profile.profileId,
  modeEpoch: profile.modeEpoch,
  profileDigest: profile.profileDigest,
  actionType: "start_version",
  targetId: "version-2",
  currentVersionId: "version-1",
  targetRelation: "legal-successor",
  gateAllowed: true,
  operationDigest: "operation-1",
  now: "2026-08-11T01:00:00.000Z",
  subjectId: profile.binding.subjectId,
  hostKind: profile.binding.hostKind,
  clientId: profile.binding.trustedClientId ?? undefined
});

const proposalFor = (context: L3AuthorizationEvaluationContext): PendingOperation => ({
  id: `proposal-${context.operationDigest}`,
  projectId: context.projectId,
  actionType: context.actionType,
  targetId: context.targetId,
  status: "pending",
  reason: "profile exact decision",
  gateSnapshot: { kind: "none", evaluatedAt: context.now, allowed: true, blockers: [] },
  digest: { algorithm: "sha256", value: context.operationDigest, payload: {} },
  payload: {},
  createdBy: { id: "test", type: "agent" },
  createdAt: context.now,
  updatedAt: context.now,
  committedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalArtifactId: null
});

const receiptFor = (
  profile: L3AuthorizationProfileV2,
  authorization: ExactAuthorizationCandidate,
  suffix: string
): L3AuthorizationConsumptionReceipt => ({
  approvalArtifactId: `artifact-${suffix}`,
  pendingOperationId: `pending-${suffix}`,
  grantId: authorization.authorizationId,
  audience: authorization.audience,
  subjectId: authorization.subjectId,
  projectId: authorization.binding.projectId,
  routeledgerRootDigest: authorization.binding.routeledgerRootDigest,
  profileId: profile.profileId,
  modeEpoch: profile.modeEpoch,
  profileDigest: profile.profileDigest,
  actionType: "start_version",
  targetId: "version-2",
  operationDigest: authorization.binding.operationDigest,
  approvalSource: "delegated_policy",
  decisionRef: authorization.decisionRef,
  approverId: profile.binding.subjectId,
  approverType: "user",
  approverDisplayName: "Local user",
  policyId: authorization.policyId,
  policyDigest: authorization.policyDigest,
  hostKind: profile.binding.hostKind,
  clientId: profile.binding.trustedClientId,
  sessionId: null,
  createdAt: authorization.createdAt,
  expiresAt: authorization.expiresAt,
  consumedUse: 1,
  status: "authorized",
  commitClaimId: null,
  commitClaimedAt: null,
  committedAt: null,
  revokedAt: null
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local L3 authorization profile runtime", () => {
  it("uses a preauthorized standing policy to mint a distinct exact decision per proposal", async () => {
    const fixture = await createFixture();
    const standingBase: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
      ...fixture.profile,
      mode: "preauthorized",
      profileRevision: 2,
      updatedAt: "2026-08-11T00:01:00.000Z"
    };
    const profile = {
      ...standingBase,
      profileDigest: digestL3AuthorizationProfile(standingBase)
    };
    const runtime = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      profile,
      hostKind: "codex",
      subjectId: "local-user"
    });
    const authority = runtime.delegatedAuthority!;
    const firstContext = contextFor(profile);
    const secondContext = { ...firstContext, operationDigest: "operation-2" };
    const first = await authority.requestExactDecision({
      authorityHandle: authority.authorityHandle,
      proposal: proposalFor(firstContext),
      context: firstContext
    });
    const second = await authority.requestExactDecision({
      authorityHandle: authority.authorityHandle,
      proposal: proposalFor(secondContext),
      context: secondContext
    });
    expect(first).toMatchObject({
      effect: "allow",
      authorization: {
        source: "preauthorized",
        binding: { proposalId: "proposal-operation-1", operationDigest: "operation-1" }
      }
    });
    expect(second).toMatchObject({
      effect: "allow",
      authorization: {
        source: "preauthorized",
        binding: { proposalId: "proposal-operation-2", operationDigest: "operation-2" }
      }
    });
    if (first.effect !== "allow" || second.effect !== "allow") throw new Error("expected allow");
    expect(first.authorization.authorizationId).not.toBe(second.authorization.authorizationId);
  });

  it("issues and recovers an exact delegated grant with profile provenance", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    expect(runtime.delegatedAuthority).toBeDefined();
    const authority = runtime.delegatedAuthority!;
    await expect(
      authority.requestExactDecision({
        authorityHandle: authority.authorityHandle,
        proposal: proposalFor(contextFor(fixture.profile)),
        context: { ...contextFor(fixture.profile), modeEpoch: 2 }
      })
    ).resolves.toMatchObject({ effect: "deny", code: "PROFILE_PROVENANCE_MISMATCH" });

    const decision = await authority.requestExactDecision({
      authorityHandle: authority.authorityHandle,
      proposal: proposalFor(contextFor(fixture.profile)),
      context: contextFor(fixture.profile)
    });
    expect(decision).toMatchObject({
      effect: "allow",
      authorization: {
        profileId: fixture.profile.profileId,
        modeEpoch: fixture.profile.modeEpoch,
        profileDigest: fixture.profile.profileDigest,
        binding: { proposalId: "proposal-operation-1", operationDigest: "operation-1" }
      }
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");

    const restarted = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    await expect(restarted.exactStore.get(decision.authorization.authorizationId)).resolves.toMatchObject({
      profileId: fixture.profile.profileId,
      modeEpoch: 1,
      binding: { operationDigest: "operation-1" }
    });
  });

  it("revokes outstanding grants when the profile epoch rotates", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    const authority = runtime.delegatedAuthority!;
    const decision = await authority.requestExactDecision({
      authorityHandle: authority.authorityHandle,
      proposal: proposalFor(contextFor(fixture.profile)),
      context: contextFor(fixture.profile)
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");

    const rotatedBase: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
      schemaVersion: fixture.profile.schemaVersion,
      profileId: fixture.profile.profileId,
      status: "disabled",
      binding: fixture.profile.binding,
      mode: "interactive",
      modeEpoch: 2,
      profileRevision: 2,
      delegatedPolicy: null,
      limits: fixture.profile.limits,
      createdAt: fixture.profile.createdAt,
      updatedAt: "2026-08-11T02:00:00.000Z"
    };
    const rotated = {
      ...rotatedBase,
      profileDigest: digestL3AuthorizationProfile(rotatedBase)
    };
    const next = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      profile: rotated,
      hostKind: "codex",
      subjectId: "local-user"
    });
    expect(next.delegatedAuthority).toBeUndefined();
    await expect(next.exactStore.get(decision.authorization.authorizationId)).resolves.toMatchObject({
      profileId: fixture.profile.profileId,
      modeEpoch: 1
    });
  });

  it("persists revoke-versus-commit ordering and does not replay revoked receipts", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    const authority = runtime.delegatedAuthority!;
    const first = await authority.requestExactDecision({
      authorityHandle: authority.authorityHandle,
      proposal: proposalFor(contextFor(fixture.profile)),
      context: contextFor(fixture.profile)
    });
    if (first.effect !== "allow") throw new Error("expected delegated grant");
    const revokedReceipt = receiptFor(fixture.profile, first.authorization, "revoked");
    await expect(runtime.grantStore.recordConsumptionReceipt(revokedReceipt))
      .rejects.toThrow("audit-only");
    const candidate = await runtime.exactStore.get(first.authorization.authorizationId);
    if (candidate === null) throw new Error("expected exact authorization");
    const consumed = await runtime.exactStore.consumeAndRecordReceipt({
      authorizationId: candidate.authorizationId,
      artifactId: "artifact-revoked",
      binding: candidate.binding,
      now: candidate.createdAt
    });
    expect(consumed.ok).toBe(true);

    await expect(
      runtime.exactStore.revokeProfileReceipts(
        fixture.profile.profileId,
        fixture.profile.modeEpoch + 1,
        "2026-08-11T02:00:00.000Z"
      )
    ).resolves.toBe(1);
    await expect(
      runtime.exactStore.claimCommit({
        authorizationId: candidate.authorizationId,
        artifactId: "artifact-revoked",
        binding: candidate.binding,
        issuer: candidate.issuer,
        audience: candidate.audience,
        subjectId: candidate.subjectId,
        source: candidate.source,
        decisionRef: candidate.decisionRef,
        policyId: candidate.policyId,
        policyDigest: candidate.policyDigest,
        profileId: candidate.profileId,
        modeEpoch: candidate.modeEpoch,
        profileDigest: candidate.profileDigest,
        hostKind: candidate.hostKind,
        clientId: candidate.clientId,
        createdAt: candidate.createdAt,
        expiresAt: candidate.expiresAt
      }, {
        claimId: "claim-too-late",
        claimedAt: "2026-08-11T02:00:01.000Z"
      })
    ).resolves.toEqual({ ok: false, code: "RECEIPT_REVOKED" });
  });
});
