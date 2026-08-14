import { describe, expect, it } from "vitest";

import { RouteLedgerService } from "../index.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";
import {
  MemoryStorageAdapter,
  completeCurrentVersion,
  createApprovedArtifact
} from "./routeledger-service-test-helpers.js";

describe("stale L3 approval recovery", () => {
  it("rejects a stale close proposal with live gate differences and an executable recovery chain", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const residualAudit = [
      {
        kind: "debt" as const,
        summary: "No residual debt",
        destination: "close" as const
      }
    ];
    const closeProposal = await service.closeVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      mode: "propose",
      residualAudit,
      actor: TEST_ACTOR
    });
    expect(closeProposal.pendingOperationId).toBeDefined();
    const pendingOperationId = closeProposal.pendingOperationId!;
    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      pendingOperationId
    );
    const lateTodo = await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "Work discovered after approval",
      actor: TEST_ACTOR
    });
    const beforeCommit = await storage.loadProjectAggregate(prepared.projectId);

    const error = await service
      .commitL3Operation({
        projectId: prepared.projectId,
        pendingOperationId,
        approvalArtifactId: artifact.id,
        actor: TEST_ACTOR
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "APPROVAL_ARTIFACT_DIGEST_MISMATCH",
      details: {
        staleProposal: true,
        pendingOperationId,
        approvalArtifactId: artifact.id,
        gateDifference: {
          stored: {
            kind: "close",
            allowed: true,
            blockerCodes: [],
            recordIds: []
          },
          live: {
            kind: "close",
            allowed: false,
            blockerCodes: ["OPEN_TODOS"],
            recordIds: [lateTodo.todo.id]
          },
          addedBlockerCodes: ["OPEN_TODOS"],
          addedRecordIds: [lateTodo.todo.id]
        },
        artifactConsumed: false,
        routeStateWritesPerformed: false,
        recommendedNextActions: [
          {
            action: "reject_stale_proposal",
            tool: "reject_l3_operation",
            input: {
              projectId: prepared.projectId,
              pendingOperationId,
              reason: "Route state changed after approval; reject stale proposal."
            }
          },
          {
            action: "refresh_context",
            tool: "get_current_context",
            input: { projectId: prepared.projectId }
          },
          {
            action: "resolve_live_blocker",
            tool: "close_todo",
            input: {
              projectId: prepared.projectId,
              todoId: lateTodo.todo.id
            },
            requiredInputs: ["reason", "note"]
          },
          {
            action: "recheck_close_gate",
            tool: "check_close_gate",
            input: {
              projectId: prepared.projectId,
              versionId: prepared.versionId,
              residualAudit: { status: "reviewed", items: residualAudit }
            }
          },
          {
            action: "propose_replacement",
            tool: "close_version",
            input: {
              projectId: prepared.projectId,
              versionId: prepared.versionId,
              mode: "propose",
              residualAudit: { status: "reviewed", items: residualAudit }
            }
          }
        ]
      }
    });

    const afterCommit = await storage.loadProjectAggregate(prepared.projectId);
    expect(afterCommit).toEqual(beforeCommit);
    expect(
      afterCommit?.pendingOperations.find((operation) => operation.id === pendingOperationId)
        ?.status
    ).toBe("pending");
    expect(
      afterCommit?.approvalArtifacts.find((current) => current.id === artifact.id)?.status
    ).toBe("approved");
    expect(afterCommit?.versions[0]?.state).toBe("complete");
  });
});
