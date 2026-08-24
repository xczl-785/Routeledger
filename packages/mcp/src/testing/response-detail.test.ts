import { describe, expect, it } from "vitest";

import { applyAgentResponseDetail } from "../response-detail.js";

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

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

  const routeContextResponse = {
    ok: true,
    data: {
      project: {
        id: "project-1",
        name: "Example",
        status: "active",
        currentVersionId: "version-1",
        contentLocale: "zh",
        updatedAt: "2026-08-24T00:00:00.000Z"
      },
      currentVersion: {
        id: "version-1",
        title: "Initial Version",
        description: "A deliberately verbose Version description for the standard response.",
        state: "ready",
        displayState: "ready",
        displayLabel: "READY",
        stateReason: null,
        order: 1,
        isCurrent: true,
        isDiagnostic: false,
        isShutdown: false,
        updatedAt: "2026-08-24T00:00:00.000Z"
      },
      nextVersion: null,
      versions: [
        {
          id: "version-1",
          title: "Initial Version",
          state: "ready",
          displayState: "ready",
          displayLabel: "READY",
          stateReason: null,
          order: 1,
          isCurrent: true,
          isDiagnostic: false,
          isShutdown: false,
          updatedAt: "2026-08-24T00:00:00.000Z"
        }
      ],
      todos: [],
      currentTodos: [],
      todoScopes: {
        todos: "all_open_route",
        currentTodos: "current_version_open"
      },
      deferred: [],
      constraints: [
        {
          id: "constraint-1",
          rule: "Generated project content must use Chinese.",
          rationale: "A long rationale belongs in standard and audit responses.",
          scope: { type: "project" },
          status: "active",
          updatedAt: "2026-08-24T00:00:00.000Z"
        }
      ],
      dueDeferred: [],
      dueDeferredIds: [],
      unresolvedDeferredIds: [],
      blockedConstraintIds: [],
      gates: {
        start: {
          kind: "start",
          versionId: "version-1",
          allowed: true,
          blockers: [],
          checkedAt: "2026-08-24T00:00:00.000Z"
        },
        close: null
      },
      pendingL3Proposals: [],
      statusRisks: [],
      nextAction: {
        actionType: "start_version",
        recommendedTool: "propose_l3_route_change",
        toolInput: {
          projectId: "project-1",
          actionType: "start_version",
          targetId: "version-1",
          reason: "Start the ready current Version after its start gate passed.",
          expectedRouteLedgerRoot: "D:/workspace/project"
        },
        summary: "Propose starting the target Version.",
        reason: "The target Version is ready and its start gate passes.",
        targetId: "version-1",
        requiresL3Approval: true,
        recordIds: ["version-1"],
        blockingRiskCodes: []
      }
    },
    meta: {
      budgetBytes: 32_768,
      payloadBytes: 4_000,
      truncated: false,
      hasMore: false,
      truncatedFields: [],
      omittedCounts: {},
      runtimeContext: {
        binding: {
          status: "bound",
          workspaceRoot: "D:/workspace",
          routeledgerRoot: "D:/workspace/project"
        },
        projectId: "project-1",
        projectName: "Example",
        hostProfile: "codex",
        runtime: { runtimePackageVersion: "0.10.6" }
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
          "meta.runtimeContext.binding[nonessential]",
          "meta.runtimeContext[nonessential]"
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

  it("keeps a healthy runtime compact response below the R1 budget and smaller than standard", () => {
    const runtimeResponse = {
      ok: true,
      data: {
        binding: {
          status: "bound",
          workspaceRoot: "D:/workspace",
          workspaceRootSource: "explicit_arg",
          workspaceRootConfidence: "high",
          routeledgerRoot: "D:/workspace/project",
          workspaceConfigPath: "D:/workspace/project/.routeledger/config.json",
          dataRoot: "D:/workspace/project",
          routeledgerDir: "D:/workspace/project/.routeledger",
          jsonProjectPath: "D:/workspace/project/.routeledger/project.json",
          sqliteDbPath: "D:/workspace/project/.routeledger/db/routeledger.sqlite3"
        },
        processCwd: "D:/plugin/runtime",
        hostProfile: "codex",
        interactionProfile: "agent_only",
        runtimeProfile: "json-only",
        runtimeIdentity: {
          runtimePackageVersion: "0.10.6",
          runtimeProfile: "json-only",
          artifactKind: "plugin",
          pluginVersion: "0.10.6",
          releaseTag: "routeledger-plugin-v0.10.6",
          provenanceStatus: "external_attestation_required",
          runtimePayloadDigest: "runtime-digest",
          attestation: {
            repositoryUrl: "https://example.test/RouteLedger",
            downloadUrl: "https://example.test/RouteLedger/attestation.json"
          }
        },
        actor: { id: "mcp-agent", displayName: "routeledger-mcp" },
        approver: { id: "host", displayName: "Codex host admission" },
        diagnostics: [],
        storage: {
          mode: "json",
          hasCanonicalJson: true,
          hasSqlite: false,
          dataRoot: "D:/workspace/project",
          jsonProjectPath: "D:/workspace/project/.routeledger/project.json",
          sqliteDbPath: "D:/workspace/project/.routeledger/db/routeledger.sqlite3",
          blockingIssue: null,
          conflict: null,
          jsonError: null,
          sqliteError: null,
          writeLock: null
        },
        activeProject: {
          source: "canonical_json",
          id: "project-1",
          name: "Example",
          currentVersionId: "version-1",
          contentLocale: "zh"
        },
        contentLocale: {
          scope: "project_content_only",
          status: "configured",
          configuredValue: "zh",
          suggestedValue: null,
          suggestionSource: null,
          requiresUserDecision: false,
          effectiveScopes: [
            "project_setting",
            "agent_authored_project_content_default",
            "write_integrity_gate"
          ]
        },
        missionControl: {
          status: "stopped",
          notice: {
            code: "MISSION_CONTROL_STOPPED",
            message: "Mission Control is stopped.",
            requiresUserDecision: true
          },
          recommendedAction: null,
          advisoryAction: {
            tool: "manage_mission_control",
            arguments: { operation: "open" },
            requiresUserDecision: true
          },
          recommendationLevel: "advisory"
        },
        blockedTools: [],
        recommendedNextActions: []
      },
      meta: {
        runtimeContext: {
          binding: {
            status: "bound",
            workspaceRoot: "D:/workspace",
            routeledgerRoot: "D:/workspace/project"
          },
          projectId: "project-1",
          projectName: "Example",
          hostProfile: "codex",
          runtime: { runtimePackageVersion: "0.10.6" }
        }
      }
    } as const;

    const compact = applyAgentResponseDetail(runtimeResponse, {
      detail: "compact",
      explicit: true,
      toolName: "inspect_runtime",
      operation: "runtime",
      riskLevel: "read-only"
    });
    const standard = applyAgentResponseDetail(runtimeResponse, {
      detail: "standard",
      explicit: true,
      toolName: "inspect_runtime",
      operation: "runtime",
      riskLevel: "read-only"
    });

    expect(compact.data).toMatchObject({
      binding: { status: "bound", routeledgerRoot: "D:/workspace/project" },
      activeProject: { id: "project-1", name: "Example" },
      contentLocale: {
        scope: "project_content_only",
        status: "configured",
        configuredValue: "zh"
      },
      missionControl: {
        status: "stopped",
        notice: { code: "MISSION_CONTROL_STOPPED", requiresUserDecision: true },
        advisoryAction: {
          tool: "manage_mission_control",
          arguments: { operation: "open" },
          requiresUserDecision: true
        }
      }
    });
    expect(compact.data).not.toHaveProperty("runtimeIdentity");
    expect(compact.data).not.toHaveProperty("storage");
    expect(compact.data).not.toHaveProperty("agentSummary");
    expect(compact.data).not.toHaveProperty("delta");
    expect(jsonBytes(compact)).toBeLessThanOrEqual(1_536);
    expect(jsonBytes(compact)).toBeLessThan(jsonBytes(standard));
  });

  it("returns only the actionable route summary for compact next_action", () => {
    const compact = applyAgentResponseDetail(routeContextResponse, {
      detail: "compact",
      explicit: true,
      toolName: "inspect_route_progress",
      operation: "next_action",
      riskLevel: "read-only"
    });
    const standard = applyAgentResponseDetail(routeContextResponse, {
      detail: "standard",
      explicit: true,
      toolName: "inspect_route_progress",
      operation: "next_action",
      riskLevel: "read-only"
    });

    expect(compact.data).toMatchObject({
      project: { id: "project-1", currentVersionId: "version-1" },
      currentVersion: { id: "version-1", state: "ready" },
      nextAction: {
        actionType: "start_version",
        recommendedTool: "propose_l3_route_change",
        toolInput: {
          projectId: "project-1",
          targetId: "version-1",
          expectedRouteLedgerRoot: "D:/workspace/project"
        },
        requiresL3Approval: true
      }
    });
    expect(compact.data).not.toHaveProperty("constraints");
    expect(compact.data).not.toHaveProperty("gates");
    expect(compact.data).not.toHaveProperty("agentSummary");
    expect(jsonBytes(compact)).toBeLessThanOrEqual(1_536);
    expect(jsonBytes(compact)).toBeLessThan(jsonBytes(standard));
  });

  it("keeps a small current context semantically complete within the R2 budget", () => {
    const compact = applyAgentResponseDetail(routeContextResponse, {
      detail: "compact",
      explicit: true,
      toolName: "inspect_route_progress",
      operation: "get_current_context",
      riskLevel: "read-only"
    });
    const standard = applyAgentResponseDetail(routeContextResponse, {
      detail: "standard",
      explicit: true,
      toolName: "inspect_route_progress",
      operation: "get_current_context",
      riskLevel: "read-only"
    });

    expect(compact.data).toMatchObject({
      project: { id: "project-1", currentVersionId: "version-1" },
      currentVersion: { id: "version-1", state: "ready" },
      constraints: [
        {
          id: "constraint-1",
          rule: "Generated project content must use Chinese.",
          status: "active"
        }
      ],
      nextAction: {
        actionType: "start_version",
        toolInput: { projectId: "project-1", targetId: "version-1" }
      }
    });
    expect(compact.data?.currentVersion).not.toHaveProperty("description");
    expect(compact.data?.constraints[0]).not.toHaveProperty("rationale");
    expect(compact.data).not.toHaveProperty("todos");
    expect(compact.data).not.toHaveProperty("currentTodos");
    expect(compact.data).not.toHaveProperty("deferred");
    expect(compact.data).not.toHaveProperty("pendingL3Proposals");
    expect(compact.data).not.toHaveProperty("agentSummary");
    expect(jsonBytes(compact)).toBeLessThanOrEqual(2_048);
    expect(jsonBytes(compact)).toBeLessThan(jsonBytes(standard));
  });
});
