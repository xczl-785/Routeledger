import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import {
  createProject,
  setCurrentVersion,
  setProjectContentLocale
} from "../services/project-service.js";
import { TEST_ACTOR, createProjectFixture, createTestDependencies, createVersionFixture } from "./builders.js";

describe("project service", () => {
  it("create_project 自动创建 initial version 并设置 current 真源", () => {
    const deps = createTestDependencies();

    const result = createProject({
      contentLocale: "en",
      name: "RouteLedger",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.project.initialVersionId).toBe(result.initialVersion.id);
    expect(result.project.currentVersionId).toBe(result.initialVersion.id);
    expect(result.initialVersion.state).toBe("wait");
    expect(result.initialVersion.isCurrent).toBe(true);
  });

  it("create_project 要求具体 locale、拒绝 auto，并规范化 BCP 47", () => {
    const deps = createTestDependencies();

    try {
      createProject({
        contentLocale: "auto",
        name: "RouteLedger",
        actor: TEST_ACTOR,
        deps
      });
      throw new Error("expected auto locale to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONTENT_LOCALE_MUST_BE_CONCRETE" });
    }

    const result = createProject({
      contentLocale: "zh-cn",
      name: "RouteLedger",
      actor: TEST_ACTOR,
      deps: createTestDependencies()
    });

    expect(result.project.settings.contentLocale).toBe("zh-CN");
    expect(result.initialVersion).toMatchObject({
      title: "初始 Version",
      description: "项目初始化 Version"
    });
  });

  it("set_project_content_locale 可为 legacy null 项目补齐语言并留下事件", () => {
    const result = setProjectContentLocale({
      project: createProjectFixture({
        settings: {
          enforceStartGate: true,
          enforceCloseGate: true,
          contextBudgetBytes: 32768,
          contentLocale: null
        }
      }),
      contentLocale: "zh-cn",
      reason: "用户确认项目内容使用中文",
      actor: TEST_ACTOR,
      deps: createTestDependencies()
    });

    expect(result.project.settings.contentLocale).toBe("zh-CN");
    expect(result.events).toEqual([
      expect.objectContaining({
        eventType: "project.content_locale_changed",
        fromState: null,
        toState: "zh-CN",
        note: "用户确认项目内容使用中文"
      })
    ]);
  });

  it("set_current_version 会 suspend 旧 running current", () => {
    const deps = createTestDependencies();
    const project = createProjectFixture({
      currentVersionId: "version-old"
    });
    const currentVersion = createVersionFixture({
      id: "version-old",
      state: "running",
      isCurrent: true
    });
    const nextVersion = createVersionFixture({
      id: "version-new",
      state: "ready",
      isCurrent: false
    });

    const result = setCurrentVersion({
      project,
      currentVersion,
      nextVersion,
      actor: TEST_ACTOR,
      deps
    });

    expect(result.project.currentVersionId).toBe("version-new");
    expect(result.currentVersion?.state).toBe("suspend");
    expect(result.currentVersion?.isCurrent).toBe(false);
    expect(result.nextVersion.isCurrent).toBe(true);
    expect(result.events.map((event) => event.operationSeq)).toEqual([1, 2]);
  });

  it("project.currentVersionId 非空时不允许缺失旧 current version", () => {
    const deps = createTestDependencies();
    const project = createProjectFixture({
      currentVersionId: "version-old"
    });
    const nextVersion = createVersionFixture({
      id: "version-new",
      state: "ready"
    });

    expect(() =>
      setCurrentVersion({
        project,
        currentVersion: null,
        nextVersion,
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("project.currentVersionId 非空时必须传入匹配的旧 current version", () => {
    const deps = createTestDependencies();
    const project = createProjectFixture({
      currentVersionId: "version-old"
    });
    const currentVersion = createVersionFixture({
      id: "version-other",
      state: "running",
      isCurrent: true
    });
    const nextVersion = createVersionFixture({
      id: "version-new",
      state: "ready"
    });

    expect(() =>
      setCurrentVersion({
        project,
        currentVersion,
        nextVersion,
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });
});
