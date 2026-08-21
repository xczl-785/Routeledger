import { expect, it, describe } from "vitest";

import { SQLiteStorageAdapter } from "@routeledger/sqlite";
import { createUndoFixture, createWorkItemFixture } from "@routeledger/core/testing";

import { createTempProjectRoot, cleanupProjectRoot, runCliJsonWithFirstVersion, createVersionViaL3 } from "./cli-test-helpers.js";
describe("routeledger cli", () => {
  it("Deferred CLI 覆盖新建、Todo 转换、再次延后、激活与解决，并在重启后保持精简输出", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, [
        "init_project",
        "--name",
        "Deferred CLI",
        "--content-locale",
        "en"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const version1Id = initResult.stdoutJson.data.firstVersion!.id as string;
      const version2Id = await createVersionViaL3(projectRoot, projectId, "Version 2");
      const version3Id = await createVersionViaL3(projectRoot, projectId, "Version 3");

      const todoResult = await runCliJsonWithFirstVersion(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        version1Id,
        "--title",
        "Existing Todo",
        "--description",
        "Move this work out of the current path"
      ]);
      const todoId = todoResult.stdoutJson.data.todo.id as string;
      const fromTodoResult = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "from-todo",
        "--project-id",
        projectId,
        "--todo-id",
        todoId,
        "--target-review-version-id",
        version2Id,
        "--reason",
        "Review later",
        "--note",
        "Convert the Todo",
        "--review-trigger",
        "Version 2 planning"
      ]);
      const convertedDeferredId = fromTodoResult.stdoutJson.data.deferred.id as string;

      expect(fromTodoResult.exitCode).toBe(0);
      expect(fromTodoResult.stdoutJson.data).toMatchObject({
        mode: "todo",
        todo: {
          id: todoId,
          status: "converted"
        },
        deferred: {
          id: convertedDeferredId,
          targetReviewVersionId: version2Id,
          status: "pending",
          reviewTrigger: "Version 2 planning"
        }
      });
      expect(JSON.stringify(fromTodoResult.stdoutJson.data)).not.toContain("workItem");
      expect(JSON.stringify(fromTodoResult.stdoutJson.data)).not.toContain(
        "originVersionId"
      );
      expect(JSON.stringify(fromTodoResult.stdoutJson.data)).not.toContain("events");

      const deferredAgainResult = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "defer-again",
        "--project-id",
        projectId,
        "--deferred-id",
        convertedDeferredId,
        "--target-review-version-id",
        version3Id,
        "--reason",
        "Needs one more review cycle",
        "--note",
        "Route to Version 3"
      ]);

      expect(deferredAgainResult.exitCode).toBe(0);
      expect(deferredAgainResult.stdoutJson.data).toMatchObject({
        action: "defer_again",
        deferred: {
          id: convertedDeferredId,
          targetReviewVersionId: version3Id,
          status: "pending"
        }
      });

      const resolveResult = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "resolve",
        "--project-id",
        projectId,
        "--deferred-id",
        convertedDeferredId,
        "--outcome",
        "superseded",
        "--reason",
        "Covered by the replacement",
        "--note",
        "Close after review"
      ]);

      expect(resolveResult.exitCode).toBe(0);
      expect(resolveResult.stdoutJson.data).toMatchObject({
        action: "resolve",
        deferred: {
          id: convertedDeferredId,
          status: "resolved",
          resolutionOutcome: "superseded"
        }
      });

      const createResult = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "create",
        "--project-id",
        projectId,
        "--current-version-id",
        version1Id,
        "--target-review-version-id",
        version2Id,
        "--title",
        "New deferred work",
        "--description",
        "Review this in Version 2",
        "--reason",
        "Not part of Version 1"
      ]);
      const createdDeferredId = createResult.stdoutJson.data.deferred.id as string;

      expect(createResult.exitCode).toBe(0);
      expect(createResult.stdoutJson.data).toMatchObject({
        mode: "new",
        deferred: {
          id: createdDeferredId,
          targetReviewVersionId: version2Id,
          status: "pending"
        }
      });

      const activateResult = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "activate",
        "--project-id",
        projectId,
        "--deferred-id",
        createdDeferredId,
        "--target-version-id",
        version2Id,
        "--reason",
        "Ready to execute",
        "--note",
        "Activate as a Todo"
      ]);

      expect(activateResult.exitCode).toBe(0);
      expect(activateResult.stdoutJson.data).toMatchObject({
        action: "activate",
        deferred: {
          id: createdDeferredId,
          status: "activated",
          resolutionOutcome: "activated"
        },
        todo: {
          versionId: version2Id,
          status: "wait"
        }
      });
      expect(JSON.stringify(activateResult.stdoutJson.data)).not.toContain("workItem");

      const contextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);

      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.deferred).toEqual([]);

      const storage = new SQLiteStorageAdapter({ projectRoot });
      const persisted = await storage.loadProjectAggregate(projectId);
      storage.close();
      expect(persisted?.deferredItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: convertedDeferredId, status: "resolved" }),
          expect.objectContaining({ id: createdDeferredId, status: "activated" })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Constraint CLI 记录 project/version 规则并退休，持久化重启后仍可审计", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, [
        "init_project",
        "--name",
        "Constraint CLI",
        "--content-locale",
        "en"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const projectConstraintResult = await runCliJsonWithFirstVersion(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "project",
        "--rule",
        "All changes require evidence",
        "--rationale",
        "Keep the route auditable"
      ]);
      const projectConstraintId =
        projectConstraintResult.stdoutJson.data.constraint.id as string;
      const versionConstraintResult = await runCliJsonWithFirstVersion(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "version",
        "--version-id",
        versionId,
        "--rule",
        "Review before start",
        "--rationale",
        "Version-specific gate"
      ]);

      expect(projectConstraintResult.exitCode).toBe(0);
      expect(projectConstraintResult.stdoutJson.data.constraint).toMatchObject({
        id: projectConstraintId,
        scope: { type: "project" },
        status: "active"
      });
      expect(versionConstraintResult.exitCode).toBe(0);
      expect(versionConstraintResult.stdoutJson.data.constraint).toMatchObject({
        scope: {
          type: "version",
          versionId
        },
        status: "active"
      });
      expect(JSON.stringify(projectConstraintResult.stdoutJson.data)).not.toContain(
        "events"
      );

      const retireResult = await runCliJsonWithFirstVersion(projectRoot, [
        "constraint",
        "retire",
        "--project-id",
        projectId,
        "--constraint-id",
        projectConstraintId,
        "--reason",
        "Superseded by policy",
        "--note",
        "Retire after review"
      ]);

      expect(retireResult.exitCode).toBe(0);
      expect(retireResult.stdoutJson.data.constraint).toMatchObject({
        id: projectConstraintId,
        status: "retired",
        retireReason: "Superseded by policy"
      });

      const contextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.constraints).toEqual(
        [
          expect.objectContaining({
            scope: {
              type: "version",
              versionId
            },
            status: "active"
          })
        ]
      );

      const storage = new SQLiteStorageAdapter({ projectRoot });
      const persisted = await storage.loadProjectAggregate(projectId);
      storage.close();
      expect(persisted?.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: projectConstraintId, status: "retired" }),
          expect.objectContaining({ scope: { type: "version", versionId }, status: "active" })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Deferred/Constraint CLI 对条件参数返回结构化错误且不产生副作用", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, [
        "init_project",
        "--name",
        "Semantic validation",
        "--content-locale",
        "en"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidOutcome = await runCliJsonWithFirstVersion(projectRoot, [
        "deferred",
        "resolve",
        "--project-id",
        projectId,
        "--deferred-id",
        "deferred-missing",
        "--outcome",
        "done",
        "--reason",
        "Invalid",
        "--note",
        "Invalid"
      ]);
      const missingVersionScope = await runCliJsonWithFirstVersion(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "version",
        "--rule",
        "Scoped rule",
        "--rationale",
        "Must name a version"
      ]);
      const extraVersionScope = await runCliJsonWithFirstVersion(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "project",
        "--version-id",
        initResult.stdoutJson.data.firstVersion!.id,
        "--rule",
        "Project rule",
        "--rationale",
        "No version should be accepted"
      ]);
      const structureResult = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId
      ]);

      expect(invalidOutcome.exitCode).toBe(1);
      expect(invalidOutcome.stderrJson).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            flag: "--outcome",
            value: "done",
            allowedValues: ["superseded", "rejected", "out_of_scope"]
          }
        }
      });
      expect(missingVersionScope.exitCode).toBe(1);
      expect(missingVersionScope.stderrJson).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            flag: "--version-id"
          }
        }
      });
      expect(extraVersionScope.exitCode).toBe(1);
      expect(extraVersionScope.stderrJson).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            flag: "--version-id",
            scope: "project"
          }
        }
      });
      expect(structureResult.exitCode).toBe(0);
      expect(structureResult.stdoutJson.data).not.toHaveProperty("openUndos");
      expect(structureResult.stdoutJson.data).not.toHaveProperty("legacyAudit");
      expect(
        structureResult.stdoutJson.data.legalOperations.some(
          (operation: { actionType: string }) =>
            operation.actionType === "create_undo" ||
            operation.actionType === "carry_forward_undo"
        )
      ).toBe(false);

      const contextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      expect(contextResult.stdoutJson.data.deferred).toEqual([]);
      expect(contextResult.stdoutJson.data.constraints).toEqual([]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("历史 undo 记录默认 context 隐藏，仅可显式审计", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, [
        "init_project",
        "--name",
        "Legacy audit",
        "--content-locale",
        "en"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const undo = createUndoFixture({
        id: "historical-undo-1",
        projectId,
        versionId,
        originVersionId: versionId,
        preferredResolutionVersionId: versionId,
        workItemId: "historical-work-item-1",
        title: "Historical record",
        reason: "Compatibility only"
      });
      const workItem = createWorkItemFixture({
        id: "historical-work-item-1",
        projectId,
        originVersionId: versionId,
        activeRecordType: "undo",
        activeRecordId: undo.id
      });
      const storage = new SQLiteStorageAdapter({ projectRoot });
      const snapshot = await storage.loadProjectAggregate(projectId);
      snapshot!.undos = snapshot!.undos.concat(undo);
      snapshot!.workItems = snapshot!.workItems.concat(workItem);
      await storage.saveProjectAggregate(snapshot!);
      storage.close();
      const undoId = undo.id;

      const defaultContext = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const auditContext = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId,
        "--include-legacy-undo"
      ]);

      expect(defaultContext.exitCode).toBe(0);
      expect(defaultContext.stdoutJson.data).not.toHaveProperty("openUndos");
      expect(defaultContext.stdoutJson.data).not.toHaveProperty("legacyUndo");
      expect(auditContext.exitCode).toBe(0);
      expect(auditContext.stdoutJson.data.legacyUndo).toEqual([
        expect.objectContaining({
          id: undoId,
          title: "Historical record"
        })
      ]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });


});
