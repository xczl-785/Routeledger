import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireRouteLedgerJsonWriteLock,
  encodeProjectAggregateToJsonDocuments,
  exportProjectAggregateToJsonDirectory,
  recoverRouteLedgerJsonReplacement,
  readRouteLedgerJsonDocuments,
  replaceRouteLedgerJsonDocuments,
  runRouteLedgerJsonMergeCheck,
  setRouteLedgerJsonFilesystemTestHooks,
  validateProjectAggregateSnapshot,
  validateRouteLedgerJsonDocuments,
  type RouteLedgerJsonDocument
} from "../index.js";
import {
  createDeferredConstraintJsonSnapshot,
  createJsonCodecSnapshot
} from "./builders.js";
import {
  createProjectFixture,
  createVersionFixture
} from "../../../core/src/testing/builders.js";

const createTempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-json-"));

const cleanupRoot = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
};

const createFilesystemError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`mock filesystem ${code}`), { code });

const writeReplacementManifest = (
  root: string,
  manifest: Record<string, unknown>
): void => {
  const replacementRoot = path.join(root, ".routeledger", ".canonical-replace");
  fs.mkdirSync(replacementRoot, { recursive: true });
  fs.writeFileSync(
    path.join(replacementRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
};

const moveCanonicalEntriesToBackup = (root: string, entryNames: string[]): void => {
  const backupRoot = path.join(root, ".routeledger", ".canonical-replace", "backup");
  fs.mkdirSync(backupRoot, { recursive: true });

  for (const entryName of entryNames) {
    fs.renameSync(
      path.join(root, ".routeledger", entryName),
      path.join(backupRoot, entryName)
    );
  }
};

const updateJsonDocument = (
  documents: RouteLedgerJsonDocument[],
  matcher: (document: RouteLedgerJsonDocument) => boolean,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>
): RouteLedgerJsonDocument[] =>
  documents.map((document) => {
    if (!matcher(document)) {
      return { ...document };
    }

    return {
      ...document,
      content: `${JSON.stringify(mutate(JSON.parse(document.content) as Record<string, unknown>), null, 2)}\n`
    };
  });

const appendDocument = (
  documents: RouteLedgerJsonDocument[],
  document: RouteLedgerJsonDocument
): RouteLedgerJsonDocument[] => [...documents.map((entry) => ({ ...entry })), document];

const getIssueCodes = (documents: RouteLedgerJsonDocument[]): string[] =>
  validateRouteLedgerJsonDocuments(documents).issues.map((issue) => issue.code);

const createSiblingGroupingEdgeCaseDocuments = (): RouteLedgerJsonDocument[] =>
  encodeProjectAggregateToJsonDocuments({
    project: createProjectFixture({
      currentVersionId: "version-2",
      initialVersionId: "version-1"
    }),
    versions: [
      createVersionFixture({
        id: "version-1",
        nextVersionId: "version-2",
        order: 1
      }),
      createVersionFixture({
        id: "version-2",
        previousVersionId: "version-1",
        nextVersionId: "__root__",
        order: 2,
        isCurrent: true,
        state: "running"
      }),
      createVersionFixture({
        id: "__root__",
        previousVersionId: "version-2",
        nextVersionId: "branch::root",
        order: 3,
        title: "Root-Named Version"
      }),
      createVersionFixture({
        id: "branch::root",
        previousVersionId: "__root__",
        order: 4,
        title: "Branch Root"
      }),
      createVersionFixture({
        id: "child-under-root-name",
        parentVersionId: "__root__",
        previousVersionId: null,
        nextVersionId: null,
        order: 11,
        title: "Child Under __root__"
      }),
      createVersionFixture({
        id: "nested::child",
        parentVersionId: "branch::root",
        previousVersionId: null,
        nextVersionId: null,
        order: 12,
        title: "Child Under branch::root"
      })
    ],
    workItems: [],
    todos: [],
    undos: [],
    deferredItems: [],
    constraints: [],
    assets: [],
    events: [],
    pendingOperations: [],
    approvalArtifacts: []
  });

describe("@routeledger/json validate", () => {
  it("accepts canonical DeferredItem and Constraint documents", () => {
    const result = validateRouteLedgerJsonDocuments(
      encodeProjectAggregateToJsonDocuments(createDeferredConstraintJsonSnapshot())
    );

    expect(result).toEqual({
      valid: true,
      issues: []
    });
  });

  it("accepts the canonical D3.8-style document set", () => {
    const documents = encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot());
    const result = validateRouteLedgerJsonDocuments(documents);

    expect(result).toEqual({
      valid: true,
      issues: []
    });
  });

  it("accepts a Project-root-only canonical set with no Version", () => {
    const baseline = createJsonCodecSnapshot();
    const documents = encodeProjectAggregateToJsonDocuments({
      ...baseline,
      project: {
        ...baseline.project,
        currentVersionId: null,
        initialVersionId: null
      },
      versions: [],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    expect(validateRouteLedgerJsonDocuments(documents)).toEqual({
      valid: true,
      issues: []
    });
  });

  it("keeps legacy missing content_locale readable but reports confirmation required", () => {
    const documents = encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()).map(
      (document) => {
        if (!document.path.endsWith("/project.json")) {
          return document;
        }

        const project = JSON.parse(document.content) as {
          settings: Record<string, unknown>;
        };
        delete project.settings.content_locale;
        return { ...document, content: `${JSON.stringify(project, null, 2)}\n` };
      }
    );

    const result = validateRouteLedgerJsonDocuments(documents);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "PROJECT_CONTENT_LOCALE_UNRESOLVED"
      })
    ]);
  });

  it("accepts valid sibling groups when version ids include __root__ and ::", () => {
    const result = validateRouteLedgerJsonDocuments(createSiblingGroupingEdgeCaseDocuments());

    expect(result).toEqual({
      valid: true,
      issues: []
    });
  });

  it("reads only canonical JSON documents and skips db/views/non-json runtime files plus extra json paths", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      fs.mkdirSync(path.join(root, ".routeledger", "db"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "views"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "tmp"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "events"), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "db", "ignored.json"), "{not-json");
      fs.writeFileSync(path.join(root, ".routeledger", "views", "ignored.json"), "{not-json");
      fs.writeFileSync(path.join(root, ".routeledger", "tmp", "extra.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(root, ".routeledger", "notes.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(root, ".routeledger", "events", "foo.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(root, ".routeledger", "runtime.lock"), "ignored");

      const readDocuments = await readRouteLedgerJsonDocuments(root);

      expect(readDocuments).toEqual(expectedDocuments);
    } finally {
      cleanupRoot(root);
    }
  });

  it("replaceRouteLedgerJsonDocuments replaces only canonical documents and preserves db/views/runtime files", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      fs.mkdirSync(path.join(root, ".routeledger", "db"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "views"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "runtime"), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "db", "routeledger.sqlite3"), "sqlite-cache");
      fs.writeFileSync(path.join(root, ".routeledger", "views", "context.json"), "{\"ignored\":true}\n");
      fs.writeFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "{\"ignored\":true}\n");
      fs.mkdirSync(path.join(root, ".routeledger", "todos", "st"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".routeledger", "todos", "st", "stale-todo.json"),
        "{\"kind\":\"todo\"}\n"
      );

      await replaceRouteLedgerJsonDocuments({
        outputRoot: root,
        documents: expectedDocuments
      });

      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
      expect(
        fs.existsSync(path.join(root, ".routeledger", "todos", "st", "stale-todo.json"))
      ).toBe(false);
      expect(fs.readFileSync(path.join(root, ".routeledger", "db", "routeledger.sqlite3"), "utf8")).toBe(
        "sqlite-cache"
      );
      expect(fs.readFileSync(path.join(root, ".routeledger", "views", "context.json"), "utf8")).toBe(
        "{\"ignored\":true}\n"
      );
      expect(fs.readFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "utf8")).toBe(
        "{\"ignored\":true}\n"
      );
    } finally {
      cleanupRoot(root);
    }
  });

  it("replaceRouteLedgerJsonDocuments retries transient Windows rename failures", async () => {
    const root = createTempRoot();
    let todosBackupAttempts = 0;

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      setRouteLedgerJsonFilesystemTestHooks({
        beforeRename: ({ operation, entryName, attempt }) => {
          if (
            operation === "backup_existing_canonical_entry" &&
            entryName === "todos"
          ) {
            todosBackupAttempts = attempt;

            if (attempt < 3) {
              throw createFilesystemError("EPERM");
            }
          }
        }
      });

      await replaceRouteLedgerJsonDocuments({
        outputRoot: root,
        documents: expectedDocuments
      });

      expect(todosBackupAttempts).toBe(3);
      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
    } finally {
      setRouteLedgerJsonFilesystemTestHooks(null);
      cleanupRoot(root);
    }
  });

  it("replaceRouteLedgerJsonDocuments invokes renewLock between transaction phases", async () => {
    const root = createTempRoot();
    let renewCalls = 0;

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      await replaceRouteLedgerJsonDocuments({
        outputRoot: root,
        documents: expectedDocuments,
        renewLock: async () => {
          renewCalls += 1;
        }
      });

      expect(renewCalls).toBeGreaterThanOrEqual(2);
      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
    } finally {
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments discards staged replacement leftovers before reading canonical documents", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      writeReplacementManifest(root, {
        transactionId: "tx-staged",
        state: "staged",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        documentCount: expectedDocuments.length,
        paths: expectedDocuments.map((document) => document.path)
      });
      fs.mkdirSync(path.join(root, ".routeledger", ".canonical-replace", "next", "todos", "xx"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(root, ".routeledger", ".canonical-replace", "next", "todos", "xx", "staged.json"),
        "{\"kind\":\"todo\"}\n"
      );

      const recoveredDocuments = await readRouteLedgerJsonDocuments(root);

      expect(recoveredDocuments).toEqual(expectedDocuments);
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments returns WRITE_IN_PROGRESS and skips recovery while a writer lock is active", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      const writeLock = await acquireRouteLedgerJsonWriteLock(root, {
        ownerId: "vitest-writer",
        retryAfterMs: 500
      });

      writeReplacementManifest(root, {
        transactionId: "tx-active-writer",
        state: "staged",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        documentCount: 1,
        paths: [".routeledger/project.json"]
      });
      fs.mkdirSync(path.join(root, ".routeledger", ".canonical-replace", "next", "todos", "xx"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(root, ".routeledger", ".canonical-replace", "next", "todos", "xx", "staged.json"),
        "{\"kind\":\"todo\"}\n"
      );

      await expect(readRouteLedgerJsonDocuments(root)).rejects.toMatchObject({
        code: "WRITE_IN_PROGRESS",
        details: {
          projectRoot: path.resolve(root),
          retryAfterMs: 500
        }
      });
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(true);

      await writeLock.release();
    } finally {
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments recovers a stale writer lock and continues reading", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      const writeLock = await acquireRouteLedgerJsonWriteLock(root, {
        ownerId: "stale-writer",
        retryAfterMs: 200,
        staleAfterMs: 5
      });
      const metadataPath = path.join(writeLock.lockPath, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        updatedAt: string;
      };
      metadata.updatedAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
      expect(fs.existsSync(writeLock.lockPath)).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("acquired write lock renew refreshes updatedAt so the lock is not reaped as stale", async () => {
    const root = createTempRoot();

    try {
      const writeLock = await acquireRouteLedgerJsonWriteLock(root, {
        ownerId: "heartbeat-writer",
        staleAfterMs: 5
      });
      const metadataPath = path.join(writeLock.lockPath, "metadata.json");

      await writeLock.renew();

      const refreshed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        ownerId: string;
        updatedAt: string;
        staleAfterMs: number;
      };

      expect(refreshed.ownerId).toBe("heartbeat-writer");
      expect(refreshed.staleAfterMs).toBe(5);
      expect(Date.now() - Date.parse(refreshed.updatedAt)).toBeLessThan(5_000);
      expect(fs.existsSync(writeLock.lockPath)).toBe(true);
      await writeLock.release();
      expect(fs.existsSync(writeLock.lockPath)).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("renew after the lock was reaped reports the reclaim instead of silently succeeding", async () => {
    const root = createTempRoot();

    try {
      const writeLock = await acquireRouteLedgerJsonWriteLock(root, {
        ownerId: "reaped-writer",
        staleAfterMs: 5
      });
      const metadataPath = path.join(writeLock.lockPath, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        ownerId: string;
      };
      metadata.ownerId = "other-owner";
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      await expect(writeLock.renew()).rejects.toMatchObject({
        code: "WRITE_IN_PROGRESS"
      });
    } finally {
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments recovers a stale empty writer lock directory", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      const lockRoot = path.join(root, ".routeledger", ".write-lock");
      fs.mkdirSync(lockRoot, { recursive: true });
      fs.utimesSync(lockRoot, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
      expect(fs.existsSync(lockRoot)).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("stale reaper does not remove a newer lock instance when metadata changes before claim", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      const staleLock = await acquireRouteLedgerJsonWriteLock(root, {
        ownerId: "stale-writer",
        retryAfterMs: 100,
        staleAfterMs: 5
      });
      const metadataPath = path.join(staleLock.lockPath, "metadata.json");
      const staleMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        updatedAt: string;
        lockId: string;
      };
      staleMetadata.updatedAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(metadataPath, `${JSON.stringify(staleMetadata, null, 2)}\n`, "utf8");

      setRouteLedgerJsonFilesystemTestHooks({
        beforeClaimStaleLock: ({ lockRoot, metadata }) => {
          if (metadata === null) {
            return;
          }

          fs.rmSync(path.join(lockRoot, `.lock-owner-${metadata.lockId}.marker`), { force: true });
          const replacementMetadata = {
            ...metadata,
            lockId: "replacement-lock",
            ownerId: "replacement-writer",
            createdAt: "2026-06-28T01:00:00.000Z",
            updatedAt: "2026-06-28T01:00:00.000Z",
            staleAfterMs: 30_000
          };
          fs.writeFileSync(
            path.join(lockRoot, "metadata.json"),
            `${JSON.stringify(replacementMetadata, null, 2)}\n`,
            "utf8"
          );
          fs.writeFileSync(
            path.join(lockRoot, ".lock-owner-replacement-lock.marker"),
            "replacement-writer\n",
            "utf8"
          );
        }
      });

      await expect(readRouteLedgerJsonDocuments(root)).rejects.toMatchObject({
        code: "WRITE_IN_PROGRESS",
        details: {
          ownerId: "replacement-writer"
        }
      });
      expect(fs.existsSync(path.join(staleLock.lockPath, "metadata.json"))).toBe(true);
    } finally {
      setRouteLedgerJsonFilesystemTestHooks(null);
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments restores old canonical set when staged state already moved partial backup", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      fs.mkdirSync(path.join(root, ".routeledger", "runtime"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "db"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "views"), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "{\"keep\":true}\n");
      fs.writeFileSync(path.join(root, ".routeledger", "db", "routeledger.sqlite3"), "sqlite-cache");
      fs.writeFileSync(path.join(root, ".routeledger", "views", "context.json"), "{\"ignored\":true}\n");

      moveCanonicalEntriesToBackup(root, ["project.json", "refs", "versions", "todos"]);
      fs.mkdirSync(path.join(root, ".routeledger", ".canonical-replace", "next", "versions", "xx"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(root, ".routeledger", ".canonical-replace", "next", "versions", "xx", "partial.json"),
        "{\"kind\":\"version\"}\n"
      );
      fs.writeFileSync(path.join(root, ".routeledger", "project.json"), "{\"kind\":\"project\"}\n");

      writeReplacementManifest(root, {
        transactionId: "tx-staged-with-backup",
        state: "staged",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        documentCount: expectedDocuments.length,
        paths: expectedDocuments.map((document) => document.path)
      });

      const recoveredDocuments = await readRouteLedgerJsonDocuments(root);

      expect(recoveredDocuments).toEqual(expectedDocuments);
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(false);
      expect(fs.readFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "utf8")).toBe(
        "{\"keep\":true}\n"
      );
      expect(fs.readFileSync(path.join(root, ".routeledger", "db", "routeledger.sqlite3"), "utf8")).toBe(
        "sqlite-cache"
      );
      expect(fs.readFileSync(path.join(root, ".routeledger", "views", "context.json"), "utf8")).toBe(
        "{\"ignored\":true}\n"
      );
    } finally {
      cleanupRoot(root);
    }
  });

  it("recoverRouteLedgerJsonReplacement restores backup canonical set after interrupted replace", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      fs.mkdirSync(path.join(root, ".routeledger", "runtime"), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "{\"keep\":true}\n");

      const replacementRoot = path.join(root, ".routeledger", ".canonical-replace");
      const backupRoot = path.join(replacementRoot, "backup");
      fs.mkdirSync(backupRoot, { recursive: true });

      fs.renameSync(
        path.join(root, ".routeledger", "project.json"),
        path.join(backupRoot, "project.json")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "refs"),
        path.join(backupRoot, "refs")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "versions"),
        path.join(backupRoot, "versions")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "work_items"),
        path.join(backupRoot, "work_items")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "todos"),
        path.join(backupRoot, "todos")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "undos"),
        path.join(backupRoot, "undos")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "assets"),
        path.join(backupRoot, "assets")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "events"),
        path.join(backupRoot, "events")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "pending_operations"),
        path.join(backupRoot, "pending_operations")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "approval_artifacts"),
        path.join(backupRoot, "approval_artifacts")
      );
      fs.renameSync(
        path.join(root, ".routeledger", "schema"),
        path.join(backupRoot, "schema")
      );

      fs.mkdirSync(path.join(root, ".routeledger", "project.json", ".."), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "project.json"), "{\"kind\":\"project\"}\n");
      fs.mkdirSync(path.join(root, ".routeledger", "pending_operations", "xx"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".routeledger", "pending_operations", "xx", "partial.json"),
        "{\"kind\":\"pending_operation\"}\n"
      );

      writeReplacementManifest(root, {
        transactionId: "tx-backup",
        state: "backup_created",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:01.000Z",
        documentCount: expectedDocuments.length,
        paths: expectedDocuments.map((document) => document.path)
      });

      const result = await recoverRouteLedgerJsonReplacement(root);

      expect(result).toEqual({
        outputRoot: path.resolve(root),
        recovered: true,
        action: "restore_backup"
      });
      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(false);
      expect(fs.readFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "utf8")).toBe(
        "{\"keep\":true}\n"
      );
      expect(
        fs.existsSync(path.join(root, ".routeledger", "pending_operations", "xx", "partial.json"))
      ).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("backup_created recovery is repeatable when canonical root already contains mixed old/new remnants", async () => {
    const root = createTempRoot();

    try {
      const snapshot = createJsonCodecSnapshot();
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot
      });

      moveCanonicalEntriesToBackup(root, [
        "project.json",
        "refs",
        "versions",
        "work_items",
        "todos",
        "undos",
        "assets",
        "events",
        "pending_operations",
        "approval_artifacts",
        "schema"
      ]);

      fs.mkdirSync(path.join(root, ".routeledger", "versions"), { recursive: true });
      fs.mkdirSync(path.join(root, ".routeledger", "pending_operations", "xx"), { recursive: true });
      fs.copyFileSync(
        path.join(
          root,
          ".routeledger",
          ".canonical-replace",
          "backup",
          "project.json"
        ),
        path.join(root, ".routeledger", "project.json")
      );
      fs.writeFileSync(
        path.join(root, ".routeledger", "pending_operations", "xx", "partial.json"),
        "{\"kind\":\"pending_operation\"}\n"
      );
      fs.writeFileSync(
        path.join(root, ".routeledger", "versions", "partial.json"),
        "{\"kind\":\"version\"}\n"
      );

      writeReplacementManifest(root, {
        transactionId: "tx-backup-repeatable",
        state: "backup_created",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:01.000Z",
        documentCount: expectedDocuments.length,
        paths: expectedDocuments.map((document) => document.path)
      });

      const firstRecovery = await recoverRouteLedgerJsonReplacement(root);
      const secondRecovery = await recoverRouteLedgerJsonReplacement(root);

      expect(firstRecovery.action).toBe("restore_backup");
      expect(secondRecovery.action).toBe("none");
      expect(await readRouteLedgerJsonDocuments(root)).toEqual(expectedDocuments);
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("readRouteLedgerJsonDocuments keeps a valid applied canonical set when manifest is missing and only partial backup remains", async () => {
    const root = createTempRoot();
    const oldSnapshot = createJsonCodecSnapshot();
    const newSnapshot = {
      ...createJsonCodecSnapshot(),
      project: {
        ...createJsonCodecSnapshot().project,
        name: "RouteLedger Applied"
      },
      versions: createJsonCodecSnapshot().versions.map((version) =>
        version.id === "version-2"
          ? {
              ...version,
              title: "Version 2 Applied"
            }
          : version
      )
    };

    try {
      const expectedDocuments = encodeProjectAggregateToJsonDocuments(newSnapshot);
      const oldDocuments = encodeProjectAggregateToJsonDocuments(oldSnapshot);

      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot: newSnapshot
      });

      fs.mkdirSync(path.join(root, ".routeledger", "runtime"), { recursive: true });
      fs.writeFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "{\"keep\":true}\n");

      const backupRoot = path.join(root, ".routeledger", ".canonical-replace", "backup");
      fs.mkdirSync(path.join(backupRoot, "refs"), { recursive: true });
      const oldProjectDocument = oldDocuments.find((document) => document.path === ".routeledger/project.json");
      const oldCurrentRefDocument = oldDocuments.find(
        (document) => document.path === ".routeledger/refs/current.json"
      );

      fs.writeFileSync(path.join(backupRoot, "project.json"), oldProjectDocument!.content, "utf8");
      fs.writeFileSync(
        path.join(backupRoot, "refs", "current.json"),
        oldCurrentRefDocument!.content,
        "utf8"
      );

      const recoveredDocuments = await readRouteLedgerJsonDocuments(root);

      expect(recoveredDocuments).toEqual(expectedDocuments);
      expect(fs.existsSync(path.join(root, ".routeledger", ".canonical-replace"))).toBe(false);
      expect(fs.readFileSync(path.join(root, ".routeledger", "runtime", "lock.json"), "utf8")).toBe(
        "{\"keep\":true}\n"
      );
    } finally {
      cleanupRoot(root);
    }
  });

  it("reports current_version target missing and Version.is_current mismatch", () => {
    const documents = updateJsonDocument(
      updateJsonDocument(
        encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
        (document) => document.path === ".routeledger/project.json",
        (value) => ({
          ...value,
          current_version_id: "version-missing"
        })
      ),
      (document) => document.path === ".routeledger/refs/current.json",
      (value) => ({
        ...value,
        current_version_id: "version-missing"
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining(["PROJECT_CURRENT_VERSION_NOT_FOUND", "VERSION_IS_CURRENT_MISMATCH"])
    );
  });

  it("reports invalid active pointers for closed todo and missing undo", () => {
    const closedTodoDocuments = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path.endsWith("/todo-1.json"),
      (value) => ({
        ...value,
        status: "closed"
      })
    );

    expect(getIssueCodes(closedTodoDocuments)).toContain("WORK_ITEM_ACTIVE_INVALID");

    const missingUndoDocuments = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path.endsWith("/work-item-1.json"),
      (value) => ({
        ...value,
        active_record_type: "undo",
        active_record_id: "undo-missing"
      })
    );

    expect(getIssueCodes(missingUndoDocuments)).toContain("WORK_ITEM_ACTIVE_INVALID");
  });

  it("reports undo version references, asset path issues, transition target issues, and pending/approval mismatches", () => {
    let documents = encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot());

    documents = updateJsonDocument(documents, (document) => document.path.endsWith("/undo-1.json"), (value) => ({
      ...value,
      origin_version_id: "",
      preferred_resolution_version_id: "version-missing"
    }));
    documents = updateJsonDocument(documents, (document) => document.path.endsWith("/asset-1.json"), (value) => ({
      ...value,
      relative_path: "/absolute/path.md",
      path_history: [
        {
          path_base: "project_root",
          relative_path: "../escape.md",
          recorded_at: "2026-06-27T00:30:00.000Z"
        }
      ]
    }));
    documents = updateJsonDocument(documents, (document) => document.path.endsWith("/event-1.json"), (value) => ({
      ...value,
      target_type: "todo",
      target_id: "todo-missing"
    }));
    documents = updateJsonDocument(
      documents,
      (document) => document.path.endsWith("/approval-1.json"),
      (value) => ({
        ...value,
        target_id: "version-mismatch"
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining([
        "UNDO_ORIGIN_VERSION_MISSING",
        "UNDO_PREFERRED_RESOLUTION_VERSION_NOT_FOUND",
        "ASSET_RELATIVE_PATH_INVALID",
        "TRANSITION_EVENT_TARGET_NOT_FOUND",
        "APPROVAL_ARTIFACT_MISMATCH",
        "PENDING_APPROVAL_MISMATCH"
      ])
    );
  });

  it("reports duplicate operation event sequence numbers", () => {
    const baseDocuments = encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot());
    const duplicateEvent = {
      path: ".routeledger/events/2026/06/event-2.json",
      content: `${JSON.stringify(
        {
          ...JSON.parse(baseDocuments.find((document) => document.path.endsWith("/event-1.json"))!.content),
          id: "event-2"
        },
        null,
        2
      )}\n`
    };
    const documents = appendDocument(baseDocuments, duplicateEvent);

    expect(getIssueCodes(documents)).toContain("OPERATION_EVENT_SEQ_DUPLICATE");
  });

  it("reports broken version sibling chains in validate and merge-check", async () => {
    const documents = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path.endsWith("/version-2.json"),
      (value) => ({
        ...value,
        previous_version_id: null
      })
    );

    const validation = validateRouteLedgerJsonDocuments(documents);

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "VERSION_SIBLING_NEXT_MISMATCH",
        "VERSION_SIBLING_HEAD_COUNT_INVALID"
      ])
    );

    const root = createTempRoot();

    try {
      await exportProjectAggregateToJsonDirectory({
        outputRoot: root,
        snapshot: createJsonCodecSnapshot()
      });

      fs.writeFileSync(
        path.join(root, ".routeledger", "versions", "ve", "version-2.json"),
        documents.find((document) => document.path.endsWith("/version-2.json"))!.content
      );

      const mergeCheck = await runRouteLedgerJsonMergeCheck(root);

      expect(mergeCheck.valid).toBe(false);
      expect(mergeCheck.issues.map((issue) => issue.code)).toContain("VERSION_SIBLING_NEXT_MISMATCH");
    } finally {
      cleanupRoot(root);
    }
  });

  it("reports cross-parent version sibling links", () => {
    const documents = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path.endsWith("/version-2.json"),
      (value) => ({
        ...value,
        parent_version_id: "version-1"
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining(["VERSION_SIBLING_PARENT_MISMATCH"])
    );
  });

  it("reports invalid document kind and schema_version during validate", () => {
    const documents = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path === ".routeledger/project.json",
      (value) => ({
        ...value,
        kind: "not_project",
        schema_version: 999
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining([
        "JSON_DOCUMENT_KIND_INVALID",
        "JSON_DOCUMENT_SCHEMA_VERSION_INVALID"
      ])
    );
  });

  it("reports inconsistent carried-forward undo metadata", () => {
    const documents = updateJsonDocument(
      encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()),
      (document) => document.path.endsWith("/undo-1.json"),
      (value) => ({
        ...value,
        carried_forward_at: "2026-06-27T02:00:00.000Z",
        carried_forward_to_version_id: "version-missing"
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining(["UNDO_CARRIED_FORWARD_TARGET_NOT_FOUND"])
    );
  });

  it("reports invalid DeferredItem references, lifecycle fields, and Constraint version scope", () => {
    let documents = encodeProjectAggregateToJsonDocuments(
      createDeferredConstraintJsonSnapshot()
    );
    documents = updateJsonDocument(
      documents,
      (document) => document.path.endsWith("/deferred-1.json"),
      (value) => ({
        ...value,
        target_review_version_id: "version-missing",
        resolution_outcome: "activated"
      })
    );
    documents = updateJsonDocument(
      documents,
      (document) => document.path.endsWith("/constraint-1.json"),
      (value) => ({
        ...value,
        scope: {
          type: "version",
          version_id: "version-missing"
        }
      })
    );

    expect(getIssueCodes(documents)).toEqual(
      expect.arrayContaining([
        "DEFERRED_TARGET_REVIEW_VERSION_NOT_FOUND",
        "DEFERRED_PENDING_RESOLUTION_FIELDS_INVALID",
        "CONSTRAINT_SCOPE_VERSION_NOT_FOUND"
      ])
    );
  });

  it("reports DeferredItem documents stored outside their id-owned canonical path", () => {
    const documents = encodeProjectAggregateToJsonDocuments(
      createDeferredConstraintJsonSnapshot()
    ).map((document) =>
      document.path.endsWith("/deferred-1.json")
        ? {
            ...document,
            path: ".routeledger/deferred_items/zz/deferred-1.json"
          }
        : document
    );

    expect(getIssueCodes(documents)).toContain("JSON_DOCUMENT_PATH_INVALID");
  });

  it("rejects malformed raw DeferredItem and Constraint shapes before decode", () => {
    const baseDocuments = encodeProjectAggregateToJsonDocuments(
      createDeferredConstraintJsonSnapshot()
    );
    const malformedDeferredMutations = [
      (value: Record<string, unknown>) => {
        const next = { ...value };
        delete next.title;
        return next;
      },
      (value: Record<string, unknown>) => ({ ...value, status: "unknown" }),
      (value: Record<string, unknown>) => ({
        ...value,
        resolution_outcome: "unknown"
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        review_trigger: 42
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        created_by: { id: "", type: "robot" }
      }),
      (value: Record<string, unknown>) => ({ ...value, updated_at: "" })
    ];

    for (const mutate of malformedDeferredMutations) {
      const documents = updateJsonDocument(
        baseDocuments,
        (document) => document.path.endsWith("/deferred-1.json"),
        mutate
      );
      expect(getIssueCodes(documents)).toContain("JSON_DOCUMENT_SHAPE_INVALID");
    }

    for (const mutate of [
      (value: Record<string, unknown>) => ({ ...value, rule: " " }),
      (value: Record<string, unknown>) => ({
        ...value,
        scope: { type: "version", version_id: "" }
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        retired_at: 42
      })
    ]) {
      const documents = updateJsonDocument(
        baseDocuments,
        (document) => document.path.endsWith("/constraint-1.json"),
        mutate
      );
      expect(getIssueCodes(documents)).toContain("JSON_DOCUMENT_SHAPE_INVALID");
    }
  });

  it("covers DeferredItem reference and lifecycle validator branches", () => {
    const referenceSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    referenceSnapshot.deferredItems[0] = {
      ...referenceSnapshot.deferredItems[0]!,
      workItemId: "missing-work-item",
      originVersionId: "missing-origin",
      targetReviewVersionId: "missing-target"
    };
    expect(
      validateProjectAggregateSnapshot(referenceSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toEqual(
      expect.arrayContaining([
        "DEFERRED_WORK_ITEM_NOT_FOUND",
        "DEFERRED_ORIGIN_VERSION_NOT_FOUND",
        "DEFERRED_TARGET_REVIEW_VERSION_NOT_FOUND"
      ])
    );

    const activatedSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    activatedSnapshot.deferredItems[0] = {
      ...activatedSnapshot.deferredItems[0]!,
      status: "activated",
      resolutionOutcome: "superseded",
      resolutionReason: null,
      resolutionNote: null,
      reviewedAt: null,
      activatedTodoId: null
    };
    expect(
      validateProjectAggregateSnapshot(activatedSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toEqual(
      expect.arrayContaining([
        "DEFERRED_RESOLUTION_FIELDS_MISSING",
        "DEFERRED_ACTIVATED_OUTCOME_INVALID",
        "DEFERRED_ACTIVATED_TODO_NOT_FOUND"
      ])
    );

    const resolvedSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    resolvedSnapshot.deferredItems[0] = {
      ...resolvedSnapshot.deferredItems[0]!,
      status: "resolved",
      resolutionOutcome: "activated",
      resolutionReason: "invalid outcome",
      resolutionNote: "invalid outcome",
      reviewedAt: "2026-06-27T02:00:00.000Z",
      activatedTodoId: "todo-1"
    };
    expect(
      validateProjectAggregateSnapshot(resolvedSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toEqual(
      expect.arrayContaining([
        "DEFERRED_RESOLVED_OUTCOME_INVALID",
        "DEFERRED_ACTIVATED_TODO_INVALID"
      ])
    );

    const rejectedSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    rejectedSnapshot.deferredItems[0] = {
      ...rejectedSnapshot.deferredItems[0]!,
      status: "resolved",
      resolutionOutcome: "rejected",
      resolutionReason: "rejected",
      resolutionNote: "rejected",
      reviewedAt: "2026-06-27T02:00:00.000Z",
      decisionRef: null
    };
    expect(
      validateProjectAggregateSnapshot(rejectedSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toContain("DEFERRED_DECISION_REF_MISSING");

    const outOfScopeSnapshot = structuredClone(rejectedSnapshot);
    outOfScopeSnapshot.deferredItems[0]!.resolutionOutcome = "out_of_scope";
    expect(
      validateProjectAggregateSnapshot(outOfScopeSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toContain("DEFERRED_DECISION_REF_MISSING");
  });

  it("covers Constraint lifecycle and new TransitionEvent target branches", () => {
    const activeSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    activeSnapshot.constraints[0] = {
      ...activeSnapshot.constraints[0]!,
      retiredAt: "2026-06-27T02:00:00.000Z",
      retireReason: "invalid",
      retireNote: "invalid"
    };
    expect(
      validateProjectAggregateSnapshot(activeSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toContain("CONSTRAINT_ACTIVE_RETIREMENT_FIELDS_INVALID");

    const retiredSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    retiredSnapshot.constraints[0] = {
      ...retiredSnapshot.constraints[0]!,
      status: "retired",
      retiredAt: null,
      retireReason: null,
      retireNote: null
    };
    expect(
      validateProjectAggregateSnapshot(retiredSnapshot).issues.map(
        (issue) => issue.code
      )
    ).toContain("CONSTRAINT_RETIREMENT_FIELDS_MISSING");

    const eventSnapshot = structuredClone(
      createDeferredConstraintJsonSnapshot()
    );
    eventSnapshot.events.push(
      {
        ...eventSnapshot.events[0]!,
        id: "event-missing-deferred",
        operationId: "operation-missing-targets",
        operationSeq: 1,
        targetType: "deferred_item",
        targetId: "missing-deferred"
      },
      {
        ...eventSnapshot.events[0]!,
        id: "event-missing-constraint",
        operationId: "operation-missing-targets",
        operationSeq: 2,
        targetType: "constraint",
        targetId: "missing-constraint"
      }
    );
    expect(
      validateProjectAggregateSnapshot(eventSnapshot).issues.filter(
        (issue) => issue.code === "TRANSITION_EVENT_TARGET_NOT_FOUND"
      )
    ).toHaveLength(2);
  });

  it("returns validation issues instead of throwing for malformed aggregate collections", () => {
    const snapshot = structuredClone(createDeferredConstraintJsonSnapshot()) as unknown as Record<
      string,
      unknown
    >;
    delete snapshot.deferredItems;
    snapshot.constraints = null;

    expect(
      validateProjectAggregateSnapshot(
        snapshot as unknown as Parameters<typeof validateProjectAggregateSnapshot>[0]
      )
    ).toEqual({
      valid: false,
      issues: [
        expect.objectContaining({
          code: "AGGREGATE_COLLECTION_INVALID",
          details: {
            collection: "deferredItems"
          }
        }),
        expect.objectContaining({
          code: "AGGREGATE_COLLECTION_INVALID",
          details: {
            collection: "constraints"
          }
        })
      ]
    });
  });

  it("returns exact shape issue codes for non-string DeferredItem and Constraint ids", () => {
    const snapshot = structuredClone(createDeferredConstraintJsonSnapshot());
    snapshot.deferredItems[0]!.id = 42 as unknown as string;
    snapshot.constraints[0]!.id = null as unknown as string;

    expect(
      validateProjectAggregateSnapshot(snapshot).issues.map((issue) => issue.code)
    ).toEqual(
      expect.arrayContaining([
        "DEFERRED_SHAPE_INVALID",
        "CONSTRAINT_SHAPE_INVALID"
      ])
    );
  });
});
