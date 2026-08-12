import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";

import {
  RouteLedgerService,
  activateDeferred,
  closeVersion,
  createAsset,
  createConstraint,
  createDeferred,
  createProject,
  createTodo,
  createTransitionEvents,
  evaluateCloseGate,
  evaluateStartGate,
  markVersionComplete,
  prepareVersion,
  resolveDeferred,
  retireConstraint,
  setCurrentVersion,
  startVersion,
  validateWorkItemActive,
  type ProjectAggregateSnapshot
} from "../../../core/src/index.js";
import {
  TEST_ACTOR,
  createTestDependencies,
  createTodoFixture,
  createUndoFixture,
  createWorkItemFixture,
  createVersionFixture
} from "../../../core/src/testing/builders.js";
import { describe, expect, it } from "vitest";

import { ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME, openRouteLedgerDatabase } from "../database.js";
import { SQLITE_MIGRATIONS, applyMigrations, ensureSchemaMigrationsTable } from "../migrations.js";
import { SQLiteStorageAdapter } from "../sqlite-storage-adapter.js";

const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-sqlite-"));

const sortById = <T extends { id: string }>(records: T[]): T[] =>
  [...records].sort((left, right) => left.id.localeCompare(right.id, "en"));

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

const createEmptyAggregate = (): ProjectAggregateSnapshot => {
  const deps = createTestDependencies();
  const creation = createProject({
    contentLocale: "en",
    name: "RouteLedger",
    firstVersion: { title: "Initial Version", description: "" },
    actor: TEST_ACTOR,
    deps
  });

  return {
    project: creation.project,
    versions: [creation.firstVersion!],
    workItems: [],
    todos: [],
    undos: [],
    deferredItems: [],
    constraints: [],
    assets: [],
    events: creation.events,
    pendingOperations: [],
    approvalArtifacts: []
  };
};

const expectConfirmationRequired = async (
  promise: Promise<unknown>
): Promise<{
  pendingOperationId: string;
  proposal: {
    targetId: string;
  };
}> => {
  try {
    await promise;
    throw new Error("expected CONFIRMATION_REQUIRED");
  } catch (error) {
    expect(error).toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    return (error as {
      details: {
        pendingOperationId: string;
        proposal: {
          targetId: string;
        };
      };
    }).details;
  }
};

const createAggregateWithRetainedHistory = (): ProjectAggregateSnapshot => {
  const deps = createTestDependencies();
  const created = createProject({
    contentLocale: "en",
    name: "RouteLedger",
    firstVersion: { title: "Initial Version", description: "" },
    actor: TEST_ACTOR,
    deps
  });
  const convertedTodo = createTodoFixture({
    id: "todo-retained",
    projectId: created.project.id,
    versionId: created.firstVersion!.id,
    workItemId: "work-item-retained",
    status: "converted",
    closeReason: "defer",
    closeNote: "defer history"
  });
  const convertedUndo = createUndoFixture({
    id: "undo-retained",
    projectId: created.project.id,
    versionId: created.firstVersion!.id,
    originVersionId: created.firstVersion!.id,
    preferredResolutionVersionId: created.firstVersion!.id,
    workItemId: "work-item-retained",
    status: "converted",
    closeReason: "resume",
    closeNote: "resume history"
  });
  const resumedTodo = createTodoFixture({
    id: "todo-resumed",
    projectId: created.project.id,
    versionId: created.firstVersion!.id,
    workItemId: "work-item-retained",
    status: "wait"
  });
  const workItem = createWorkItemFixture({
    id: "work-item-retained",
    projectId: created.project.id,
    originVersionId: created.firstVersion!.id,
    activeRecordType: "todo",
    activeRecordId: resumedTodo.id
  });
  const historyEvents = createTransitionEvents(
    [
      {
        targetType: "todo" as const,
        targetId: convertedTodo.id,
        eventType: "todo.converted_to_undo",
        fromState: "wait",
        toState: "converted",
        note: "defer history"
      },
      {
        targetType: "undo" as const,
        targetId: convertedUndo.id,
        eventType: "undo.converted_to_todo",
        fromState: "wait",
        toState: "converted",
        note: "resume history"
      },
      {
        targetType: "work_item" as const,
        targetId: workItem.id,
        eventType: "work_item.active_changed",
        fromState: "undo",
        toState: "todo",
        note: "resume history"
      }
    ],
    {
      projectId: created.project.id,
      operationId: deps.idGenerator.nextId(),
      actor: TEST_ACTOR,
      now: "2026-06-27T00:00:00.000Z"
    },
    deps.idGenerator
  );
  const assetCreation = createAsset({
    projectId: created.project.id,
    workItemIds: [workItem.id],
    pathBase: "project_root",
    relativePath: "docs/history.md",
    actor: TEST_ACTOR,
    deps
  });

  return {
    project: created.project,
    versions: [created.firstVersion!],
    workItems: [workItem],
    todos: [convertedTodo, resumedTodo],
    undos: [convertedUndo],
    deferredItems: [],
    constraints: [],
    assets: [assetCreation.asset],
    events: created.events.concat(historyEvents).concat(assetCreation.events),
    pendingOperations: [],
    approvalArtifacts: []
  };
};

describe("sqlite storage adapter", () => {

  it("init 创建 DB 文件并启用 foreign_keys/WAL", () => {
    const projectRoot = createTempProjectRoot();

    try {
      const opened = openRouteLedgerDatabase({ projectRoot });

      try {
        expect(fs.existsSync(path.join(projectRoot, ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME))).toBe(true);
        expect(opened.db.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(String(opened.db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      } finally {
        opened.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it(".gitignore 忽略仓库根运行态，但保留受控 canonical fixture", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

    const ignoredDb = spawnSync("git", ["check-ignore", ".routeledger/db/routeledger.sqlite3"], {
      cwd: repoRoot
    });
    const ignoredViews = spawnSync("git", ["check-ignore", ".routeledger/views/current_context.json"], {
      cwd: repoRoot
    });
    const ignoredProjectJson = spawnSync("git", ["check-ignore", ".routeledger/project.json"], {
      cwd: repoRoot
    });
    const visibleCanonicalFixture = spawnSync(
      "git",
      ["check-ignore", "packages/json/src/testing/fixtures/canonical/.routeledger/project.json"],
      {
        cwd: repoRoot
      }
    );

    expect(ignoredDb.status).toBe(0);
    expect(ignoredViews.status).toBe(0);
    expect(ignoredProjectJson.status).toBe(0);
    expect(visibleCanonicalFixture.status).toBe(1);
  });

  it("migration runner 幂等且 schema 无 trigger", () => {
    const projectRoot = createTempProjectRoot();

    try {
      const opened = openRouteLedgerDatabase({ projectRoot });

      try {
        applyMigrations(opened.db);
        const migrationCount = opened.db
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get() as { count: number };
        const triggerCount = opened.db
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'")
          .get() as { count: number };

        expect(migrationCount.count).toBe(8);
        expect(triggerCount.count).toBe(0);
      } finally {
        opened.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("upgrades every real migration prefix through 0008 and rejects future histories", () => {
    for (let prefixLength = 0; prefixLength <= SQLITE_MIGRATIONS.length; prefixLength += 1) {
      const db = new BetterSqlite3(":memory:");
      try {
        ensureSchemaMigrationsTable(db);
        for (const migration of SQLITE_MIGRATIONS.slice(0, prefixLength)) {
          db.exec(migration.sql);
          db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
            .run(migration.id, "2026-08-12T00:00:00.000Z");
        }
        applyMigrations(db);
        applyMigrations(db);
        expect(
          (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count
        ).toBe(SQLITE_MIGRATIONS.length);
        expect(
          (db.prepare("PRAGMA table_info(approval_artifacts)").all() as Array<{ name: string }>)
            .map(({ name }) => name)
        ).toContain("authorization_record_json");
      } finally {
        db.close();
      }
    }

    const future = new BetterSqlite3(":memory:");
    try {
      ensureSchemaMigrationsTable(future);
      future.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("9999_future", "2026-08-12T00:00:00.000Z");
      expect(() => applyMigrations(future)).toThrow("Unsupported or non-prefix");
    } finally {
      future.close();
    }
  });

  it("makes the 0008 approval format unreadable to the 0.7.2 column projection", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      applyMigrations(db);
      expect(() => db.prepare(
        "SELECT authorization_provenance_json FROM approval_artifacts"
      ).all()).toThrow("no such column");
    } finally {
      db.close();
    }
  });

  it("0003 migration backfills carried-forward undo fields from retained undo.reassigned events", () => {
    const projectRoot = createTempProjectRoot();
    const databaseDirectory = path.join(projectRoot, ROUTELEDGER_DB_DIRECTORY);
    const databasePath = path.join(databaseDirectory, ROUTELEDGER_DB_FILENAME);
    fs.mkdirSync(databaseDirectory, { recursive: true });
    const db = new BetterSqlite3(databasePath);

    try {
      db.pragma("foreign_keys = ON");
      ensureSchemaMigrationsTable(db);
      db.exec(SQLITE_MIGRATIONS[0]!.sql);
      db.exec(SQLITE_MIGRATIONS[1]!.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("0001_initial_schema", "2026-06-27T00:00:00.000Z");
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("0002_d2_pending_operations_and_approval_artifacts", "2026-06-27T00:01:00.000Z");

      db.prepare(
        `INSERT INTO projects (
          id, schema_version, name, description, status, current_version_id, initial_version_id,
          created_by_id, created_by_type, created_by_display_name, created_at, updated_at,
          archived_at, settings_json
        ) VALUES (
          @id, @schema_version, @name, @description, @status, @current_version_id, @initial_version_id,
          @created_by_id, @created_by_type, @created_by_display_name, @created_at, @updated_at,
          @archived_at, @settings_json
        )`
      ).run({
        id: "project-1",
        schema_version: 2,
        name: "RouteLedger",
        description: "",
        status: "active",
        current_version_id: "version-1",
        initial_version_id: "version-1",
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
        archived_at: null,
        settings_json: "{}"
      });
      db.prepare(
        `INSERT INTO versions (
          id, schema_version, project_id, title, description, state, parent_version_id,
          previous_version_id, next_version_id, "order", is_current, created_by_id,
          created_by_type, created_by_display_name, created_at, updated_at, closed_at, state_reason
        ) VALUES (
          @id, @schema_version, @project_id, @title, @description, @state, @parent_version_id,
          @previous_version_id, @next_version_id, @order, @is_current, @created_by_id,
          @created_by_type, @created_by_display_name, @created_at, @updated_at, @closed_at, @state_reason
        )`
      ).run({
        id: "version-1",
        schema_version: 2,
        project_id: "project-1",
        title: "V1",
        description: "",
        state: "complete",
        parent_version_id: null,
        previous_version_id: null,
        next_version_id: null,
        order: 1,
        is_current: 1,
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
        closed_at: null,
        state_reason: null
      });
      db.prepare(
        `INSERT INTO versions (
          id, schema_version, project_id, title, description, state, parent_version_id,
          previous_version_id, next_version_id, "order", is_current, created_by_id,
          created_by_type, created_by_display_name, created_at, updated_at, closed_at, state_reason
        ) VALUES (
          @id, @schema_version, @project_id, @title, @description, @state, @parent_version_id,
          @previous_version_id, @next_version_id, @order, @is_current, @created_by_id,
          @created_by_type, @created_by_display_name, @created_at, @updated_at, @closed_at, @state_reason
        )`
      ).run({
        id: "version-2",
        schema_version: 2,
        project_id: "project-1",
        title: "V2",
        description: "",
        state: "ready",
        parent_version_id: null,
        previous_version_id: "version-1",
        next_version_id: null,
        order: 2,
        is_current: 0,
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:10:00.000Z",
        updated_at: "2026-06-27T00:10:00.000Z",
        closed_at: null,
        state_reason: null
      });
      db.prepare(
        `INSERT INTO work_items (
          id, schema_version, project_id, title, type, status, origin_version_id,
          active_record_type, active_record_id, created_by_id, created_by_type,
          created_by_display_name, created_at, updated_at, closed_at, summary
        ) VALUES (
          @id, @schema_version, @project_id, @title, @type, @status, @origin_version_id,
          @active_record_type, @active_record_id, @created_by_id, @created_by_type,
          @created_by_display_name, @created_at, @updated_at, @closed_at, @summary
        )`
      ).run({
        id: "work-item-1",
        schema_version: 2,
        project_id: "project-1",
        title: "Carry this undo",
        type: "other",
        status: "active",
        origin_version_id: "version-1",
        active_record_type: "undo",
        active_record_id: "undo-1",
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
        closed_at: null,
        summary: "Carry this undo"
      });
      db.prepare(
        `INSERT INTO todos (
          id, schema_version, project_id, work_item_id, version_id, title, description, status,
          source_type, source_id, created_by_id, created_by_type, created_by_display_name,
          created_at, updated_at, closed_at, close_reason, close_note
        ) VALUES (
          @id, @schema_version, @project_id, @work_item_id, @version_id, @title, @description, @status,
          @source_type, @source_id, @created_by_id, @created_by_type, @created_by_display_name,
          @created_at, @updated_at, @closed_at, @close_reason, @close_note
        )`
      ).run({
        id: "todo-legacy-1",
        schema_version: 2,
        project_id: "project-1",
        work_item_id: "work-item-1",
        version_id: "version-1",
        title: "Legacy converted todo",
        description: "",
        status: "converted",
        source_type: "manual",
        source_id: null,
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
        closed_at: null,
        close_reason: "defer",
        close_note: "converted"
      });
      db.prepare(
        `INSERT INTO undos (
          id, schema_version, project_id, work_item_id, version_id, origin_version_id,
          preferred_resolution_version_id, source_type, source_id, title, description, status,
          reason, trigger_condition, created_by_id, created_by_type, created_by_display_name,
          created_at, updated_at, closed_at, close_reason, close_note
        ) VALUES (
          @id, @schema_version, @project_id, @work_item_id, @version_id, @origin_version_id,
          @preferred_resolution_version_id, @source_type, @source_id, @title, @description, @status,
          @reason, @trigger_condition, @created_by_id, @created_by_type, @created_by_display_name,
          @created_at, @updated_at, @closed_at, @close_reason, @close_note
        )`
      ).run({
        id: "undo-1",
        schema_version: 2,
        project_id: "project-1",
        work_item_id: "work-item-1",
        version_id: "version-1",
        origin_version_id: "version-1",
        preferred_resolution_version_id: "version-2",
        source_type: "manual",
        source_id: null,
        title: "Carry this undo",
        description: "",
        status: "wait",
        reason: "defer downstream",
        trigger_condition: null,
        created_by_id: TEST_ACTOR.id,
        created_by_type: TEST_ACTOR.type,
        created_by_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T02:00:00.000Z",
        closed_at: null,
        close_reason: null,
        close_note: null
      });
      db.prepare(
        `INSERT INTO transition_events (
          id, schema_version, project_id, operation_id, operation_seq, target_type, target_id,
          event_type, from_state, to_state, note, actor_id, actor_type, actor_display_name,
          created_at, metadata_json
        ) VALUES (
          @id, @schema_version, @project_id, @operation_id, @operation_seq, @target_type, @target_id,
          @event_type, @from_state, @to_state, @note, @actor_id, @actor_type, @actor_display_name,
          @created_at, @metadata_json
        )`
      ).run({
        id: "event-undo-reassigned-1",
        schema_version: 2,
        project_id: "project-1",
        operation_id: "op-undo-reassigned-1",
        operation_seq: 1,
        target_type: "undo",
        target_id: "undo-1",
        event_type: "undo.reassigned",
        from_state: "wait",
        to_state: "wait",
        note: "carry to v2",
        actor_id: TEST_ACTOR.id,
        actor_type: TEST_ACTOR.type,
        actor_display_name: TEST_ACTOR.displayName,
        created_at: "2026-06-27T02:00:00.000Z",
        metadata_json: JSON.stringify({
          reason: "defer downstream",
          previousPreferredResolutionVersionId: "version-1",
          nextPreferredResolutionVersionId: "version-2",
          carriedForwardAt: "2026-06-27T02:00:00.000Z",
          carriedForwardToVersionId: "version-2"
        })
      });

      applyMigrations(db);

      const row = db
        .prepare<
          [],
          {
            carried_forward_at: string | null;
            carried_forward_to_version_id: string | null;
          }
        >(
          `SELECT carried_forward_at, carried_forward_to_version_id
           FROM undos
           WHERE id = 'undo-1'`
        )
        .get();

      expect(row).toEqual({
        carried_forward_at: "2026-06-27T02:00:00.000Z",
        carried_forward_to_version_id: "version-2"
      });
      applyMigrations(db);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
            count: number;
          }
        ).count
      ).toBe(8);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM todos WHERE id = 'todo-legacy-1'").get() as {
            count: number;
          }
        ).count
      ).toBe(1);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM transition_events WHERE id = 'event-undo-reassigned-1'").get() as {
            count: number;
          }
        ).count
      ).toBe(1);
      expect(
        (
          db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_items'").get() as {
            sql: string;
          }
        ).sql
      ).toContain("'deferred'");
    } finally {
      db.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("0004 migration rolls back the full rebuild when a late statement fails", () => {
    const db = new BetterSqlite3(":memory:");

    try {
      db.pragma("foreign_keys = ON");
      ensureSchemaMigrationsTable(db);

      for (const migration of SQLITE_MIGRATIONS.slice(0, 3)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, "2026-06-27T00:00:00.000Z");
      }

      db.exec("CREATE TABLE constraints (id TEXT PRIMARY KEY)");

      expect(() => applyMigrations(db)).toThrow();

      const workItemsSql = (
        db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_items'"
        ).get() as { sql: string }
      ).sql;
      const migrationCount = (
        db.prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?"
        ).get(SQLITE_MIGRATIONS[3]!.id) as { count: number }
      ).count;
      const renamedTableCount = (
        db.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('todos_old', 'undos_old', 'work_items_old')"
        ).get() as { count: number }
      ).count;

      expect(workItemsSql).not.toContain("'deferred'");
      expect(migrationCount).toBe(0);
      expect(renamedTableCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("0005 migration preserves legacy project pointers while making initial_version_id nullable", () => {
    const db = new BetterSqlite3(":memory:");

    try {
      ensureSchemaMigrationsTable(db);
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          current_version_id TEXT,
          initial_version_id TEXT NOT NULL,
          created_by_id TEXT NOT NULL,
          created_by_type TEXT NOT NULL,
          created_by_display_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          settings_json TEXT NOT NULL
        );
      `);
      for (const migration of SQLITE_MIGRATIONS.slice(0, 4)) {
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, "2026-06-27T00:00:00.000Z");
      }
      db.prepare(
        `INSERT INTO projects (
          id, schema_version, name, description, status, current_version_id,
          initial_version_id, created_by_id, created_by_type, created_by_display_name,
          created_at, updated_at, archived_at, settings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-project",
        1,
        "Legacy Project",
        "",
        "active",
        "legacy-version",
        "legacy-version",
        TEST_ACTOR.id,
        TEST_ACTOR.type,
        TEST_ACTOR.displayName,
        "2026-06-27T00:00:00.000Z",
        "2026-06-27T00:00:00.000Z",
        null,
        "{}"
      );

      db.exec(SQLITE_MIGRATIONS[4]!.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("0005_project_root", "2026-06-27T00:01:00.000Z");

      expect(
        db.prepare("SELECT current_version_id, initial_version_id FROM projects WHERE id = ?")
          .get("legacy-project")
      ).toEqual({
        current_version_id: "legacy-version",
        initial_version_id: "legacy-version"
      });
      const initialColumn = (
        db.prepare("PRAGMA table_info(projects)").all() as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "initial_version_id");
      expect(initialColumn?.notnull).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
          .get("0005_project_root")
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("0006 preserves historical approvals and admits advance_to_version rows", () => {
    const db = new BetterSqlite3(":memory:");

    try {
      db.pragma("foreign_keys = ON");
      ensureSchemaMigrationsTable(db);
      for (const migration of SQLITE_MIGRATIONS.slice(0, 5)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, "2026-06-27T00:00:00.000Z");
      }
      db.prepare(
        `INSERT INTO projects (
          id, schema_version, name, description, status, current_version_id,
          initial_version_id, created_by_id, created_by_type, created_by_display_name,
          created_at, updated_at, archived_at, settings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "project-1",
        1,
        "Legacy approvals",
        "",
        "active",
        null,
        null,
        TEST_ACTOR.id,
        TEST_ACTOR.type,
        TEST_ACTOR.displayName,
        "2026-06-27T00:00:00.000Z",
        "2026-06-27T00:00:00.000Z",
        null,
        "{}"
      );
      const insertPending = db.prepare(
        `INSERT INTO pending_operations (
          id, schema_version, project_id, action_type, target_id, status, reason,
          gate_snapshot_json, digest_json, payload_json, created_by_id,
          created_by_type, created_by_display_name, created_at, updated_at,
          committed_at, rejected_at, rejection_reason, approval_artifact_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertApproval = db.prepare(
        `INSERT INTO approval_artifacts (
          id, schema_version, project_id, pending_operation_id, action_type,
          target_id, digest_json, status, approver_id, approver_type,
          approver_display_name, decision_ref, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertPending.run(
        "pending-start",
        1,
        "project-1",
        "start_version",
        "version-1",
        "pending",
        "historical start",
        "{}",
        "{}",
        "{}",
        TEST_ACTOR.id,
        TEST_ACTOR.type,
        TEST_ACTOR.displayName,
        "2026-06-27T00:01:00.000Z",
        "2026-06-27T00:01:00.000Z",
        null,
        null,
        null,
        "approval-start"
      );
      insertApproval.run(
        "approval-start",
        1,
        "project-1",
        "pending-start",
        "start_version",
        "version-1",
        "{}",
        "approved",
        "user-1",
        "user",
        "owner",
        "decision://start",
        "2026-06-27T00:02:00.000Z",
        "2026-06-28T00:02:00.000Z",
        null
      );

      applyMigrations(db);

      expect(
        db.prepare("SELECT action_type FROM pending_operations WHERE id = ?")
          .get("pending-start")
      ).toEqual({ action_type: "start_version" });
      expect(
        db.prepare("SELECT action_type FROM approval_artifacts WHERE id = ?")
          .get("approval-start")
      ).toEqual({ action_type: "start_version" });

      insertPending.run(
        "pending-advance",
        1,
        "project-1",
        "advance_to_version",
        "version-2",
        "pending",
        "advance",
        "{}",
        "{}",
        "{}",
        TEST_ACTOR.id,
        TEST_ACTOR.type,
        TEST_ACTOR.displayName,
        "2026-06-27T00:03:00.000Z",
        "2026-06-27T00:03:00.000Z",
        null,
        null,
        null,
        "approval-advance"
      );
      insertApproval.run(
        "approval-advance",
        1,
        "project-1",
        "pending-advance",
        "advance_to_version",
        "version-2",
        "{}",
        "approved",
        "user-1",
        "user",
        "owner",
        "decision://advance",
        "2026-06-27T00:04:00.000Z",
        "2026-06-28T00:04:00.000Z",
        null
      );

      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(
        db.prepare("SELECT action_type FROM approval_artifacts WHERE id = ?")
          .get("approval-advance")
      ).toEqual({ action_type: "advance_to_version" });
    } finally {
      db.close();
    }
  });

  it("create_project 持久化后可重读 Project + initial Version + TransitionEvent", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const aggregate = createEmptyAggregate();

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded).not.toBeNull();
      expect(loaded?.project.currentVersionId).toBe(aggregate.project.currentVersionId);
      expect(loaded?.versions).toHaveLength(1);
      expect(loaded?.versions[0]?.state).toBe("wait");
      expect(loaded?.events.map((event) => event.eventType)).toEqual([
        "project.created",
        "version.created"
      ]);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Project 逻辑根可在零 Version、零 current 状态下 round-trip", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const service = new RouteLedgerService({
        storage: adapter,
        deps: createTestDependencies()
      });
      const created = await service.initProject({
        name: "Empty Route",
        contentLocale: "zh-CN",
        firstVersion: null,
        actor: TEST_ACTOR
      });
      const loaded = await adapter.loadProjectAggregate(created.project.id);

      expect(loaded).toMatchObject({
        project: { currentVersionId: null, initialVersionId: null },
        versions: [],
        todos: []
      });
      expect(loaded?.events.map((event) => event.eventType)).toEqual(["project.created"]);
      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("DeferredItem and Constraint round-trip with active pointer and transition targets", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const deferredCreation = createDeferred({
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: created.firstVersion!.id,
        title: "Persist deferred semantics",
        reason: "review after persistence lands",
        actor: TEST_ACTOR,
        deps
      });
      const constraintCreation = createConstraint({
        projectId: created.project.id,
        rule: "Keep persistence atomic",
        rationale: "Partial replacement would lose history",
        scope: {
          type: "version",
          versionId: created.firstVersion!.id
        },
        actor: TEST_ACTOR,
        deps
      });
      const projectConstraintCreation = createConstraint({
        projectId: created.project.id,
        rule: "Keep project semantics simple",
        rationale: "Agents must understand the model",
        scope: {
          type: "project"
        },
        actor: TEST_ACTOR,
        deps
      });
      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [created.firstVersion!],
        workItems: [deferredCreation.workItem],
        todos: [],
        undos: [],
        deferredItems: [deferredCreation.deferred],
        constraints: [
          constraintCreation.constraint,
          projectConstraintCreation.constraint
        ],
        assets: [],
        events: created.events
          .concat(deferredCreation.events)
          .concat(constraintCreation.events)
          .concat(projectConstraintCreation.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(created.project.id);

      expect(loaded?.deferredItems).toEqual(aggregate.deferredItems);
      expect(loaded?.constraints).toEqual(aggregate.constraints);
      expect(loaded?.events.map((event) => event.targetType)).toEqual(
        expect.arrayContaining(["deferred_item", "constraint"])
      );
      expect(() =>
        validateWorkItemActive(
          loaded!.workItems[0]!,
          loaded!.todos,
          loaded!.undos,
          loaded!.deferredItems
        )
      ).not.toThrow();

      const updatedAggregate: ProjectAggregateSnapshot = {
        ...loaded!,
        deferredItems: loaded!.deferredItems.map((deferredItem) => ({
          ...deferredItem,
          title: "Persist deferred semantics v2",
          reason: "review after the full persistence pass",
          updatedAt: "2026-06-27T02:00:00.000Z"
        })),
        constraints: loaded!.constraints.map((constraint) => ({
          ...constraint,
          rule: `${constraint.rule} v2`,
          rationale: `${constraint.rationale} updated`,
          updatedAt: "2026-06-27T02:00:00.000Z"
        }))
      };

      await adapter.saveProjectAggregate(updatedAggregate);
      const updated = await adapter.loadProjectAggregate(created.project.id);

      expect(updated?.deferredItems).toHaveLength(1);
      expect(updated?.deferredItems[0]?.id).toBe(deferredCreation.deferred.id);
      expect(updated?.deferredItems[0]?.title).toBe(
        "Persist deferred semantics v2"
      );
      expect(updated?.constraints).toHaveLength(2);
      expect(updated?.constraints.map((constraint) => constraint.scope)).toEqual(
        expect.arrayContaining([
          { type: "project" },
          { type: "version", versionId: created.firstVersion!.id }
        ])
      );

      await expect(
        adapter.saveProjectAggregate({
          ...updated!,
          constraints: updated!.constraints.slice(1)
        })
      ).rejects.toThrow(/missing persisted constraints/);
      await expect(
        adapter.saveProjectAggregate({
          ...updated!,
          workItems: updated!.workItems.map((workItem) => ({
            ...workItem,
            status: "closed" as const,
            activeRecordType: null,
            activeRecordId: null,
            closedAt: "2026-06-27T03:00:00.000Z"
          })),
          deferredItems: []
        })
      ).rejects.toThrow(/missing persisted deferred items/);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("round-trips activated/resolved DeferredItem and retired Constraint, and rejects invalid matrices atomically", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "Lifecycle baseline",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const activatedCreation = createDeferred({
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: created.firstVersion!.id,
        title: "Activate later",
        reason: "activation test",
        actor: TEST_ACTOR,
        deps
      });
      const activated = activateDeferred({
        deferred: activatedCreation.deferred,
        workItem: activatedCreation.workItem,
        versionId: created.firstVersion!.id,
        reason: "activate now",
        note: "activation evidence",
        actor: TEST_ACTOR,
        deps
      });
      const resolvedCreation = createDeferred({
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: created.firstVersion!.id,
        title: "Resolve later",
        reason: "resolution test",
        actor: TEST_ACTOR,
        deps
      });
      const resolved = resolveDeferred({
        deferred: resolvedCreation.deferred,
        workItem: resolvedCreation.workItem,
        outcome: "superseded",
        reason: "covered elsewhere",
        note: "resolution evidence",
        actor: TEST_ACTOR,
        deps
      });
      const activeConstraint = createConstraint({
        projectId: created.project.id,
        rule: "Active rule",
        rationale: "active lifecycle test",
        scope: { type: "project" },
        actor: TEST_ACTOR,
        deps
      });
      const retiringConstraint = createConstraint({
        projectId: created.project.id,
        rule: "Retire rule",
        rationale: "retired lifecycle test",
        scope: {
          type: "version",
          versionId: created.firstVersion!.id
        },
        actor: TEST_ACTOR,
        deps
      });
      const retiredConstraint = retireConstraint({
        constraint: retiringConstraint.constraint,
        reason: "superseded",
        note: "retirement evidence",
        actor: TEST_ACTOR,
        deps
      });
      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [created.firstVersion!],
        workItems: [activated.workItem, resolved.workItem],
        todos: [activated.todo],
        undos: [],
        deferredItems: [activated.deferred, resolved.deferred],
        constraints: [
          activeConstraint.constraint,
          retiredConstraint.constraint
        ],
        assets: [],
        events: created.events
          .concat(activatedCreation.events)
          .concat(activated.events)
          .concat(resolvedCreation.events)
          .concat(resolved.events)
          .concat(activeConstraint.events)
          .concat(retiringConstraint.events)
          .concat(retiredConstraint.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(created.project.id);

      expect(sortById(loaded!.deferredItems)).toEqual(
        sortById(aggregate.deferredItems)
      );
      expect(sortById(loaded!.constraints)).toEqual(
        sortById(aggregate.constraints)
      );
      expect(loaded?.deferredItems.map((item) => item.status)).toEqual(
        expect.arrayContaining(["activated", "resolved"])
      );
      expect(loaded?.constraints.map((item) => item.status)).toEqual(
        expect.arrayContaining(["active", "retired"])
      );

      const invalidMutations: Array<
        (snapshot: ProjectAggregateSnapshot) => void
      > = [
        (snapshot) => {
          snapshot.deferredItems[0]!.title = " ";
        },
        (snapshot) => {
          snapshot.deferredItems[0]!.reason = "";
        },
        (snapshot) => {
          (snapshot.deferredItems[0] as any).status = "unknown";
        },
        (snapshot) => {
          (snapshot.deferredItems[0] as any).resolutionOutcome = "unknown";
        },
        (snapshot) => {
          (snapshot.deferredItems[0] as any).reviewTrigger = 42;
        },
        (snapshot) => {
          (snapshot.deferredItems[0] as any).createdBy = {
            id: "",
            type: "robot"
          };
        },
        (snapshot) => {
          snapshot.deferredItems[0]!.updatedAt = "";
        },
        (snapshot) => {
          snapshot.deferredItems[0]!.activatedTodoId = null;
        },
        (snapshot) => {
          snapshot.deferredItems[1]!.resolutionOutcome = "rejected";
          snapshot.deferredItems[1]!.decisionRef = null;
        },
        (snapshot) => {
          snapshot.constraints[0]!.rule = "";
        },
        (snapshot) => {
          snapshot.constraints[0]!.rationale = " ";
        },
        (snapshot) => {
          (snapshot.constraints[0] as any).scope = {
            type: "version",
            versionId: ""
          };
        },
        (snapshot) => {
          (snapshot.constraints[0] as any).status = "unknown";
        },
        (snapshot) => {
          (snapshot.constraints[0] as any).retireNote = 42;
        },
        (snapshot) => {
          snapshot.constraints[0]!.retiredAt =
            "2026-06-27T03:00:00.000Z";
        },
        (snapshot) => {
          snapshot.constraints[1]!.retireReason = null;
        }
      ];

      for (const mutate of invalidMutations) {
        const invalid = structuredClone(aggregate);
        invalid.project.name = "partial write must rollback";
        mutate(invalid);

        await expect(adapter.saveProjectAggregate(invalid)).rejects.toThrow();
        const persisted = await adapter.loadProjectAggregate(created.project.id);
        expect(persisted?.project.name).toBe("Lifecycle baseline");
        expect(sortById(persisted!.deferredItems)).toEqual(
          sortById(aggregate.deferredItems)
        );
        expect(sortById(persisted!.constraints)).toEqual(
          sortById(aggregate.constraints)
        );
      }

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("persists Deferred/Constraint application commands through a real SQLite reload", async () => {
    const projectRoot = createTempProjectRoot();
    let adapter: SQLiteStorageAdapter | null = null;
    let reloadedAdapter: SQLiteStorageAdapter | null = null;

    try {
      adapter = new SQLiteStorageAdapter({ projectRoot });
      const service = new RouteLedgerService({
        storage: adapter,
        deps: createTestDependencies()
      });
      const created = await service.initProject({
        contentLocale: "en",
        name: "Application command persistence",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });
      const snapshot = await adapter.loadProjectAggregate(created.project.id);
      expect(snapshot).not.toBeNull();
      const reviewVersion = createVersionFixture({
        id: "application-review-version",
        projectId: created.project.id,
        title: "Application review version",
        state: "wait",
        order: 2,
        previousVersionId: created.firstVersion!.id,
        nextVersionId: null,
        isCurrent: false
      });
      snapshot!.versions = [
        {
          ...snapshot!.versions[0]!,
          nextVersionId: reviewVersion.id
        },
        reviewVersion
      ];
      await adapter.saveProjectAggregate(snapshot!);

      const deferred = await service.deferWork({
        mode: "new",
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: reviewVersion.id,
        title: "Persist through application command",
        reason: "Review in the downstream version",
        actor: TEST_ACTOR
      });
      const constraint = await service.recordConstraint({
        projectId: created.project.id,
        rule: "Persist application constraint",
        rationale: "Verify RouteLedgerService plus SQLite",
        scope: {
          type: "version",
          versionId: reviewVersion.id
        },
        actor: TEST_ACTOR
      });
      await service.retireConstraint({
        projectId: created.project.id,
        constraintId: constraint.constraint.id,
        reason: "Constraint superseded",
        note: "Retire through the application command",
        actor: TEST_ACTOR
      });
      const activated = await service.reviewDeferred({
        action: "activate",
        projectId: created.project.id,
        deferredId: deferred.deferred.id,
        targetVersionId: reviewVersion.id,
        reason: "Activate through the application command",
        actor: TEST_ACTOR
      });
      if (activated.action !== "activate") {
        throw new Error("expected activate review result");
      }

      adapter.close();
      adapter = null;
      reloadedAdapter = new SQLiteStorageAdapter({ projectRoot });
      const reloaded = await reloadedAdapter.loadProjectAggregate(
        created.project.id
      );

      expect(reloaded?.deferredItems).toContainEqual(activated.deferred);
      expect(reloaded?.todos).toContainEqual(activated.todo);
      expect(reloaded?.workItems).toContainEqual(activated.workItem);
      expect(
        reloaded?.constraints.find(
          (item) => item.id === constraint.constraint.id
        )
      ).toMatchObject({
        status: "retired",
        retireReason: "Constraint superseded",
        retireNote: "Retire through the application command"
      });
    } finally {
      adapter?.close();
      reloadedAdapter?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Version lifecycle 持久化重读一致", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const prepared = prepareVersion(created.firstVersion!, { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_prepare" }, deps);
      const startGate = evaluateStartGate({
        targetVersion: prepared.version,
        currentVersionTodos: [],
        dueUndos: []
      });
      const started = startVersion(prepared.version, startGate, { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_start" }, deps);
      const completed = markVersionComplete(started.version, { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_complete" }, deps);
      const closeGate = evaluateCloseGate({
        version: completed.version,
        todos: [],
        undos: [],
        residualAudit: [
          {
            kind: "debt",
            summary: "no residual work",
            destination: "close"
          }
        ]
      });
      const closed = closeVersion(completed.version, closeGate, { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_close" }, deps);

      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [closed.version],
        workItems: [],
        todos: [],
        undos: [],
        deferredItems: [],
        constraints: [],
        assets: [],
        events: created.events
          .concat(prepared.events)
          .concat(started.events)
          .concat(completed.events)
          .concat(closed.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded?.versions[0]?.state).toBe("close");
      expect(loaded?.versions[0]?.closedAt).toBe("2026-06-27T00:00:00.000Z");
      expect(loaded?.events.filter((event) => event.targetType === "version")).toHaveLength(5);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("set_current_version 多对象重读一致", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const prepared = prepareVersion(created.firstVersion!, { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_prepare" }, deps);
      const started = startVersion(
        prepared.version,
        evaluateStartGate({
          targetVersion: prepared.version,
          currentVersionTodos: [],
          dueUndos: []
        }),
        { actor: TEST_ACTOR, now: deps.clock.now(), operationId: "op_start" },
        deps
      );

      const nextVersion = createVersionFixture({
        id: "version-2",
        projectId: created.project.id,
        state: "ready",
        isCurrent: false,
        order: 2
      });

      const switched = setCurrentVersion({
        project: created.project,
        currentVersion: started.version,
        nextVersion,
        actor: TEST_ACTOR,
        deps
      });

      const aggregate: ProjectAggregateSnapshot = {
        project: switched.project,
        versions: [switched.currentVersion!, switched.nextVersion],
        workItems: [],
        todos: [],
        undos: [],
        deferredItems: [],
        constraints: [],
        assets: [],
        events: created.events
          .concat(prepared.events)
          .concat(started.events)
          .concat(switched.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded?.project.currentVersionId).toBe("version-2");
      expect(loaded?.versions.find((version) => version.id === created.firstVersion!.id)?.state).toBe(
        "suspend"
      );
      expect(loaded?.versions.find((version) => version.id === "version-2")?.isCurrent).toBe(true);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("todo/undo/WorkItem active round trip 与 load 后不变量可验证", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const todoCreation = createTodo({
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        title: "Implement persistence",
        actor: TEST_ACTOR,
        deps
      });

      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [created.firstVersion!],
        workItems: [todoCreation.workItem],
        todos: [todoCreation.todo],
        undos: [],
        deferredItems: [],
        constraints: [],
        assets: [],
        events: created.events.concat(todoCreation.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded?.workItems[0]?.activeRecordType).toBe("todo");
      expect(loaded?.workItems[0]?.activeRecordId).toBe(todoCreation.todo.id);
      expect(() =>
        validateWorkItemActive(loaded!.workItems[0]!, loaded!.todos, loaded!.undos)
      ).not.toThrow();
      expect(
        loaded?.versions.filter((version) => version.isCurrent).map((version) => version.id)
      ).toEqual([created.firstVersion!.id]);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Asset path/history/work_item_ids round trip", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const todoCreation = createTodo({
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        title: "Link doc",
        actor: TEST_ACTOR,
        deps
      });
      const assetCreation = createAsset({
        projectId: created.project.id,
        workItemIds: [todoCreation.workItem.id],
        pathBase: "project_root",
        relativePath: "docs/route.md",
        actor: TEST_ACTOR,
        deps
      });
      const updatedAsset = {
        ...assetCreation.asset,
        relativePath: "docs/route-v2.md",
        updatedAt: "2026-06-27T01:00:00.000Z",
        pathHistory: assetCreation.asset.pathHistory.concat({
          pathBase: "project_root" as const,
          relativePath: "docs/route-v2.md",
          recordedAt: "2026-06-27T01:00:00.000Z"
        })
      };

      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [created.firstVersion!],
        workItems: [todoCreation.workItem],
        todos: [todoCreation.todo],
        undos: [],
        deferredItems: [],
        constraints: [],
        assets: [updatedAsset],
        events: created.events.concat(todoCreation.events, assetCreation.events),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded?.assets[0]?.workItemIds).toEqual([todoCreation.workItem.id]);
      expect(loaded?.assets[0]?.relativePath).toBe("docs/route-v2.md");
      expect(loaded?.assets[0]?.pathHistory).toHaveLength(2);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("saveProjectAggregate 失败时回滚", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const baseline = createEmptyAggregate();
      await adapter.saveProjectAggregate(baseline);

      const invalidSnapshot: ProjectAggregateSnapshot = {
        ...baseline,
        project: {
          ...baseline.project,
          name: "Should rollback"
        },
        todos: [
          {
            id: "todo-bad",
            projectId: baseline.project.id,
            workItemId: "missing-work-item",
            versionId: baseline.project.currentVersionId!,
            title: "Broken row",
            description: "",
            status: "wait",
            sourceType: "manual",
            sourceId: null,
            createdBy: TEST_ACTOR,
            createdAt: baseline.project.createdAt,
            updatedAt: baseline.project.updatedAt,
            closedAt: null,
            closeReason: null,
            closeNote: null
          }
        ]
      };

      await expect(adapter.saveProjectAggregate(invalidSnapshot)).rejects.toThrow();

      const loaded = await adapter.loadProjectAggregate(baseline.project.id);
      expect(loaded?.project.name).toBe("RouteLedger");
      expect(loaded?.todos).toHaveLength(0);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("saveProjectAggregate 第二次保存完整 aggregate 时保留历史 todo/undo/event/asset", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const originalAggregate = createAggregateWithRetainedHistory();
      await adapter.saveProjectAggregate(originalAggregate);

      const loaded = await adapter.loadProjectAggregate(originalAggregate.project.id);
      expect(loaded).not.toBeNull();

      const updatedAggregate: ProjectAggregateSnapshot = {
        ...loaded!,
        project: {
          ...loaded!.project,
          description: "updated without dropping history"
        }
      };

      await adapter.saveProjectAggregate(updatedAggregate);
      const reloaded = await adapter.loadProjectAggregate(originalAggregate.project.id);

      expect(reloaded?.project.description).toBe("updated without dropping history");
      expect(reloaded?.todos).toHaveLength(2);
      expect(reloaded?.todos.filter((todo) => todo.status === "converted")).toHaveLength(1);
      expect(reloaded?.undos).toHaveLength(1);
      expect(reloaded?.undos[0]?.status).toBe("converted");
      expect(reloaded?.assets).toHaveLength(1);
      expect(reloaded?.events).toHaveLength(originalAggregate.events.length);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("saveProjectAggregate 拒绝不完整 aggregate，避免静默删除已持久化历史", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const originalAggregate = createAggregateWithRetainedHistory();
      await adapter.saveProjectAggregate(originalAggregate);

      const incompleteAggregate: ProjectAggregateSnapshot = {
        ...originalAggregate,
        todos: originalAggregate.todos.filter((todo) => todo.status !== "converted"),
        assets: []
      };

      await expect(adapter.saveProjectAggregate(incompleteAggregate)).rejects.toThrow(
        /complete aggregate snapshot|missing persisted/
      );

      const loaded = await adapter.loadProjectAggregate(originalAggregate.project.id);
      expect(loaded?.todos).toHaveLength(2);
      expect(loaded?.assets).toHaveLength(1);
      expect(loaded?.events).toHaveLength(originalAggregate.events.length);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("saveProjectAggregate 在写入前拒绝 current version 与 active 指针等 aggregate 不变量错误", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const baseline = createAggregateWithRetainedHistory();

      const invalidCurrentAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        project: {
          ...baseline.project,
          currentVersionId: "missing-version"
        }
      };

      await expect(adapter.saveProjectAggregate(invalidCurrentAggregate)).rejects.toThrow(
        /currentVersionId/
      );

      const invalidActiveAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        workItems: baseline.workItems.map((workItem) => ({
          ...workItem,
          activeRecordType: "todo" as const,
          activeRecordId: baseline.todos[0]!.id
        }))
      };

      await expect(adapter.saveProjectAggregate(invalidActiveAggregate)).rejects.toThrow(
        /active todo|active 指针/
      );

      const invalidUndoAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        undos: baseline.undos.map((undo) => ({
          ...undo,
          preferredResolutionVersionId: "missing-version"
        }))
      };

      await expect(adapter.saveProjectAggregate(invalidUndoAggregate)).rejects.toThrow(
        /preferred_resolution_version/
      );

      const invalidEventAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        events: baseline.events.map((event, index) =>
          index === baseline.events.length - 1
            ? {
                ...event,
                targetType: "asset" as const,
                targetId: "missing-asset"
              }
            : event
        )
      };

      await expect(adapter.saveProjectAggregate(invalidEventAggregate)).rejects.toThrow(
        /missing asset/
      );

      const deps = createTestDependencies();
      const deferredCreation = createDeferred({
        projectId: baseline.project.id,
        originVersionId: baseline.project.currentVersionId!,
        targetReviewVersionId: baseline.project.currentVersionId!,
        title: "Invalid active deferred",
        reason: "validator test",
        actor: TEST_ACTOR,
        deps
      });
      const invalidDeferredActiveAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        workItems: [...baseline.workItems, deferredCreation.workItem]
      };

      await expect(
        adapter.saveProjectAggregate(invalidDeferredActiveAggregate)
      ).rejects.toThrow(/active Deferred/);

      const constraintCreation = createConstraint({
        projectId: baseline.project.id,
        rule: "Invalid version scope",
        rationale: "validator test",
        scope: {
          type: "version",
          versionId: baseline.project.currentVersionId!
        },
        actor: TEST_ACTOR,
        deps
      });
      const invalidConstraintAggregate: ProjectAggregateSnapshot = {
        ...baseline,
        constraints: [
          {
            ...constraintCreation.constraint,
            scope: {
              type: "version",
              versionId: "missing-version"
            }
          }
        ]
      };

      await expect(adapter.saveProjectAggregate(invalidConstraintAggregate)).rejects.toThrow(
        /scope version/
      );

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("operation_id 查询按 operation_seq 排序", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const deps = createTestDependencies();
      const created = createProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "" },
        actor: TEST_ACTOR,
        deps
      });
      const todo = createTodoFixture({
        id: "todo-query",
        workItemId: "work-item-query",
        projectId: created.project.id,
        versionId: created.firstVersion!.id
      });
      const undo = createUndoFixture({
        id: "undo-query",
        workItemId: "work-item-query",
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        originVersionId: created.firstVersion!.id,
        preferredResolutionVersionId: created.firstVersion!.id
      });
      const workItem = createWorkItemFixture({
        id: "work-item-query",
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        activeRecordType: "undo",
        activeRecordId: undo.id
      });      const convertedEvents = createTransitionEvents(
        [
          {
            targetType: "todo" as const,
            targetId: todo.id,
            eventType: "todo.converted_to_undo",
            fromState: "wait",
            toState: "converted",
            note: "query test"
          },
          {
            targetType: "undo" as const,
            targetId: undo.id,
            eventType: "undo.created",
            toState: "wait",
            note: "query test"
          },
          {
            targetType: "work_item" as const,
            targetId: workItem.id,
            eventType: "work_item.active_changed",
            fromState: "todo",
            toState: "undo",
            note: "query test"
          }
        ],
        {
          projectId: created.project.id,
          operationId: deps.idGenerator.nextId(),
          actor: TEST_ACTOR,
          now: "2026-06-27T00:00:00.000Z"
        },
        deps.idGenerator
      );

      const aggregate: ProjectAggregateSnapshot = {
        project: created.project,
        versions: [created.firstVersion!],
        workItems: [workItem],
        todos: [{ ...todo, status: "converted" }],
        undos: [undo],
        deferredItems: [],
        constraints: [],
        assets: [],
        events: created.events.concat(convertedEvents),
        pendingOperations: [],
        approvalArtifacts: []
      };

      await adapter.saveProjectAggregate(aggregate);
      const events = await adapter.listTransitionEventsByOperationId(convertedEvents[0]!.operationId);

      expect(events.map((event) => event.eventType)).toEqual([
        "todo.converted_to_undo",
        "undo.created",
        "work_item.active_changed"
      ]);
      expect(events.map((event) => event.operationSeq)).toEqual([1, 2, 3]);

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("pending operation / approval artifact 持久化后可重读", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const service = new RouteLedgerService({
        storage: adapter,
        deps: createTestDependencies()
      });
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        actor: TEST_ACTOR
      });

      const proposal = await service.proposeL3Operation({
        projectId: created.project.id,
        actionType: "start_version",
        targetId: created.firstVersion!.id,
        reason: "start current version",
        actor: TEST_ACTOR
      });

      const artifact = await service.approveL3Operation({
        projectId: created.project.id,
        pendingOperationId: proposal.id,
        approver: {
          id: "user-1",
          type: "user",
          displayName: "owner"
        },
        actor: TEST_ACTOR
      });

      const advanceProposal = await service.proposeL3Operation({
        projectId: created.project.id,
        actionType: "advance_to_version",
        targetId: created.firstVersion!.id,
        reason: "exercise persisted advance action type",
        payload: { fromVersionId: created.firstVersion!.id },
        actor: TEST_ACTOR
      });
      const advanceArtifact = await service.approveL3Operation({
        projectId: created.project.id,
        pendingOperationId: advanceProposal.id,
        approver: {
          id: "user-1",
          type: "user",
          displayName: "owner"
        },
        actor: TEST_ACTOR
      });

      const loaded = await adapter.loadProjectAggregate(created.project.id);

      expect(loaded?.pendingOperations).toHaveLength(2);
      expect(loaded?.pendingOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: proposal.id, digest: proposal.digest }),
          expect.objectContaining({
            id: advanceProposal.id,
            actionType: "advance_to_version",
            payload: { fromVersionId: created.firstVersion!.id }
          })
        ])
      );
      expect(loaded?.approvalArtifacts).toHaveLength(2);
      expect(loaded?.approvalArtifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: artifact.id }),
          expect.objectContaining({
            id: advanceArtifact.id,
            actionType: "advance_to_version"
          })
        ])
      );

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("shutdown_version 与 undo carried-forward 字段可 round-trip", async () => {
    const projectRoot = createTempProjectRoot();
    const adapter = new SQLiteStorageAdapter({ projectRoot });

    try {
      const aggregate = createEmptyAggregate();
      const currentVersion = aggregate.versions[0]!;
      const downstreamVersion = createVersionFixture({
        id: "version-2",
        projectId: aggregate.project.id,
        title: "Version 2",
        order: 2,
        previousVersionId: currentVersion.id
      });
      const linkedCurrentVersion = {
        ...currentVersion,
        nextVersionId: downstreamVersion.id
      };
      const workItem = createWorkItemFixture({
        projectId: aggregate.project.id,
        originVersionId: currentVersion.id,
        activeRecordType: "undo",
        activeRecordId: "undo-1"
      });
      const undo = createUndoFixture({
        projectId: aggregate.project.id,
        workItemId: workItem.id,
        versionId: currentVersion.id,
        originVersionId: currentVersion.id,
        preferredResolutionVersionId: downstreamVersion.id,
        carriedForwardAt: "2026-06-27T02:00:00.000Z",
        carriedForwardToVersionId: downstreamVersion.id
      });
      const digest = {
        algorithm: "sha256" as const,
        value: "digest-shutdown",
        payload: {
          projectId: aggregate.project.id,
          actionType: "shutdown_version",
          targetId: currentVersion.id
        }
      };
      const pendingOperation: ProjectAggregateSnapshot["pendingOperations"][number] = {
        id: "pending-shutdown-1",
        projectId: aggregate.project.id,
        actionType: "shutdown_version",
        targetId: currentVersion.id,
        status: "pending",
        reason: "emergency_stop",
        gateSnapshot: {
          kind: "shutdown",
          evaluatedAt: "2026-06-27T03:00:00.000Z",
          allowed: true,
          blockers: [],
          forced: true,
          stateReason: "shutdown:emergency_stop",
          ordinaryCloseGate: {
            allowed: false,
            blockers: [],
            unresolvedTodoIds: [],
            unresolvedUndoIds: [undo.id],
            unresolvedDeferredIds: [],
            blockedConstraintIds: []
          }
        },
        digest,
        payload: {
          currentVersionId: currentVersion.id,
          shutdownReason: "emergency_stop"
        },
        createdBy: TEST_ACTOR,
        createdAt: "2026-06-27T03:00:00.000Z",
        updatedAt: "2026-06-27T03:00:00.000Z",
        committedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        approvalArtifactId: "approval-shutdown-1"
      };
      const approvalArtifact: ProjectAggregateSnapshot["approvalArtifacts"][number] = {
        id: "approval-shutdown-1",
        projectId: aggregate.project.id,
        pendingOperationId: pendingOperation.id,
        actionType: "shutdown_version",
        targetId: currentVersion.id,
        digest,
        status: "approved",
        approver: {
          id: "user-1",
          type: "user",
          displayName: "owner"
        },
        decisionRef: "decision://routeledger/shutdown-1",
        createdAt: "2026-06-27T03:01:00.000Z",
        expiresAt: "2026-06-28T03:01:00.000Z",
        consumedAt: null,
        authorizationId: "grant-shutdown-1",
        approvalSource: "user_interaction",
        policyId: null,
        policyDigest: null,
        profileId: "profile-shutdown-1",
        modeEpoch: 3,
        profileDigest: "profile-digest-shutdown-1",
        hostKind: "codex",
        clientId: "codex-client",
      };

      await adapter.saveProjectAggregate({
        ...aggregate,
        versions: [linkedCurrentVersion, downstreamVersion],
        workItems: [workItem],
        undos: [undo],
        pendingOperations: [pendingOperation],
        approvalArtifacts: [approvalArtifact]
      });

      const loaded = await adapter.loadProjectAggregate(aggregate.project.id);

      expect(loaded?.undos[0]).toMatchObject({
        carriedForwardAt: "2026-06-27T02:00:00.000Z",
        carriedForwardToVersionId: downstreamVersion.id
      });
      expect(loaded?.pendingOperations[0]).toMatchObject({
        actionType: "shutdown_version",
        approvalArtifactId: approvalArtifact.id
      });
      expect(loaded?.approvalArtifacts[0]).toMatchObject({
        actionType: "shutdown_version",
        pendingOperationId: pendingOperation.id,
        authorizationId: "grant-shutdown-1",
        approvalSource: "user_interaction",
        profileId: "profile-shutdown-1",
        modeEpoch: 3,
        profileDigest: "profile-digest-shutdown-1",
        hostKind: "codex",
        clientId: "codex-client",
      });
    } finally {
      adapter.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("version tree L3 commit 持久化后重读仍保持稠密 order 与 sibling 指针", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const adapter = new SQLiteStorageAdapter({ projectRoot });
      const service = new RouteLedgerService({
        storage: adapter,
        deps: createTestDependencies()
      });
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      const createDetails = await expectConfirmationRequired(
        service.createVersion({
          projectId: created.project.id,
          title: "Version 2",
          actor: TEST_ACTOR
        })
      );
      const createArtifact = await service.approveL3Operation({
        projectId: created.project.id,
        pendingOperationId: createDetails.pendingOperationId,
        approver: {
          id: "user-1",
          type: "user",
          displayName: "owner"
        },
        actor: TEST_ACTOR
      });
      await service.commitL3Operation({
        projectId: created.project.id,
        pendingOperationId: createDetails.pendingOperationId,
        approvalArtifactId: createArtifact.id,
        actor: TEST_ACTOR
      });

      const childDetails = await expectConfirmationRequired(
        service.createChildVersion({
          projectId: created.project.id,
          parentVersionId: created.firstVersion!.id,
          title: "Child 1",
          actor: TEST_ACTOR
        })
      );
      const childArtifact = await service.approveL3Operation({
        projectId: created.project.id,
        pendingOperationId: childDetails.pendingOperationId,
        approver: {
          id: "user-1",
          type: "user",
          displayName: "owner"
        },
        actor: TEST_ACTOR
      });
      await service.commitL3Operation({
        projectId: created.project.id,
        pendingOperationId: childDetails.pendingOperationId,
        approvalArtifactId: childArtifact.id,
        actor: TEST_ACTOR
      });

      const loaded = await adapter.loadProjectAggregate(created.project.id);
      const loadedEventTypes = loaded?.events.map((event) => event.eventType) ?? [];

      expect(loaded?.versions.map((version) => version.id)).toEqual([
        created.firstVersion!.id,
        childDetails.proposal.targetId,
        createDetails.proposal.targetId
      ]);
      expect(loaded?.versions.map((version) => version.order)).toEqual([1, 2, 3]);
      expect(loaded?.project.currentVersionId).toBe(created.firstVersion!.id);
      expect(loaded?.pendingOperations).toHaveLength(2);
      expect(loaded?.pendingOperations.map((operation) => operation.status)).toEqual([
        "committed",
        "committed"
      ]);
      expect(loaded?.approvalArtifacts).toHaveLength(2);
      expect(loaded?.approvalArtifacts.map((artifact) => artifact.status)).toEqual([
        "consumed",
        "consumed"
      ]);
      expect(loadedEventTypes).toContain("version.created");
      expect(loadedEventTypes).toContain("version.tree_changed");
      expect(loadedEventTypes).toContain("pending_operation.committed");
      expect(loadedEventTypes).toContain("approval_artifact.consumed");
      expect(loaded?.versions.find((version) => version.id === created.firstVersion!.id)).toMatchObject({
        previousVersionId: null,
        nextVersionId: createDetails.proposal.targetId
      });
      expect(loaded?.versions.find((version) => version.id === childDetails.proposal.targetId)).toMatchObject({
        parentVersionId: created.firstVersion!.id,
        previousVersionId: null,
        nextVersionId: null
      });

      adapter.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});
