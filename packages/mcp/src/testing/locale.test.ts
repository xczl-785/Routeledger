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

  it("localizes advance_to_version review text and route blockers", () => {
    const response = localizeToolResponse(
      {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: "confirmation required",
          details: {
            humanReviewText: [
              "RouteLedger proposal pending-advance",
              "action: advance_to_version",
              "blockers: CURRENT_VERSION_NOT_CLOSED, TARGET_VERSION_NOT_NEXT"
            ].join("\n"),
            blockers: [
              { code: "CURRENT_VERSION_NOT_CLOSED", message: "old message" },
              { code: "TARGET_VERSION_NOT_NEXT", message: "old message" }
            ]
          }
        }
      },
      resolveResponseLocale("zh-CN"),
      "advance_to_version"
    );

    expect(response.error.details.humanReviewText).toContain("RouteLedger 提案 pending-advance");
    expect(response.error.details.humanReviewText).toContain("操作: advance_to_version");
    expect(response.error.details.blockers).toEqual([
      { code: "CURRENT_VERSION_NOT_CLOSED", message: "当前 Version 尚未关闭，不能推进到下一 Version。" },
      { code: "TARGET_VERSION_NOT_NEXT", message: "目标 Version 不是当前 Version 的直接后继。" }
    ]);
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

  it("localizes doc drift summaries and transition guide labels for zh-CN", () => {
    const docDrift = localizeToolResponse(
      {
        ok: true,
        data: {
          project: { name: "PocketRead" },
          routeTruth: {
            currentVersion: { id: "version-2", title: "组织与检索" },
            openTodoCount: 4,
            openUndoCount: 0,
            pendingProposalCount: 1
          },
          checkedFiles: [{ path: "README.md" }],
          unreadableFiles: [],
          warnings: [
            {
              code: "STALE_CURRENT_VERSION",
              file: "README.md",
              assertionKind: "current_version_title",
              summary: "original system summary"
            }
          ],
          suggestedTodos: [
            {
              title: "同步 README.md 的 current version 指针",
              reason: "original system reason",
              file: "README.md"
            }
          ],
          coverage: {
            level: "partial",
            recognizedAssertionCount: 1,
            notDetectedAssertionCount: 2,
            limitations: ["original limitation"]
          },
          summaryText: "Checked 1 entry files for project PocketRead."
        }
      },
      resolveResponseLocale("zh-CN"),
      "check_doc_drift"
    );
    const guide = localizeToolResponse(
      {
        ok: true,
        data: {
          recommendedSteps: [
            { label: "Prepare target version" },
            { label: "Approve transition proposal" }
          ],
          notes: [
            "Read-only guide only. It never creates pending proposals; execute the listed existing tools step by step."
          ]
        }
      },
      resolveResponseLocale("zh-CN"),
      "get_version_transition_guide"
    );

    expect(docDrift.data.summaryText).toBe(
      "已检查项目 PocketRead 的 1 个入口文件。 当前 Version：组织与检索 (version-2)。 当前路线事实包含 4 个未关闭 Todo、0 个未关闭 Undo，以及 1 个待决 proposal。 发现 1 个 warning，另有 0 个文件无法读取。 覆盖率为 partial：识别到 1 条显式 current Version 声明；2 个声明字段未检测到。"
    );
    expect(docDrift.data.warnings[0].summary).toBe(
      "README.md 的 current_version_title 声明与 RouteLedger 当前事实不一致。"
    );
    expect(docDrift.data.suggestedTodos[0]).toMatchObject({
      title: "同步 README.md 的 current Version 声明",
      reason: "README.md 的 current_version_title 声明与 RouteLedger 当前事实不一致。"
    });
    expect(docDrift.data.coverage.limitations).toEqual([
      "仅比较显式的中文或英文 current Version 声明。",
      "partial 结果不能证明检查文档中的所有路线表述均为最新。"
    ]);
    expect(guide.data).toEqual({
      recommendedSteps: [
        { label: "准备目标 Version" },
        { label: "审批转换 proposal" }
      ],
      notes: ["这是只读向导，不会创建待决 proposal；请逐步执行列出的现有工具。"]
    });
  });

  it("localizes transition guide reasons and dynamic notes without changing project content", () => {
    const response = localizeToolResponse(
      {
        ok: true,
        data: {
          targetVersion: { title: "用户提供的标题" },
          recommendedSteps: [
            {
              label: "Prepare target version",
              reason:
                "target version 仍是 wait，需先 prepare_version 才能进入 ready/start 路径。"
            }
          ],
          notes: [
            "target version 目前是 complete，已超出本 guide 的常规 close -> start 向导路径。",
            "fromVersion 不是当前 current version。请先确认 live current，再决定是否仍按该 from -> target 顺序推进。"
          ]
        }
      },
      resolveResponseLocale("en"),
      "get_version_transition_guide"
    );

    expect(response.data).toEqual({
      targetVersion: { title: "用户提供的标题" },
      recommendedSteps: [
        {
          label: "Prepare the target Version",
          reason:
            "The target Version is still in `wait`; run prepare_version before entering the ready/start path."
        }
      ],
      notes: [
        "The target Version is in `complete`, outside this guide's ordinary close -> start path.",
        "fromVersion is not the current Version. Confirm the live route before continuing from the source to the target."
      ]
    });
  });
});
