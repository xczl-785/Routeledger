import { describe, expect, it, vi } from "vitest";

import { RouteLedgerQueryService } from "../application/routeledger-query-service.js";
import { RouteLedgerService } from "../index.js";
import {
  createProjectFixture,
  createTestDependencies,
  createVersionFixture
} from "./builders.js";
import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService query delegation", () => {
  it("delegates version list queries while preserving their public contracts", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-2" }),
      versions: [
        createVersionFixture({ id: "version-3", order: 3 }),
        createVersionFixture({ id: "version-1", order: 1 }),
        createVersionFixture({ id: "version-2", order: 2, isCurrent: true })
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
    const queryService = new RouteLedgerQueryService({ storage });
    const listVersions = vi.spyOn(queryService, "listVersions");
    const listVersionsWindow = vi.spyOn(queryService, "listVersionsWindow");
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies(),
      queryService
    });
    const windowInput = {
      projectId: "project-1",
      aroundVersionId: "version-2",
      before: 0,
      after: 1
    };

    const versions = await service.listVersions("project-1");
    const window = await service.listVersionsWindow(windowInput);

    expect(listVersions).toHaveBeenCalledOnce();
    expect(listVersions).toHaveBeenCalledWith("project-1");
    expect(listVersionsWindow).toHaveBeenCalledOnce();
    expect(listVersionsWindow).toHaveBeenCalledWith(windowInput);
    expect(versions.map((version) => version.id)).toEqual([
      "version-1",
      "version-2",
      "version-3"
    ]);
    expect(window).toMatchObject({
      data: {
        project: {
          id: "project-1",
          currentVersionId: "version-2",
          contentLocale: "en"
        },
        aroundVersionId: "version-2",
        versions: [{ id: "version-2" }, { id: "version-3" }]
      },
      meta: {
        versionWindow: {
          aroundVersionId: "version-2",
          before: 0,
          after: 1,
          includeAllVersions: false,
          totalCount: 3,
          includedCount: 2,
          omittedBeforeCount: 1,
          omittedAfterCount: 0
        }
      }
    });
  });
});
