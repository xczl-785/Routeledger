import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  L3CanonicalDigestMaterial,
  L3ProposalSecurityPort
} from "../application/l3-proposal-security-port.js";
import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import {
  LossyPendingOperationStorageAdapter,
  MemoryStorageAdapter,
  createPreparedProject
} from "./routeledger-service-test-helpers.js";

class GateTamperingPendingOperationStorageAdapter extends MemoryStorageAdapter {
  override async saveProjectAggregate(snapshot: Parameters<MemoryStorageAdapter["saveProjectAggregate"]>[0]) {
    const tamperedSnapshot = structuredClone(snapshot);

    for (const operation of tamperedSnapshot.pendingOperations) {
      if (operation.gateSnapshot.kind === "start") {
        operation.gateSnapshot = { ...operation.gateSnapshot, allowed: false };
      }
    }

    await super.saveProjectAggregate(tamperedSnapshot);
  }
}

describe("L3 proposal security port", () => {
  it("exposes one atomic description operation and digest material without a stored digest", () => {
    expectTypeOf<keyof L3ProposalSecurityPort>().toEqualTypeOf<"describe">();
    expectTypeOf<L3CanonicalDigestMaterial>().not.toHaveProperty("digest");
  });

  it("rolls back a proposal when lossy storage changes persisted payload", async () => {
    const storage = new LossyPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const created = await service.initProject({
      contentLocale: "en",
      name: "Lossy payload contract",
      firstVersion: null,
      actor: TEST_ACTOR
    });

    await expect(
      service.createVersion({
        projectId: created.project.id,
        title: "Dropped normalized payload",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: { rollbackStatus: "rolled_back" }
    });

    const snapshot = await storage.loadProjectAggregate(created.project.id);
    expect(snapshot?.pendingOperations).toEqual([]);
  });

  it("rolls back a proposal when lossy storage changes its persisted gate", async () => {
    const storage = new GateTamperingPendingOperationStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);

    await expect(
      service.proposeL3Operation({
        projectId: prepared.projectId,
        actionType: "start_version",
        targetId: prepared.versionId,
        reason: "Tampered start gate",
        actor: TEST_ACTOR
      })
    ).rejects.toMatchObject({
      code: "PENDING_OPERATION_PERSISTENCE_MISMATCH",
      details: { rollbackStatus: "rolled_back" }
    });

    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    expect(snapshot?.pendingOperations).toEqual([]);
  });
});
