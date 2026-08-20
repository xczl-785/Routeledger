import { describe, expect, it, vi } from "vitest";

import {
  createBindingAssistTools,
  createProjectBootstrapTools
} from "../capabilities/binding-tools.js";

const actor = { id: "agent", type: "agent" as const };

describe("binding tool registrations", () => {
  it("preserves the binding-assist and bootstrap segments", () => {
    const bindingTools = createBindingAssistTools({
      readBinding: vi.fn(),
      hostProfile: "codex",
      withCurrentRuntimeContextMeta: () => ({}),
      stagePendingSessionRebind: vi.fn(),
      operations: {} as never
    });
    const bootstrapTools = createProjectBootstrapTools({
      service: {} as never,
      actor
    });

    expect(bindingTools.map((tool) => tool.definition.name)).toEqual([
      "discover_routeledger_roots",
      "plan_routeledger_binding",
      "activate_routeledger_binding",
      "render_host_binding_config",
      "write_host_binding_config"
    ]);
    expect(bootstrapTools.map((tool) => tool.definition.name)).toEqual([
      "init_project",
      "set_project_content_locale"
    ]);
  });

  it("stages a confirmed high-confidence Codex binding switch", async () => {
    const previousBinding = {
      status: "bound",
      workspaceRootConfidence: "high"
    } as never;
    const bindingPlan = {
      status: "ready",
      targetBinding: {
        workspaceRoot: "D:\\next",
        routeledgerRoot: "D:\\next\\ledger"
      },
      requiresInit: false
    } as never;
    const stagePendingSessionRebind = vi.fn();
    const tools = createBindingAssistTools({
      readBinding: () => previousBinding,
      hostProfile: "codex",
      withCurrentRuntimeContextMeta: () => ({}),
      stagePendingSessionRebind,
      operations: {
        discoverRouteLedgerRoots: vi.fn(),
        planRouteLedgerBinding: vi.fn().mockResolvedValue(bindingPlan),
        renderHostBindingConfig: vi.fn(),
        writeHostBindingConfig: vi.fn()
      }
    });

    const response = await tools
      .find((tool) => tool.definition.name === "activate_routeledger_binding")!
      .handler({
        workspaceRoot: "D:\\next",
        routeledgerRoot: "D:\\next\\ledger",
        confirmProjectSwitch: true
      });

    expect(response).toMatchObject({
      ok: true,
      data: { status: "pending_session_rebind", requiresInit: false }
    });
    expect(stagePendingSessionRebind).toHaveBeenCalledWith({
      workspaceRoot: "D:\\next",
      routeledgerRoot: "D:\\next\\ledger",
      previousBinding,
      bindingPlan,
      requiresInit: false,
      workspaceGitAttributesExisted: false,
      dataGitAttributesExisted: false
    });
  });

  it("delegates project bootstrap writes with the registry actor", async () => {
    const initProject = vi.fn().mockResolvedValue({ id: "project" });
    const setProjectContentLocale = vi.fn().mockResolvedValue({ contentLocale: "zh-CN" });
    const tools = createProjectBootstrapTools({
      service: { initProject, setProjectContentLocale } as never,
      actor
    });

    await tools.find((tool) => tool.definition.name === "init_project")!.handler({
      name: "Project",
      contentLocale: "zh-CN"
    });
    await tools
      .find((tool) => tool.definition.name === "set_project_content_locale")!
      .handler({ projectId: "project", contentLocale: "zh-CN", reason: "confirmed" });

    expect(initProject).toHaveBeenCalledWith({
      name: "Project",
      description: undefined,
      contentLocale: "zh-CN",
      firstVersion: null,
      actor
    });
    expect(setProjectContentLocale).toHaveBeenCalledWith({
      projectId: "project",
      contentLocale: "zh-CN",
      reason: "confirmed",
      actor
    });
  });
});
