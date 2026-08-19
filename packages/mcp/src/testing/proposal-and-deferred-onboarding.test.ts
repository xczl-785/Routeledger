import { describe, expect, it } from "vitest";

import {
  cleanupProjectRoot,
  createRegistry,
  createTempProjectRoot
} from "./mcp-test-helpers.js";

describe("proposal and Deferred onboarding contracts", () => {
  it("reports a persisted Version-structure proposal as pending confirmation, not a failed write", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initialized = await registry.invoke("init_project", {
        name: "Proposal outcome contract",
        contentLocale: "en",
        firstVersion: null
      });
      const projectId = (initialized.data as { project: { id: string } }).project.id;

      const proposed = await registry.invoke("propose_version_structure_change", {
        operation: "propose_version_creation",
        projectId,
        title: "Future review version",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(proposed).toMatchObject({
        ok: true,
        data: {
          status: "confirmation_required",
          pendingOperationId: expect.any(String),
          proposal: {
            targetId: expect.any(String)
          },
          recommendedNextActions: expect.arrayContaining([
            expect.objectContaining({
              action: "approve",
              tool: "execute_route_change",
              input: expect.objectContaining({ operation: "approve_l3_operation" })
            }),
            expect.objectContaining({
              action: "reject",
              tool: "execute_route_change",
              input: expect.objectContaining({ operation: "reject_l3_operation" })
            })
          ])
        }
      });
      expect(proposed.error).toBeUndefined();
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("guides an empty downstream route to a Version proposal before retrying Deferred work", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initialized = await registry.invoke("init_project", {
        name: "Deferred onboarding contract",
        contentLocale: "en",
        firstVersion: {
          title: "Current version",
          description: "The only Version",
          initialTodos: []
        }
      });
      const data = initialized.data as {
        project: { id: string };
        firstVersion: { id: string };
      };

      const deferred = await registry.invoke("manage_deferred", {
        operation: "defer",
        mode: "new",
        projectId: data.project.id,
        currentVersionId: data.firstVersion.id,
        targetReviewVersionId: "missing-future-version",
        title: "Review this later",
        reason: "There is no downstream Version yet.",
        idempotencyKey: "deferred-onboarding-contract",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(deferred).toMatchObject({
        ok: false,
        error: {
          code: "DEFERRED_ROUTE_TARGET_UNKNOWN",
          details: {
            eligibleTargetVersions: [],
            recoveryState: "downstream_version_required",
            currentState: "no_downstream_version",
            expectedState: "downstream_version",
            safeToRetry: false,
            writesPerformed: false,
            artifactConsumed: false,
            recommendedNextActions: [
              expect.objectContaining({
                type: "propose_downstream_version",
                tool: "propose_version_structure_change",
                toolInput: {
                  operation: "propose_version_creation",
                  projectId: data.project.id
                },
                requiredInputs: ["title"]
              })
            ]
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
