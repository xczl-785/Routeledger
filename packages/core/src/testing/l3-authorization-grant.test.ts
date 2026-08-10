import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore,
  validateL3AuthorizationGrant,
  type L3AuthorizationGrant,
  type L3AuthorizationGrantContext,
  type L3AuthorizationReceiptBinding
} from "../index.js";

const grant = (overrides: Partial<L3AuthorizationGrant> = {}): L3AuthorizationGrant => ({
  id: "grant-1",
  issuer: "routeledger-codex-host",
  subjectId: "user-1",
  audience: "routeledger-core",
  projectId: "project-1",
  routeledgerRootDigest: "sha256:root-1",
  allowedActions: ["close_version"],
  allowedTargetIds: ["version-1"],
  operationDigest: "operation-1",
  scope: "operation",
  source: "user_interaction",
  policyId: null,
  policyDigest: null,
  decisionId: "decision-1",
  hostKind: "codex",
  clientId: "client-1",
  sessionId: "session-1",
  nonce: "nonce-1",
  createdAt: "2026-08-10T04:00:00.000Z",
  expiresAt: "2026-08-10T05:00:00.000Z",
  maxUses: 1,
  uses: 0,
  status: "active",
  revokedAt: null,
  ...overrides
});

const context = (
  overrides: Partial<L3AuthorizationGrantContext> = {}
): L3AuthorizationGrantContext => ({
  audience: "routeledger-core",
  subjectId: "user-1",
  projectId: "project-1",
  routeledgerRootDigest: "sha256:root-1",
  actionType: "close_version",
  targetId: "version-1",
  operationDigest: "operation-1",
  now: "2026-08-10T04:30:00.000Z",
  hostKind: "codex",
  clientId: "client-1",
  sessionId: "session-1",
  ...overrides
});

const receiptBinding = (
  overrides: Partial<L3AuthorizationReceiptBinding> = {}
): L3AuthorizationReceiptBinding => ({
  approvalArtifactId: "artifact-1",
  pendingOperationId: "pending-1",
  grantId: "grant-1",
  audience: "routeledger-core",
  subjectId: "user-1",
  projectId: "project-1",
  routeledgerRootDigest: "sha256:root-1",
  actionType: "close_version",
  targetId: "version-1",
  operationDigest: "operation-1",
  approvalSource: "user_interaction",
  decisionRef: "decision-1",
  approverId: "user-1",
  approverType: "user",
  approverDisplayName: "user-1",
  policyId: null,
  policyDigest: null,
  hostKind: "codex",
  clientId: "client-1",
  sessionId: "session-1",
  createdAt: "2026-08-10T04:30:00.000Z",
  expiresAt: "2026-08-10T05:00:00.000Z",
  ...overrides
});

describe("L3 authorization grant store", () => {
  it("atomically consumes a matching operation grant once", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    await store.issue(grant());

    const first = await store.consume("grant-1", context());
    expect(first).toMatchObject({ ok: true, consumedUse: 1, grant: { status: "exhausted" } });
    await expect(store.consume("grant-1", context())).resolves.toEqual({
      ok: false,
      code: "GRANT_INACTIVE"
    });
  });

  it("verifies only an exact host-owned consumption receipt", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    await store.recordConsumptionReceipt({ ...receiptBinding(), consumedUse: 1 });

    await expect(store.verifyConsumptionReceipt(receiptBinding())).resolves.toBe(true);
    await expect(
      store.verifyConsumptionReceipt(receiptBinding({ decisionRef: "forged-decision" }))
    ).resolves.toBe(false);
    await expect(
      store.verifyConsumptionReceipt(receiptBinding({ approvalArtifactId: "forged-artifact" }))
    ).resolves.toBe(false);
  });

  it("rejects every security binding mismatch", () => {
    const candidate = grant({ maxUses: 2 });
    expect(validateL3AuthorizationGrant(candidate, context({ audience: "other" }))).toBe(
      "GRANT_AUDIENCE_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ subjectId: "other" }))).toBe(
      "GRANT_SUBJECT_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ projectId: "other" }))).toBe(
      "GRANT_PROJECT_MISMATCH"
    );
    expect(
      validateL3AuthorizationGrant(candidate, context({ routeledgerRootDigest: "sha256:other" }))
    ).toBe("GRANT_ROOT_MISMATCH");
    expect(validateL3AuthorizationGrant(candidate, context({ actionType: "start_version" }))).toBe(
      "GRANT_ACTION_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ targetId: "other" }))).toBe(
      "GRANT_TARGET_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ operationDigest: "other" }))).toBe(
      "GRANT_OPERATION_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ hostKind: "other" }))).toBe(
      "GRANT_HOST_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ clientId: "other" }))).toBe(
      "GRANT_CLIENT_MISMATCH"
    );
    expect(validateL3AuthorizationGrant(candidate, context({ sessionId: "other" }))).toBe(
      "GRANT_SESSION_MISMATCH"
    );
  });

  it("rejects expired, revoked, exhausted, and malformed operation grants", () => {
    expect(validateL3AuthorizationGrant(grant(), context({ now: "2026-08-10T05:00:00.000Z" }))).toBe(
      "GRANT_EXPIRED"
    );
    expect(validateL3AuthorizationGrant(grant({ status: "revoked" }), context())).toBe(
      "GRANT_INACTIVE"
    );
    expect(validateL3AuthorizationGrant(grant({ uses: 1, maxUses: 1 }), context())).toBe(
      "GRANT_EXHAUSTED"
    );
    expect(validateL3AuthorizationGrant(grant({ operationDigest: null }), context())).toBe(
      "GRANT_OPERATION_MISMATCH"
    );
  });

  it("revokes grants in the trusted store", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    await store.issue(grant({ maxUses: 2 }));

    await expect(store.revoke("grant-1", "2026-08-10T04:15:00.000Z")).resolves.toMatchObject({
      status: "revoked",
      revokedAt: "2026-08-10T04:15:00.000Z"
    });
    await expect(store.consume("grant-1", context())).resolves.toEqual({
      ok: false,
      code: "GRANT_INACTIVE"
    });
  });

  it("finds a reusable session grant only within its exact bindings", async () => {
    const store = new MemoryL3AuthorizationGrantStore();
    await store.issue(
      grant({ scope: "session", operationDigest: null, maxUses: 2 })
    );

    await expect(store.findMatching(context({ operationDigest: "operation-2" }))).resolves.toMatchObject({
      id: "grant-1",
      scope: "session"
    });
    await expect(store.findMatching(context({ targetId: "other" }))).resolves.toBeNull();
  });
});
