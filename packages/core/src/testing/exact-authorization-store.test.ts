import { describe, expect, it } from "vitest";

import {
  MemoryExactAuthorizationStore,
  type ExactAuthorizationBinding,
  type ExactAuthorizationCandidate
} from "../index.js";

const binding = (overrides: Partial<ExactAuthorizationBinding> = {}): ExactAuthorizationBinding => ({
  proposalId: "proposal-1",
  projectId: "project-1",
  routeledgerRootDigest: "root-1",
  actionType: "start_version",
  targetId: "version-1",
  operationDigest: "digest-1",
  ...overrides
});

const candidate = (
  overrides: Partial<ExactAuthorizationCandidate> = {}
): ExactAuthorizationCandidate => ({
  schemaVersion: 2,
  authorizationId: "authorization-1",
  binding: binding(),
  source: "host_admission",
  decisionRef: "decision-1",
  issuer: "codex-native-tool-admission",
  audience: "routeledger-core",
  subjectId: "user-1",
  policyId: null,
  policyDigest: null,
  profileId: null,
  modeEpoch: null,
  profileDigest: null,
  hostKind: "codex",
  clientId: "client-1",
  sessionId: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  expiresAt: "2026-08-12T01:00:00.000Z",
  ...overrides
});

const authorize = (store: MemoryExactAuthorizationStore, exactBinding = binding()) =>
  store.consumeAndRecordReceipt({
    authorizationId: "authorization-1",
    artifactId: "artifact-1",
    binding: exactBinding,
    now: "2026-08-12T00:30:00.000Z"
  });

describe("MemoryExactAuthorizationStore", () => {
  it("rejects empty identities and partial profile provenance", async () => {
    const store = new MemoryExactAuthorizationStore();
    await expect(store.issue(candidate({ authorizationId: "" }))).rejects.toThrow(
      "authorizationId is required"
    );
    await expect(
      store.issue(candidate({ profileId: "profile-1", modeEpoch: null, profileDigest: null }))
    ).rejects.toThrow("profile provenance must be all present or all null");
  });

  it("atomically authorizes once and exact-replays the same artifact", async () => {
    const store = new MemoryExactAuthorizationStore();
    await store.issue(candidate());
    await expect(authorize(store)).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(authorize(store)).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(
      store.consumeAndRecordReceipt({
        authorizationId: "authorization-1",
        artifactId: "artifact-forged",
        binding: binding(),
        now: "2026-08-12T00:30:00.000Z"
      })
    ).resolves.toEqual({ ok: false, code: "AUTHORIZATION_ARTIFACT_MISMATCH" });
  });

  it.each([
    ["proposalId", { proposalId: "proposal-2" }],
    ["projectId", { projectId: "project-2" }],
    ["routeledgerRootDigest", { routeledgerRootDigest: "root-2" }],
    ["actionType", { actionType: "close_version" as const }],
    ["targetId", { targetId: "version-2" }],
    ["operationDigest", { operationDigest: "digest-2" }]
  ])("fails closed on %s mismatch", async (_field, mismatch) => {
    const store = new MemoryExactAuthorizationStore();
    await store.issue(candidate());
    await expect(authorize(store, binding(mismatch))).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_BINDING_MISMATCH"
    });
  });

  it("rejects expiry at the exact boundary and revocation", async () => {
    const expired = new MemoryExactAuthorizationStore();
    await expired.issue(candidate({ expiresAt: "2026-08-12T00:30:00.000Z" }));
    await expect(authorize(expired)).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_EXPIRED"
    });

    const revoked = new MemoryExactAuthorizationStore();
    await revoked.issue(candidate());
    await expect(revoked.revoke("authorization-1", "2026-08-12T00:20:00.000Z"))
      .resolves.toBe(true);
    await expect(authorize(revoked)).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_INACTIVE"
    });
  });

  it("serializes commit claims, exact-replays one claim, and finalizes idempotently", async () => {
    const store = new MemoryExactAuthorizationStore();
    await store.issue(candidate());
    const authorized = await authorize(store);
    if (!authorized.ok) throw new Error(authorized.code);
    const receiptBinding = {
      authorizationId: authorized.receipt.authorizationId,
      artifactId: authorized.receipt.artifactId,
      binding: authorized.receipt.binding,
      issuer: authorized.receipt.issuer,
      audience: authorized.receipt.audience,
      subjectId: authorized.receipt.subjectId,
      source: authorized.receipt.source,
      decisionRef: authorized.receipt.decisionRef,
      policyId: authorized.receipt.policyId,
      policyDigest: authorized.receipt.policyDigest,
      profileId: authorized.receipt.profileId,
      modeEpoch: authorized.receipt.modeEpoch,
      profileDigest: authorized.receipt.profileDigest,
      hostKind: authorized.receipt.hostKind,
      clientId: authorized.receipt.clientId,
      createdAt: authorized.receipt.createdAt,
      expiresAt: authorized.receipt.expiresAt
    };
    const claims = await Promise.all([
      store.claimCommit(receiptBinding, { claimId: "claim-1", claimedAt: "2026-08-12T00:31:00.000Z" }),
      store.claimCommit(receiptBinding, { claimId: "claim-2", claimedAt: "2026-08-12T00:31:00.000Z" })
    ]);
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    expect(claims.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "RECEIPT_CLAIMED_BY_OTHER" }
    ]);
    await expect(
      store.claimCommit(receiptBinding, { claimId: "claim-1", claimedAt: "2026-08-12T00:31:00.000Z" })
    ).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(
      store.finalizeCommit(receiptBinding, "claim-1", "2026-08-12T00:32:00.000Z")
    ).resolves.toMatchObject({ ok: true, replayed: false, receipt: { status: "committed" } });
    await expect(
      store.finalizeCommit(receiptBinding, "claim-1", "2026-08-12T00:32:00.000Z")
    ).resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("rejects forged receipt provenance and does not revoke a claimed receipt", async () => {
    const store = new MemoryExactAuthorizationStore();
    await store.issue(candidate());
    const authorized = await authorize(store);
    if (!authorized.ok) throw new Error(authorized.code);
    const { status, commitClaimId, commitClaimedAt, committedAt, revokedAt, ...receiptBinding } =
      authorized.receipt;
    void status; void commitClaimId; void commitClaimedAt; void committedAt; void revokedAt;
    await expect(
      store.verifyReceipt({ ...receiptBinding, decisionRef: "forged" })
    ).resolves.toBe(false);
    await expect(
      store.verifyReceipt({
        authorizationId: receiptBinding.authorizationId,
        artifactId: receiptBinding.artifactId,
        binding: receiptBinding.binding
      } as typeof receiptBinding)
    ).resolves.toBe(false);
    await store.claimCommit(receiptBinding, {
      claimId: "claim-1",
      claimedAt: "2026-08-12T00:31:00.000Z"
    });
    await expect(store.revoke("authorization-1", "2026-08-12T00:31:30.000Z"))
      .resolves.toBe(false);
  });
});
