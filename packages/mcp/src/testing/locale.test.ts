import { describe, expect, it } from "vitest";

import { localizeToolResponse, resolveResponseLocale } from "../locale.js";

describe("MCP response locale", () => {
  it("localizes explicit system fields without rewriting user-shaped payloads", () => {
    const response = localizeToolResponse(
      {
        ok: true,
        data: {
          metadata: {
            code: "OPEN_TODOS",
            message: "user-authored message",
            summary: "user-authored summary",
            actionType: "close_todo",
            reason: "user-authored reason",
            blockers: [
              {
                code: "OPEN_TODOS",
                message: "user-authored nested blocker"
              }
            ]
          },
          blockers: [
            {
              code: "OPEN_TODOS",
              message: "existing system text"
            }
          ]
        }
      },
      resolveResponseLocale("zh-CN"),
      "check_close_gate"
    );

    expect(response.data.metadata).toEqual({
      code: "OPEN_TODOS",
      message: "user-authored message",
      summary: "user-authored summary",
      actionType: "close_todo",
      reason: "user-authored reason",
      blockers: [
        {
          code: "OPEN_TODOS",
          message: "user-authored nested blocker"
        }
      ]
    });
    expect(response.data.blockers[0]).toEqual({
      code: "OPEN_TODOS",
      message: "仍有未关闭 Todo。"
    });
  });

  it("localizes the explicit humanReviewText presentation field", () => {
    const response = localizeToolResponse(
      {
        ok: true,
        data: {
          humanReviewText: [
            "RouteLedger batch proposal pending-1",
            "action: batch_create_versions",
            "reason: user supplied reason",
            "blockers: none"
          ].join("\n")
        }
      },
      resolveResponseLocale("zh-CN"),
      "batch_create_versions"
    );

    expect(response.data.humanReviewText).toBe(
      [
        "RouteLedger 批量提案 pending-1",
        "操作: batch_create_versions",
        "理由: user supplied reason",
        "阻断项: 无"
      ].join("\n")
    );
  });

  it("localizes get_version_structure presentation without changing project titles", () => {
    const response = localizeToolResponse(
      {
        ok: true,
        data: {
          focusVersion: { title: "用户定义的中文标题" },
          legalOperations: [
            {
              actionType: "transition_version",
              allowed: true,
              summary: "剩余步骤: set_current_version -> start_version",
              blockers: [
                {
                  code: "INVALID_VERSION_TRANSITION",
                  message: "原系统消息"
                }
              ],
              details: {
                stepsRemaining: ["set_current_version", "start_version"]
              }
            }
          ]
        }
      },
      resolveResponseLocale("en"),
      "get_version_structure"
    );

    expect(response.data.focusVersion.title).toBe("用户定义的中文标题");
    expect(response.data.legalOperations[0]).toMatchObject({
      summary: "Remaining steps: set_current_version -> start_version",
      blockers: [
        {
          code: "INVALID_VERSION_TRANSITION",
          message: "The current Version state does not allow this operation."
        }
      ]
    });
  });
});
