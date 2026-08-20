import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { expect, it, describe } from "vitest";

import { SQLiteStorageAdapter } from "../../../sqlite/src/index.js";
import { createUndoFixture, createWorkItemFixture } from "../../../core/src/testing/builders.js";
import { decodeProjectAggregateFromJsonDocuments } from "@routeledger/json";
import { runCli } from "../index.js";

import { createTempProjectRoot, cleanupProjectRoot, removeSqliteFiles, readJsonDocuments, readDocumentBytesByPaths, runCliJson, runCliJsonWithFirstVersion, createVersionViaL3, setCurrentVersionViaL3 } from "./cli-test-helpers.js";
describe("routeledger cli", () => {
  it("standalone l3 approve fails closed without a trusted host bridge", async () => {
    const projectRoot = createTempProjectRoot();
    try {
      const initialized = await runCliJson(projectRoot, [
        "init_project", "--name", "No Bridge", "--content-locale", "en"
      ]);
      const projectId = initialized.stdoutJson.data.project.id as string;
      const created = await runCliJson(projectRoot, [
        "version", "create", "--project-id", projectId, "--title", "Version 1"
      ]);
      const pendingOperationId = created.stderrJson.error.details.pendingOperationId as string;
      const stderr: string[] = [];
      const exitCode = await runCli({
        projectRoot,
        argv: [
          "l3", "approve", "--project-id", projectId,
          "--pending-operation-id", pendingOperationId
        ],
        stderr: (line) => stderr.push(line)
      });
      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr[0]!)).toMatchObject({
        error: { code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE" }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
  it("init_project 默认只创建 Project 逻辑根", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initialized = await runCliJson(
        projectRoot,
        ["init_project", "--name", "Empty Route", "--content-locale", "zh-CN"]
      );
      const projectId = initialized.stdoutJson.data.project.id as string;

      expect(initialized.stdoutJson.data).toMatchObject({
        project: { currentVersionId: null, initialVersionId: null },
        firstVersion: null,
        todos: []
      });

      const context = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      expect(context.stdoutJson.data).toMatchObject({
        currentVersion: null,
        versions: [],
        nextAction: { actionType: "create_version" }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("init_project requires a concrete content locale and rejects auto", async () => {
    const missingRoot = createTempProjectRoot();
    const autoRoot = createTempProjectRoot();

    try {
      const missing = await runCliJsonWithFirstVersion(missingRoot, [
        "init_project",
        "--name",
        "Missing Locale"
      ]);
      const automatic = await runCliJsonWithFirstVersion(autoRoot, [
        "init_project",
        "--name",
        "Auto Locale",
        "--content-locale",
        "auto"
      ]);

      expect(missing).toMatchObject({
        exitCode: 1,
        stderrJson: {
          ok: false,
          error: { code: "CONTENT_LOCALE_REQUIRED" }
        }
      });
      expect(automatic).toMatchObject({
        exitCode: 1,
        stderrJson: {
          ok: false,
          error: { code: "CONTENT_LOCALE_MUST_BE_CONCRETE" }
        }
      });
    } finally {
      cleanupProjectRoot(missingRoot);
      cleanupProjectRoot(autoRoot);
    }
  });

  it("set_project_content_locale resolves a legacy null project", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initialized = await runCliJsonWithFirstVersion(projectRoot, [
        "init_project",
        "--name",
        "Legacy Locale",
        "--content-locale",
        "en"
      ]);
      const projectId = initialized.stdoutJson.data.project.id as string;
      const database = new Database(
        path.join(projectRoot, ".routeledger", "db", "routeledger.sqlite3")
      );
      const row = database
        .prepare("SELECT settings_json FROM projects WHERE id = ?")
        .get(projectId) as { settings_json: string };
      const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
      delete settings.contentLocale;
      database
        .prepare("UPDATE projects SET settings_json = ? WHERE id = ?")
        .run(JSON.stringify(settings), projectId);
      database.close();

      const resolved = await runCliJsonWithFirstVersion(projectRoot, [
        "set_project_content_locale",
        "--project-id",
        projectId,
        "--content-locale",
        "zh-cn",
        "--reason",
        "用户确认使用中文"
      ]);

      expect(resolved).toMatchObject({
        exitCode: 0,
        stdoutJson: {
          ok: true,
          data: {
            project: {
              settings: { contentLocale: "zh-CN" }
            }
          }
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: init/context/versions 与 L3 approve/commit 链路可用", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      expect(initResult.exitCode).toBe(0);

      const prepareResult = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      expect(prepareResult.exitCode).toBe(0);

      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      expect(bareStart.exitCode).not.toBe(0);
      expect(bareStart.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(bareStart.stderrJson.error.details.proposal.actionType).toBe("start_version");

      const pendingOperationId = bareStart.stderrJson.error.details.pendingOperationId as string;

      const approveResult = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        pendingOperationId
      ]);

      expect(approveResult.exitCode).toBe(0);

      expect(approveResult.stdoutJson.data).toMatchObject({
        artifactId: expect.any(String),
        authorizationId: expect.any(String),
        routeledgerRootDigest: expect.any(String),
        operationDigest: expect.any(String)
      });
      expect(approveResult.stdoutJson.data).not.toHaveProperty("sessionId");
      const approvalArtifactId = approveResult.stdoutJson.data.artifactId as string;
      const commitResult = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        pendingOperationId,
        "--approval-artifact-id",
        approvalArtifactId
      ]);

      expect(commitResult.exitCode).toBe(0);

      const contextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--json",
        "--project-id",
        projectId
      ]);
      const versionsResult = await runCliJsonWithFirstVersion(projectRoot, [
        "versions",
        "list",
        "--project-id",
        projectId
      ]);

      expect(contextResult.stdoutJson.data.currentVersion.state).toBe("running");
      expect(versionsResult.stdoutJson.data[0].state).toBe("running");
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("context 默认返回 version window，并支持显式全量与自定义 window 参数", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const createdVersionIds = [initResult.stdoutJson.data.firstVersion!.id as string];

      for (const title of [
        "Version 2",
        "Version 3",
        "Version 4",
        "Version 5",
        "Version 6",
        "Version 7",
        "Version 8"
      ]) {
        createdVersionIds.push(await createVersionViaL3(projectRoot, projectId, title));
      }

      await setCurrentVersionViaL3(projectRoot, projectId, createdVersionIds[3]!);

      const defaultContextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const fullContextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId,
        "--include-all-versions"
      ]);
      const customWindowResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId,
        "--version-window-before",
        "1",
        "--version-window-after",
        "2"
      ]);
      const versionsResult = await runCliJsonWithFirstVersion(projectRoot, [
        "versions",
        "list",
        "--project-id",
        projectId
      ]);

      expect(defaultContextResult.exitCode).toBe(0);
      expect(defaultContextResult.stdoutJson.data.versions.map((version: { id: string }) => version.id)).toEqual(
        createdVersionIds.slice(0, 7)
      );
      expect(defaultContextResult.stdoutJson.meta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[3],
        before: 3,
        after: 3,
        includeAllVersions: false,
        totalCount: 8,
        includedCount: 7,
        omittedBeforeCount: 0,
        omittedAfterCount: 1
      });

      expect(fullContextResult.exitCode).toBe(0);
      expect(fullContextResult.stdoutJson.data.versions.map((version: { id: string }) => version.id)).toEqual(
        createdVersionIds
      );
      expect(fullContextResult.stdoutJson.meta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[3],
        before: 3,
        after: 3,
        includeAllVersions: true,
        totalCount: 8,
        includedCount: 8,
        omittedBeforeCount: 0,
        omittedAfterCount: 0
      });

      expect(customWindowResult.exitCode).toBe(0);
      expect(customWindowResult.stdoutJson.data.versions.map((version: { id: string }) => version.id)).toEqual(
        createdVersionIds.slice(2, 6)
      );
      expect(customWindowResult.stdoutJson.meta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[3],
        before: 1,
        after: 2,
        includeAllVersions: false,
        totalCount: 8,
        includedCount: 4,
        omittedBeforeCount: 2,
        omittedAfterCount: 2
      });

      expect(versionsResult.exitCode).toBe(0);
      expect(versionsResult.stdoutJson.data.map((version: { id: string }) => version.id)).toEqual(
        createdVersionIds
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: gate check-start/check-close 为只读命令并返回稳定 JSON", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const startGateResult = await runCliJsonWithFirstVersion(projectRoot, [
        "gate",
        "check-start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      expect(startGateResult.exitCode).toBe(0);
      expect(startGateResult.stdoutJson.ok).toBe(true);
      expect(startGateResult.stdoutJson.data).toHaveProperty("allowed");
      expect(startGateResult.stdoutJson.data).toHaveProperty("blockers");
      expect(startGateResult.stdoutJson.data).toHaveProperty("openTodoIds");
      expect(startGateResult.stdoutJson.data).toHaveProperty("dueUndoIds");

      const startContextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--json",
        "--project-id",
        projectId
      ]);

      expect(startContextResult.stdoutJson.data.currentVersion.state).toBe("ready");

      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const startProposalId = bareStart.stderrJson.error.details.pendingOperationId as string;
      const startApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId,
        "--approval-artifact-id",
        startApprove.stdoutJson.data.artifactId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const closeGateResult = await runCliJsonWithFirstVersion(projectRoot, [
        "gate",
        "check-close",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      expect(closeGateResult.exitCode).toBe(0);
      expect(closeGateResult.stdoutJson.ok).toBe(true);
      expect(closeGateResult.stdoutJson.data).toHaveProperty("allowed");
      expect(closeGateResult.stdoutJson.data).toHaveProperty("blockers");
      expect(closeGateResult.stdoutJson.data).toHaveProperty("unresolvedTodoIds");
      expect(closeGateResult.stdoutJson.data).toHaveProperty("unresolvedUndoIds");

      const closeContextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--json",
        "--project-id",
        projectId
      ]);

      expect(closeContextResult.stdoutJson.data.currentVersion.state).toBe("complete");
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: close/reopen/current-set 通过 proposal/approve/commit 闭环，direct 调用稳定返回 CONFIRMATION_REQUIRED", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const startProposalId = bareStart.stderrJson.error.details.pendingOperationId as string;
      const startApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId,
        "--approval-artifact-id",
        startApprove.stdoutJson.data.artifactId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareClose = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "close",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--residual-audit-json",
        JSON.stringify([{ kind: "debt", summary: "none", destination: "close" }])
      ]);
      expect(bareClose.exitCode).not.toBe(0);
      expect(bareClose.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const closeProposalId = bareClose.stderrJson.error.details.pendingOperationId as string;
      const closeApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        closeProposalId
      ]);
      const closeCommit = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        closeProposalId,
        "--approval-artifact-id",
        closeApprove.stdoutJson.data.artifactId
      ]);
      expect(closeCommit.exitCode).toBe(0);

      const bareReopen = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "reopen",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      expect(bareReopen.exitCode).not.toBe(0);
      expect(bareReopen.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const reopenProposalId = bareReopen.stderrJson.error.details.pendingOperationId as string;
      const reopenApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reopenProposalId
      ]);
      const reopenCommit = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reopenProposalId,
        "--approval-artifact-id",
        reopenApprove.stdoutJson.data.artifactId
      ]);
      expect(reopenCommit.exitCode).toBe(0);

      const bareCurrentSet = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "current",
        "set",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      expect(bareCurrentSet.exitCode).not.toBe(0);
      expect(bareCurrentSet.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const currentSetProposalId = bareCurrentSet.stderrJson.error.details.pendingOperationId as string;
      const currentSetApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        currentSetProposalId
      ]);
      const currentSetCommit = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        currentSetProposalId,
        "--approval-artifact-id",
        currentSetApprove.stdoutJson.data.artifactId
      ]);
      expect(currentSetCommit.exitCode).toBe(0);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: version tree create/insert/child/reorder 可通过 direct + l3 commit 落地", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.firstVersion!.id as string;

      const createResult = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "create",
        "--project-id",
        projectId,
        "--title",
        "Version 2"
      ]);
      expect(createResult.exitCode).not.toBe(0);
      expect(createResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const createProposalId = createResult.stderrJson.error.details.pendingOperationId as string;
      const createdVersionId = createResult.stderrJson.error.details.proposal.targetId as string;
      const createApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        createProposalId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        createProposalId,
        "--approval-artifact-id",
        createApprove.stdoutJson.data.artifactId
      ]);

      const insertResult = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "insert",
        "--project-id",
        projectId,
        "--title",
        "Version 1.5",
        "--after-version-id",
        initialVersionId
      ]);
      expect(insertResult.exitCode).not.toBe(0);
      expect(insertResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const insertProposalId = insertResult.stderrJson.error.details.pendingOperationId as string;
      const insertedVersionId = insertResult.stderrJson.error.details.proposal.targetId as string;
      const insertApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        insertProposalId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        insertProposalId,
        "--approval-artifact-id",
        insertApprove.stdoutJson.data.artifactId
      ]);

      const childResult = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "child",
        "create",
        "--project-id",
        projectId,
        "--parent-version-id",
        initialVersionId,
        "--title",
        "Child 1"
      ]);
      expect(childResult.exitCode).not.toBe(0);
      expect(childResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const childProposalId = childResult.stderrJson.error.details.pendingOperationId as string;
      const childVersionId = childResult.stderrJson.error.details.proposal.targetId as string;
      const childApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        childProposalId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        childProposalId,
        "--approval-artifact-id",
        childApprove.stdoutJson.data.artifactId
      ]);

      const reorderResult = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "reorder",
        "--project-id",
        projectId,
        "--version-id",
        createdVersionId,
        "--before-version-id",
        insertedVersionId
      ]);
      expect(reorderResult.exitCode).not.toBe(0);
      expect(reorderResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");
      const reorderProposalId = reorderResult.stderrJson.error.details.pendingOperationId as string;
      const reorderApprove = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reorderProposalId
      ]);
      const reorderCommit = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reorderProposalId,
        "--approval-artifact-id",
        reorderApprove.stdoutJson.data.artifactId
      ]);
      expect(reorderCommit.exitCode).toBe(0);

      const versionsResult = await runCliJsonWithFirstVersion(projectRoot, [
        "versions",
        "list",
        "--project-id",
        projectId
      ]);

      expect(versionsResult.stdoutJson.data.map((version: { id: string }) => version.id)).toEqual([
        initialVersionId,
        childVersionId,
        createdVersionId,
        insertedVersionId
      ]);
      expect(
        versionsResult.stdoutJson.data.map((version: { order: number }) => version.order)
      ).toEqual([1, 2, 3, 4]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 命令支持 preflight/propose 入口", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const invalidPreflight = await runCliJsonWithFirstVersion(projectRoot, [
        "batch_create_versions",
        "--project-id",
        projectId,
        "--mode",
        "preflight",
        "--partial-allowed",
        "true",
        "--items-json",
        JSON.stringify([
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ])
      ]);
      const validPropose = await runCliJsonWithFirstVersion(projectRoot, [
        "batch_create_versions",
        "--project-id",
        projectId,
        "--mode",
        "propose",
        "--anchor-json",
        JSON.stringify({
          afterVersionId: initialVersionId
        }),
        "--items-json",
        JSON.stringify([
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: ["write docs"]
          }
        ])
      ]);

      expect(invalidPreflight.exitCode).toBe(0);
      expect(invalidPreflight.stdoutJson.data).toMatchObject({
        ok: false,
        code: "BATCH_VERSION_PLAN_INVALID"
      });
      expect(validPropose.exitCode).toBe(0);
      expect(validPropose.stdoutJson.data).toMatchObject({
        ok: true,
        pendingOperationId: expect.any(String)
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 命令会拒绝非法 --mode，且不产生 pending proposal 副作用", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidMode = await runCliJsonWithFirstVersion(projectRoot, [
        "batch_create_versions",
        "--project-id",
        projectId,
        "--mode",
        "typo",
        "--items-json",
        JSON.stringify([
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ])
      ]);
      const contextResult = await runCliJsonWithFirstVersion(projectRoot, ["context", "--project-id", projectId]);

      expect(invalidMode.exitCode).toBe(1);
      expect(invalidMode.stderrJson.error).toMatchObject({
        code: "BATCH_CREATE_VERSIONS_MODE_INVALID",
        details: {
          flag: "--mode",
          receivedMode: "typo",
          allowedModes: ["preflight", "propose"]
        }
      });
      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.pendingL3Proposals).toEqual([]);
      expect(contextResult.stdoutJson.data.versions).toHaveLength(1);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 命令会拒绝非法 --previous-current-policy，且不产生 pending proposal 副作用", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidPolicy = await runCliJsonWithFirstVersion(projectRoot, [
        "batch_create_versions",
        "--project-id",
        projectId,
        "--mode",
        "propose",
        "--previous-current-policy",
        "typo",
        "--items-json",
        JSON.stringify([
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ])
      ]);
      const contextResult = await runCliJsonWithFirstVersion(projectRoot, ["context", "--project-id", projectId]);

      expect(invalidPolicy.exitCode).toBe(1);
      expect(invalidPolicy.stderrJson.error).toMatchObject({
        code: "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
        details: {
          flag: "--previous-current-policy",
          receivedPreviousCurrentPolicy: "typo",
          allowedPreviousCurrentPolicies: ["leave_as_is", "require_complete_or_close"]
        }
      });
      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.pendingL3Proposals).toEqual([]);
      expect(contextResult.stdoutJson.data.versions).toHaveLength(1);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("transition_version 命令会按 live 状态只生成下一条 proposal", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const targetVersionId = await createVersionViaL3(projectRoot, projectId, "Next Version");

      const prepareCurrent = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const prepareTarget = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);
      const dryRunBeforeSwitch = await runCliJsonWithFirstVersion(projectRoot, [
        "transition_version",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);

      expect(prepareCurrent.exitCode).toBe(0);
      expect(prepareTarget.exitCode).toBe(0);
      expect(dryRunBeforeSwitch.exitCode).toBe(0);
      expect(dryRunBeforeSwitch.stdoutJson.data).toMatchObject({
        mode: "dry_run",
        nextActionType: "set_current_version",
        stepsRemaining: ["set_current_version", "start_version"]
      });

      const proposeSwitch = await runCliJsonWithFirstVersion(projectRoot, [
        "transition_version",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId,
        "--mode",
        "propose"
      ]);

      expect(proposeSwitch.exitCode).toBe(0);
      expect(proposeSwitch.stdoutJson.data).toMatchObject({
        proposedActionType: "set_current_version",
        pendingOperationId: expect.any(String)
      });

      const approveSwitch = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        proposeSwitch.stdoutJson.data.pendingOperationId
      ]);
      const commitSwitch = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        proposeSwitch.stdoutJson.data.pendingOperationId,
        "--approval-artifact-id",
        approveSwitch.stdoutJson.data.artifactId
      ]);
      const dryRunAfterSwitch = await runCliJsonWithFirstVersion(projectRoot, [
        "transition_version",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);

      expect(approveSwitch.exitCode).toBe(0);
      expect(commitSwitch.exitCode).toBe(0);
      expect(dryRunAfterSwitch.stdoutJson.data).toMatchObject({
        nextActionType: "start_version",
        stepsRemaining: ["start_version"]
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("close_version block-first 与 get_version_structure 的 legacy 审计展示语义", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const downstreamVersionId = await createVersionViaL3(projectRoot, projectId, "Downstream");

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const approveStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      const commitStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.artifactId
      ]);
      const completeVersion = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const blockedClose = await runCliJsonWithFirstVersion(projectRoot, [
        "close_version",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId,
        "--mode",
        "propose"
      ]);
      const proposalsAfterBlockedClose = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "list",
        "--project-id",
        projectId
      ]);
      const historicalUndo = createUndoFixture({
        id: "historical-undo-1",
        projectId,
        versionId: initialVersionId,
        originVersionId: initialVersionId,
        preferredResolutionVersionId: downstreamVersionId,
        workItemId: "historical-work-item-1",
        title: "route later",
        reason: "defer downstream"
      });
      const historicalWorkItem = createWorkItemFixture({
        id: "historical-work-item-1",
        projectId,
        originVersionId: initialVersionId,
        activeRecordType: "undo",
        activeRecordId: historicalUndo.id
      });
      const storage = new SQLiteStorageAdapter({ projectRoot });
      const snapshot = await storage.loadProjectAggregate(projectId);
      snapshot!.undos = snapshot!.undos.concat(historicalUndo);
      snapshot!.workItems = snapshot!.workItems.concat(historicalWorkItem);
      await storage.saveProjectAggregate(snapshot!);
      storage.close();
      const blockingStructure = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const structure = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const legacyAuditStructure = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId,
        "--include-legacy-undo"
      ]);

      expect(bareStart.exitCode).toBe(1);
      expect(approveStart.exitCode).toBe(0);
      expect(commitStart.exitCode).toBe(0);
      expect(completeVersion.exitCode).toBe(0);
      expect(blockedClose.exitCode).toBe(0);
      expect(blockedClose.stdoutJson.data).toMatchObject({
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "MISSING_RESIDUAL_AUDIT"
          })
        ]
      });
      expect(
        proposalsAfterBlockedClose.stdoutJson.data.filter(
          (proposal: { status: string }) => proposal.status === "pending"
        )
      ).toEqual([]);
      expect(structure.exitCode).toBe(0);
      expect(structure.stdoutJson.data).not.toHaveProperty("openUndos");
      expect(structure.stdoutJson.data.legacyAudit).toMatchObject({
        required: true,
        recordCount: 1
      });
      expect(structure.stdoutJson.data.legalOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionType: "close_version" })
        ])
      );
      expect(
        structure.stdoutJson.data.legalOperations.some(
          (operation: { actionType: string }) =>
            operation.actionType === "create_undo" ||
            operation.actionType === "carry_forward_undo"
        )
      ).toBe(false);
      const closeOperation = blockingStructure.stdoutJson.data.legalOperations.find(
        (operation: { actionType: string }) =>
          operation.actionType === "close_version"
      );
      const shutdownOperation = blockingStructure.stdoutJson.data.legalOperations.find(
        (operation: { actionType: string }) =>
          operation.actionType === "shutdown_version"
      );
      expect(closeOperation).toMatchObject({
        allowed: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_WORK_REQUIRES_AUDIT",
            recordCount: 1
          })
        ]),
        details: {
          legacyBlockerCount: 1
        }
      });
      expect(shutdownOperation).toMatchObject({
        details: {
          ordinaryCloseGate: {
            allowed: false,
            legacyBlockerCount: 1,
            blockerCodes: expect.arrayContaining([
              "LEGACY_WORK_REQUIRES_AUDIT"
            ])
          }
        }
      });
      const serializedStructure = JSON.stringify(
        blockingStructure.stdoutJson.data
      );
      expect(serializedStructure).not.toContain("unresolvedUndoIds");
      expect(serializedStructure).not.toContain("OPEN_UNDOS");
      expect(serializedStructure).not.toContain("create_undo");
      expect(serializedStructure).not.toContain("carry_forward_undo");
      expect(legacyAuditStructure.exitCode).toBe(0);
      expect(legacyAuditStructure.stdoutJson.data.openUndos).toBeDefined();
      expect(
        legacyAuditStructure.stdoutJson.data.legalOperations.some(
          (operation: { actionType: string }) =>
            operation.actionType === "carry_forward_undo"
        )
      ).toBe(false);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("shutdown_version 命令将 shutdown reason 与 proposal reason 分离", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const approveStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      const commitStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.artifactId
      ]);

      await runCliJsonWithFirstVersion(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "still open"
      ]);

      const shutdownResult = await runCliJsonWithFirstVersion(projectRoot, [
        "shutdown_version",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--mode",
        "propose",
        "--shutdown-reason",
        "emergency_stop",
        "--reason",
        "force close after runtime failure"
      ]);
      const shutdownProposal = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "get",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId
      ]);
      const approveShutdown = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId
      ]);
      const commitShutdown = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId,
        "--approval-artifact-id",
        approveShutdown.stdoutJson.data.artifactId
      ]);
      const contextResult = await runCliJsonWithFirstVersion(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const proposalsResult = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "list",
        "--project-id",
        projectId
      ]);

      expect(commitStart.exitCode).toBe(0);
      expect(shutdownResult.exitCode).toBe(0);
      expect(shutdownResult.stdoutJson.data).toMatchObject({
        status: "confirmation_required",
        forced: true,
        shutdownStateReason: "shutdown:emergency_stop"
      });
      expect(shutdownProposal.exitCode).toBe(0);
      expect(shutdownProposal.stdoutJson.data).toMatchObject({
        actionType: "shutdown_version",
        reason: "force close after runtime failure",
        payload: {
          shutdownReason: "emergency_stop"
        }
      });
      expect(approveShutdown.exitCode).toBe(0);
      expect(commitShutdown.exitCode).toBe(0);
      expect(contextResult.exitCode).toBe(0);
      expect(contextResult.stdoutJson.data.currentVersion).toMatchObject({
        id: versionId,
        state: "close",
        stateReason: "shutdown:emergency_stop"
      });
      expect(proposalsResult.stdoutJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionType: "shutdown_version",
            status: "committed"
          })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("shutdown_version 在未传 --shutdown-reason 时回退使用 --reason，并保留默认 proposal rationale", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const approveStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.artifactId
      ]);

      await runCliJsonWithFirstVersion(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "still open"
      ]);

      const shutdownResult = await runCliJsonWithFirstVersion(projectRoot, [
        "shutdown_version",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--mode",
        "propose",
        "--reason",
        "emergency_stop"
      ]);
      const shutdownProposal = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "get",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId
      ]);

      expect(shutdownResult.exitCode).toBe(0);
      expect(shutdownResult.stdoutJson.data).toMatchObject({
        shutdownStateReason: "shutdown:emergency_stop"
      });
      expect(shutdownProposal.exitCode).toBe(0);
      expect(shutdownProposal.stdoutJson.data).toMatchObject({
        actionType: "shutdown_version",
        reason: "emergency shutdown requested (shutdown:emergency_stop)",
        payload: {
          shutdownReason: "emergency_stop"
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_version_transition_guide 命令始终读取 canonical JSON，而不是陈旧或缺失的 SQLite", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.firstVersion!.id as string;
      const targetVersionId = await createVersionViaL3(projectRoot, projectId, "Next Version");

      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const bareStart = await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const approveStart = await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.artifactId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      await runCliJsonWithFirstVersion(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);
      const exportResult = await runCliJsonWithFirstVersion(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId
      ]);

      expect(exportResult.exitCode).toBe(0);

      const sqliteStorage = new SQLiteStorageAdapter({ projectRoot });

      try {
        const snapshot = await sqliteStorage.loadProjectAggregate(projectId);
        expect(snapshot).not.toBeNull();
        snapshot!.project.currentVersionId = targetVersionId;
        snapshot!.project.updatedAt = "2099-01-01T00:00:00.000Z";
        snapshot!.versions = snapshot!.versions.map((version) => {
          if (version.id === initialVersionId) {
            return {
              ...version,
              isCurrent: false,
              updatedAt: "2099-01-01T00:00:00.000Z"
            };
          }

          if (version.id === targetVersionId) {
            return {
              ...version,
              state: "running",
              isCurrent: true,
              updatedAt: "2099-01-01T00:00:00.000Z"
            };
          }

          return version;
        });
        await sqliteStorage.saveProjectAggregate(snapshot!);
      } finally {
        sqliteStorage.close();
      }

      const staleSqliteGuide = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_transition_guide",
        "--project-id",
        projectId,
        "--target-version-id",
        targetVersionId,
        "--residual-audit-json",
        JSON.stringify([
          {
            kind: "debt",
            summary: "none",
            destination: "close"
          }
        ])
      ]);

      expect(staleSqliteGuide.exitCode).toBe(0);
      expect(staleSqliteGuide.stdoutJson.meta).toMatchObject({
        source: "canonical_json"
      });
      expect(staleSqliteGuide.stdoutJson.data).toMatchObject({
        status: "ready",
        currentVersion: {
          id: initialVersionId,
          state: "complete",
          isCurrent: true
        },
        targetVersion: {
          id: targetVersionId,
          state: "ready",
          isCurrent: false
        }
      });

      removeSqliteFiles(projectRoot);

      const missingSqliteGuide = await runCliJsonWithFirstVersion(projectRoot, [
        "get_version_transition_guide",
        "--project-id",
        projectId,
        "--target-version-id",
        targetVersionId,
        "--residual-audit-json",
        JSON.stringify([
          {
            kind: "debt",
            summary: "none",
            destination: "close"
          }
        ])
      ]);

      expect(missingSqliteGuide.exitCode).toBe(0);
      expect(missingSqliteGuide.stdoutJson.data).toMatchObject({
        status: "ready",
        currentVersion: {
          id: initialVersionId
        },
        targetVersion: {
          id: targetVersionId,
          state: "ready"
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: json export 从 SQLite aggregate 写出 canonical JSON，并支持 force 稳定覆盖", async () => {
    const projectRoot = createTempProjectRoot();
    const outputDir = path.join(projectRoot, "exports");

    try {
      const initResult = await runCliJsonWithFirstVersion(projectRoot, ["init_project", "--name", "RouteLedger", "--content-locale", "en"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.firstVersion!.id as string;

      await runCliJsonWithFirstVersion(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "Export todo",
        "--description",
        "Verify sqlite export"
      ]);

      const defaultExport = await runCliJsonWithFirstVersion(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId
      ]);

      expect(defaultExport.exitCode).toBe(0);
      expect(defaultExport.stdoutJson.ok).toBe(true);
      expect(defaultExport.stdoutJson.data).toEqual({
        projectId,
        outputDir: path.join(projectRoot, ".routeledger")
      });
      expect(fs.existsSync(path.join(projectRoot, ".routeledger", "project.json"))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, ".routeledger", "refs", "current.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(projectRoot, ".routeledger", "db", "routeledger.sqlite3"))
      ).toBe(true);

      const exportResult = await runCliJsonWithFirstVersion(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        outputDir
      ]);

      expect(exportResult.exitCode).toBe(0);
      expect(exportResult.stdoutJson.ok).toBe(true);
      expect(exportResult.stdoutJson.data).toEqual({
        projectId,
        outputDir: path.join(outputDir, ".routeledger")
      });
      expect(exportResult.stdoutJson.meta.documentCount).toBeGreaterThanOrEqual(5);
      expect(exportResult.stdoutJson.meta.paths).toContain(".routeledger/project.json");
      expect(exportResult.stdoutJson.meta.paths).toContain(".routeledger/refs/current.json");
      expect(
        exportResult.stdoutJson.meta.paths.some((documentPath: string) =>
          documentPath.startsWith(".routeledger/todos/")
        )
      ).toBe(true);

      const exportedRoot = path.join(outputDir, ".routeledger");
      expect(fs.existsSync(path.join(exportedRoot, "project.json"))).toBe(true);
      expect(fs.existsSync(path.join(exportedRoot, "refs", "current.json"))).toBe(true);
      expect(fs.existsSync(path.join(exportedRoot, "schema", "routeledger.schema.json"))).toBe(true);

      const documents = readJsonDocuments(exportedRoot).map((document) => ({
        path: `.routeledger/${document.path}`,
        content: document.content
      }));
      const joinedContent = documents.map((document) => document.content).join("\n");
      const decoded = decodeProjectAggregateFromJsonDocuments(documents);

      expect(decoded.project.id).toBe(projectId);
      expect(decoded.project.currentVersionId).toBe(versionId);
      expect(decoded.project.initialVersionId).toBeNull();
      expect(decoded.todos).toHaveLength(1);
      expect(decoded.todos[0]?.title).toBe("Export todo");
      expect(joinedContent).not.toContain("\"currentVersionId\"");
      expect(joinedContent).not.toContain("\"createdBy\"");

      const duplicateExport = await runCliJsonWithFirstVersion(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        outputDir
      ]);

      expect(duplicateExport.exitCode).not.toBe(0);
      expect(duplicateExport.stderrJson.error.code).toBe("JSON_EXPORT_TARGET_EXISTS");
      expect(exportResult.stdoutJson.meta.paths).toContain(duplicateExport.stderrJson.error.details.path);

      const beforeForce = readDocumentBytesByPaths(exportedRoot, exportResult.stdoutJson.meta.paths);
      const forcedExport = await runCliJsonWithFirstVersion(projectRoot, [
        "json",
        "export",
        "--project-id",
        projectId,
        "--output-dir",
        outputDir,
        "--force"
      ]);
      const afterForce = readDocumentBytesByPaths(exportedRoot, forcedExport.stdoutJson.meta.paths);

      expect(forcedExport.exitCode).toBe(0);
      expect(forcedExport.stdoutJson.meta.paths).toEqual(exportResult.stdoutJson.meta.paths);
      expect(
        Object.fromEntries(
          Object.entries(afterForce).map(([documentPath, content]) => [
            documentPath,
            Buffer.compare(beforeForce[documentPath]!, content)
          ])
        )
      ).toEqual(
        Object.fromEntries(exportResult.stdoutJson.meta.paths.map((documentPath: string) => [documentPath, 0]))
      );
      expect(
        fs.existsSync(path.join(projectRoot, ".routeledger", "db", "routeledger.sqlite3"))
      ).toBe(true);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

});
