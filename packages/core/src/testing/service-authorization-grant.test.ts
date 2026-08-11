import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore,
  RouteLedgerService,
  type L3AuthorizationGrant
} from "../index.js";
import { createTestDependencies, TEST_ACTOR } from "./builders.js";
import {
  FailOnSaveStorageAdapter,
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

class FailOnceFinalizeGrantStore extends MemoryL3AuthorizationGrantStore {
  private failNextFinalize = true;

  override finalizeCommit(
    ...args: Parameters<MemoryL3AuthorizationGrantStore["finalizeCommit"]>
  ): ReturnType<MemoryL3AuthorizationGrantStore["finalizeCommit"]> {
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      return Promise.reject(new Error("injected finalize failure"));
    }
    return super.finalizeCommit(...args);
  }
}

const setup = async (
  storage: MemoryStorageAdapter = new MemoryStorageAdapter(),
  profile?: { profileId: string; modeEpoch: number; profileDigest: string },
  grantStore: MemoryL3AuthorizationGrantStore = new MemoryL3AuthorizationGrantStore()
) => {
  const service = new RouteLedgerService({
    storage,
    deps: createTestDependencies(),
    l3Authorization: {
      grantStore,
      audience: "routeledger-core",
      subjectId: "local-user",
      routeledgerRootDigest: "sha256:root-1",
      ...profile,
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
  it("rejects a V2 artifact from an old profile epoch before claiming commit", async () => {
    const profileV1 = {
      profileId: "profile-1",
      modeEpoch: 1,
      profileDigest: "profile-digest-1"
    };
    const fixture = await setup(new MemoryStorageAdapter(), profileV1);
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId],
        ...profileV1
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });
    const rotated = new RouteLedgerService({
      storage: fixture.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        grantStore: fixture.grantStore,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        profileId: "profile-1",
        modeEpoch: 2,
        profileDigest: "profile-digest-2",
        hostKind: "codex",
        clientId: "codex-client",
        sessionId: "session-1"
      }
    });
    await expect(
      rotated.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "AUTHORIZATION_PROFILE_EPOCH_INACTIVE" }
    });
  });

  it("recovers exact commit finalization after canonical save already succeeded", async () => {
    const profile = {
      profileId: "profile-1",
      modeEpoch: 1,
      profileDigest: "profile-digest-1"
    };
    const grantStore = new FailOnceFinalizeGrantStore();
    const fixture = await setup(new MemoryStorageAdapter(), profile, grantStore);
    await grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId],
        ...profile
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });
    await expect(
      fixture.service.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toThrow("injected finalize failure");
    expect(
      (await fixture.storage.loadProjectAggregate(fixture.prepared.projectId))?.pendingOperations[0]
        ?.status
    ).toBe("committed");
    await expect(
      fixture.service.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true });
  });

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

  it("rejects a persisted legacy approved artifact after upgrade but preserves consumed replay", async () => {
    const createLegacyFixture = async (commitBeforeUpgrade: boolean) => {
      const storage = new MemoryStorageAdapter();
      const legacyService = new RouteLedgerService({
        storage,
        deps: createTestDependencies()
      });
      const prepared = await createPreparedProject(legacyService, storage);
      const proposal = await legacyService.proposeL3Operation({
        projectId: prepared.projectId,
        actionType: "start_version",
        targetId: prepared.versionId,
        reason: "legacy fixture",
        actor: TEST_ACTOR
      });
      const artifact = await legacyService.approveL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approver: TEST_ACTOR,
        actor: TEST_ACTOR
      });
      if (commitBeforeUpgrade) {
        await legacyService.commitL3Operation({
          projectId: prepared.projectId,
          pendingOperationId: proposal.id,
          approvalArtifactId: artifact.id,
          actor: TEST_ACTOR
        });
      }
      const upgradedService = new RouteLedgerService({
        storage,
        deps: createTestDependencies(),
        l3Authorization: {
          grantStore: new MemoryL3AuthorizationGrantStore(),
          audience: "routeledger-core",
          subjectId: "local-user",
          routeledgerRootDigest: "sha256:root-1",
          hostKind: "codex"
        }
      });
      return { upgradedService, prepared, proposal, artifact };
    };

    const unconsumed = await createLegacyFixture(false);
    await expect(
      unconsumed.upgradedService.commitL3Operation({
        projectId: unconsumed.prepared.projectId,
        pendingOperationId: unconsumed.proposal.id,
        approvalArtifactId: unconsumed.artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "LEGACY_ARTIFACT_REAUTHORIZATION_REQUIRED" }
    });

    const consumed = await createLegacyFixture(true);
    await expect(
      consumed.upgradedService.commitL3Operation({
        projectId: consumed.prepared.projectId,
        pendingOperationId: consumed.proposal.id,
        approvalArtifactId: consumed.artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: true, approvalArtifact: { status: "consumed" } });
  });

  it("rejects a forged project artifact even when every provenance field is populated", async () => {
    const storage = new MemoryStorageAdapter();
    const legacyService = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(legacyService, storage);
    const proposal = await legacyService.proposeL3Operation({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      reason: "forged receipt fixture",
      actor: TEST_ACTOR
    });
    const artifact = await legacyService.approveL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      approver: TEST_ACTOR,
      actor: TEST_ACTOR
    });
    const aggregate = await storage.loadProjectAggregate(prepared.projectId);
    expect(aggregate).not.toBeNull();
    aggregate!.approvalArtifacts = aggregate!.approvalArtifacts.map((candidate) =>
      candidate.id === artifact.id
        ? {
            ...candidate,
            authorizationGrantId: "forged-grant",
            approvalSource: "delegated_policy",
            policyId: "forged-policy",
            policyDigest: "sha256:forged-policy",
            hostKind: "codex",
            clientId: "forged-client",
            sessionId: "forged-session",
            decisionRef: "forged-decision"
          }
        : candidate
    );
    await storage.saveProjectAggregate(aggregate!);

    const upgradedService = new RouteLedgerService({
      storage,
      deps: createTestDependencies(),
      l3Authorization: {
        grantStore: new MemoryL3AuthorizationGrantStore(),
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex"
      }
    });
    await expect(
      upgradedService.commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "AUTHORIZATION_RECEIPT_INVALID" }
    });
  });

  it("rejects provenance tampering but lets a restarted service verify the trusted receipt", async () => {
    const valid = await setup();
    await valid.grantStore.issue(
      createGrant(valid.proposal.digest.value, {
        projectId: valid.prepared.projectId,
        allowedTargetIds: [valid.prepared.versionId]
      })
    );
    const artifact = await valid.service.authorizeL3Operation({
      projectId: valid.prepared.projectId,
      pendingOperationId: valid.proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });
    const restartedService = new RouteLedgerService({
      storage: valid.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        grantStore: valid.grantStore,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex",
        clientId: "codex-client",
        sessionId: "session-1"
      }
    });
    await expect(
      restartedService.commitL3Operation({
        projectId: valid.prepared.projectId,
        pendingOperationId: valid.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ pendingOperation: { status: "committed" } });

    const tampered = await setup();
    await tampered.grantStore.issue(
      createGrant(tampered.proposal.digest.value, {
        projectId: tampered.prepared.projectId,
        allowedTargetIds: [tampered.prepared.versionId]
      })
    );
    const tamperedArtifact = await tampered.service.authorizeL3Operation({
      projectId: tampered.prepared.projectId,
      pendingOperationId: tampered.proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });
    const aggregate = await tampered.storage.loadProjectAggregate(tampered.prepared.projectId);
    expect(aggregate).not.toBeNull();
    aggregate!.approvalArtifacts = aggregate!.approvalArtifacts.map((candidate) =>
      candidate.id === tamperedArtifact.id
        ? { ...candidate, decisionRef: "tampered-decision" }
        : candidate
    );
    await tampered.storage.saveProjectAggregate(aggregate!);
    await expect(
      tampered.service.commitL3Operation({
        projectId: tampered.prepared.projectId,
        pendingOperationId: tampered.proposal.id,
        approvalArtifactId: tamperedArtifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_GRANT_REJECTED",
      details: { reason: "AUTHORIZATION_RECEIPT_INVALID" }
    });
  });

  it("mints an approval artifact only after consuming a trusted grant and records its receipt", async () => {
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

  it("recovers the exact approval artifact after canonical save fails post-consumption", async () => {
    const storage = new FailOnSaveStorageAdapter();
    const { grantStore, service, prepared, proposal } = await setup(storage);
    await grantStore.issue(
      createGrant(proposal.digest.value, {
        projectId: prepared.projectId,
        allowedTargetIds: [prepared.versionId]
      })
    );
    storage.failOnce();
    await expect(
      service.authorizeL3Operation({
        projectId: prepared.projectId,
        pendingOperationId: proposal.id,
        grantId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toThrow("injected save failure");
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({
      uses: 1,
      status: "exhausted"
    });
    expect((await storage.loadProjectAggregate(prepared.projectId))?.approvalArtifacts).toEqual([]);

    const recovered = await service.authorizeL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      grantId: "grant-1",
      actor: TEST_ACTOR
    });
    expect(recovered).toMatchObject({
      authorizationGrantId: "grant-1",
      decisionRef: "decision-1",
      status: "approved"
    });
    expect((await storage.loadProjectAggregate(prepared.projectId))?.approvalArtifacts).toEqual([
      recovered
    ]);
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({ uses: 1 });
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
