import { afterEach, describe, expect, it, vi } from "vitest";

import { L3ProposalWriteService } from "../application/l3-proposal-write-service.js";
import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { MemoryStorageAdapter, createPreparedProject } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService L3 proposal write delegation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates the complete proposal write lifecycle to the application service", async () => {
    const proposeL3Operation = vi.spyOn(L3ProposalWriteService.prototype, "proposeL3Operation");
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({ storage, deps: createTestDependencies() });
    const prepared = await createPreparedProject(service, storage);
    const input = {
      projectId: prepared.projectId,
      actionType: "start_version" as const,
      targetId: prepared.versionId,
      reason: "write service delegation",
      actor: TEST_ACTOR
    };

    const proposal = await service.proposeL3Operation(input);

    expect(proposeL3Operation).toHaveBeenCalledOnce();
    expect(proposeL3Operation).toHaveBeenCalledWith(input);
    expect(proposal).toMatchObject({
      projectId: prepared.projectId,
      actionType: "start_version",
      targetId: prepared.versionId,
      status: "pending"
    });
  });
});
