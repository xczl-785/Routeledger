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
              action: "execute_if_admitted",
              tool: "execute_route_change",
              input: expect.objectContaining({
                operation: "execute_admitted_proposal",
                expectedRouteLedgerRoot: projectRoot,
                expectedOperationDigest: expect.any(String)
              })
            }),
            expect.objectContaining({
              action: "approve",
              tool: "execute_route_change",
              input: expect.objectContaining({
                operation: "approve_l3_operation",
                expectedRouteLedgerRoot: projectRoot
              })
            }),
            expect.objectContaining({
              action: "reject",
              tool: "execute_route_change",
              input: expect.objectContaining({
                operation: "reject_l3_operation",
                expectedRouteLedgerRoot: projectRoot
              })
            })
          ])
        }
      });
      expect(proposed.error).toBeUndefined();

      const nextAction = await registry.invoke("inspect_route_progress", {
        operation: "next_action",
        projectId
      });
      expect(nextAction).toMatchObject({
        ok: true,
        data: {
          nextAction: {
            actionType: "review_pending_proposal",
            recommendedTool: "inspect_l3_route_operations",
            toolInput: {
              operation: "get_l3_proposal",
              projectId,
              pendingOperationId: (proposed.data as { pendingOperationId: string })
                .pendingOperationId
            }
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("returns an executable write next action with the active RouteLedger root", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initialized = await registry.invoke("init_project", {
        name: "Executable next action",
        contentLocale: "en",
        firstVersion: {
          title: "Current version",
          description: "",
          initialTodos: []
        }
      });
      const data = initialized.data as {
        project: { id: string };
        firstVersion: { id: string };
      };

      const nextAction = await registry.invoke("inspect_route_progress", {
        operation: "next_action",
        projectId: data.project.id
      });

      expect(nextAction).toMatchObject({
        ok: true,
        data: {
          nextAction: {
            actionType: "prepare_version",
            recommendedTool: "set_version_state",
            toolInput: {
              operation: "prepare",
              projectId: data.project.id,
              versionId: data.firstVersion.id,
              expectedRouteLedgerRoot: projectRoot
            }
          }
        }
      });
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
                stepId: "propose_downstream_version",
                type: "propose_downstream_version",
                tool: "propose_version_structure_change",
                toolInput: {
                  operation: "propose_version_creation",
                  projectId: data.project.id,
                  expectedRouteLedgerRoot: projectRoot
                },
                requiredInputs: ["title"]
              }),
              {
                stepId: "execute_downstream_version_creation",
                dependsOn: ["propose_downstream_version"],
                type: "execute_downstream_version_creation",
                tool: "execute_route_change",
                description:
                  "After host admission, execute the persisted Version creation proposal.",
                toolInput: {
                  operation: "execute_admitted_proposal",
                  projectId: data.project.id,
                  expectedRouteLedgerRoot: projectRoot
                },
                inputBindings: [
                  {
                    target: "pendingOperationId",
                    sourceStep: "propose_downstream_version",
                    sourcePath: "pendingOperationId"
                  },
                  {
                    target: "expectedOperationDigest",
                    sourceStep: "propose_downstream_version",
                    sourcePath: "proposal.digest.value",
                    optional: true
                  }
                ]
              },
              {
                stepId: "retry_deferred_with_created_version",
                dependsOn: ["execute_downstream_version_creation"],
                type: "retry_deferred_with_created_version",
                tool: "manage_deferred",
                description:
                  "Retry the original Deferred request with the created downstream Version ID.",
                toolInput: {
                  operation: "defer",
                  mode: "new",
                  projectId: data.project.id,
                  currentVersionId: data.firstVersion.id,
                  title: "Review this later",
                  reason: "There is no downstream Version yet.",
                  idempotencyKey: "deferred-onboarding-contract",
                  expectedRouteLedgerRoot: projectRoot
                },
                inputBindings: [
                  {
                    target: "targetReviewVersionId",
                    sourceStep: "propose_downstream_version",
                    sourcePath: "proposal.targetId"
                  }
                ]
              }
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
