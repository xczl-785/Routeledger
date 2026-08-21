import { describe, expect, it, vi } from "vitest";

import {
  MemoryExactCommitCoordinator,
  MemoryExactAuthorizationStore,
  RouteLedgerService,
  type ExactCommitCoordinator,
  type ExactCommitOwnershipToken,
  type ExactAuthorizationSource,
  type L3ActionType
} from "../index.js";
import { createTestDependencies, TEST_ACTOR } from "./builders.js";
import {
  FailOnSaveStorageAdapter,
  MemoryStorageAdapter,
  createPreparedProject
} from "./routeledger-service-test-helpers.js";

interface TestAuthorizationInput {
  id: string;
  issuer: string;
  subjectId: string;
  audience: string;
  projectId: string;
  routeledgerRootDigest: string;
  profileId?: string;
  modeEpoch?: number;
  profileDigest?: string;
  allowedActions: L3ActionType[];
  allowedTargetIds: string[];
  operationDigest: string | null;
  scope: "operation";
  source: ExactAuthorizationSource;
  policyId: string | null;
  policyDigest: string | null;
  decisionId: string;
  hostKind: string;
  clientId: string | null;
  sessionId: string | null;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  status: "active";
  revokedAt: null;
}

class TestAuthorizationIssuer {
  private readonly records = new Map<string, TestAuthorizationInput>();

  async issue(input: TestAuthorizationInput): Promise<void> {
    this.records.set(input.id, structuredClone(input));
  }

  async get(id: string): Promise<TestAuthorizationInput | null> {
    return structuredClone(this.records.get(id) ?? null);
  }
}

const createGrant = (
  operationDigest: string,
  overrides: Partial<TestAuthorizationInput> = {}
): TestAuthorizationInput => ({
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

class FailOnceFinalizeExactStore extends MemoryExactAuthorizationStore {
  private failNextFinalize = true;

  override finalizeCommit(
    ...args: Parameters<MemoryExactAuthorizationStore["finalizeCommit"]>
  ): ReturnType<MemoryExactAuthorizationStore["finalizeCommit"]> {
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      return Promise.reject(new Error("injected finalize failure"));
    }
    return super.finalizeCommit(...args);
  }
}

const createTestCommitCoordinator = (): MemoryExactCommitCoordinator =>
  new MemoryExactCommitCoordinator({
    currentProcess: {
      processId: 101,
      processStartedAt: "2026-08-21T08:00:00.000Z",
      instanceId: "service-authorization-test"
    },
    leaseDurationMs: 60_000,
    now: () => "2026-08-21T08:00:00.000Z",
    resolveOwnerLiveness: async () => "alive"
  });

const setup = async (
  storage: MemoryStorageAdapter = new MemoryStorageAdapter(),
  profile?: { profileId: string; modeEpoch: number; profileDigest: string },
  grantStore: TestAuthorizationIssuer = new TestAuthorizationIssuer(),
  exactStore: MemoryExactAuthorizationStore = new MemoryExactAuthorizationStore(),
  commitCoordinator: ExactCommitCoordinator = createTestCommitCoordinator()
) => {
  const service = new RouteLedgerService({
    storage,
    deps: createTestDependencies(),
    l3Authorization: {
      exactStore,
      commitCoordinator,
      audience: "routeledger-core",
      subjectId: "local-user",
      routeledgerRootDigest: "sha256:root-1",
      ...profile,
      hostKind: "codex",
      clientId: "codex-client",
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
  const issueLegacyFixture = grantStore.issue.bind(grantStore);
  grantStore.issue = async (grant) => {
    await issueLegacyFixture(grant);
    if (
      grant.operationDigest === null ||
      grant.allowedActions.length !== 1 ||
      grant.allowedTargetIds.length !== 1
    ) return;
    await exactStore.issue({
      schemaVersion: 2,
      authorizationId: grant.id,
      binding: {
        proposalId: proposal.id,
        projectId: grant.projectId,
        routeledgerRootDigest: grant.routeledgerRootDigest,
        actionType: grant.allowedActions[0]!,
        targetId: grant.allowedTargetIds[0]!,
        operationDigest: grant.operationDigest
      },
      source: grant.source,
      decisionRef: grant.decisionId,
      issuer: grant.issuer,
      audience: grant.audience,
      subjectId: grant.subjectId,
      policyId: grant.policyId,
      policyDigest: grant.policyDigest,
      profileId: grant.profileId ?? null,
      modeEpoch: grant.modeEpoch ?? null,
      profileDigest: grant.profileDigest ?? null,
      hostKind: grant.hostKind,
      clientId: grant.clientId,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt
    });
  };
  return { storage, grantStore, exactStore, commitCoordinator, service, prepared, proposal };
};

class DelayCommitStorageAdapter extends MemoryStorageAdapter {
  private armed = false;
  private releaseGate: (() => void) | null = null;
  private startedGate: (() => void) | null = null;
  readonly started = new Promise<void>((resolve) => { this.startedGate = resolve; });
  readonly released = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  delayedSaves = 0;

  arm(): void { this.armed = true; }
  release(): void { this.releaseGate?.(); }

  override async saveProjectAggregate(snapshot: Parameters<MemoryStorageAdapter["saveProjectAggregate"]>[0]): Promise<void> {
    if (this.armed) {
      this.armed = false;
      this.delayedSaves += 1;
      this.startedGate?.();
      await this.released;
    }
    await super.saveProjectAggregate(snapshot);
  }
}

describe("RouteLedgerService trusted L3 authorization", () => {
  it("lets only one of two service instances own and apply an exact commit", async () => {
    const storage = new DelayCommitStorageAdapter();
    const fixture = await setup(storage);
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId]
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    const command = {
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    };
    const competingService = new RouteLedgerService({
      storage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: fixture.exactStore,
        commitCoordinator: fixture.commitCoordinator,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex",
        clientId: "codex-client",
      }
    });
    storage.arm();
    const owner = fixture.service.commitL3Operation(command);
    await storage.started;
    await expect(competingService.commitL3Operation(command)).rejects.toMatchObject({
      code: "WRITE_IN_PROGRESS",
      details: { reason: "EXACT_COMMIT_ALREADY_IN_PROGRESS" }
    });
    storage.release();
    await expect(owner).resolves.toMatchObject({ replayed: false });
    expect(storage.delayedSaves).toBe(1);
    const aggregate = await storage.loadProjectAggregate(fixture.prepared.projectId);
    expect(aggregate?.pendingOperations.filter((item) => item.status === "committed"))
      .toHaveLength(1);
    expect(aggregate?.events.filter((event) => event.eventType === "pending_operation.committed"))
      .toHaveLength(1);
  });

  it("uses the injected exact commit coordinator and releases its opaque token", async () => {
    const storage = new DelayCommitStorageAdapter();
    const fixture = await setup(storage);
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId]
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    const token: ExactCommitOwnershipToken = {
      commitKey: fixture.proposal.id,
      owner: {
        attemptId: "attempt-1",
        processId: 101,
        processStartedAt: "2026-08-21T08:00:00.000Z",
        instanceId: "instance-1"
      },
      generation: 1,
      leaseExpiresAt: "2026-08-21T08:01:00.000Z",
      status: "owned",
      releasedAt: null
    };
    let acquireCount = 0;
    const release = vi.fn(async (_token: ExactCommitOwnershipToken) => undefined);
    const coordinator: ExactCommitCoordinator = {
      acquire: vi.fn(async () =>
        acquireCount++ === 0
          ? { ok: true as const, token }
          : { ok: false as const, code: "COMMIT_OWNED_BY_LIVE_PROCESS" as const }
      ),
      assertOwned: async (candidate) => candidate === token,
      renew: async (candidate) => ({ ok: true, token: candidate }),
      release
    };
    const legacyAcquire = vi.spyOn(fixture.exactStore, "acquireCommitOwnership");
    const createCommitService = () =>
      new RouteLedgerService({
        storage,
        deps: createTestDependencies(),
        l3Authorization: {
          exactStore: fixture.exactStore,
          commitCoordinator: coordinator,
          audience: "routeledger-core",
          subjectId: "local-user",
          routeledgerRootDigest: "sha256:root-1",
          hostKind: "codex",
          clientId: "codex-client"
        }
      });
    const ownerService = createCommitService();
    const competingService = createCommitService();
    const command = {
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    };

    storage.arm();
    const owner = ownerService.commitL3Operation(command);
    await storage.started;
    await expect(competingService.commitL3Operation(command)).rejects.toMatchObject({
      code: "WRITE_IN_PROGRESS",
      details: { reason: "EXACT_COMMIT_ALREADY_IN_PROGRESS" }
    });
    storage.release();
    await expect(owner).resolves.toMatchObject({ replayed: false });

    expect(coordinator.acquire).toHaveBeenCalledTimes(2);
    expect(coordinator.acquire).toHaveBeenCalledWith({
      commitKey: `${fixture.prepared.projectId}/${fixture.proposal.id}`,
      attemptId: expect.any(String)
    });
    expect(legacyAcquire).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[0]).toBe(token);
  });

  it("fences the canonical save when exact commit ownership is lost", async () => {
    const fixture = await setup();
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId]
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    const token: ExactCommitOwnershipToken = {
      commitKey: fixture.proposal.id,
      owner: {
        attemptId: "attempt-1",
        processId: 101,
        processStartedAt: "2026-08-21T08:00:00.000Z",
        instanceId: "instance-1"
      },
      generation: 1,
      leaseExpiresAt: "2026-08-21T08:01:00.000Z",
      status: "owned",
      releasedAt: null
    };
    const assertOwned = vi.fn(async () => false);
    const release = vi.fn(async (_token: ExactCommitOwnershipToken) => undefined);
    const coordinator: ExactCommitCoordinator = {
      acquire: async () => ({ ok: true, token }),
      assertOwned,
      renew: async (candidate) => ({ ok: true, token: candidate }),
      release
    };
    const save = vi.spyOn(fixture.storage, "saveProjectAggregate");
    const finalize = vi.spyOn(fixture.exactStore, "finalizeCommit");
    const service = new RouteLedgerService({
      storage: fixture.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: fixture.exactStore,
        commitCoordinator: coordinator,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex",
        clientId: "codex-client"
      }
    });

    await expect(
      service.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "WRITE_IN_PROGRESS",
      details: { reason: "COMMIT_OWNERSHIP_LOST" }
    });

    expect(assertOwned).toHaveBeenCalledWith(token);
    expect(save).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    const aggregate = await fixture.storage.loadProjectAggregate(fixture.prepared.projectId);
    expect(aggregate?.pendingOperations.find((item) => item.id === fixture.proposal.id)?.status)
      .toBe("pending");
    expect(
      aggregate?.events.filter(
        (event) =>
          event.eventType === "pending_operation.committed" &&
          event.targetId === fixture.proposal.id
      )
    ).toHaveLength(0);
    expect(release).toHaveBeenCalledWith(token);
  });

  it("runs profile-less host admission through the same durable claim/finalize lifecycle", async () => {
    const fixture = await setup();
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId],
        source: "host_admission",
        issuer: "codex-native-tool-admission",
        decisionId: "codex-tool-call-1"
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    await expect(
      fixture.service.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).resolves.toMatchObject({ replayed: false });
    await expect(fixture.exactStore.getReceipt("grant-1")).resolves.toMatchObject({
      authorizationId: "grant-1",
      artifactId: artifact.id,
      source: "host_admission",
      status: "committed",
      commitClaimId: expect.any(String),
      committedAt: expect.any(String)
    });
  });

  it("fails closed when a restarted service has no exact receipt for committed replay", async () => {
    const fixture = await setup();
    await fixture.grantStore.issue(
      createGrant(fixture.proposal.digest.value, {
        projectId: fixture.prepared.projectId,
        allowedTargetIds: [fixture.prepared.versionId]
      })
    );
    const artifact = await fixture.service.authorizeL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    await fixture.service.commitL3Operation({
      projectId: fixture.prepared.projectId,
      pendingOperationId: fixture.proposal.id,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const emptyRestart = new RouteLedgerService({
      storage: fixture.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: new MemoryExactAuthorizationStore(),
        commitCoordinator: createTestCommitCoordinator(),
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex",
        clientId: "codex-client"
      }
    });
    await expect(
      emptyRestart.commitL3Operation({
        projectId: fixture.prepared.projectId,
        pendingOperationId: fixture.proposal.id,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "AUTHORIZATION_RECEIPT_INVALID" }
    });
  });


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
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    const rotated = new RouteLedgerService({
      storage: fixture.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: fixture.exactStore,
        commitCoordinator: fixture.commitCoordinator,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        profileId: "profile-1",
        modeEpoch: 2,
        profileDigest: "profile-digest-2",
        hostKind: "codex",
        clientId: "codex-client",
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
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "AUTHORIZATION_PROFILE_EPOCH_INACTIVE" }
    });
  });

  it("recovers exact commit finalization after canonical save already succeeded", async () => {
    const profile = {
      profileId: "profile-1",
      modeEpoch: 1,
      profileDigest: "profile-digest-1"
    };
    const grantStore = new TestAuthorizationIssuer();
    const exactStore = new FailOnceFinalizeExactStore();
    const fixture = await setup(new MemoryStorageAdapter(), profile, grantStore, exactStore);
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
      authorizationId: "grant-1",
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
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "LEGACY_APPROVAL_DISABLED" }
    });
  });

  it("rejects persisted legacy artifacts after upgrade, including committed replay without receipt", async () => {
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
          exactStore: new MemoryExactAuthorizationStore(),
          commitCoordinator: createTestCommitCoordinator(),
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
      code: "EXACT_AUTHORIZATION_REJECTED",
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
    ).rejects.toMatchObject({
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "AUTHORIZATION_RECEIPT_INVALID" }
    });
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
            authorizationId: "forged-grant",
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
        exactStore: new MemoryExactAuthorizationStore(),
        commitCoordinator: createTestCommitCoordinator(),
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
      code: "EXACT_AUTHORIZATION_REJECTED",
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
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    const restartedService = new RouteLedgerService({
      storage: valid.storage,
      deps: createTestDependencies(),
      l3Authorization: {
        exactStore: valid.exactStore,
        commitCoordinator: valid.commitCoordinator,
        audience: "routeledger-core",
        subjectId: "local-user",
        routeledgerRootDigest: "sha256:root-1",
        hostKind: "codex",
        clientId: "codex-client",
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
      authorizationId: "grant-1",
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
      code: "EXACT_AUTHORIZATION_REJECTED",
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
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });

    expect(artifact).toMatchObject({
      status: "approved",
      authorizationId: "grant-1",
      approvalSource: "user_interaction",
      decisionRef: "decision-1",
      hostKind: "codex",
      clientId: "codex-client",
      approver: { id: "local-user", type: "user" }
    });
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({
      uses: 0,
      status: "active"
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
        authorizationId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toThrow("injected save failure");
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({
      uses: 0,
      status: "active"
    });
    expect((await storage.loadProjectAggregate(prepared.projectId))?.approvalArtifacts).toEqual([]);

    const recovered = await service.authorizeL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: proposal.id,
      authorizationId: "grant-1",
      actor: TEST_ACTOR
    });
    expect(recovered).toMatchObject({
      authorizationId: "grant-1",
      decisionRef: "decision-1",
      status: "approved"
    });
    expect((await storage.loadProjectAggregate(prepared.projectId))?.approvalArtifacts).toEqual([
      recovered
    ]);
    await expect(grantStore.get("grant-1")).resolves.toMatchObject({ uses: 0, status: "active" });
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
        authorizationId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "EXACT_AUTHORIZATION_REJECTED",
      details: { reason: "AUTHORIZATION_BINDING_MISMATCH" }
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
        authorizationId: "grant-1",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({ code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE" });
  });
});
