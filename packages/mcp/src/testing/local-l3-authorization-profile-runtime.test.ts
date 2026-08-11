import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBalancedL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  type L3AuthorizationConsumptionReceipt,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationGrant,
  type L3AuthorizationProfileV2,
  type L3AuthorizationReceiptBinding
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
    schemaVersion: 2,
    profileId: "profile-1",
    status: "active",
    binding,
    mode: "delegated",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: policy,
    limits: { maxGrantTtlSeconds: 300, maxGrantUses: 5 },
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

const receiptFor = (
  profile: L3AuthorizationProfileV2,
  grant: L3AuthorizationGrant,
  suffix: string
): L3AuthorizationConsumptionReceipt => ({
  approvalArtifactId: `artifact-${suffix}`,
  pendingOperationId: `pending-${suffix}`,
  grantId: grant.id,
  audience: grant.audience,
  subjectId: grant.subjectId,
  projectId: grant.projectId,
  routeledgerRootDigest: grant.routeledgerRootDigest,
  profileId: profile.profileId,
  modeEpoch: profile.modeEpoch,
  profileDigest: profile.profileDigest,
  actionType: "start_version",
  targetId: "version-2",
  operationDigest: grant.operationDigest!,
  approvalSource: "delegated_policy",
  decisionRef: grant.decisionId,
  approverId: profile.binding.subjectId,
  approverType: "user",
  approverDisplayName: "Local user",
  policyId: grant.policyId,
  policyDigest: grant.policyDigest,
  hostKind: profile.binding.hostKind,
  clientId: profile.binding.trustedClientId,
  sessionId: null,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  consumedUse: 1,
  status: "authorized",
  commitClaimId: null,
  commitClaimedAt: null,
  committedAt: null,
  revokedAt: null
});

const bindingFor = (
  receipt: L3AuthorizationConsumptionReceipt
): L3AuthorizationReceiptBinding => ({
  approvalArtifactId: receipt.approvalArtifactId,
  pendingOperationId: receipt.pendingOperationId,
  grantId: receipt.grantId,
  audience: receipt.audience,
  subjectId: receipt.subjectId,
  projectId: receipt.projectId,
  routeledgerRootDigest: receipt.routeledgerRootDigest,
  profileId: receipt.profileId,
  modeEpoch: receipt.modeEpoch,
  profileDigest: receipt.profileDigest,
  actionType: receipt.actionType,
  targetId: receipt.targetId,
  operationDigest: receipt.operationDigest,
  approvalSource: receipt.approvalSource,
  decisionRef: receipt.decisionRef,
  approverId: receipt.approverId,
  approverType: receipt.approverType,
  approverDisplayName: receipt.approverDisplayName,
  policyId: receipt.policyId,
  policyDigest: receipt.policyDigest,
  hostKind: receipt.hostKind,
  clientId: receipt.clientId,
  sessionId: receipt.sessionId,
  createdAt: receipt.createdAt,
  expiresAt: receipt.expiresAt
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local L3 authorization profile runtime", () => {
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
      authority.requestGrant({
        authorityHandle: authority.authorityHandle,
        proposal: {} as never,
        context: { ...contextFor(fixture.profile), modeEpoch: 2 }
      })
    ).resolves.toMatchObject({ effect: "deny", code: "PROFILE_PROVENANCE_MISMATCH" });

    const decision = await authority.requestGrant({
      authorityHandle: authority.authorityHandle,
      proposal: {} as never,
      context: contextFor(fixture.profile)
    });
    expect(decision).toMatchObject({
      effect: "allow",
      grant: {
        profileId: fixture.profile.profileId,
        modeEpoch: fixture.profile.modeEpoch,
        profileDigest: fixture.profile.profileDigest,
        scope: "operation",
        maxUses: 1
      }
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await runtime.grantStore.issue(decision.grant);

    const restarted = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    await expect(restarted.grantStore.get(decision.grant.id)).resolves.toMatchObject({
      profileId: fixture.profile.profileId,
      modeEpoch: 1,
      status: "active"
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
    const decision = await authority.requestGrant({
      authorityHandle: authority.authorityHandle,
      proposal: {} as never,
      context: contextFor(fixture.profile)
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await runtime.grantStore.issue(decision.grant);

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
    await expect(next.grantStore.get(decision.grant.id)).resolves.toMatchObject({
      status: "revoked"
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
    const first = await authority.requestGrant({
      authorityHandle: authority.authorityHandle,
      proposal: {} as never,
      context: contextFor(fixture.profile)
    });
    if (first.effect !== "allow") throw new Error("expected delegated grant");
    const revokedReceipt = receiptFor(fixture.profile, first.grant, "revoked");
    await runtime.grantStore.recordConsumptionReceipt(revokedReceipt);

    await expect(
      runtime.grantStore.revokeProfileReceipts(
        fixture.profile.profileId,
        fixture.profile.modeEpoch + 1,
        "2026-08-11T02:00:00.000Z"
      )
    ).resolves.toBe(1);
    await expect(
      runtime.grantStore.claimCommit(bindingFor(revokedReceipt), {
        claimId: "claim-too-late",
        claimedAt: "2026-08-11T02:00:01.000Z"
      })
    ).resolves.toEqual({ ok: false, code: "RECEIPT_REVOKED" });
    await expect(
      runtime.grantStore.findConsumedAuthorization(
        {
          audience: revokedReceipt.audience,
          subjectId: revokedReceipt.subjectId,
          projectId: revokedReceipt.projectId,
          routeledgerRootDigest: revokedReceipt.routeledgerRootDigest,
          profileId: revokedReceipt.profileId,
          modeEpoch: revokedReceipt.modeEpoch,
          profileDigest: revokedReceipt.profileDigest,
          actionType: revokedReceipt.actionType,
          targetId: revokedReceipt.targetId,
          operationDigest: revokedReceipt.operationDigest,
          now: "2026-08-11T02:00:01.000Z",
          hostKind: revokedReceipt.hostKind!,
          clientId: revokedReceipt.clientId ?? undefined
        },
        revokedReceipt.pendingOperationId
      )
    ).resolves.toBeNull();

    const second = await authority.requestGrant({
      authorityHandle: authority.authorityHandle,
      proposal: {} as never,
      context: { ...contextFor(fixture.profile), operationDigest: "operation-2" }
    });
    if (second.effect !== "allow") throw new Error("expected delegated grant");
    const claimedReceipt = receiptFor(fixture.profile, second.grant, "claimed");
    await runtime.grantStore.recordConsumptionReceipt(claimedReceipt);
    await expect(
      runtime.grantStore.claimCommit(bindingFor(claimedReceipt), {
        claimId: "claim-wins",
        claimedAt: "2026-08-11T02:00:02.000Z"
      })
    ).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(
      runtime.grantStore.revokeProfileReceipts(
        fixture.profile.profileId,
        fixture.profile.modeEpoch + 1,
        "2026-08-11T02:00:03.000Z"
      )
    ).resolves.toBe(0);

    const restarted = await loadLocalL3AuthorityProfileRuntime({
      ...fixture,
      hostKind: "codex",
      subjectId: "local-user"
    });
    await expect(
      restarted.grantStore.finalizeCommit(
        bindingFor(claimedReceipt),
        "claim-wins",
        "2026-08-11T02:00:04.000Z"
      )
    ).resolves.toMatchObject({ ok: true, receipt: { status: "committed" } });
  });
});
