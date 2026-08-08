import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { expect } from "vitest";

import type { ProjectAggregateSnapshot } from "@routeledger/core";
import {
  TEST_ACTOR,
  createUndoFixture,
  createWorkItemFixture
} from "../../../core/src/testing/builders.js";
import { createTransitionEvents } from "@routeledger/core";

import { SQLiteStorageAdapter } from "@routeledger/sqlite";

import { runCli } from "../index.js";

export const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-cli-"));

export const cleanupProjectRoot = (projectRoot: string): void => {
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

export const removeSqliteFiles = (projectRoot: string): void => {
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

export const runGit = (projectRoot: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8"
  });

export const readJsonDocuments = (root: string): { path: string; content: string }[] => {
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

export const readDocumentBytesByPaths = (
  baseRoot: string,
  documentPaths: string[]
): Record<string, Buffer> =>
  Object.fromEntries(
    documentPaths.map((documentPath) => [
      documentPath,
      fs.readFileSync(path.join(baseRoot, ...documentPath.split("/").slice(1)))
    ])
  );

export const runCliJson = async (projectRoot: string, argv: string[]) => {
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

export const summarizeSnapshotCounts = (snapshot: {
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

export const getIssueCodesFromCliError = (result: {
  stderrJson: {
    error: {
      details?: {
        issues?: Array<{ code: string }>;
      };
    };
  };
}): string[] =>
  result.stderrJson.error.details?.issues?.map((issue) => issue.code) ?? [];

export const seedJsonRoundTripProject = async (projectRoot: string) => {
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

  const undoWorkItem = createWorkItemFixture({
    id: "round-trip-undo-work-item-1",
    projectId,
    originVersionId: versionId,
    activeRecordType: "undo",
    activeRecordId: "round-trip-undo-1"
  });
  const undo = createUndoFixture({
    id: "round-trip-undo-1",
    projectId,
    versionId,
    originVersionId: versionId,
    preferredResolutionVersionId: versionId,
    workItemId: undoWorkItem.id,
    title: "Round-trip undo",
    reason: "preserve undo linkage",
    description: "preserve pending artifacts"
  });
  const undoEvents = createTransitionEvents(
    [
      {
        targetType: "undo" as const,
        targetId: undo.id,
        eventType: "undo.created",
        toState: "wait"
      },
      {
        targetType: "work_item" as const,
        targetId: undoWorkItem.id,
        eventType: "work_item.created",
        toState: "active"
      }
    ],
    {
      projectId,
      operationId: crypto.randomUUID(),
      actor: TEST_ACTOR,
      now: "2026-06-27T00:00:00.000Z"
    },
    {
      nextId: () => crypto.randomUUID()
    }
  );
  const storage = new SQLiteStorageAdapter({ projectRoot });
  const snapshot = await storage.loadProjectAggregate(projectId);
  snapshot!.undos = snapshot!.undos.concat(undo);
  snapshot!.workItems = snapshot!.workItems.concat(undoWorkItem);
  snapshot!.events = snapshot!.events.concat(undoEvents);
  await storage.saveProjectAggregate(snapshot!);
  storage.close();

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

export const createVersionViaL3 = async (
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

export const setCurrentVersionViaL3 = async (
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

export const updateJsonFile = (
  root: string,
  relativePath: string,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>
): void => {
  const absolutePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(absolutePath, `${JSON.stringify(mutate(value), null, 2)}\n`);
};

export const rewriteJsonFile = (
  root: string,
  relativePath: string,
  render: (value: Record<string, unknown>) => string
): void => {
  const absolutePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(absolutePath, render(value));
};

export const createValidateSnapshot = (): ProjectAggregateSnapshot => ({
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
