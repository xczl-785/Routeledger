import fs from "node:fs";
import path from "node:path";

import { expect, it, describe } from "vitest";

import { SQLiteStorageAdapter } from "../../../sqlite/src/index.js";
import { exportProjectAggregateToJsonDirectory } from "@routeledger/json";

import { createTempProjectRoot, cleanupProjectRoot, runGit, readJsonDocuments, readDocumentBytesByPaths, runCliJson, summarizeSnapshotCounts, getIssueCodesFromCliError, seedJsonRoundTripProject, createVersionViaL3, setCurrentVersionViaL3, updateJsonFile, rewriteJsonFile, createValidateSnapshot } from "./cli-test-helpers.js";
describe("routeledger cli", () => {
  it("smoke: json validate 支持默认 projectRoot 与显式 input-dir，额外 json 不计入 documentCount，且不会触碰 SQLite runtime 路径", async () => {
    const projectRoot = createTempProjectRoot();
    const validateRoot = createTempProjectRoot();
    const outputDir = path.join(projectRoot, "exports");

    try {
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      await runCliJson(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "Validate JSON"
      ]);

      const defaultExport = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId
      ]);
      const explicitExport = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        outputDir
      ]);
      const exportedRoot = path.join(outputDir, ".routeledger");

      fs.mkdirSync(path.join(exportedRoot, "db"), { recursive: true });
      fs.mkdirSync(path.join(exportedRoot, "views"), { recursive: true });
      fs.mkdirSync(path.join(exportedRoot, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(exportedRoot, "db", "ignored.json"), "{invalid");
      fs.writeFileSync(path.join(exportedRoot, "views", "ignored.json"), "{invalid");
      fs.writeFileSync(path.join(exportedRoot, "tmp", "extra.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(exportedRoot, "runtime.lock"), "ignored");

      const defaultValidate = await runCliJson(projectRoot, ["json", "validate"]);

      expect(defaultExport.exitCode).toBe(0);
      expect(defaultValidate.exitCode).toBe(0);
      expect(defaultValidate.stdoutJson).toEqual({
        ok: true,
        data: {
          valid: true,
          issues: []
        },
        meta: {
          inputDir: path.join(projectRoot, ".routeledger"),
          documentCount: defaultExport.stdoutJson.meta.documentCount
        }
      });

      const beforeValidate = readDocumentBytesByPaths(exportedRoot, explicitExport.stdoutJson.meta.paths);
      const explicitValidate = await runCliJson(validateRoot, [
        "json",
        "validate",
        "--input-dir",
        outputDir
      ]);
      const afterValidate = readDocumentBytesByPaths(exportedRoot, explicitExport.stdoutJson.meta.paths);

      expect(explicitValidate.exitCode).toBe(0);
      expect(explicitValidate.stdoutJson).toEqual({
        ok: true,
        data: {
          valid: true,
          issues: []
        },
        meta: {
          inputDir: path.join(outputDir, ".routeledger"),
          documentCount: explicitExport.stdoutJson.meta.documentCount
        }
      });
      expect(
        Object.fromEntries(
          Object.entries(afterValidate).map(([documentPath, content]) => [
            documentPath,
            Buffer.compare(beforeValidate[documentPath]!, content)
          ])
        )
      ).toEqual(
        Object.fromEntries(explicitExport.stdoutJson.meta.paths.map((documentPath: string) => [documentPath, 0]))
      );
      expect(fs.existsSync(path.join(validateRoot, ".routeledger", "db", "routeledger.sqlite3"))).toBe(
        false
      );
    } finally {
      cleanupProjectRoot(projectRoot);
      cleanupProjectRoot(validateRoot);
    }
  });

  it("smoke: json validate 发现 semantic errors 时返回 JSON_VALIDATION_FAILED 与可读 issues", async () => {
    const projectRoot = createTempProjectRoot();
    const validateRoot = createTempProjectRoot();
    const outputDir = path.join(projectRoot, "exports");

    try {
      await exportProjectAggregateToJsonDirectory({
        outputRoot: outputDir,
        snapshot: createValidateSnapshot()
      });
      const exportedRoot = path.join(outputDir, ".routeledger");

      updateJsonFile(exportedRoot, "project.json", (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));
      updateJsonFile(exportedRoot, path.join("refs", "current.json"), (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));
      updateJsonFile(exportedRoot, path.join("todos", "to", "todo-1.json"), (value) => ({
        ...value,
        status: "closed"
      }));
      updateJsonFile(exportedRoot, path.join("undos", "un", "undo-1.json"), (value) => ({
        ...value,
        origin_version_id: "",
        preferred_resolution_version_id: "version-missing"
      }));
      updateJsonFile(exportedRoot, path.join("assets", "as", "asset-1.json"), (value) => ({
        ...value,
        relative_path: "../escape.md"
      }));
      updateJsonFile(exportedRoot, path.join("events", "2026", "06", "event-1.json"), (value) => ({
        ...value,
        target_type: "todo",
        target_id: "todo-missing"
      }));
      updateJsonFile(
        exportedRoot,
        path.join("pending_operations", "pe", "pending-1.json"),
        (value) => ({
          ...value,
          approval_artifact_id: "approval-missing"
        })
      );
      updateJsonFile(
        exportedRoot,
        path.join("approval_artifacts", "ap", "approval-1.json"),
        (value) => ({
          ...value,
          pending_operation_id: "pending-missing"
        })
      );

      const validateResult = await runCliJson(validateRoot, [
        "json",
        "validate",
        "--input-dir",
        outputDir
      ]);

      expect(validateResult.exitCode).toBe(1);
      expect(validateResult.stderrJson.error.code).toBe("JSON_VALIDATION_FAILED");
      expect(validateResult.stderrJson.error.details.valid).toBe(false);
      expect(
        validateResult.stderrJson.error.details.issues.map((issue: { code: string }) => issue.code)
      ).toEqual(
        expect.arrayContaining([
          "PROJECT_CURRENT_VERSION_NOT_FOUND",
          "VERSION_IS_CURRENT_MISMATCH",
          "WORK_ITEM_ACTIVE_INVALID",
          "UNDO_ORIGIN_VERSION_MISSING",
          "UNDO_PREFERRED_RESOLUTION_VERSION_NOT_FOUND",
          "ASSET_RELATIVE_PATH_INVALID",
          "TRANSITION_EVENT_TARGET_NOT_FOUND",
          "PENDING_OPERATION_APPROVAL_NOT_FOUND",
          "APPROVAL_ARTIFACT_PENDING_OPERATION_NOT_FOUND"
        ])
      );
      expect(
        validateResult.stderrJson.error.details.issues.every(
          (issue: { message?: string }) => typeof issue.message === "string" && issue.message.length > 0
        )
      ).toBe(true);
      expect(fs.existsSync(path.join(validateRoot, ".routeledger", "db", "routeledger.sqlite3"))).toBe(
        false
      );
    } finally {
      cleanupProjectRoot(projectRoot);
      cleanupProjectRoot(validateRoot);
    }
  });

  it("smoke: json import 从 canonical JSON 重建 SQLite，并保持 round-trip document set 稳定", async () => {
    const sourceRoot = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    const exportRoot = path.join(sourceRoot, "exported-json");
    const secondExportRoot = path.join(targetRoot, "re-exported-json");

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);
      const sourceStorage = new SQLiteStorageAdapter({
        projectRoot: sourceRoot
      });
      const sourceSnapshot = await sourceStorage.loadProjectAggregate(seeded.projectId);
      sourceStorage.close();

      expect(sourceSnapshot).not.toBeNull();

      const exportResult = await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        exportRoot
      ]);

      expect(exportResult.exitCode).toBe(0);

      const importResult = await runCliJson(sourceRoot, [
        "json",
        "import",
        "--input-dir",
        exportRoot,
        "--project-root",
        targetRoot
      ]);

      expect(importResult.exitCode).toBe(0);
      expect(importResult.stdoutJson.ok).toBe(true);
      expect(importResult.stdoutJson.data).toEqual({
        projectId: seeded.projectId,
        targetProjectRoot: targetRoot,
        ...summarizeSnapshotCounts(sourceSnapshot!)
      });
      expect(importResult.stdoutJson.data).not.toHaveProperty("undos");
      expect(importResult.stdoutJson.data).toMatchObject({
        deferredItems: 0,
        constraints: 0,
        legacyUndoRecords: 1
      });
      expect(importResult.stdoutJson.meta.inputDir).toBe(path.join(exportRoot, ".routeledger"));
      expect(importResult.stdoutJson.meta.documentCount).toBe(exportResult.stdoutJson.meta.documentCount);

      const contextResult = await runCliJson(targetRoot, [
        "context",
        "--project-id",
        seeded.projectId
      ]);
      const versionsResult = await runCliJson(targetRoot, [
        "versions",
        "list",
        "--project-id",
        seeded.projectId
      ]);

      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.project.id).toBe(seeded.projectId);
      expect(contextResult.stdoutJson.data.currentVersion.id).toBe(seeded.versionId);
      expect(versionsResult.exitCode).toBe(0);
      expect(versionsResult.stdoutJson.data).toHaveLength(1);

      const importedStorage = new SQLiteStorageAdapter({
        projectRoot: targetRoot
      });

      try {
        const snapshot = await importedStorage.loadProjectAggregate(seeded.projectId);

        expect(snapshot).not.toBeNull();
        expect(snapshot?.pendingOperations.map((operation) => operation.id)).toEqual([
          seeded.pendingOperationId
        ]);
        expect(snapshot?.approvalArtifacts.map((artifact) => artifact.id)).toEqual([
          seeded.approvalArtifactId
        ]);
        expect(snapshot?.events).toHaveLength(sourceSnapshot!.events.length);
      } finally {
        importedStorage.close();
      }

      const secondExportResult = await runCliJson(targetRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        secondExportRoot
      ]);

      expect(secondExportResult.exitCode).toBe(0);
      expect(readJsonDocuments(path.join(secondExportRoot, ".routeledger"))).toEqual(
        readJsonDocuments(path.join(exportRoot, ".routeledger"))
      );
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("smoke: json import 在 invalid JSON 上失败，返回 JSON_VALIDATION_FAILED，且不会写入 target SQLite", async () => {
    const sourceRoot = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    const exportRoot = path.join(sourceRoot, "exported-json");

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);

      await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        exportRoot
      ]);

      updateJsonFile(path.join(exportRoot, ".routeledger"), "project.json", (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));
      updateJsonFile(path.join(exportRoot, ".routeledger"), path.join("refs", "current.json"), (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));

      const importResult = await runCliJson(sourceRoot, [
        "json",
        "import",
        "--input-dir",
        exportRoot,
        "--project-root",
        targetRoot
      ]);

      expect(importResult.exitCode).toBe(1);
      expect(importResult.stderrJson.error.code).toBe("JSON_VALIDATION_FAILED");
      expect(importResult.stderrJson.error.details.valid).toBe(false);
      expect(
        importResult.stderrJson.error.details.issues.map((issue: { code: string }) => issue.code)
      ).toEqual(
        expect.arrayContaining(["PROJECT_CURRENT_VERSION_NOT_FOUND", "VERSION_IS_CURRENT_MISMATCH"])
      );
      expect(fs.existsSync(path.join(targetRoot, ".routeledger", "db", "routeledger.sqlite3"))).toBe(
        false
      );
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("smoke: json import 对比源 JSON 文档集本身；非 canonical 但语义等价的输入会返回 JSON_IMPORT_ROUND_TRIP_MISMATCH", async () => {
    const sourceRoot = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    const exportRoot = path.join(sourceRoot, "exported-json");

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);

      await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        exportRoot
      ]);

      rewriteJsonFile(path.join(exportRoot, ".routeledger"), "project.json", (value) =>
        JSON.stringify(
          {
            settings: value.settings,
            updated_at: value.updated_at,
            created_at: value.created_at,
            created_by: value.created_by,
            initial_version_id: value.initial_version_id,
            current_version_id: value.current_version_id,
            status: value.status,
            description: value.description,
            name: value.name,
            id: value.id,
            kind: value.kind,
            schema_version: value.schema_version,
            archived_at: value.archived_at
          },
          null,
          4
        )
      );

      const importResult = await runCliJson(sourceRoot, [
        "json",
        "import",
        "--input-dir",
        exportRoot,
        "--project-root",
        targetRoot
      ]);

      expect(importResult.exitCode).toBe(1);
      expect(importResult.stderrJson.error.code).toBe("JSON_IMPORT_ROUND_TRIP_MISMATCH");
      expect(importResult.stderrJson.error.details.projectId).toBe(seeded.projectId);
      expect(importResult.stderrJson.error.details.targetProjectRoot).toBe(targetRoot);
      expect(importResult.stderrJson.error.details.mismatchedPaths).toEqual([
        ".routeledger/project.json"
      ]);
      expect(fs.existsSync(path.join(targetRoot, ".routeledger", "db", "routeledger.sqlite3"))).toBe(
        false
      );

      const targetStorage = new SQLiteStorageAdapter({
        projectRoot: targetRoot
      });

      try {
        expect(await targetStorage.loadProjectAggregate(seeded.projectId)).toBeNull();
      } finally {
        targetStorage.close();
      }
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("smoke: json import 遇到已存在同 id project 时失败并返回 JSON_IMPORT_TARGET_EXISTS", async () => {
    const sourceRoot = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    const exportRoot = path.join(sourceRoot, "exported-json");

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);

      await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        exportRoot
      ]);

      const firstImport = await runCliJson(sourceRoot, [
        "json",
        "import",
        "--input-dir",
        exportRoot,
        "--project-root",
        targetRoot
      ]);
      const duplicateImport = await runCliJson(sourceRoot, [
        "json",
        "import",
        "--input-dir",
        exportRoot,
        "--project-root",
        targetRoot
      ]);

      expect(firstImport.exitCode).toBe(0);
      expect(duplicateImport.exitCode).toBe(1);
      expect(duplicateImport.stderrJson.error.code).toBe("JSON_IMPORT_TARGET_EXISTS");
      expect(duplicateImport.stderrJson.error.details).toEqual({
        projectId: seeded.projectId,
        inputDir: path.join(exportRoot, ".routeledger"),
        targetProjectRoot: targetRoot
      });
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("smoke: json merge-check 可作为 Git-backed pilot gate，并支持缺失 SQLite 时重建 read model", async () => {
    const sourceRoot = createTempProjectRoot();
    const pilotRoot = createTempProjectRoot();
    const rebuildRoot = createTempProjectRoot();

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);
      const exportResult = await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        pilotRoot
      ]);

      expect(exportResult.exitCode).toBe(0);

      fs.writeFileSync(
        path.join(pilotRoot, ".gitignore"),
        [".routeledger/db/", ".routeledger/views/", ".routeledger/cache/", ".routeledger/runtime/"].join(
          "\n"
        ) + "\n"
      );
      fs.mkdirSync(path.join(pilotRoot, ".routeledger", "db"), { recursive: true });
      fs.mkdirSync(path.join(pilotRoot, ".routeledger", "views"), { recursive: true });
      fs.mkdirSync(path.join(pilotRoot, ".routeledger", "cache"), { recursive: true });
      fs.mkdirSync(path.join(pilotRoot, ".routeledger", "runtime"), { recursive: true });
      fs.writeFileSync(path.join(pilotRoot, ".routeledger", "db", "routeledger.sqlite3"), "ignored");
      fs.writeFileSync(path.join(pilotRoot, ".routeledger", "views", "context.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(pilotRoot, ".routeledger", "cache", "graph.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(pilotRoot, ".routeledger", "runtime", "lock.json"), "{\"ignored\":true}\n");

      runGit(pilotRoot, ["init"]);
      runGit(pilotRoot, ["add", "."]);

      const gitStatus = runGit(pilotRoot, ["status", "--short", "--ignored=matching"]);

      expect(gitStatus).toContain("A  .routeledger/project.json");
      expect(gitStatus).toContain("A  .routeledger/refs/current.json");
      expect(gitStatus).toContain("!! .routeledger/db/");
      expect(gitStatus).toContain("!! .routeledger/views/");
      expect(gitStatus).toContain("!! .routeledger/cache/");
      expect(gitStatus).toContain("!! .routeledger/runtime/");
      expect(gitStatus).not.toContain("A  .routeledger/db/");
      expect(gitStatus).not.toContain("A  .routeledger/views/");

      const mergeCheckResult = await runCliJson(pilotRoot, ["json", "merge-check"]);

      expect(mergeCheckResult.exitCode).toBe(0);
      expect(mergeCheckResult.stdoutJson.data).toEqual({
        valid: true,
        issues: []
      });
      expect(mergeCheckResult.stdoutJson.meta).toEqual({
        inputDir: path.join(pilotRoot, ".routeledger"),
        documentCount: exportResult.stdoutJson.meta.documentCount
      });

      expect(fs.existsSync(path.join(rebuildRoot, ".routeledger", "db", "routeledger.sqlite3"))).toBe(
        false
      );

      const importResult = await runCliJson(pilotRoot, [
        "json",
        "import",
        "--input-dir",
        pilotRoot,
        "--project-root",
        rebuildRoot
      ]);

      expect(importResult.exitCode).toBe(0);

      const contextResult = await runCliJson(rebuildRoot, [
        "context",
        "--json",
        "--project-id",
        seeded.projectId
      ]);
      const versionsResult = await runCliJson(rebuildRoot, [
        "versions",
        "list",
        "--project-id",
        seeded.projectId
      ]);
      const l3Result = await runCliJson(rebuildRoot, ["l3", "list", "--project-id", seeded.projectId]);

      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.project.id).toBe(seeded.projectId);
      expect(versionsResult.exitCode).toBe(0);
      expect(versionsResult.stdoutJson.data.some((version: { id: string }) => version.id === seeded.versionId)).toBe(
        true
      );
      expect(l3Result.exitCode).toBe(0);
      expect(l3Result.stdoutJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: seeded.pendingOperationId
          })
        ])
      );

      const rebuiltStorage = new SQLiteStorageAdapter({
        projectRoot: rebuildRoot
      });

      try {
        const rebuiltSnapshot = await rebuiltStorage.loadProjectAggregate(seeded.projectId);

        expect(rebuiltSnapshot).not.toBeNull();
        expect(rebuiltSnapshot?.project.currentVersionId).toBe(seeded.versionId);
        expect(rebuiltSnapshot?.pendingOperations.map((record) => record.id)).toContain(
          seeded.pendingOperationId
        );
        expect(rebuiltSnapshot?.approvalArtifacts.map((record) => record.id)).toContain(
          seeded.approvalArtifactId
        );
      } finally {
        rebuiltStorage.close();
      }
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(pilotRoot);
      cleanupProjectRoot(rebuildRoot);
    }
  });

  it("smoke: json merge-check 遇到 merge 后语义坏状态时返回 JSON_MERGE_CHECK_FAILED 和 issues", async () => {
    const sourceRoot = createTempProjectRoot();
    const mergeRoot = createTempProjectRoot();

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);

      await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        mergeRoot
      ]);

      updateJsonFile(path.join(mergeRoot, ".routeledger"), "project.json", (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));
      updateJsonFile(path.join(mergeRoot, ".routeledger"), "refs/current.json", (value) => ({
        ...value,
        current_version_id: "version-missing"
      }));

      const mergeCheckResult = await runCliJson(mergeRoot, ["json", "merge-check"]);

      expect(mergeCheckResult.exitCode).toBe(1);
      expect(mergeCheckResult.stderrJson.error.code).toBe("JSON_MERGE_CHECK_FAILED");
      expect(getIssueCodesFromCliError(mergeCheckResult)).toEqual(
        expect.arrayContaining(["PROJECT_CURRENT_VERSION_NOT_FOUND", "VERSION_IS_CURRENT_MISMATCH"])
      );
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(mergeRoot);
    }
  });

  it("smoke: json merge-check 会拒绝非 canonical 但语义等价的 JSON 文档集", async () => {
    const sourceRoot = createTempProjectRoot();
    const mergeRoot = createTempProjectRoot();

    try {
      const seeded = await seedJsonRoundTripProject(sourceRoot);

      await runCliJson(sourceRoot, [
        "json",
        "export",
        "--project-id",
        seeded.projectId,
        "--output-dir",
        mergeRoot
      ]);

      rewriteJsonFile(path.join(mergeRoot, ".routeledger"), "project.json", (value) =>
        `${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 2)}\n`
      );

      const mergeCheckResult = await runCliJson(mergeRoot, ["json", "merge-check"]);

      expect(mergeCheckResult.exitCode).toBe(1);
      expect(mergeCheckResult.stderrJson.error.code).toBe("JSON_MERGE_CHECK_FAILED");
      expect(getIssueCodesFromCliError(mergeCheckResult)).toContain("JSON_CANONICAL_MISMATCH");
    } finally {
      cleanupProjectRoot(sourceRoot);
      cleanupProjectRoot(mergeRoot);
    }
  });

  it("smoke: json review-summary 从两个 git ref 聚合语义摘要", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      runGit(projectRoot, ["init"]);
      runGit(projectRoot, ["config", "user.email", "routeledger-test@example.com"]);
      runGit(projectRoot, ["config", "user.name", "RouteLedger Test"]);

      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;
      const version2Id = await createVersionViaL3(projectRoot, projectId, "Version 2");

      await setCurrentVersionViaL3(projectRoot, projectId, version2Id);

      const createTodoResult = await runCliJson(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        version2Id,
        "--title",
        "Review summary todo"
      ]);

      expect(createTodoResult.exitCode).toBe(0);

      expect(initialVersionId).not.toBe(version2Id);
      const exportBaseResult = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(exportBaseResult.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "base"]);

      const createHeadTodoResult = await runCliJson(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        version2Id,
        "--title",
        "Head follow-up todo"
      ]);

      expect(createHeadTodoResult.exitCode).toBe(0);

      const createDeferredResult = await runCliJson(projectRoot, [
        "deferred",
        "create",
        "--project-id",
        projectId,
        "--current-version-id",
        initialVersionId,
        "--target-review-version-id",
        version2Id,
        "--title",
        "Review in Version 2",
        "--reason",
        "Current semantic review fixture"
      ]);
      const createConstraintResult = await runCliJson(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "project",
        "--rule",
        "Keep current semantics visible",
        "--rationale",
        "Review summary must include current work semantics"
      ]);

      expect(createDeferredResult.exitCode).toBe(0);
      expect(createConstraintResult.exitCode).toBe(0);

      const createUndoResult = await runCliJson(projectRoot, [
        "undo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        version2Id,
        "--origin-version-id",
        version2Id,
        "--preferred-resolution-version-id",
        version2Id,
        "--title",
        "Review summary blocker",
        "--reason",
        "keep guardrail visible"
      ]);

      expect(createUndoResult.exitCode).toBe(0);

      const createVersionResult = await runCliJson(projectRoot, [
        "version",
        "create",
        "--project-id",
        projectId,
        "--title",
        "Version 3"
      ]);

      expect(createVersionResult.exitCode).toBe(1);
      expect(createVersionResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");

      const pendingOperationId = createVersionResult.stderrJson.error.details.pendingOperationId as string;
      const approveResult = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        pendingOperationId
      ]);

      expect(approveResult.exitCode).toBe(0);

      const exportHeadResult = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(exportHeadResult.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "head"]);

      const summaryResult = await runCliJson(projectRoot, [
        "json",
        "review-summary",
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD"
      ]);

      expect(summaryResult.exitCode).toBe(0);
      expect(summaryResult.stdoutJson.data.overview).toMatchObject({
        baseRef: "HEAD~1",
        headRef: "HEAD",
        projectId,
        hasSemanticChanges: true
      });
      expect(summaryResult.stdoutJson.data.todos.createdCount).toBe(1);
      expect(summaryResult.stdoutJson.data.deferred.createdCount).toBe(1);
      expect(summaryResult.stdoutJson.data.constraints.createdCount).toBe(1);
      expect(
        summaryResult.stdoutJson.data.legacyCompatibility.undos.createdCount
      ).toBe(1);
      expect(summaryResult.stdoutJson.data.pendingOperations).toMatchObject({
        proposedCount: 1
      });
      expect(summaryResult.stdoutJson.data.approvalArtifacts).toMatchObject({
        approvedCount: 1
      });
      expect(summaryResult.stdoutJson.data.events).toBeUndefined();
      expect(summaryResult.stdoutJson.data.eventsDigest.totalAdded).toBeGreaterThan(0);
      expect(summaryResult.stdoutJson.data.summaryText).toContain("HEAD~1 -> HEAD");
      expect(summaryResult.stdoutJson.data.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("pending proposal"),
          expect.stringContaining("Deferred"),
          expect.stringContaining("Legacy compatibility")
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("json review-summary 在 base ref 缺少 .routeledger 时稳定报错", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      runGit(projectRoot, ["init"]);
      runGit(projectRoot, ["config", "user.email", "routeledger-test@example.com"]);
      runGit(projectRoot, ["config", "user.name", "RouteLedger Test"]);

      fs.writeFileSync(path.join(projectRoot, "README.md"), "# temp\n");
      runGit(projectRoot, ["add", "README.md"]);
      runGit(projectRoot, ["commit", "-m", "plain repo"]);

      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      expect(initResult.exitCode).toBe(0);

      const exportResult = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        initResult.stdoutJson.data.project.id,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(exportResult.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "add routeledger"]);

      const summaryResult = await runCliJson(projectRoot, [
        "json",
        "review-summary",
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD"
      ]);

      expect(summaryResult.exitCode).toBe(1);
      expect(summaryResult.stderrJson.error.code).toBe("JSON_REVIEW_SUMMARY_REF_MISSING_ROUTELEDGER");
      expect(summaryResult.stderrJson.error.details).toMatchObject({
        side: "base",
        ref: "HEAD~1",
        missingPath: ".routeledger/project.json"
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("json review-summary 在 ref 不存在时不会误报缺少 routeledger 文档", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      runGit(projectRoot, ["init"]);
      runGit(projectRoot, ["config", "user.email", "routeledger-test@example.com"]);
      runGit(projectRoot, ["config", "user.name", "RouteLedger Test"]);

      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      expect(initResult.exitCode).toBe(0);

      const exportResult = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        initResult.stdoutJson.data.project.id,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(exportResult.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "add routeledger"]);

      const summaryResult = await runCliJson(projectRoot, [
        "json",
        "review-summary",
        "--base-ref",
        "refs/heads/does-not-exist",
        "--head-ref",
        "HEAD"
      ]);

      expect(summaryResult.exitCode).toBe(1);
      expect(summaryResult.stderrJson.error.code).toBe("JSON_REVIEW_SUMMARY_REF_INVALID");
      expect(summaryResult.stderrJson.error.message).not.toContain("缺少 canonical .routeledger 文档");
      expect(summaryResult.stderrJson.error.details).toMatchObject({
        side: "base",
        ref: "refs/heads/does-not-exist"
      });
      expect(summaryResult.stderrJson.error.details?.missingPath).toBeUndefined();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("json review-summary 在两个 ref projectId 不同时稳定报错", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      runGit(projectRoot, ["init"]);
      runGit(projectRoot, ["config", "user.email", "routeledger-test@example.com"]);
      runGit(projectRoot, ["config", "user.name", "RouteLedger Test"]);

      const firstInit = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger A"]);
      expect(firstInit.exitCode).toBe(0);

      const firstExport = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        firstInit.stdoutJson.data.project.id,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(firstExport.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "project a"]);

      fs.rmSync(path.join(projectRoot, ".routeledger"), { recursive: true, force: true });

      const secondInit = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger B"]);
      expect(secondInit.exitCode).toBe(0);

      const secondExport = await runCliJson(projectRoot, [
        "json",
        "export",
        "--project-id",
        secondInit.stdoutJson.data.project.id,
        "--output-dir",
        projectRoot,
        "--force"
      ]);

      expect(secondExport.exitCode).toBe(0);
      runGit(projectRoot, ["add", "-A", "-f", ".routeledger"]);
      runGit(projectRoot, ["commit", "-m", "project b"]);

      const summaryResult = await runCliJson(projectRoot, [
        "json",
        "review-summary",
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD"
      ]);

      expect(summaryResult.exitCode).toBe(1);
      expect(summaryResult.stderrJson.error.code).toBe("PROJECT_ID_MISMATCH");
      expect(summaryResult.stderrJson.error.details).toMatchObject({
        baseProjectId: firstInit.stdoutJson.data.project.id,
        headProjectId: secondInit.stdoutJson.data.project.id
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

});
