import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import type { ProjectAggregateSnapshot } from "@routeledger/core";
import {
  decodeProjectAggregateFromJsonDocuments,
  exportProjectAggregateToJsonDirectory
} from "@routeledger/json";
import { SQLiteStorageAdapter } from "@routeledger/sqlite";

import { runCli } from "../index.js";

const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-cli-"));

const cleanupProjectRoot = (projectRoot: string): void => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 4) {
        throw error;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
};

const removeSqliteFiles = (projectRoot: string): void => {
  const databasePath = path.join(projectRoot, ".routeledger", "db", "routeledger.sqlite3");

  for (const candidatePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ]) {
    fs.rmSync(candidatePath, { force: true });
  }
};

const runGit = (projectRoot: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8"
  });

const readJsonDocuments = (root: string): { path: string; content: string }[] => {
  const documents: { path: string; content: string }[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      documents.push({
        path: path.relative(root, entryPath).split(path.sep).join("/"),
        content: fs.readFileSync(entryPath, "utf8")
      });
    }
  };

  visit(root);

  return documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
};

const readDocumentBytesByPaths = (
  baseRoot: string,
  documentPaths: string[]
): Record<string, Buffer> =>
  Object.fromEntries(
    documentPaths.map((documentPath) => [
      documentPath,
      fs.readFileSync(path.join(baseRoot, ...documentPath.split("/").slice(1)))
    ])
  );

const runCliJson = async (projectRoot: string, argv: string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli({
    argv,
    projectRoot,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });

  return {
    exitCode,
    stdout,
    stderr,
    stdoutJson: stdout.length === 0 ? null : JSON.parse(stdout.at(-1)!),
    stderrJson: stderr.length === 0 ? null : JSON.parse(stderr.at(-1)!)
  };
};

const summarizeSnapshotCounts = (snapshot: {
  versions: unknown[];
  todos: unknown[];
  deferredItems: unknown[];
  constraints: unknown[];
  undos: unknown[];
  assets: unknown[];
  events: unknown[];
  pendingOperations: unknown[];
  approvalArtifacts: unknown[];
}) => ({
  versions: snapshot.versions.length,
  todos: snapshot.todos.length,
  deferredItems: snapshot.deferredItems.length,
  constraints: snapshot.constraints.length,
  legacyUndoRecords: snapshot.undos.length,
  assets: snapshot.assets.length,
  events: snapshot.events.length,
  pendingOperations: snapshot.pendingOperations.length,
  approvalArtifacts: snapshot.approvalArtifacts.length
});

const getIssueCodesFromCliError = (result: {
  stderrJson: {
    error: {
      details?: {
        issues?: Array<{ code: string }>;
      };
    };
  };
}): string[] =>
  result.stderrJson.error.details?.issues?.map((issue) => issue.code) ?? [];

const seedJsonRoundTripProject = async (projectRoot: string) => {
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
    "Round-trip todo",
    "--description",
    "preserve todo linkage"
  ]);

  await runCliJson(projectRoot, [
    "undo",
    "create",
    "--project-id",
    projectId,
    "--version-id",
    versionId,
    "--origin-version-id",
    versionId,
    "--preferred-resolution-version-id",
    versionId,
    "--title",
    "Round-trip undo",
    "--reason",
    "preserve undo linkage",
    "--description",
    "preserve pending artifacts"
  ]);

  const createVersionResult = await runCliJson(projectRoot, [
    "version",
    "create",
    "--project-id",
    projectId,
    "--title",
    "Version 2"
  ]);
  const pendingOperationId = createVersionResult.stderrJson.error.details.pendingOperationId as string;

  const approveResult = await runCliJson(projectRoot, [
    "l3",
    "approve",
    "--project-id",
    projectId,
    "--pending-operation-id",
    pendingOperationId
  ]);
  const approvalArtifactId = approveResult.stdoutJson.data.id as string;

  return {
    projectId,
    versionId,
    pendingOperationId,
    approvalArtifactId
  };
};

const createVersionViaL3 = async (
  projectRoot: string,
  projectId: string,
  title: string
): Promise<string> => {
  const createResult = await runCliJson(projectRoot, [
    "version",
    "create",
    "--project-id",
    projectId,
    "--title",
    title
  ]);

  expect(createResult.exitCode).not.toBe(0);
  expect(createResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");

  const pendingOperationId = createResult.stderrJson.error.details.pendingOperationId as string;
  const createdVersionId = createResult.stderrJson.error.details.proposal.targetId as string;
  const approveResult = await runCliJson(projectRoot, [
    "l3",
    "approve",
    "--project-id",
    projectId,
    "--pending-operation-id",
    pendingOperationId
  ]);

  expect(approveResult.exitCode).toBe(0);

  const commitResult = await runCliJson(projectRoot, [
    "l3",
    "commit",
    "--project-id",
    projectId,
    "--pending-operation-id",
    pendingOperationId,
    "--approval-artifact-id",
    approveResult.stdoutJson.data.id
  ]);

  expect(commitResult.exitCode).toBe(0);

  return createdVersionId;
};

const setCurrentVersionViaL3 = async (
  projectRoot: string,
  projectId: string,
  versionId: string
): Promise<void> => {
  const setCurrentResult = await runCliJson(projectRoot, [
    "version",
    "current",
    "set",
    "--project-id",
    projectId,
    "--version-id",
    versionId
  ]);

  expect(setCurrentResult.exitCode).not.toBe(0);
  expect(setCurrentResult.stderrJson.error.code).toBe("CONFIRMATION_REQUIRED");

  const pendingOperationId = setCurrentResult.stderrJson.error.details.pendingOperationId as string;
  const approveResult = await runCliJson(projectRoot, [
    "l3",
    "approve",
    "--project-id",
    projectId,
    "--pending-operation-id",
    pendingOperationId
  ]);

  expect(approveResult.exitCode).toBe(0);

  const commitResult = await runCliJson(projectRoot, [
    "l3",
    "commit",
    "--project-id",
    projectId,
    "--pending-operation-id",
    pendingOperationId,
    "--approval-artifact-id",
    approveResult.stdoutJson.data.id
  ]);

  expect(commitResult.exitCode).toBe(0);
};

const updateJsonFile = (
  root: string,
  relativePath: string,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>
): void => {
  const absolutePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(absolutePath, `${JSON.stringify(mutate(value), null, 2)}\n`);
};

const rewriteJsonFile = (
  root: string,
  relativePath: string,
  render: (value: Record<string, unknown>) => string
): void => {
  const absolutePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(absolutePath, render(value));
};

const createValidateSnapshot = (): ProjectAggregateSnapshot => ({
  project: {
    id: "project-1",
    name: "RouteLedger",
    description: "",
    status: "active",
    currentVersionId: "version-2",
    initialVersionId: "version-1",
    createdBy: {
      id: "agent-1",
      type: "agent",
      displayName: "routeledger-cli"
    },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    archivedAt: null,
    settings: {
      enforceStartGate: true,
      enforceCloseGate: true,
      contextBudgetBytes: 65536
    }
  },
  versions: [
    {
      id: "version-1",
      projectId: "project-1",
      title: "Version 1",
      description: "",
      state: "wait",
      parentVersionId: null,
      previousVersionId: null,
      nextVersionId: "version-2",
      order: 1,
      isCurrent: false,
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      closedAt: null,
      stateReason: null
    },
    {
      id: "version-2",
      projectId: "project-1",
      title: "Version 2",
      description: "",
      state: "running",
      parentVersionId: null,
      previousVersionId: "version-1",
      nextVersionId: null,
      order: 2,
      isCurrent: true,
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      closedAt: null,
      stateReason: null
    }
  ],
  workItems: [
    {
      id: "work-item-1",
      projectId: "project-1",
      title: "Track JSON",
      type: "other",
      status: "active",
      originVersionId: "version-1",
      activeRecordType: "todo",
      activeRecordId: "todo-1",
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      closedAt: null,
      summary: "Track JSON"
    }
  ],
  todos: [
    {
      id: "todo-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      versionId: "version-2",
      title: "Validate JSON",
      description: "",
      status: "wait",
      sourceType: "manual",
      sourceId: null,
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      closedAt: null,
      closeReason: null,
      closeNote: null
    }
  ],
  undos: [
    {
      id: "undo-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      versionId: "version-1",
      originVersionId: "version-1",
      preferredResolutionVersionId: "version-2",
      sourceType: "manual",
      sourceId: null,
      title: "Undo JSON",
      description: "",
      status: "wait",
      reason: "defer",
      triggerCondition: null,
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      carriedForwardAt: null,
      carriedForwardToVersionId: null,
      closedAt: null,
      closeReason: null,
      closeNote: null
    }
  ],
  deferredItems: [],
  constraints: [],
  assets: [
    {
      id: "asset-1",
      projectId: "project-1",
      workItemIds: ["work-item-1"],
      pathBase: "project_root",
      relativePath: "docs/json.md",
      status: "active",
      pathHistory: [
        {
          pathBase: "project_root",
          relativePath: "docs/json.md",
          recordedAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    }
  ],
  events: [
    {
      id: "event-1",
      projectId: "project-1",
      operationId: "operation-1",
      operationSeq: 1,
      targetType: "pending_operation",
      targetId: "pending-1",
      eventType: "pending_operation.created",
      fromState: null,
      toState: "pending",
      note: null,
      actorId: "agent-1",
      actorType: "agent",
      actorDisplayName: "routeledger-cli",
      createdAt: "2026-06-27T00:00:00.000Z",
      metadata: {}
    }
  ],
  pendingOperations: [
    {
      id: "pending-1",
      projectId: "project-1",
      actionType: "close_version",
      targetId: "version-2",
      status: "pending",
      reason: "close version",
      gateSnapshot: {
        kind: "close",
        evaluatedAt: "2026-06-27T00:00:00.000Z",
        allowed: false,
        blockers: [],
        unresolvedTodoIds: ["todo-1"],
        unresolvedUndoIds: ["undo-1"],
        unresolvedDeferredIds: [],
        blockedConstraintIds: [],
        residualAudit: null
      },
      digest: {
        algorithm: "sha256",
        value: "digest-1",
        payload: {
          projectId: "project-1",
          actionType: "close_version",
          targetId: "version-2"
        }
      },
      payload: {
        currentVersionId: "version-2"
      },
      createdBy: {
        id: "agent-1",
        type: "agent",
        displayName: "routeledger-cli"
      },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
      committedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      approvalArtifactId: "approval-1"
    }
  ],
  approvalArtifacts: [
    {
      id: "approval-1",
      projectId: "project-1",
      pendingOperationId: "pending-1",
      actionType: "close_version",
      targetId: "version-2",
      digest: {
        algorithm: "sha256",
        value: "digest-1",
        payload: {
          projectId: "project-1",
          actionType: "close_version",
          targetId: "version-2"
        }
      },
      status: "approved",
      approver: {
        id: "user-1",
        type: "user",
        displayName: "owner"
      },
      decisionRef: "decision://routeledger/1",
      createdAt: "2026-06-27T00:00:00.000Z",
      expiresAt: "2026-06-28T00:00:00.000Z",
      consumedAt: null
    }
  ]
});

describe("routeledger cli", () => {
  it("smoke: init/context/versions 与 L3 approve/commit 链路可用", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      expect(initResult.exitCode).toBe(0);

      const prepareResult = await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      expect(prepareResult.exitCode).toBe(0);

      const bareStart = await runCliJson(projectRoot, [
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

      const approveResult = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        pendingOperationId
      ]);

      expect(approveResult.exitCode).toBe(0);

      const approvalArtifactId = approveResult.stdoutJson.data.id as string;
      const commitResult = await runCliJson(projectRoot, [
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

      const contextResult = await runCliJson(projectRoot, [
        "context",
        "--json",
        "--project-id",
        projectId
      ]);
      const versionsResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const createdVersionIds = [initResult.stdoutJson.data.initialVersion.id as string];

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

      const defaultContextResult = await runCliJson(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const fullContextResult = await runCliJson(projectRoot, [
        "context",
        "--project-id",
        projectId,
        "--include-all-versions"
      ]);
      const customWindowResult = await runCliJson(projectRoot, [
        "context",
        "--project-id",
        projectId,
        "--version-window-before",
        "1",
        "--version-window-after",
        "2"
      ]);
      const versionsResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const startGateResult = await runCliJson(projectRoot, [
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

      const startContextResult = await runCliJson(projectRoot, [
        "context",
        "--json",
        "--project-id",
        projectId
      ]);

      expect(startContextResult.stdoutJson.data.currentVersion.state).toBe("ready");

      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const startProposalId = bareStart.stderrJson.error.details.pendingOperationId as string;
      const startApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId,
        "--approval-artifact-id",
        startApprove.stdoutJson.data.id
      ]);
      await runCliJson(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const closeGateResult = await runCliJson(projectRoot, [
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

      const closeContextResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const startProposalId = bareStart.stderrJson.error.details.pendingOperationId as string;
      const startApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        startProposalId,
        "--approval-artifact-id",
        startApprove.stdoutJson.data.id
      ]);
      await runCliJson(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareClose = await runCliJson(projectRoot, [
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
      const closeApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        closeProposalId
      ]);
      const closeCommit = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        closeProposalId,
        "--approval-artifact-id",
        closeApprove.stdoutJson.data.id
      ]);
      expect(closeCommit.exitCode).toBe(0);

      const bareReopen = await runCliJson(projectRoot, [
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
      const reopenApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reopenProposalId
      ]);
      const reopenCommit = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reopenProposalId,
        "--approval-artifact-id",
        reopenApprove.stdoutJson.data.id
      ]);
      expect(reopenCommit.exitCode).toBe(0);

      const bareCurrentSet = await runCliJson(projectRoot, [
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
      const currentSetApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        currentSetProposalId
      ]);
      const currentSetCommit = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        currentSetProposalId,
        "--approval-artifact-id",
        currentSetApprove.stdoutJson.data.id
      ]);
      expect(currentSetCommit.exitCode).toBe(0);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("smoke: version tree create/insert/child/reorder 可通过 direct + l3 commit 落地", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;

      const createResult = await runCliJson(projectRoot, [
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
      const createApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        createProposalId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        createProposalId,
        "--approval-artifact-id",
        createApprove.stdoutJson.data.id
      ]);

      const insertResult = await runCliJson(projectRoot, [
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
      const insertApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        insertProposalId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        insertProposalId,
        "--approval-artifact-id",
        insertApprove.stdoutJson.data.id
      ]);

      const childResult = await runCliJson(projectRoot, [
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
      const childApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        childProposalId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        childProposalId,
        "--approval-artifact-id",
        childApprove.stdoutJson.data.id
      ]);

      const reorderResult = await runCliJson(projectRoot, [
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
      const reorderApprove = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reorderProposalId
      ]);
      const reorderCommit = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        reorderProposalId,
        "--approval-artifact-id",
        reorderApprove.stdoutJson.data.id
      ]);
      expect(reorderCommit.exitCode).toBe(0);

      const versionsResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;
      const invalidPreflight = await runCliJson(projectRoot, [
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
      const validPropose = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidMode = await runCliJson(projectRoot, [
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
      const contextResult = await runCliJson(projectRoot, ["context", "--project-id", projectId]);

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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidPolicy = await runCliJson(projectRoot, [
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
      const contextResult = await runCliJson(projectRoot, ["context", "--project-id", projectId]);

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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;
      const targetVersionId = await createVersionViaL3(projectRoot, projectId, "Next Version");

      const prepareCurrent = await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const prepareTarget = await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);
      const dryRunBeforeSwitch = await runCliJson(projectRoot, [
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

      const proposeSwitch = await runCliJson(projectRoot, [
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

      const approveSwitch = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        proposeSwitch.stdoutJson.data.pendingOperationId
      ]);
      const commitSwitch = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        proposeSwitch.stdoutJson.data.pendingOperationId,
        "--approval-artifact-id",
        approveSwitch.stdoutJson.data.id
      ]);
      const dryRunAfterSwitch = await runCliJson(projectRoot, [
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

  it("close_version / carry_forward_undo / get_version_structure 命令遵守 block-first 与保守结转语义", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;
      const downstreamVersionId = await createVersionViaL3(projectRoot, projectId, "Downstream");

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const approveStart = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      const commitStart = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.id
      ]);
      const completeVersion = await runCliJson(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const blockedClose = await runCliJson(projectRoot, [
        "close_version",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId,
        "--mode",
        "propose"
      ]);
      const proposalsAfterBlockedClose = await runCliJson(projectRoot, [
        "l3",
        "list",
        "--project-id",
        projectId
      ]);
      const createdUndo = await runCliJson(projectRoot, [
        "undo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId,
        "--origin-version-id",
        initialVersionId,
        "--preferred-resolution-version-id",
        initialVersionId,
        "--title",
        "route later",
        "--reason",
        "defer downstream"
      ]);
      const blockingStructure = await runCliJson(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const carryForward = await runCliJson(projectRoot, [
        "carry_forward_undo",
        "--project-id",
        projectId,
        "--undo-id",
        createdUndo.stdoutJson.data.undo.id,
        "--preferred-resolution-version-id",
        downstreamVersionId,
        "--reason",
        "route to downstream version",
        "--note",
        "keep as undo"
      ]);
      const structure = await runCliJson(projectRoot, [
        "get_version_structure",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const legacyAuditStructure = await runCliJson(projectRoot, [
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
      expect(carryForward.exitCode).toBe(0);
      expect(carryForward.stdoutJson.data).toMatchObject({
        status: "reassigned",
        preferredResolutionVersionId: downstreamVersionId
      });
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
      expect(legacyAuditStructure.stdoutJson.data.legalOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionType: "carry_forward_undo" })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("shutdown_version 命令将 shutdown reason 与 proposal reason 分离", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const approveStart = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      const commitStart = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.id
      ]);

      await runCliJson(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "still open"
      ]);

      const shutdownResult = await runCliJson(projectRoot, [
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
      const shutdownProposal = await runCliJson(projectRoot, [
        "l3",
        "get",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId
      ]);
      const approveShutdown = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId
      ]);
      const commitShutdown = await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        shutdownResult.stdoutJson.data.pendingOperationId,
        "--approval-artifact-id",
        approveShutdown.stdoutJson.data.id
      ]);
      const contextResult = await runCliJson(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const proposalsResult = await runCliJson(projectRoot, [
        "l3",
        "list",
        "--project-id",
        projectId
      ]);

      expect(commitStart.exitCode).toBe(0);
      expect(shutdownResult.exitCode).toBe(0);
      expect(shutdownResult.stdoutJson.data).toMatchObject({
        status: "ready",
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);

      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        versionId
      ]);
      const approveStart = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.id
      ]);

      await runCliJson(projectRoot, [
        "todo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--title",
        "still open"
      ]);

      const shutdownResult = await runCliJson(projectRoot, [
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
      const shutdownProposal = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, ["init_project", "--name", "RouteLedger"]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const initialVersionId = initResult.stdoutJson.data.initialVersion.id as string;
      const targetVersionId = await createVersionViaL3(projectRoot, projectId, "Next Version");

      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const bareStart = await runCliJson(projectRoot, [
        "version",
        "start",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      const approveStart = await runCliJson(projectRoot, [
        "l3",
        "approve",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId
      ]);
      await runCliJson(projectRoot, [
        "l3",
        "commit",
        "--project-id",
        projectId,
        "--pending-operation-id",
        bareStart.stderrJson.error.details.pendingOperationId,
        "--approval-artifact-id",
        approveStart.stdoutJson.data.id
      ]);
      await runCliJson(projectRoot, [
        "version",
        "complete",
        "--project-id",
        projectId,
        "--version-id",
        initialVersionId
      ]);
      await runCliJson(projectRoot, [
        "version",
        "prepare",
        "--project-id",
        projectId,
        "--version-id",
        targetVersionId
      ]);
      const exportResult = await runCliJson(projectRoot, [
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

      const staleSqliteGuide = await runCliJson(projectRoot, [
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

      const missingSqliteGuide = await runCliJson(projectRoot, [
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
        "Export todo",
        "--description",
        "Verify sqlite export"
      ]);

      const defaultExport = await runCliJson(projectRoot, [
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

      const exportResult = await runCliJson(projectRoot, [
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
      expect(decoded.project.initialVersionId).toBe(versionId);
      expect(decoded.todos).toHaveLength(1);
      expect(decoded.todos[0]?.title).toBe("Export todo");
      expect(joinedContent).not.toContain("\"currentVersionId\"");
      expect(joinedContent).not.toContain("\"createdBy\"");

      const duplicateExport = await runCliJson(projectRoot, [
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
      const forcedExport = await runCliJson(projectRoot, [
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

  it("Deferred CLI 覆盖新建、Todo 转换、再次延后、激活与解决，并在重启后保持精简输出", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, [
        "init_project",
        "--name",
        "Deferred CLI"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const version1Id = initResult.stdoutJson.data.initialVersion.id as string;
      const version2Id = await createVersionViaL3(projectRoot, projectId, "Version 2");
      const version3Id = await createVersionViaL3(projectRoot, projectId, "Version 3");

      const todoResult = await runCliJson(projectRoot, [
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
      const fromTodoResult = await runCliJson(projectRoot, [
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

      const deferredAgainResult = await runCliJson(projectRoot, [
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

      const resolveResult = await runCliJson(projectRoot, [
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

      const createResult = await runCliJson(projectRoot, [
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

      const activateResult = await runCliJson(projectRoot, [
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

      const contextResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, [
        "init_project",
        "--name",
        "Constraint CLI"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;
      const projectConstraintResult = await runCliJson(projectRoot, [
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
      const versionConstraintResult = await runCliJson(projectRoot, [
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

      const retireResult = await runCliJson(projectRoot, [
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

      const contextResult = await runCliJson(projectRoot, [
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
      const initResult = await runCliJson(projectRoot, [
        "init_project",
        "--name",
        "Semantic validation"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const invalidOutcome = await runCliJson(projectRoot, [
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
      const missingVersionScope = await runCliJson(projectRoot, [
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
      const extraVersionScope = await runCliJson(projectRoot, [
        "constraint",
        "record",
        "--project-id",
        projectId,
        "--scope",
        "project",
        "--version-id",
        initResult.stdoutJson.data.initialVersion.id,
        "--rule",
        "Project rule",
        "--rationale",
        "No version should be accepted"
      ]);
      const structureResult = await runCliJson(projectRoot, [
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

      const contextResult = await runCliJson(projectRoot, [
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

  it("旧 Undo CLI 仅保留兼容直调，默认 context 隐藏并可显式审计", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const initResult = await runCliJson(projectRoot, [
        "init_project",
        "--name",
        "Legacy compatibility"
      ]);
      const projectId = initResult.stdoutJson.data.project.id as string;
      const versionId = initResult.stdoutJson.data.initialVersion.id as string;
      const undoResult = await runCliJson(projectRoot, [
        "undo",
        "create",
        "--project-id",
        projectId,
        "--version-id",
        versionId,
        "--origin-version-id",
        versionId,
        "--preferred-resolution-version-id",
        versionId,
        "--title",
        "Historical record",
        "--reason",
        "Compatibility only"
      ]);

      expect(undoResult.exitCode).toBe(0);
      const undoId = undoResult.stdoutJson.data.undo.id as string;

      const defaultContext = await runCliJson(projectRoot, [
        "context",
        "--project-id",
        projectId
      ]);
      const auditContext = await runCliJson(projectRoot, [
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
