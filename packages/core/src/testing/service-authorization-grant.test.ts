import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore,
  RouteLedgerService,
  type L3AuthorizationGrant
} from "../index.js";
import { createTestDependencies, TEST_ACTOR } from "./builders.js";
import {
  MemoryStorageAdapter,
  createPreparedProject
} from "./routeledger-service-test-helpers.js";

const createGrant = (
  operationDigest: string,
  overrides: Partial<L3AuthorizationGrant> = {}
): L3AuthorizationGrant => ({
  id: "grant-1",
  issuer: "codex-app-server",
  subjectId: "local-user",
  audience: "routeledger-core",
  projectId: "id-1",
  routeledgerRootDigest: "sha256:root-1",
  allowedActions: ["start_version"],
  allowedTargetIds: ["id-2"],
  operationDigest,
  scope: "operation",
  source: "user_interaction",
  policyId: null,
  policyDigest: null,
  decisionId: "decision-1",
  hostKind: "codex",
  clientId: "codex-client",
  sessionId: "session-1",
  nonce: "nonce-1",
  createdAt: "2026-06-26T23:00:00.000Z",
  expiresAt: "2026-06-27T01:00:00.000Z",
  maxUses: 1,
  uses: 0,
  status: "active",
  revokedAt: null,
  ...overrides
});

const setup = async () => {
  const storage = new MemoryStorageAdapter();
  const grantStore = new MemoryL3AuthorizationGrantStore();
  const service = new RouteLedgerService({
    storage,
    deps: createTestDependencies(),
    l3Authorization: {
      grantStore,
      audience: "routeledger-core",
      subjectId: "local-user",
      routeledgerRootDigest: "sha256:root-1",
      hostKind: "codex",
      clientId: "codex-client",
      sessionId: "session-1"
    }
  });
  const prepared = await createPreparedProject(service, storage);
  const proposal = await service.proposeL3Operation({
    projectId: prepared.projectId,
    actionType: "start_version",
    targetId: prepared.versionId,
    reason: "start version",
    actor: TEST_ACTOR
  });
  return { storage, grantStore, service, prepared, proposal };
};

describe("RouteLedgerService trusted L3 authorization", () => {
  it("rejects the legacy approval method when the trusted control plane is configured", async () => {
    const { service, prepared, proposal } = await setup();
    await expect(
      service.approveL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approver: TEST_ACTOR,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "LEGACY_APPROVAL_DISABLED" }
    });
  });
  it("mints an approval artifact only after atomically consuming a trusted grant", async () => {
    const { storage, grantStore, service, prepared, proposal } = await setup();
    await grantStore.issue(
      createGrant(proposal.digest.value, {
        projectId: prepared.projectId,
        allowedTargetIds: [prepared.versionId]
      })
    );

    const artifact = await service.authorizeL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });

    expect(artifact).toMatchObject({
      status: "approved",
      authorizationGrantId: "grant-1",
      approvalSource: "user_interaction",
      decisionRef: "decision-1",
      hostKind: "codex",
      clientId: "codex-client",
      sessionId: "session-1",
      approver: { id: "local-user", type: "user" }
    });
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({
      uses: 1,
      status: "exhausted"
    });
    expect(
      (await storage.loadProjectAggregate(prepared.projectId))?.events.at(-1)?.eventType
    ).toBe("approval_artifact.authorized");
  });

  it("rejects a grant that does not bind the exact operation digest", async () => {
    const { grantStore, service, prepared, proposal } = await setup();
    await grantStore.issue(
      createGrant("different-digest", {
        projectId: prepared.projectId,
        allowedTargetIds: [prepared.versionId]
      })
    );

    await expect(
      service.authorizeL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        grantId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "GRANT_OPERATION_MISMATCH" }
    });
  });

  it("fails closed when no trusted authorization control plane is configured", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const proposal = await service.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "start version",
      actor: TEST_ACTOR
    });

    await expect(
      service.authorizeL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        grantId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE" });
  });
});
