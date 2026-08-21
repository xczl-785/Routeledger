import { describe, expect, it, vi } from "vitest";

import { VersionCommandService } from "../application/version-command-service.js";
import { RouteLedgerService } from "../index.js";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTestDependencies,
  createVersionFixture
} from "./builders.js";
import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService version command delegation", () => {
  it("delegates prepareVersion without reshaping its input or return contract", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [
        createVersionFixture({ id: "version-1", isCurrent: true, state: "wait" })
      ],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });
    const deps = createTestDependencies();
    const versionCommandService = new VersionCommandService({ storage, deps });
    const prepareVersion = vi.spyOn(versionCommandService, "prepareVersion");
    const service = new RouteLedgerService({
      storage,
      deps,
      versionCommandService
    });
    const input = {
      projectId: "project-1",
      versionId: "version-1",
      actor: TEST_ACTOR
    };

    const result = await service.prepareVersion(input);

    expect(prepareVersion).toHaveBeenCalledOnce();
    expect(prepareVersion.mock.calls[0]?.[0]).toBe(input);
    expect(result).toMatchObject({
      version: {
        id: "version-1",
        projectId: "project-1",
        state: "ready"
      },
      events: [
        {
          targetType: "version",
          targetId: "version-1",
          eventType: "version.state_changed",
          fromState: "wait",
          toState: "ready"
        }
      ]
    });
  });

  it("delegates markVersionComplete without reshaping its input or close-readiness contract", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [
        createVersionFixture({ id: "version-1", isCurrent: true, state: "running" })
      ],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });
    const deps = createTestDependencies();
    const versionCommandService = new VersionCommandService({ storage, deps });
    const markVersionComplete = vi.spyOn(versionCommandService, "markVersionComplete");
    const service = new RouteLedgerService({
      storage,
      deps,
      versionCommandService
    });
    const input = {
      projectId: "project-1",
      versionId: "version-1",
      actor: TEST_ACTOR
    };

    const result = await service.markVersionComplete(input);

    expect(markVersionComplete).toHaveBeenCalledOnce();
    expect(markVersionComplete.mock.calls[0]?.[0]).toBe(input);
    expect(result).toMatchObject({
      version: { id: "version-1", state: "complete" },
      closeReadiness: { allowed: false },
      warnings: [
        {
          code: "VERSION_COMPLETE_CLOSE_BLOCKED",
          recommendedTool: "check_close_gate"
        }
      ]
    });
  });
});
