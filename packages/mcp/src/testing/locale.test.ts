import { describe, expect, it } from "vitest";

import { localizeToolResponse, resolveResponseLocale } from "../locale.js";

describe("MCP response locale", () => {
  it("localizes only the selected next action and preserves pending proposal facts", () => {
    const response = localizeToolResponse(
      {
        ok: true,
        data: {
          pendingL3Proposals: [
            {
              id: "pending-create",
              actionType: "create_version",
              targetId: "future-version",
              status: "pending"
            }
          ],
          nextAction: {
            actionType: "review_pending_proposal",
            summary: "original summary",
            reason: "original reason"
          }
        }
      },
      resolveResponseLocale("en"),
      "next_action"
    );

    expect(response.data.pendingL3Proposals[0]).toEqual({
      id: "pending-create",
      actionType: "create_version",
      targetId: "future-version",
      status: "pending"
    });
    expect(response.data.nextAction).toMatchObject({
      summary: "Resolve the pending L3 proposal first.",
      reason: "The pending proposal affects subsequent route decisions."
    });
  });

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
            "reason: none",
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
        "理由: none",
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

    const blocked = localizeToolResponse(
      {
        ok: true,
        data: {
          status: "blocked",
          blockers: [
            { code: "DUE_DEFERRED_REQUIRES_REVIEW", message: "old message" }
          ]
        }
      },
      resolveResponseLocale("zh-CN"),
      "advance_to_version"
    );
    expect(blocked.data.blockers).toEqual([
      {
        code: "DUE_DEFERRED_REQUIRES_REVIEW",
        message: "到期 Deferred 必须在启动目标 Version 前复评。"
      }
    ]);
  });

  it("localizes create_version confirmation review text", () => {
    const response = localizeToolResponse(
      {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: "confirmation required",
          details: {
            humanReviewText: [
              "RouteLedger proposal pending-create",
              "action: create_version",
              "target: version-1",
              "digest: abc123",
              "reason: user supplied reason",
              "blockers: none"
            ].join("\n")
          }
        }
      },
      resolveResponseLocale("zh-CN"),
      "create_version"
    );

    expect(response.error.details.humanReviewText).toBe(
      [
        "RouteLedger 提案 pending-create",
        "操作: create_version",
        "目标: version-1",
        "摘要: abc123",
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
            },
            {
              code: "STALE_CURRENT_VERSION",
              file: "README.md",
              assertionKind: "current_version_id",
              summary: "second original system summary"
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
      "已检查项目 PocketRead 的 1 个入口文件。 当前 Version：组织与检索 (version-2)。 当前路线事实包含 4 个未关闭 Todo、0 个未关闭 Undo，以及 1 个待决 proposal。 发现 2 个 warning，另有 0 个文件无法读取。 覆盖率为 partial：识别到 1 条显式 current Version 声明；2 个声明字段未检测到。"
    );
    expect(docDrift.data.warnings[0].summary).toBe(
      "README.md 的 current_version_title 声明与 RouteLedger 当前事实不一致。"
    );
    expect(docDrift.data.suggestedTodos[0]).toMatchObject({
      title: "同步 README.md 的 current Version 声明",
      reason: [
        "README.md 的 current_version_title 声明与 RouteLedger 当前事实不一致。",
        "README.md 的 current_version_id 声明与 RouteLedger 当前事实不一致。"
      ].join("\n")
    });
    expect(docDrift.data.coverage.limitations).toEqual([
      "比较显式的中文或英文 current Version 声明；简写的当前状态必须有邻近的 current Version 上下文。",
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

  it("localizes every Mission Control runtime notice without changing its semantic code", () => {
    const cases = [
      [
        "MISSION_CONTROL_STOPPED",
        null,
        "RouteLedger Mission Control 尚未启动，是否现在启动并打开当前项目？"
      ],
      [
        "MISSION_CONTROL_PROJECT_UNREGISTERED",
        null,
        "RouteLedger Mission Control 已启动，但当前项目尚未加入。是否将当前项目加入并打开？"
      ],
      [
        "MISSION_CONTROL_INCOMPATIBLE",
        null,
        "当前运行的 RouteLedger Mission Control 与本插件版本不兼容，是否使用当前 runtime 替换并打开当前项目？"
      ],
      [
        "MISSION_CONTROL_STATUS_ERROR",
        null,
        "RouteLedger 无法检查 Mission Control 状态，但可以继续处理路线工作。"
      ],
      [
        "MISSION_CONTROL_RUNNING",
        "http://127.0.0.1:3210/#token=secret",
        "RouteLedger Mission Control 已启动，可通过以下地址访问：http://127.0.0.1:3210/#token=secret"
      ]
    ] as const;

    for (const [code, accessUrl, expectedMessage] of cases) {
      const response = localizeToolResponse(
        {
          ok: true,
          data: {
            missionControl: {
              notice: {
                code,
                message: "English placeholder",
                accessUrl
              }
            }
          }
        },
        resolveResponseLocale("zh-CN"),
        "get_runtime_context"
      );

      expect(response.data.missionControl.notice).toEqual({
        code,
        message: expectedMessage,
        accessUrl
      });
    }
  });
});
