import type {
  Actor,
  ApprovalArtifact,
  Asset,
  AssetPathHistoryEntry,
  Constraint,
  DeferredItem,
  PendingOperation,
  Project,
  ProjectAggregateSnapshot,
  StoragePort,
  Todo,
  TransitionEvent,
  Undo,
  Version,
  WorkItem
} from "@routeledger/core";
import {
  collectConstraintInvariantViolations,
  collectDeferredItemInvariantViolations,
  validateWorkItemActive
} from "@routeledger/core";
import type BetterSqlite3 from "better-sqlite3";

import { openRouteLedgerDatabase } from "./database.js";

const SCHEMA_VERSION = 2;

const serializeJson = (value: unknown): string => JSON.stringify(value);

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const mapActor = (row: {
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
}): Actor => ({
  id: row.created_by_id,
  type: row.created_by_type,
  displayName: row.created_by_display_name ?? undefined
});

const toSqliteBoolean = (value: boolean): number => (value ? 1 : 0);

const fromSqliteBoolean = (value: number): boolean => value === 1;

class AggregateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateValidationError";
  }
}

const buildRecordMap = <T extends { id: string }>(
  recordType: string,
  records: T[]
): Map<string, T> => {
  const map = new Map<string, T>();

  for (const record of records) {
    if (map.has(record.id)) {
      throw new AggregateValidationError(
        `${recordType} ${record.id} appears more than once in the aggregate snapshot`
      );
    }

    map.set(record.id, record);
  }

  return map;
};

const assertProjectScopedCollection = (
  recordType: string,
  projectId: string,
  records: Array<{ id: string; projectId: string }>
): void => {
  for (const record of records) {
    if (record.projectId !== projectId) {
      throw new AggregateValidationError(
        `${recordType} ${record.id} project_id=${record.projectId} does not match aggregate project ${projectId}`
      );
    }
  }
};

const assertExistingRecordIdsArePreserved = (
  recordType: string,
  existingIds: Iterable<string>,
  nextIds: Set<string>
): void => {
  const missingIds = [...existingIds].filter((id) => !nextIds.has(id));

  if (missingIds.length > 0) {
    throw new AggregateValidationError(
      `saveProjectAggregate requires a complete aggregate snapshot; missing persisted ${recordType}: ${missingIds.join(", ")}`
    );
  }
};

const assertCompleteAggregateSnapshot = (
  snapshot: ProjectAggregateSnapshot,
  persistedSnapshot: ProjectAggregateSnapshot | null
): void => {
  const { project } = snapshot;

  if (
    !Array.isArray(snapshot.deferredItems) ||
    !Array.isArray(snapshot.constraints)
  ) {
    throw new AggregateValidationError(
      "aggregate snapshot requires deferredItems and constraints arrays"
    );
  }

  for (const deferredItem of snapshot.deferredItems) {
    const violations = collectDeferredItemInvariantViolations(
      deferredItem,
      snapshot.todos
    );

    if (violations.length > 0) {
      throw new AggregateValidationError(
        `deferred_item invariant failed: ${violations
          .map((violation) => `${violation.code}: ${violation.message}`)
          .join("; ")}`
      );
    }
  }

  for (const constraint of snapshot.constraints) {
    const violations = collectConstraintInvariantViolations(constraint);

    if (violations.length > 0) {
      throw new AggregateValidationError(
        `constraint invariant failed: ${violations
          .map((violation) => `${violation.code}: ${violation.message}`)
          .join("; ")}`
      );
    }
  }

  assertProjectScopedCollection("version", project.id, snapshot.versions);
  assertProjectScopedCollection("work_item", project.id, snapshot.workItems);
  assertProjectScopedCollection("todo", project.id, snapshot.todos);
  assertProjectScopedCollection("undo", project.id, snapshot.undos);
  assertProjectScopedCollection("deferred_item", project.id, snapshot.deferredItems);
  assertProjectScopedCollection("constraint", project.id, snapshot.constraints);
  assertProjectScopedCollection("asset", project.id, snapshot.assets);
  assertProjectScopedCollection("transition_event", project.id, snapshot.events);
  assertProjectScopedCollection(
    "pending_operation",
    project.id,
    snapshot.pendingOperations
  );
  assertProjectScopedCollection(
    "approval_artifact",
    project.id,
    snapshot.approvalArtifacts
  );

  const versionMap = buildRecordMap("version", snapshot.versions);
  const workItemMap = buildRecordMap("work_item", snapshot.workItems);
  const todoMap = buildRecordMap("todo", snapshot.todos);
  const undoMap = buildRecordMap("undo", snapshot.undos);
  const deferredItemMap = buildRecordMap("deferred_item", snapshot.deferredItems);
  const constraintMap = buildRecordMap("constraint", snapshot.constraints);
  const assetMap = buildRecordMap("asset", snapshot.assets);
  const eventMap = buildRecordMap("transition_event", snapshot.events);
  const pendingOperationMap = buildRecordMap(
    "pending_operation",
    snapshot.pendingOperations
  );
  const approvalArtifactMap = buildRecordMap(
    "approval_artifact",
    snapshot.approvalArtifacts
  );

  if (project.currentVersionId === null) {
    throw new AggregateValidationError("project.currentVersionId must point to an existing current version");
  }

  const currentVersion = versionMap.get(project.currentVersionId);

  if (currentVersion === undefined) {
    throw new AggregateValidationError(
      `project.currentVersionId ${project.currentVersionId} does not exist in the aggregate snapshot`
    );
  }

  const initialVersion = versionMap.get(project.initialVersionId);

  if (initialVersion === undefined) {
    throw new AggregateValidationError(
      `project.initialVersionId ${project.initialVersionId} does not exist in the aggregate snapshot`
    );
  }

  const currentVersions = snapshot.versions.filter((version) => version.isCurrent);

  if (currentVersions.length !== 1) {
    throw new AggregateValidationError(
      `aggregate snapshot must contain exactly one current version, found ${currentVersions.length}`
    );
  }

  if (currentVersions[0]?.id !== project.currentVersionId) {
    throw new AggregateValidationError(
      `project.currentVersionId ${project.currentVersionId} must match the version flagged as current`
    );
  }

  if (persistedSnapshot !== null) {
    assertExistingRecordIdsArePreserved(
      "versions",
      persistedSnapshot.versions.map((version) => version.id),
      new Set(versionMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "work items",
      persistedSnapshot.workItems.map((workItem) => workItem.id),
      new Set(workItemMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "todos",
      persistedSnapshot.todos.map((todo) => todo.id),
      new Set(todoMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "undos",
      persistedSnapshot.undos.map((undo) => undo.id),
      new Set(undoMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "deferred items",
      persistedSnapshot.deferredItems.map((deferredItem) => deferredItem.id),
      new Set(deferredItemMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "constraints",
      persistedSnapshot.constraints.map((constraint) => constraint.id),
      new Set(constraintMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "assets",
      persistedSnapshot.assets.map((asset) => asset.id),
      new Set(assetMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "transition events",
      persistedSnapshot.events.map((event) => event.id),
      new Set(eventMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "pending operations",
      persistedSnapshot.pendingOperations.map((operation) => operation.id),
      new Set(pendingOperationMap.keys())
    );
    assertExistingRecordIdsArePreserved(
      "approval artifacts",
      persistedSnapshot.approvalArtifacts.map((artifact) => artifact.id),
      new Set(approvalArtifactMap.keys())
    );
  }

  for (const version of snapshot.versions) {
    if (version.parentVersionId !== null && !versionMap.has(version.parentVersionId)) {
      throw new AggregateValidationError(
        `version ${version.id} parent_version_id ${version.parentVersionId} does not exist`
      );
    }

    if (version.previousVersionId !== null && !versionMap.has(version.previousVersionId)) {
      throw new AggregateValidationError(
        `version ${version.id} previous_version_id ${version.previousVersionId} does not exist`
      );
    }

    if (version.nextVersionId !== null && !versionMap.has(version.nextVersionId)) {
      throw new AggregateValidationError(
        `version ${version.id} next_version_id ${version.nextVersionId} does not exist`
      );
    }
  }

  for (const todo of snapshot.todos) {
    if (!workItemMap.has(todo.workItemId)) {
      throw new AggregateValidationError(
        `todo ${todo.id} references missing work_item ${todo.workItemId}`
      );
    }

    if (!versionMap.has(todo.versionId)) {
      throw new AggregateValidationError(
        `todo ${todo.id} references missing version ${todo.versionId}`
      );
    }
  }

  for (const undo of snapshot.undos) {
    if (!workItemMap.has(undo.workItemId)) {
      throw new AggregateValidationError(
        `undo ${undo.id} references missing work_item ${undo.workItemId}`
      );
    }

    if (!versionMap.has(undo.versionId)) {
      throw new AggregateValidationError(
        `undo ${undo.id} references missing version ${undo.versionId}`
      );
    }

    if (!versionMap.has(undo.originVersionId)) {
      throw new AggregateValidationError(
        `undo ${undo.id} references missing origin_version ${undo.originVersionId}`
      );
    }

    if (!versionMap.has(undo.preferredResolutionVersionId)) {
      throw new AggregateValidationError(
        `undo ${undo.id} references missing preferred_resolution_version ${undo.preferredResolutionVersionId}`
      );
    }
  }

  for (const workItem of snapshot.workItems) {
    if (!versionMap.has(workItem.originVersionId)) {
      throw new AggregateValidationError(
        `work_item ${workItem.id} references missing origin_version ${workItem.originVersionId}`
      );
    }

    validateWorkItemActive(
      workItem,
      snapshot.todos,
      snapshot.undos,
      snapshot.deferredItems
    );
  }

  for (const deferredItem of snapshot.deferredItems) {
    if (!workItemMap.has(deferredItem.workItemId)) {
      throw new AggregateValidationError(
        `deferred_item ${deferredItem.id} references missing work_item ${deferredItem.workItemId}`
      );
    }

    if (!versionMap.has(deferredItem.originVersionId)) {
      throw new AggregateValidationError(
        `deferred_item ${deferredItem.id} references missing origin_version ${deferredItem.originVersionId}`
      );
    }

    if (!versionMap.has(deferredItem.targetReviewVersionId)) {
      throw new AggregateValidationError(
        `deferred_item ${deferredItem.id} references missing target_review_version ${deferredItem.targetReviewVersionId}`
      );
    }

  }

  for (const constraint of snapshot.constraints) {
    if (
      constraint.scope.type === "version" &&
      !versionMap.has(constraint.scope.versionId)
    ) {
      throw new AggregateValidationError(
        `constraint ${constraint.id} references missing scope version ${constraint.scope.versionId}`
      );
    }

  }

  for (const asset of snapshot.assets) {
    for (const workItemId of asset.workItemIds) {
      if (!workItemMap.has(workItemId)) {
        throw new AggregateValidationError(
          `asset ${asset.id} references missing work_item ${workItemId}`
        );
      }
    }
  }

  for (const pendingOperation of snapshot.pendingOperations) {
    if (pendingOperation.approvalArtifactId !== null) {
      const approvalArtifact = approvalArtifactMap.get(pendingOperation.approvalArtifactId);

      if (approvalArtifact === undefined) {
        throw new AggregateValidationError(
          `pending_operation ${pendingOperation.id} references missing approval_artifact ${pendingOperation.approvalArtifactId}`
        );
      }
    }
  }

  for (const approvalArtifact of snapshot.approvalArtifacts) {
    const pendingOperation = pendingOperationMap.get(approvalArtifact.pendingOperationId);

    if (pendingOperation === undefined) {
      throw new AggregateValidationError(
        `approval_artifact ${approvalArtifact.id} references missing pending_operation ${approvalArtifact.pendingOperationId}`
      );
    }
  }

  const operationSequenceKeys = new Set<string>();

  for (const event of snapshot.events) {
    const sequenceKey = `${event.operationId}:${event.operationSeq}`;

    if (operationSequenceKeys.has(sequenceKey)) {
      throw new AggregateValidationError(
        `transition_event ${event.id} duplicates operation_id/operation_seq ${sequenceKey}`
      );
    }

    operationSequenceKeys.add(sequenceKey);

    switch (event.targetType) {
      case "project":
        if (event.targetId !== project.id) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets project ${event.targetId}, expected ${project.id}`
          );
        }
        break;
      case "version":
        if (!versionMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing version ${event.targetId}`
          );
        }
        break;
      case "work_item":
        if (!workItemMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing work_item ${event.targetId}`
          );
        }
        break;
      case "todo":
        if (!todoMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing todo ${event.targetId}`
          );
        }
        break;
      case "undo":
        if (!undoMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing undo ${event.targetId}`
          );
        }
        break;
      case "deferred_item":
        if (!deferredItemMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing deferred_item ${event.targetId}`
          );
        }
        break;
      case "constraint":
        if (!constraintMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing constraint ${event.targetId}`
          );
        }
        break;
      case "asset":
        if (!assetMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing asset ${event.targetId}`
          );
        }
        break;
      case "pending_operation":
        if (!pendingOperationMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing pending_operation ${event.targetId}`
          );
        }
        break;
      case "approval_artifact":
        if (!approvalArtifactMap.has(event.targetId)) {
          throw new AggregateValidationError(
            `transition_event ${event.id} targets missing approval_artifact ${event.targetId}`
          );
        }
        break;
      default: {
        const exhaustiveTargetType: never = event.targetType;
        throw new AggregateValidationError(
          `unsupported transition_event target type ${String(exhaustiveTargetType)}`
        );
      }
    }
  }

};

export interface SQLiteStorageAdapterOptions {
  projectRoot: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: Project["status"];
  current_version_id: string | null;
  initial_version_id: string;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  settings_json: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: Version["state"];
  parent_version_id: string | null;
  previous_version_id: string | null;
  next_version_id: string | null;
  order: number;
  is_current: number;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  state_reason: string | null;
}

interface WorkItemRow {
  id: string;
  project_id: string;
  title: string;
  type: WorkItem["type"];
  status: WorkItem["status"];
  origin_version_id: string;
  active_record_type: WorkItem["activeRecordType"];
  active_record_id: string | null;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  summary: string;
}

interface TodoRow {
  id: string;
  project_id: string;
  work_item_id: string;
  version_id: string;
  title: string;
  description: string;
  status: Todo["status"];
  source_type: Todo["sourceType"];
  source_id: string | null;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
  close_note: string | null;
}

interface UndoRow {
  id: string;
  project_id: string;
  work_item_id: string;
  version_id: string;
  origin_version_id: string;
  preferred_resolution_version_id: string;
  source_type: Undo["sourceType"];
  source_id: string | null;
  title: string;
  description: string;
  status: Undo["status"];
  reason: string;
  trigger_condition: string | null;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  carried_forward_at: string | null;
  carried_forward_to_version_id: string | null;
  closed_at: string | null;
  close_reason: string | null;
  close_note: string | null;
}

interface DeferredItemRow {
  id: string;
  project_id: string;
  work_item_id: string;
  origin_version_id: string;
  target_review_version_id: string;
  title: string;
  description: string;
  status: DeferredItem["status"];
  reason: string;
  review_trigger: string | null;
  resolution_outcome: DeferredItem["resolutionOutcome"];
  resolution_reason: string | null;
  resolution_note: string | null;
  decision_ref: string | null;
  activated_todo_id: string | null;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

interface ConstraintRow {
  id: string;
  project_id: string;
  rule: string;
  rationale: string;
  scope_type: Constraint["scope"]["type"];
  scope_version_id: string | null;
  status: Constraint["status"];
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
  retire_reason: string | null;
  retire_note: string | null;
}

interface AssetRow {
  id: string;
  project_id: string;
  work_item_ids_json: string;
  path_base: Asset["pathBase"];
  relative_path: string;
  status: Asset["status"];
  path_history_json: string;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
}

interface TransitionEventRow {
  id: string;
  project_id: string;
  operation_id: string;
  operation_seq: number;
  target_type: TransitionEvent["targetType"];
  target_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  note: string | null;
  actor_id: string;
  actor_type: Actor["type"];
  actor_display_name: string | null;
  created_at: string;
  metadata_json: string;
}

interface PendingOperationRow {
  id: string;
  project_id: string;
  action_type: PendingOperation["actionType"];
  target_id: string;
  status: PendingOperation["status"];
  reason: string;
  gate_snapshot_json: string;
  digest_json: string;
  payload_json: string;
  created_by_id: string;
  created_by_type: Actor["type"];
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  approval_artifact_id: string | null;
}

interface ApprovalArtifactRow {
  id: string;
  project_id: string;
  pending_operation_id: string;
  action_type: ApprovalArtifact["actionType"];
  target_id: string;
  digest_json: string;
  status: ApprovalArtifact["status"];
  approver_id: string;
  approver_type: Actor["type"];
  approver_display_name: string | null;
  decision_ref: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export class SQLiteStorageAdapter implements StoragePort {
  readonly db: BetterSqlite3.Database;
  readonly databasePath: string;

  constructor(options: SQLiteStorageAdapterOptions) {
    const opened = openRouteLedgerDatabase(options);
    this.db = opened.db;
    this.databasePath = opened.databasePath;
  }

  close(): void {
    this.db.close();
  }

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    const projectRow = this.db
      .prepare<string[], ProjectRow>(
        `SELECT
          id,
          name,
          description,
          status,
          current_version_id,
          initial_version_id,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          archived_at,
          settings_json
        FROM projects
        WHERE id = ?`
      )
      .get(projectId);

    if (projectRow === undefined) {
      return null;
    }

    const project: Project = {
      id: projectRow.id,
      name: projectRow.name,
      description: projectRow.description,
      status: projectRow.status,
      currentVersionId: projectRow.current_version_id,
      initialVersionId: projectRow.initial_version_id,
      createdBy: mapActor(projectRow),
      createdAt: projectRow.created_at,
      updatedAt: projectRow.updated_at,
      archivedAt: projectRow.archived_at,
      settings: parseJson<Project["settings"]>(projectRow.settings_json)
    };

    const versions = this.db
      .prepare<string[], VersionRow>(
        `SELECT
          id,
          project_id,
          title,
          description,
          state,
          parent_version_id,
          previous_version_id,
          next_version_id,
          "order" AS "order",
          is_current,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          closed_at,
          state_reason
        FROM versions
        WHERE project_id = ?
        ORDER BY "order" ASC, created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): Version => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          description: row.description,
          state: row.state,
          parentVersionId: row.parent_version_id,
          previousVersionId: row.previous_version_id,
          nextVersionId: row.next_version_id,
          order: row.order,
          isCurrent: fromSqliteBoolean(row.is_current),
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          closedAt: row.closed_at,
          stateReason: row.state_reason
        })
      );

    const workItems = this.db
      .prepare<string[], WorkItemRow>(
        `SELECT
          id,
          project_id,
          title,
          type,
          status,
          origin_version_id,
          active_record_type,
          active_record_id,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          closed_at,
          summary
        FROM work_items
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): WorkItem => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          type: row.type,
          status: row.status,
          originVersionId: row.origin_version_id,
          activeRecordType: row.active_record_type,
          activeRecordId: row.active_record_id,
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          closedAt: row.closed_at,
          summary: row.summary
        })
      );

    const todos = this.db
      .prepare<string[], TodoRow>(
        `SELECT
          id,
          project_id,
          work_item_id,
          version_id,
          title,
          description,
          status,
          source_type,
          source_id,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          closed_at,
          close_reason,
          close_note
        FROM todos
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): Todo => ({
          id: row.id,
          projectId: row.project_id,
          workItemId: row.work_item_id,
          versionId: row.version_id,
          title: row.title,
          description: row.description,
          status: row.status,
          sourceType: row.source_type,
          sourceId: row.source_id,
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          closedAt: row.closed_at,
          closeReason: row.close_reason,
          closeNote: row.close_note
        })
      );

    const undos = this.db
      .prepare<string[], UndoRow>(
        `SELECT
          id,
          project_id,
          work_item_id,
          version_id,
          origin_version_id,
          preferred_resolution_version_id,
          source_type,
          source_id,
          title,
          description,
          status,
          reason,
          trigger_condition,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          carried_forward_at,
          carried_forward_to_version_id,
          closed_at,
          close_reason,
          close_note
        FROM undos
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): Undo => ({
          id: row.id,
          projectId: row.project_id,
          workItemId: row.work_item_id,
          versionId: row.version_id,
          originVersionId: row.origin_version_id,
          preferredResolutionVersionId: row.preferred_resolution_version_id,
          sourceType: row.source_type,
          sourceId: row.source_id,
          title: row.title,
          description: row.description,
          status: row.status,
          reason: row.reason,
          triggerCondition: row.trigger_condition,
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          carriedForwardAt: row.carried_forward_at,
          carriedForwardToVersionId: row.carried_forward_to_version_id,
          closedAt: row.closed_at,
          closeReason: row.close_reason,
          closeNote: row.close_note
        })
      );

    const deferredItems = this.db
      .prepare<string[], DeferredItemRow>(
        `SELECT
          id,
          project_id,
          work_item_id,
          origin_version_id,
          target_review_version_id,
          title,
          description,
          status,
          reason,
          review_trigger,
          resolution_outcome,
          resolution_reason,
          resolution_note,
          decision_ref,
          activated_todo_id,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          reviewed_at
        FROM deferred_items
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): DeferredItem => ({
          id: row.id,
          projectId: row.project_id,
          workItemId: row.work_item_id,
          originVersionId: row.origin_version_id,
          targetReviewVersionId: row.target_review_version_id,
          title: row.title,
          description: row.description,
          status: row.status,
          reason: row.reason,
          reviewTrigger: row.review_trigger,
          resolutionOutcome: row.resolution_outcome,
          resolutionReason: row.resolution_reason,
          resolutionNote: row.resolution_note,
          decisionRef: row.decision_ref,
          activatedTodoId: row.activated_todo_id,
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          reviewedAt: row.reviewed_at
        })
      );

    const constraints = this.db
      .prepare<string[], ConstraintRow>(
        `SELECT
          id,
          project_id,
          rule,
          rationale,
          scope_type,
          scope_version_id,
          status,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          retired_at,
          retire_reason,
          retire_note
        FROM constraints
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): Constraint => ({
          id: row.id,
          projectId: row.project_id,
          rule: row.rule,
          rationale: row.rationale,
          scope:
            row.scope_type === "version"
              ? {
                  type: "version",
                  versionId: row.scope_version_id ?? ""
                }
              : {
                  type: "project"
                },
          status: row.status,
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          retiredAt: row.retired_at,
          retireReason: row.retire_reason,
          retireNote: row.retire_note
        })
      );

    const assets = this.db
      .prepare<string[], AssetRow>(
        `SELECT
          id,
          project_id,
          work_item_ids_json,
          path_base,
          relative_path,
          status,
          path_history_json,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at
        FROM assets
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): Asset => ({
          id: row.id,
          projectId: row.project_id,
          workItemIds: parseJson<string[]>(row.work_item_ids_json),
          pathBase: row.path_base,
          relativePath: row.relative_path,
          status: row.status,
          pathHistory: parseJson<AssetPathHistoryEntry[]>(row.path_history_json),
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })
      );

    const events = this.db
      .prepare<string[], TransitionEventRow>(
        `SELECT
          id,
          project_id,
          operation_id,
          operation_seq,
          target_type,
          target_id,
          event_type,
          from_state,
          to_state,
          note,
          actor_id,
          actor_type,
          actor_display_name,
          created_at,
          metadata_json
        FROM transition_events
        WHERE project_id = ?
        ORDER BY created_at ASC, operation_id ASC, operation_seq ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): TransitionEvent => ({
          id: row.id,
          projectId: row.project_id,
          operationId: row.operation_id,
          operationSeq: row.operation_seq,
          targetType: row.target_type,
          targetId: row.target_id,
          eventType: row.event_type,
          fromState: row.from_state,
          toState: row.to_state,
          note: row.note,
          actorId: row.actor_id,
          actorType: row.actor_type,
          actorDisplayName: row.actor_display_name,
          createdAt: row.created_at,
          metadata: parseJson<Record<string, unknown>>(row.metadata_json)
        })
      );

    const pendingOperations = this.db
      .prepare<string[], PendingOperationRow>(
        `SELECT
          id,
          project_id,
          action_type,
          target_id,
          status,
          reason,
          gate_snapshot_json,
          digest_json,
          payload_json,
          created_by_id,
          created_by_type,
          created_by_display_name,
          created_at,
          updated_at,
          committed_at,
          rejected_at,
          rejection_reason,
          approval_artifact_id
        FROM pending_operations
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): PendingOperation => ({
          id: row.id,
          projectId: row.project_id,
          actionType: row.action_type,
          targetId: row.target_id,
          status: row.status,
          reason: row.reason,
          gateSnapshot: parseJson<PendingOperation["gateSnapshot"]>(row.gate_snapshot_json),
          digest: parseJson<PendingOperation["digest"]>(row.digest_json),
          payload: parseJson<PendingOperation["payload"]>(row.payload_json),
          createdBy: mapActor(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          committedAt: row.committed_at,
          rejectedAt: row.rejected_at,
          rejectionReason: row.rejection_reason,
          approvalArtifactId: row.approval_artifact_id
        })
      );

    const approvalArtifacts = this.db
      .prepare<string[], ApprovalArtifactRow>(
        `SELECT
          id,
          project_id,
          pending_operation_id,
          action_type,
          target_id,
          digest_json,
          status,
          approver_id,
          approver_type,
          approver_display_name,
          decision_ref,
          created_at,
          expires_at,
          consumed_at
        FROM approval_artifacts
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(projectId)
      .map(
        (row): ApprovalArtifact => ({
          id: row.id,
          projectId: row.project_id,
          pendingOperationId: row.pending_operation_id,
          actionType: row.action_type,
          targetId: row.target_id,
          digest: parseJson<ApprovalArtifact["digest"]>(row.digest_json),
          status: row.status,
          approver: {
            id: row.approver_id,
            type: row.approver_type,
            displayName: row.approver_display_name ?? undefined
          },
          decisionRef: row.decision_ref,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at
        })
      );

    const snapshot: ProjectAggregateSnapshot = {
      project,
      versions,
      workItems,
      todos,
      undos,
      deferredItems,
      constraints,
      assets,
      events,
      pendingOperations,
      approvalArtifacts
    };

    assertCompleteAggregateSnapshot(snapshot, null);
    return snapshot;
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    const persistedSnapshot = await this.loadProjectAggregate(snapshot.project.id);
    assertCompleteAggregateSnapshot(snapshot, persistedSnapshot);

    const upsertProject = this.db.prepare(`
      INSERT INTO projects (
        id,
        schema_version,
        name,
        description,
        status,
        current_version_id,
        initial_version_id,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        archived_at,
        settings_json
      ) VALUES (
        @id,
        @schema_version,
        @name,
        @description,
        @status,
        @current_version_id,
        @initial_version_id,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @archived_at,
        @settings_json
      )
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        current_version_id = excluded.current_version_id,
        initial_version_id = excluded.initial_version_id,
        created_by_id = excluded.created_by_id,
        created_by_type = excluded.created_by_type,
        created_by_display_name = excluded.created_by_display_name,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        settings_json = excluded.settings_json
    `);

    const deleteEvents = this.db.prepare("DELETE FROM transition_events WHERE project_id = ?");
    const deleteAssets = this.db.prepare("DELETE FROM assets WHERE project_id = ?");
    const deleteDeferredItems = this.db.prepare(
      "DELETE FROM deferred_items WHERE project_id = ?"
    );
    const deleteConstraints = this.db.prepare(
      "DELETE FROM constraints WHERE project_id = ?"
    );
    const deleteTodos = this.db.prepare("DELETE FROM todos WHERE project_id = ?");
    const deleteUndos = this.db.prepare("DELETE FROM undos WHERE project_id = ?");
    const deleteWorkItems = this.db.prepare("DELETE FROM work_items WHERE project_id = ?");
    const deleteVersions = this.db.prepare("DELETE FROM versions WHERE project_id = ?");
    const deletePendingOperations = this.db.prepare(
      "DELETE FROM pending_operations WHERE project_id = ?"
    );
    const deleteApprovalArtifacts = this.db.prepare(
      "DELETE FROM approval_artifacts WHERE project_id = ?"
    );

    const insertVersion = this.db.prepare(`
      INSERT INTO versions (
        id,
        schema_version,
        project_id,
        title,
        description,
        state,
        parent_version_id,
        previous_version_id,
        next_version_id,
        "order",
        is_current,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        closed_at,
        state_reason
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @title,
        @description,
        @state,
        @parent_version_id,
        @previous_version_id,
        @next_version_id,
        @order,
        @is_current,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @closed_at,
        @state_reason
      )
    `);

    const insertWorkItem = this.db.prepare(`
      INSERT INTO work_items (
        id,
        schema_version,
        project_id,
        title,
        type,
        status,
        origin_version_id,
        active_record_type,
        active_record_id,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        closed_at,
        summary
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @title,
        @type,
        @status,
        @origin_version_id,
        @active_record_type,
        @active_record_id,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @closed_at,
        @summary
      )
    `);

    const insertTodo = this.db.prepare(`
      INSERT INTO todos (
        id,
        schema_version,
        project_id,
        work_item_id,
        version_id,
        title,
        description,
        status,
        source_type,
        source_id,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        closed_at,
        close_reason,
        close_note
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @work_item_id,
        @version_id,
        @title,
        @description,
        @status,
        @source_type,
        @source_id,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @closed_at,
        @close_reason,
        @close_note
      )
    `);

    const insertUndo = this.db.prepare(`
      INSERT INTO undos (
        id,
        schema_version,
        project_id,
        work_item_id,
        version_id,
        origin_version_id,
        preferred_resolution_version_id,
        source_type,
        source_id,
        title,
        description,
        status,
        reason,
        trigger_condition,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        carried_forward_at,
        carried_forward_to_version_id,
        closed_at,
        close_reason,
        close_note
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @work_item_id,
        @version_id,
        @origin_version_id,
        @preferred_resolution_version_id,
        @source_type,
        @source_id,
        @title,
        @description,
        @status,
        @reason,
        @trigger_condition,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @carried_forward_at,
        @carried_forward_to_version_id,
        @closed_at,
        @close_reason,
        @close_note
      )
    `);

    const insertDeferredItem = this.db.prepare(`
      INSERT INTO deferred_items (
        id,
        schema_version,
        project_id,
        work_item_id,
        origin_version_id,
        target_review_version_id,
        title,
        description,
        status,
        reason,
        review_trigger,
        resolution_outcome,
        resolution_reason,
        resolution_note,
        decision_ref,
        activated_todo_id,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        reviewed_at
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @work_item_id,
        @origin_version_id,
        @target_review_version_id,
        @title,
        @description,
        @status,
        @reason,
        @review_trigger,
        @resolution_outcome,
        @resolution_reason,
        @resolution_note,
        @decision_ref,
        @activated_todo_id,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @reviewed_at
      )
    `);

    const insertConstraint = this.db.prepare(`
      INSERT INTO constraints (
        id,
        schema_version,
        project_id,
        rule,
        rationale,
        scope_type,
        scope_version_id,
        status,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        retired_at,
        retire_reason,
        retire_note
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @rule,
        @rationale,
        @scope_type,
        @scope_version_id,
        @status,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @retired_at,
        @retire_reason,
        @retire_note
      )
    `);

    const insertAsset = this.db.prepare(`
      INSERT INTO assets (
        id,
        schema_version,
        project_id,
        work_item_ids_json,
        path_base,
        relative_path,
        status,
        path_history_json,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @work_item_ids_json,
        @path_base,
        @relative_path,
        @status,
        @path_history_json,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at
      )
    `);

    const insertEvent = this.db.prepare(`
      INSERT INTO transition_events (
        id,
        schema_version,
        project_id,
        operation_id,
        operation_seq,
        target_type,
        target_id,
        event_type,
        from_state,
        to_state,
        note,
        actor_id,
        actor_type,
        actor_display_name,
        created_at,
        metadata_json
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @operation_id,
        @operation_seq,
        @target_type,
        @target_id,
        @event_type,
        @from_state,
        @to_state,
        @note,
        @actor_id,
        @actor_type,
        @actor_display_name,
        @created_at,
        @metadata_json
      )
    `);

    const insertPendingOperation = this.db.prepare(`
      INSERT INTO pending_operations (
        id,
        schema_version,
        project_id,
        action_type,
        target_id,
        status,
        reason,
        gate_snapshot_json,
        digest_json,
        payload_json,
        created_by_id,
        created_by_type,
        created_by_display_name,
        created_at,
        updated_at,
        committed_at,
        rejected_at,
        rejection_reason,
        approval_artifact_id
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @action_type,
        @target_id,
        @status,
        @reason,
        @gate_snapshot_json,
        @digest_json,
        @payload_json,
        @created_by_id,
        @created_by_type,
        @created_by_display_name,
        @created_at,
        @updated_at,
        @committed_at,
        @rejected_at,
        @rejection_reason,
        @approval_artifact_id
      )
    `);

    const insertApprovalArtifact = this.db.prepare(`
      INSERT INTO approval_artifacts (
        id,
        schema_version,
        project_id,
        pending_operation_id,
        action_type,
        target_id,
        digest_json,
        status,
        approver_id,
        approver_type,
        approver_display_name,
        decision_ref,
        created_at,
        expires_at,
        consumed_at
      ) VALUES (
        @id,
        @schema_version,
        @project_id,
        @pending_operation_id,
        @action_type,
        @target_id,
        @digest_json,
        @status,
        @approver_id,
        @approver_type,
        @approver_display_name,
        @decision_ref,
        @created_at,
        @expires_at,
        @consumed_at
      )
    `);

    // D1 keeps saveProjectAggregate as a full-project replace inside one transaction.
    // Callers must pass the complete aggregate snapshot instead of a partial patch.
    const persistCompleteAggregate = this.db.transaction((aggregate: ProjectAggregateSnapshot) => {
      upsertProject.run({
        id: aggregate.project.id,
        schema_version: SCHEMA_VERSION,
        name: aggregate.project.name,
        description: aggregate.project.description,
        status: aggregate.project.status,
        current_version_id: aggregate.project.currentVersionId,
        initial_version_id: aggregate.project.initialVersionId,
        created_by_id: aggregate.project.createdBy.id,
        created_by_type: aggregate.project.createdBy.type,
        created_by_display_name: aggregate.project.createdBy.displayName ?? null,
        created_at: aggregate.project.createdAt,
        updated_at: aggregate.project.updatedAt,
        archived_at: aggregate.project.archivedAt,
        settings_json: serializeJson(aggregate.project.settings)
      });

      deleteEvents.run(aggregate.project.id);
      deleteAssets.run(aggregate.project.id);
      deleteDeferredItems.run(aggregate.project.id);
      deleteConstraints.run(aggregate.project.id);
      deleteTodos.run(aggregate.project.id);
      deleteUndos.run(aggregate.project.id);
      deleteWorkItems.run(aggregate.project.id);
      deleteVersions.run(aggregate.project.id);
      deleteApprovalArtifacts.run(aggregate.project.id);
      deletePendingOperations.run(aggregate.project.id);

      for (const version of aggregate.versions) {
        insertVersion.run({
          id: version.id,
          schema_version: SCHEMA_VERSION,
          project_id: version.projectId,
          title: version.title,
          description: version.description,
          state: version.state,
          parent_version_id: version.parentVersionId,
          previous_version_id: version.previousVersionId,
          next_version_id: version.nextVersionId,
          order: version.order,
          is_current: toSqliteBoolean(version.isCurrent),
          created_by_id: version.createdBy.id,
          created_by_type: version.createdBy.type,
          created_by_display_name: version.createdBy.displayName ?? null,
          created_at: version.createdAt,
          updated_at: version.updatedAt,
          closed_at: version.closedAt,
          state_reason: version.stateReason
        });
      }

      for (const workItem of aggregate.workItems) {
        insertWorkItem.run({
          id: workItem.id,
          schema_version: SCHEMA_VERSION,
          project_id: workItem.projectId,
          title: workItem.title,
          type: workItem.type,
          status: workItem.status,
          origin_version_id: workItem.originVersionId,
          active_record_type: workItem.activeRecordType,
          active_record_id: workItem.activeRecordId,
          created_by_id: workItem.createdBy.id,
          created_by_type: workItem.createdBy.type,
          created_by_display_name: workItem.createdBy.displayName ?? null,
          created_at: workItem.createdAt,
          updated_at: workItem.updatedAt,
          closed_at: workItem.closedAt,
          summary: workItem.summary
        });
      }

      for (const todo of aggregate.todos) {
        insertTodo.run({
          id: todo.id,
          schema_version: SCHEMA_VERSION,
          project_id: todo.projectId,
          work_item_id: todo.workItemId,
          version_id: todo.versionId,
          title: todo.title,
          description: todo.description,
          status: todo.status,
          source_type: todo.sourceType,
          source_id: todo.sourceId,
          created_by_id: todo.createdBy.id,
          created_by_type: todo.createdBy.type,
          created_by_display_name: todo.createdBy.displayName ?? null,
          created_at: todo.createdAt,
          updated_at: todo.updatedAt,
          closed_at: todo.closedAt,
          close_reason: todo.closeReason,
          close_note: todo.closeNote
        });
      }

      for (const undo of aggregate.undos) {
        insertUndo.run({
          id: undo.id,
          schema_version: SCHEMA_VERSION,
          project_id: undo.projectId,
          work_item_id: undo.workItemId,
          version_id: undo.versionId,
          origin_version_id: undo.originVersionId,
          preferred_resolution_version_id: undo.preferredResolutionVersionId,
          source_type: undo.sourceType,
          source_id: undo.sourceId,
          title: undo.title,
          description: undo.description,
          status: undo.status,
          reason: undo.reason,
          trigger_condition: undo.triggerCondition,
          created_by_id: undo.createdBy.id,
          created_by_type: undo.createdBy.type,
          created_by_display_name: undo.createdBy.displayName ?? null,
          created_at: undo.createdAt,
          updated_at: undo.updatedAt,
          carried_forward_at: undo.carriedForwardAt,
          carried_forward_to_version_id: undo.carriedForwardToVersionId,
          closed_at: undo.closedAt,
          close_reason: undo.closeReason,
          close_note: undo.closeNote
        });
      }

      for (const deferredItem of aggregate.deferredItems) {
        insertDeferredItem.run({
          id: deferredItem.id,
          schema_version: SCHEMA_VERSION,
          project_id: deferredItem.projectId,
          work_item_id: deferredItem.workItemId,
          origin_version_id: deferredItem.originVersionId,
          target_review_version_id: deferredItem.targetReviewVersionId,
          title: deferredItem.title,
          description: deferredItem.description,
          status: deferredItem.status,
          reason: deferredItem.reason,
          review_trigger: deferredItem.reviewTrigger,
          resolution_outcome: deferredItem.resolutionOutcome,
          resolution_reason: deferredItem.resolutionReason,
          resolution_note: deferredItem.resolutionNote,
          decision_ref: deferredItem.decisionRef,
          activated_todo_id: deferredItem.activatedTodoId,
          created_by_id: deferredItem.createdBy.id,
          created_by_type: deferredItem.createdBy.type,
          created_by_display_name: deferredItem.createdBy.displayName ?? null,
          created_at: deferredItem.createdAt,
          updated_at: deferredItem.updatedAt,
          reviewed_at: deferredItem.reviewedAt
        });
      }

      for (const constraint of aggregate.constraints) {
        insertConstraint.run({
          id: constraint.id,
          schema_version: SCHEMA_VERSION,
          project_id: constraint.projectId,
          rule: constraint.rule,
          rationale: constraint.rationale,
          scope_type: constraint.scope.type,
          scope_version_id:
            constraint.scope.type === "version"
              ? constraint.scope.versionId
              : null,
          status: constraint.status,
          created_by_id: constraint.createdBy.id,
          created_by_type: constraint.createdBy.type,
          created_by_display_name: constraint.createdBy.displayName ?? null,
          created_at: constraint.createdAt,
          updated_at: constraint.updatedAt,
          retired_at: constraint.retiredAt,
          retire_reason: constraint.retireReason,
          retire_note: constraint.retireNote
        });
      }

      for (const asset of aggregate.assets) {
        insertAsset.run({
          id: asset.id,
          schema_version: SCHEMA_VERSION,
          project_id: asset.projectId,
          work_item_ids_json: serializeJson(asset.workItemIds),
          path_base: asset.pathBase,
          relative_path: asset.relativePath,
          status: asset.status,
          path_history_json: serializeJson(asset.pathHistory),
          created_by_id: asset.createdBy.id,
          created_by_type: asset.createdBy.type,
          created_by_display_name: asset.createdBy.displayName ?? null,
          created_at: asset.createdAt,
          updated_at: asset.updatedAt
        });
      }

      for (const event of aggregate.events) {
        insertEvent.run({
          id: event.id,
          schema_version: SCHEMA_VERSION,
          project_id: event.projectId,
          operation_id: event.operationId,
          operation_seq: event.operationSeq,
          target_type: event.targetType,
          target_id: event.targetId,
          event_type: event.eventType,
          from_state: event.fromState,
          to_state: event.toState,
          note: event.note,
          actor_id: event.actorId,
          actor_type: event.actorType,
          actor_display_name: event.actorDisplayName,
          created_at: event.createdAt,
          metadata_json: serializeJson(event.metadata)
        });
      }

      for (const pendingOperation of aggregate.pendingOperations) {
        insertPendingOperation.run({
          id: pendingOperation.id,
          schema_version: SCHEMA_VERSION,
          project_id: pendingOperation.projectId,
          action_type: pendingOperation.actionType,
          target_id: pendingOperation.targetId,
          status: pendingOperation.status,
          reason: pendingOperation.reason,
          gate_snapshot_json: serializeJson(pendingOperation.gateSnapshot),
          digest_json: serializeJson(pendingOperation.digest),
          payload_json: serializeJson(pendingOperation.payload),
          created_by_id: pendingOperation.createdBy.id,
          created_by_type: pendingOperation.createdBy.type,
          created_by_display_name: pendingOperation.createdBy.displayName ?? null,
          created_at: pendingOperation.createdAt,
          updated_at: pendingOperation.updatedAt,
          committed_at: pendingOperation.committedAt,
          rejected_at: pendingOperation.rejectedAt,
          rejection_reason: pendingOperation.rejectionReason,
          approval_artifact_id: pendingOperation.approvalArtifactId
        });
      }

      for (const approvalArtifact of aggregate.approvalArtifacts) {
        insertApprovalArtifact.run({
          id: approvalArtifact.id,
          schema_version: SCHEMA_VERSION,
          project_id: approvalArtifact.projectId,
          pending_operation_id: approvalArtifact.pendingOperationId,
          action_type: approvalArtifact.actionType,
          target_id: approvalArtifact.targetId,
          digest_json: serializeJson(approvalArtifact.digest),
          status: approvalArtifact.status,
          approver_id: approvalArtifact.approver.id,
          approver_type: approvalArtifact.approver.type,
          approver_display_name: approvalArtifact.approver.displayName ?? null,
          decision_ref: approvalArtifact.decisionRef,
          created_at: approvalArtifact.createdAt,
          expires_at: approvalArtifact.expiresAt,
          consumed_at: approvalArtifact.consumedAt
        });
      }
    });

    persistCompleteAggregate(snapshot);
  }

  async listTransitionEventsByOperationId(operationId: string): Promise<TransitionEvent[]> {
    return this.db
      .prepare<string[], TransitionEventRow>(
        `SELECT
          id,
          project_id,
          operation_id,
          operation_seq,
          target_type,
          target_id,
          event_type,
          from_state,
          to_state,
          note,
          actor_id,
          actor_type,
          actor_display_name,
          created_at,
          metadata_json
        FROM transition_events
        WHERE operation_id = ?
        ORDER BY operation_seq ASC, id ASC`
      )
      .all(operationId)
      .map(
        (row): TransitionEvent => ({
          id: row.id,
          projectId: row.project_id,
          operationId: row.operation_id,
          operationSeq: row.operation_seq,
          targetType: row.target_type,
          targetId: row.target_id,
          eventType: row.event_type,
          fromState: row.from_state,
          toState: row.to_state,
          note: row.note,
          actorId: row.actor_id,
          actorType: row.actor_type,
          actorDisplayName: row.actor_display_name,
          createdAt: row.created_at,
          metadata: parseJson<Record<string, unknown>>(row.metadata_json)
        })
      );
  }
}
