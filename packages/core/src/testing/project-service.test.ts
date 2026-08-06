import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import { createProject, setCurrentVersion } from "../services/project-service.js";
import { TEST_ACTOR, createProjectFixture, createTestDependencies, createVersionFixture } from "./builders.js";

describe("project service", () => {
  it("create_project 自动创建 initial version 并设置 current 真源", () => {
    const deps = createTestDependencies();

    const result = createProject({
      name: "RouteLedger",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.project.initialVersionId).toBe(result.initialVersion.id);
    expect(result.project.currentVersionId).toBe(result.initialVersion.id);
    expect(result.initialVersion.state).toBe("wait");
    expect(result.initialVersion.isCurrent).toBe(true);
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
