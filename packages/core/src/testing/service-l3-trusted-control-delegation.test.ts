import { afterEach, describe, expect, it, vi } from "vitest";

import { L3ExactAuthorizationService } from "../application/l3-exact-authorization-service.js";
import { L3OperationCommitService } from "../application/l3-operation-commit-service.js";
import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService trusted L3 control delegation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates exact authorization and the indivisible commit chain to internal services", async () => {
    const authorize = vi.spyOn(L3ExactAuthorizationService.prototype, "authorizeL3Operation");
    const commit = vi.spyOn(L3OperationCommitService.prototype, "commitL3Operation");
    const service = new RouteLedgerService({
      storage: new MemoryStorageAdapter(),
      deps: createTestDependencies()
    });
    const authorizeInput = {
      projectId: "project-1",
      pendingOperationId: "proposal-1",
      authorizationId: "authorization-1",
      actor: TEST_ACTOR
    };
    const commitInput = {
      projectId: "project-1",
      pendingOperationId: "proposal-1",
      approvalArtifactId: "approval-1",
      actor: TEST_ACTOR
    };

    await expect(service.authorizeL3Operation(authorizeInput)).rejects.toMatchObject({
      code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE"
    });
    await expect(service.commitL3Operation(commitInput)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND"
    });

    expect(authorize).toHaveBeenCalledWith(authorizeInput);
    expect(commit).toHaveBeenCalledWith(commitInput);
  });
});
