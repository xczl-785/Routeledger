import { describe, expect, it } from "vitest";

import { ApplicationError, DomainError } from "@routeledger/core";

import { toToolError } from "../index.js";
import { localizeToolResponse, resolveResponseLocale } from "../locale.js";

describe("MCP business error recovery", () => {
  it("treats a repeated close_todo as an already-applied boundary without weakening the state machine", () => {
    const response = toToolError(
        new DomainError("INVALID_TODO_TRANSITION", "cannot close", {
          todoId: "todo-1",
          status: "closed"
        }),
        { toolName: "manage_todo", input: { operation: "close", projectId: "project-1", todoId: "todo-1" } }
      );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_TODO_TRANSITION",
        details: {
          recoveryState: "already_applied",
          currentState: "closed",
          expectedState: "wait_or_running",
          blockedReason: "INVALID_TODO_TRANSITION",
          safeToRetry: false,
          writesPerformed: false,
          artifactConsumed: false,
          recommendedNextActions: [
            expect.objectContaining({ type: "continue_route", tool: "next_action" })
          ]
        }
      }
    });
    expect(
      localizeToolResponse(response, resolveResponseLocale("zh-CN"), "close_todo")
    ).toMatchObject({
      error: {
        message: "Todo 已关闭，无需重试；请继续处理后续路线。",
        details: {
          recommendedNextActions: [
            expect.objectContaining({ description: "Todo 已关闭；不要重试写入，继续读取下一步路线动作。" })
          ]
        }
      }
    });
  });

  it("preserves legal Deferred candidates and recommends retrying with one of them", () => {
    expect(
      toToolError(
        new DomainError("DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM", "not downstream", {
          sourceVersionId: "version-2",
          targetReviewVersionId: "version-1",
          eligibleTargetVersions: [
            { id: "version-3", title: "Version 3", state: "wait", order: 3 }
          ]
        }),
        { toolName: "defer_work", input: { projectId: "project-1" } }
      )
    ).toMatchObject({
      ok: false,
      error: {
        details: {
          recoveryState: "retry_with_legal_target",
          currentState: "invalid_target",
          expectedState: "downstream_version",
          safeToRetry: true,
          writesPerformed: false,
          artifactConsumed: false,
          eligibleTargetVersions: [{ id: "version-3" }],
          recommendedNextActions: [
            expect.objectContaining({
              type: "choose_legal_deferred_target",
              tool: "defer_work",
              toolInput: expect.objectContaining({
                projectId: "project-1",
                targetReviewVersionId: "version-3"
              })
            })
          ]
        }
      }
    });
  });

  it("routes stale create_version targets back through structure inspection", () => {
    expect(
      toToolError(
        new DomainError("INVALID_VERSION_TRANSITION", "stale target", {
          targetId: "old-tail"
        }),
        {
          toolName: "execute_route_change",
          input: { operation: "execute_l3_operation", projectId: "project-1", actionType: "create_version", targetId: "old-tail" }
        }
      )
    ).toMatchObject({
      ok: false,
      error: {
        details: {
          recoveryState: "inspect_current_route",
          currentState: "stale_route_target",
          expectedState: "current_route_tail",
          safeToRetry: true,
          writesPerformed: false,
          artifactConsumed: false,
          recommendedNextActions: [
            expect.objectContaining({ type: "inspect_version_structure", tool: "get_version_structure" }),
            expect.objectContaining({
              type: "retry_create_version",
              tool: "propose_version_creation",
              toolInput: { projectId: "project-1" },
              requiredInputs: ["title"]
            })
          ]
        }
      }
    });
  });

  it("normalizes the complete stale-proposal recovery chain without hiding safety evidence", () => {
    const response = toToolError(
      new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "stale", {
        staleProposal: true,
        artifactConsumed: false,
        routeStateWritesPerformed: false,
        recommendedNextActions: [
          {
            action: "reject_stale_proposal",
            tool: "reject_l3_operation",
            input: { projectId: "project-1", pendingOperationId: "proposal-1" }
          },
          {
            action: "refresh_context",
            tool: "get_current_context",
            input: { projectId: "project-1" }
          }
        ]
      }),
      { toolName: "commit_l3_operation", input: { projectId: "project-1" } }
    );

    expect(response).toMatchObject({
      error: {
        details: {
          staleProposal: true,
          artifactConsumed: false,
          routeStateWritesPerformed: false,
          recoveryState: "stale_proposal",
          currentState: "stale_proposal",
          expectedState: "live_gate_match",
          safeToRetry: false,
          writesPerformed: false,
          recommendedNextActions: [
            expect.objectContaining({
              type: "reject_stale_proposal",
              tool: "reject_l3_operation",
              toolInput: expect.objectContaining({ pendingOperationId: "proposal-1" })
            }),
            expect.objectContaining({
              type: "refresh_context",
              tool: "get_current_context"
            })
          ]
        }
      }
    });
  });
});
