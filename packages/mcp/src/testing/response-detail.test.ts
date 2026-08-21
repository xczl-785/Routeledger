import { describe, expect, it } from "vitest";

import { applyAgentResponseDetail } from "../response-detail.js";

describe("agent response detail projection", () => {
  const fullResponse = {
    ok: true,
    data: {
      status: "committed",
      proposalId: "proposal-1",
      proposal: {
        id: "proposal-1",
        projectId: "project-1",
        actionType: "close_version",
        targetId: "version-1",
        status: "committed",
        reason: "route complete",
        digest: {
          algorithm: "sha256",
          value: "digest-1",
          payload: { large: "x".repeat(2_000) }
        },
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:01:00.000Z"
      },
      approvalArtifact: {
        id: "artifact-1",
        pendingOperationId: "proposal-1",
        status: "consumed",
        authorizationId: "authorization-1",
        operationDigest: "digest-1",
        authorization: { fullReceipt: "x".repeat(1_000) }
      },
      events: [
        {
          id: "event-1",
          type: "version.closed",
          createdAt: "2026-08-21T00:01:00.000Z",
          payload: { duplicatedEntity: "x".repeat(1_000) }
        }
      ],
      recommendedNextActions: [
        {
          tool: "inspect_route_progress",
          input: {
            operation: "get_current_context",
            projectId: "project-1",
            payload: { requiredForExecution: true }
          }
        }
      ]
    },
    meta: {
      runtimeContext: {
        binding: {
          status: "bound",
          workspaceRoot: "D:/workspace",
          routeledgerRoot: "D:/workspace/project",
          jsonProjectPath: "D:/workspace/project/.routeledger/project.json"
        },
        projectId: "project-1",
        projectName: "Example",
        hostProfile: "codex",
        runtime: {
          runtimePackageVersion: "0.10.3",
          runtimeProfile: "plugin",
          runtimePayloadDigest: "runtime-digest"
        }
      }
    }
  } as const;

  it("leaves the default standard response byte-for-byte compatible", () => {
    expect(
      applyAgentResponseDetail(fullResponse, {
        detail: "standard",
        explicit: false,
        toolName: "execute_route_change",
        operation: "commit_l3_operation",
        riskLevel: "high-risk"
      })
    ).toEqual(fullResponse);
  });

  it("keeps actionable and authorization evidence while omitting audit-heavy bodies", () => {
    const compact = applyAgentResponseDetail(fullResponse, {
      detail: "compact",
      explicit: true,
      toolName: "execute_route_change",
      operation: "commit_l3_operation",
      riskLevel: "high-risk"
    });

    expect(compact).toMatchObject({
      ok: true,
      data: {
        status: "committed",
        proposalId: "proposal-1",
        proposal: {
          id: "proposal-1",
          actionType: "close_version",
          targetId: "version-1",
          status: "committed",
          digest: { algorithm: "sha256", value: "digest-1" }
        },
        approvalArtifact: {
          id: "artifact-1",
          pendingOperationId: "proposal-1",
          status: "consumed",
          authorizationId: "authorization-1",
          operationDigest: "digest-1"
        },
        events: [
          {
            id: "event-1",
            type: "version.closed",
            createdAt: "2026-08-21T00:01:00.000Z"
          }
        ],
        recommendedNextActions: [
          expect.objectContaining({
            input: expect.objectContaining({
              payload: { requiredForExecution: true }
            })
          })
        ],
        agentSummary: {
          outcome: "committed",
          tool: "execute_route_change",
          operation: "commit_l3_operation",
          primaryId: "proposal-1"
        },
        delta: {
          kind: "updated",
          entityIds: expect.arrayContaining(["proposal-1", "version-1"])
        }
      },
      meta: {
        detailApplied: "compact",
        payloadBytes: expect.any(Number),
        hasMore: true,
        omittedSections: expect.arrayContaining([
          "data.proposal.digest.payload",
          "data.approvalArtifact.authorization",
          "data.events[].payload",
          "meta.runtimeContext.binding.workspaceRoot",
          "meta.runtimeContext.runtime"
        ]),
        runtimeContext: {
          binding: {
            status: "bound",
            routeledgerRoot: "D:/workspace/project"
          },
          projectId: "project-1",
          hostProfile: "codex"
        }
      }
    });
    expect(JSON.stringify(compact)).not.toContain("duplicatedEntity");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(fullResponse).length / 2);
  });

  it("preserves the complete response when audit detail is explicit", () => {
    const audit = applyAgentResponseDetail(fullResponse, {
      detail: "audit",
      explicit: true,
      toolName: "execute_route_change",
      operation: "commit_l3_operation",
      riskLevel: "high-risk"
    });

    expect(audit.data).toEqual(fullResponse.data);
    expect(audit.meta).toMatchObject({
      runtimeContext: fullResponse.meta.runtimeContext,
      detailApplied: "audit",
      hasMore: false,
      omittedSections: []
    });
  });
});
