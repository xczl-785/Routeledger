import { describe, expect, it, vi } from "vitest";

import { BatchCreateVersionsUseCase } from "../application/batch-create-versions-use-case.js";
import { RouteLedgerService } from "../index.js";
import {
  TEST_ACTOR,
  createProjectFixture,
  createTestDependencies,
  createVersionFixture
} from "./builders.js";
import { MemoryStorageAdapter } from "./routeledger-service-test-helpers.js";

describe("RouteLedgerService batch-create command delegation", () => {
  it("delegates batchCreateVersions without reshaping its input or preflight contract", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [createVersionFixture({ id: "version-1", isCurrent: true })],
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
    const batchCreateVersionsUseCase = new BatchCreateVersionsUseCase({
      storage,
      deps,
      buildDigestPreview: () => ({
        algorithm: "sha256",
        value: "digest-preview",
        payload: {}
      }),
      propose: async () => {
        throw new Error("preflight must not propose");
      }
    });
    const execute = vi.spyOn(batchCreateVersionsUseCase, "execute");
    const service = new RouteLedgerService({
      storage,
      deps,
      batchCreateVersionsUseCase
    });
    const input = {
      projectId: "project-1",
      mode: "preflight" as const,
      anchor: { afterVersionId: "version-1" },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: []
        }
      ],
      actor: TEST_ACTOR
    };

    const result = await service.batchCreateVersions(input);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe(input);
    expect(result).toMatchObject({
      ok: true,
      normalizedPlan: {
        items: [{ clientKey: "plan-a", title: "Plan A" }]
      },
      preview: {
        createdVersions: [{ clientKey: "plan-a" }]
      },
      blockers: []
    });
  });
});
