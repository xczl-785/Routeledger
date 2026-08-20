import { describe, expect, it } from "vitest";

import { normalizeAgentToolResponse } from "../agent-response.js";

describe("MCP canonical agent response", () => {
  it("normalizes coded system fields to English without rewriting user content", () => {
    const response = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          metadata: {
            message: "用户内容",
            summary: "用户摘要",
            title: "用户标题"
          },
          blockers: [{ code: "OPEN_TODOS", message: "旧系统消息" }]
        }
      },
      "check_close_gate"
    );

    expect(response.data.metadata).toEqual({
      message: "用户内容",
      summary: "用户摘要",
      title: "用户标题"
    });
    expect(response.data.blockers).toEqual([
      { code: "OPEN_TODOS", message: "Open Todos remain." }
    ]);
    expect((response as typeof response & { meta: Record<string, unknown> }).meta).not.toHaveProperty(
      "language"
    );
  });

  it("normalizes only the selected next action and preserves pending proposal facts", () => {
    const response = normalizeAgentToolResponse(
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
            summary: "旧摘要",
            reason: "旧原因"
          }
        }
      },
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

  it("normalizes decision guidance and nested current-context gates to canonical English", () => {
    const response = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          gates: {
            close: {
              blockers: [
                {
                  code: "TARGET_VERSION_NOT_COMPLETE",
                  message: "close gate 仅允许 complete version 进入 close"
                },
                {
                  code: "MISSING_RESIDUAL_AUDIT",
                  message: "close gate 需要 residual audit"
                }
              ]
            }
          },
          nextAction: {
            actionType: "decision_required",
            summary: "当前 Version 正在运行，但没有开放工作项。",
            reason: "请判断当前阶段是否仍有工作需要记录，或实现是否确已完成。",
            choices: [
              { actionType: "create_todo", when: "当前阶段仍有实现工作。" },
              { actionType: "mark_version_complete", when: "当前阶段实现确已完成。" }
            ]
          }
        }
      },
      "get_current_context"
    );

    expect(response.data.gates.close.blockers).toEqual([
      {
        code: "TARGET_VERSION_NOT_COMPLETE",
        message: "Only a Version in the `complete` state can be closed."
      },
      {
        code: "MISSING_RESIDUAL_AUDIT",
        message: "A residual audit is required before the Version can be closed."
      }
    ]);
    expect(response.data.nextAction).toMatchObject({
      summary: "Decide whether the running Version needs more recorded work.",
      reason: "The current Version is running but has no open Todo.",
      choices: [
        { when: "Implementation work remains." },
        { when: "Implementation is actually complete." }
      ]
    });

    const inspected = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          blockers: [
            { code: "TARGET_VERSION_NOT_COMPLETE", message: "different endpoint text" },
            { code: "MISSING_RESIDUAL_AUDIT", message: "different endpoint text" }
          ]
        }
      },
      "check_close_gate"
    );
    const structured = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          legalOperations: [
            {
              actionType: "close_version",
              summary: "旧摘要",
              blockers: [
                { code: "TARGET_VERSION_NOT_COMPLETE", message: "third endpoint text" },
                { code: "MISSING_RESIDUAL_AUDIT", message: "third endpoint text" }
              ]
            }
          ]
        }
      },
      "get_version_structure"
    );

    expect(inspected.data.blockers.map((blocker) => blocker.message)).toEqual(
      response.data.gates.close.blockers.map((blocker) => blocker.message)
    );
    expect(
      structured.data.legalOperations[0].blockers.map((blocker) => blocker.message)
    ).toEqual(response.data.gates.close.blockers.map((blocker) => blocker.message));
  });

  it("normalizes Version structure guidance without changing project titles", () => {
    const response = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          focusVersion: { title: "用户定义的中文标题" },
          legalOperations: [
            {
              actionType: "transition_version",
              allowed: true,
              summary: "旧摘要",
              blockers: [
                { code: "INVALID_VERSION_TRANSITION", message: "旧系统消息" }
              ],
              details: { stepsRemaining: ["set_current_version", "start_version"] }
            }
          ]
        }
      },
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

  it("normalizes doc-drift presentation to canonical English", () => {
    const response = normalizeAgentToolResponse(
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
              summary: "旧系统摘要"
            }
          ],
          suggestedTodos: [
            {
              title: "任意旧标题",
              reason: "任意旧原因",
              file: "README.md"
            }
          ],
          coverage: {
            level: "partial",
            recognizedAssertionCount: 1,
            notDetectedAssertionCount: 2,
            limitations: ["旧限制"]
          },
          summaryText: "旧摘要"
        }
      },
      "check_doc_drift"
    );

    expect(response.data.summaryText).toContain(
      "Checked 1 entry files for project PocketRead."
    );
    expect(response.data.warnings[0].summary).toBe(
      "README.md declares current_version_title inconsistently with the current RouteLedger truth."
    );
    expect(response.data.suggestedTodos[0]).toMatchObject({
      title: "任意旧标题",
      reason: "任意旧原因"
    });
    expect(response.data.coverage.limitations).toEqual([
      "Explicit Chinese or English current-Version declarations are compared; short current-state aliases require nearby current-Version context.",
      "A partial result does not prove that every route statement in the checked documents is current."
    ]);
  });

  it("normalizes unreadable doc-drift diagnostics while preserving localized Todo content", () => {
    const response = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          project: { name: "testproject" },
          routeTruth: {
            currentVersion: null,
            openTodoCount: 0,
            openUndoCount: 0,
            pendingProposalCount: 0
          },
          checkedFiles: [],
          unreadableFiles: [{ path: "README.md", code: "ENOENT" }],
          warnings: [
            {
              code: "UNREADABLE_ENTRY_FILE",
              file: "README.md",
              summary: "README.md 无法读取，未完成该入口文档的漂移检查。",
              expected: "A readable entry file.",
              actual: "ENOENT: file not found"
            },
            {
              code: "MISSING_EXPECTED_POINTER",
              file: null,
              summary: "入口文档没有指向期望路径 .routeledger/project.json。",
              expected: ".routeledger/project.json",
              actual: "旧说明"
            }
          ],
          suggestedTodos: [
            {
              title: "补入口文档指针：.routeledger/project.json",
              reason: "入口文档没有指向期望路径 .routeledger/project.json。",
              file: null
            }
          ],
          coverage: {
            level: "none",
            recognizedAssertionCount: 0,
            notDetectedAssertionCount: 0,
            limitations: ["旧限制"]
          },
          summaryText: "旧摘要"
        }
      },
      "check_doc_drift"
    );

    expect(response.data.warnings).toEqual([
      expect.objectContaining({
        code: "UNREADABLE_ENTRY_FILE",
        summary: "README.md could not be read, so its drift check was not completed."
      }),
      expect.objectContaining({
        code: "MISSING_EXPECTED_POINTER",
        summary: "No entry document points to the expected path .routeledger/project.json.",
        actual: "No checked entry file contains the expected pointer path."
      })
    ]);
    expect(response.data.suggestedTodos[0]).toMatchObject({
      title: "补入口文档指针：.routeledger/project.json",
      reason: "入口文档没有指向期望路径 .routeledger/project.json。"
    });
    expect(response.data.summaryText).not.toMatch(/[\p{Script=Han}]/u);
    expect(response.data.coverage.limitations.join(" ")).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("normalizes Mission Control notices to canonical English", () => {
    const response = normalizeAgentToolResponse(
      {
        ok: true,
        data: {
          missionControl: {
            notice: {
              code: "MISSION_CONTROL_STOPPED",
              message: "旧系统消息",
              accessUrl: null
            }
          }
        }
      },
      "get_runtime_context"
    );

    expect(response.data.missionControl.notice).toEqual({
      code: "MISSION_CONTROL_STOPPED",
      message:
        "RouteLedger Mission Control is not running. Would you like to start it and open the current project?",
      accessUrl: null
    });
  });
});
