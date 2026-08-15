import type BetterSqlite3 from "better-sqlite3";

export interface MigrationDefinition {
  id: string;
  sql: string;
}

const INITIAL_SCHEMA_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_version_id TEXT,
  initial_version_id TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  settings_json TEXT NOT NULL
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('wait', 'ready', 'running', 'suspend', 'complete', 'close')),
  parent_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
  previous_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
  next_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
  "order" INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  state_reason TEXT
);

CREATE INDEX idx_versions_project_order ON versions(project_id, "order");
CREATE INDEX idx_versions_project_current ON versions(project_id, is_current);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('feature', 'bug', 'risk', 'open_question', 'debt', 'decision', 'other')),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  origin_version_id TEXT NOT NULL REFERENCES versions(id),
  active_record_type TEXT CHECK (active_record_type IN ('todo', 'undo')),
  active_record_id TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  summary TEXT NOT NULL,
  CHECK (
    (status = 'active' AND active_record_type IS NOT NULL AND active_record_id IS NOT NULL)
    OR
    (status = 'closed' AND active_record_type IS NULL AND active_record_id IS NULL)
  )
);

CREATE INDEX idx_work_items_project_status ON work_items(project_id, status);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wait', 'running', 'closed', 'converted')),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'conversion', 'residual_audit')),
  source_id TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  close_note TEXT
);

CREATE INDEX idx_todos_project_version ON todos(project_id, version_id);
CREATE INDEX idx_todos_work_item ON todos(work_item_id);

CREATE TABLE undos (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  origin_version_id TEXT NOT NULL REFERENCES versions(id),
  preferred_resolution_version_id TEXT NOT NULL REFERENCES versions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'roadmap_planning', 'agent_discovery', 'residual_audit', 'conversion', 'import')),
  source_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wait', 'closed', 'converted')),
  reason TEXT NOT NULL,
  trigger_condition TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  close_note TEXT
);

CREATE INDEX idx_undos_project_version ON undos(project_id, version_id);
CREATE INDEX idx_undos_preferred_resolution ON undos(preferred_resolution_version_id, status);
CREATE INDEX idx_undos_work_item ON undos(work_item_id);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_ids_json TEXT NOT NULL,
  path_base TEXT NOT NULL CHECK (path_base IN ('project_root')),
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'missing', 'path_unverified')),
  path_history_json TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_assets_project_status ON assets(project_id, status);

CREATE TABLE transition_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  operation_seq INTEGER NOT NULL CHECK (operation_seq > 0),
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'version', 'work_item', 'todo', 'undo', 'asset')),
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  note TEXT,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_display_name TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (operation_id, operation_seq)
);

CREATE INDEX idx_transition_events_project_operation
  ON transition_events(project_id, operation_id, operation_seq);
CREATE INDEX idx_transition_events_target
  ON transition_events(project_id, target_type, target_id);
`;

const D2_APPROVAL_SQL = `
CREATE TABLE pending_operations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected')),
  reason TEXT NOT NULL,
  gate_snapshot_json TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  approval_artifact_id TEXT
);

CREATE INDEX idx_pending_operations_project_created
  ON pending_operations(project_id, created_at, id);

CREATE TABLE approval_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pending_operation_id TEXT NOT NULL REFERENCES pending_operations(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  approver_id TEXT NOT NULL,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('user', 'agent', 'system')),
  approver_display_name TEXT,
  decision_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_approval_artifacts_project_created
  ON approval_artifacts(project_id, created_at, id);

ALTER TABLE transition_events RENAME TO transition_events_old;

CREATE TABLE transition_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  operation_seq INTEGER NOT NULL CHECK (operation_seq > 0),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'project',
    'version',
    'work_item',
    'todo',
    'undo',
    'asset',
    'pending_operation',
    'approval_artifact'
  )),
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  note TEXT,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_display_name TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (operation_id, operation_seq)
);

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
)
SELECT
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
FROM transition_events_old;

DROP TABLE transition_events_old;

CREATE INDEX idx_transition_events_project_operation
  ON transition_events(project_id, operation_id, operation_seq);
CREATE INDEX idx_transition_events_target
  ON transition_events(project_id, target_type, target_id);
`;

const D2_FLOW_FRICTION_SQL = `
ALTER TABLE undos ADD COLUMN carried_forward_at TEXT;
ALTER TABLE undos ADD COLUMN carried_forward_to_version_id TEXT REFERENCES versions(id);

WITH latest_undo_reassignment AS (
  SELECT
    target_id AS undo_id,
    created_at,
    json_extract(metadata_json, '$.carriedForwardAt') AS carried_forward_at,
    json_extract(metadata_json, '$.carriedForwardToVersionId') AS carried_forward_to_version_id,
    json_extract(metadata_json, '$.nextPreferredResolutionVersionId') AS next_preferred_resolution_version_id,
    ROW_NUMBER() OVER (
      PARTITION BY target_id
      ORDER BY created_at DESC, operation_seq DESC, id DESC
    ) AS rn
  FROM transition_events
  WHERE target_type = 'undo' AND event_type = 'undo.reassigned'
)
UPDATE undos
SET
  carried_forward_at = (
    SELECT COALESCE(
      latest_undo_reassignment.carried_forward_at,
      latest_undo_reassignment.created_at
    )
    FROM latest_undo_reassignment
    WHERE latest_undo_reassignment.undo_id = undos.id
      AND latest_undo_reassignment.rn = 1
      AND COALESCE(
        latest_undo_reassignment.carried_forward_to_version_id,
        latest_undo_reassignment.next_preferred_resolution_version_id
      ) = undos.preferred_resolution_version_id
  ),
  carried_forward_to_version_id = (
    SELECT COALESCE(
      latest_undo_reassignment.carried_forward_to_version_id,
      latest_undo_reassignment.next_preferred_resolution_version_id
    )
    FROM latest_undo_reassignment
    WHERE latest_undo_reassignment.undo_id = undos.id
      AND latest_undo_reassignment.rn = 1
      AND COALESCE(
        latest_undo_reassignment.carried_forward_to_version_id,
        latest_undo_reassignment.next_preferred_resolution_version_id
      ) = undos.preferred_resolution_version_id
  )
WHERE EXISTS (
  SELECT 1
  FROM latest_undo_reassignment
  WHERE latest_undo_reassignment.undo_id = undos.id
    AND latest_undo_reassignment.rn = 1
    AND COALESCE(
      latest_undo_reassignment.carried_forward_to_version_id,
      latest_undo_reassignment.next_preferred_resolution_version_id
    ) = undos.preferred_resolution_version_id
);

DROP INDEX idx_approval_artifacts_project_created;
DROP INDEX idx_pending_operations_project_created;

ALTER TABLE approval_artifacts RENAME TO approval_artifacts_old;
ALTER TABLE pending_operations RENAME TO pending_operations_old;

CREATE TABLE pending_operations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected')),
  reason TEXT NOT NULL,
  gate_snapshot_json TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  approval_artifact_id TEXT
);

CREATE INDEX idx_pending_operations_project_created
  ON pending_operations(project_id, created_at, id);

CREATE TABLE approval_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pending_operation_id TEXT NOT NULL REFERENCES pending_operations(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  approver_id TEXT NOT NULL,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('user', 'agent', 'system')),
  approver_display_name TEXT,
  decision_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_approval_artifacts_project_created
  ON approval_artifacts(project_id, created_at, id);

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
)
SELECT
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
FROM pending_operations_old;

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
)
SELECT
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
FROM approval_artifacts_old;

DROP TABLE approval_artifacts_old;
DROP TABLE pending_operations_old;
`;

const D2A_DEFERRED_CONSTRAINT_SQL = `
ALTER TABLE todos RENAME TO todos_old;
ALTER TABLE undos RENAME TO undos_old;
ALTER TABLE work_items RENAME TO work_items_old;

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('feature', 'bug', 'risk', 'open_question', 'debt', 'decision', 'other')),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  origin_version_id TEXT NOT NULL REFERENCES versions(id),
  active_record_type TEXT CHECK (active_record_type IN ('todo', 'undo', 'deferred')),
  active_record_id TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  summary TEXT NOT NULL,
  CHECK (
    (status = 'active' AND active_record_type IS NOT NULL AND active_record_id IS NOT NULL)
    OR
    (status = 'closed' AND active_record_type IS NULL AND active_record_id IS NULL)
  )
);

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
)
SELECT
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
FROM work_items_old;

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wait', 'running', 'closed', 'converted')),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'conversion', 'residual_audit')),
  source_id TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  close_note TEXT
);

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
)
SELECT
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
FROM todos_old;

CREATE TABLE undos (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  origin_version_id TEXT NOT NULL REFERENCES versions(id),
  preferred_resolution_version_id TEXT NOT NULL REFERENCES versions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'roadmap_planning', 'agent_discovery', 'residual_audit', 'conversion', 'import')),
  source_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wait', 'closed', 'converted')),
  reason TEXT NOT NULL,
  trigger_condition TEXT,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  close_note TEXT,
  carried_forward_at TEXT,
  carried_forward_to_version_id TEXT REFERENCES versions(id)
);

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
  closed_at,
  close_reason,
  close_note,
  carried_forward_at,
  carried_forward_to_version_id
)
SELECT
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
  closed_at,
  close_reason,
  close_note,
  carried_forward_at,
  carried_forward_to_version_id
FROM undos_old;

DROP TABLE todos_old;
DROP TABLE undos_old;
DROP TABLE work_items_old;

CREATE INDEX idx_work_items_project_status ON work_items(project_id, status);
CREATE INDEX idx_todos_project_version ON todos(project_id, version_id);
CREATE INDEX idx_todos_work_item ON todos(work_item_id);
CREATE INDEX idx_undos_project_version ON undos(project_id, version_id);
CREATE INDEX idx_undos_preferred_resolution ON undos(preferred_resolution_version_id, status);
CREATE INDEX idx_undos_work_item ON undos(work_item_id);

CREATE TABLE deferred_items (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  origin_version_id TEXT NOT NULL REFERENCES versions(id),
  target_review_version_id TEXT NOT NULL REFERENCES versions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'activated', 'resolved')),
  reason TEXT NOT NULL,
  review_trigger TEXT,
  resolution_outcome TEXT CHECK (resolution_outcome IN ('activated', 'superseded', 'rejected', 'out_of_scope')),
  resolution_reason TEXT,
  resolution_note TEXT,
  decision_ref TEXT,
  activated_todo_id TEXT REFERENCES todos(id) DEFERRABLE INITIALLY DEFERRED,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX idx_deferred_items_project_status
  ON deferred_items(project_id, status);
CREATE INDEX idx_deferred_items_target_review
  ON deferred_items(target_review_version_id, status);
CREATE INDEX idx_deferred_items_work_item
  ON deferred_items(work_item_id);

CREATE TABLE constraints (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'version')),
  scope_version_id TEXT REFERENCES versions(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  retire_reason TEXT,
  retire_note TEXT,
  CHECK (
    (scope_type = 'project' AND scope_version_id IS NULL)
    OR
    (scope_type = 'version' AND scope_version_id IS NOT NULL)
  )
);

CREATE INDEX idx_constraints_project_status
  ON constraints(project_id, status);
CREATE INDEX idx_constraints_scope_version
  ON constraints(scope_version_id, status);

ALTER TABLE transition_events RENAME TO transition_events_old;

CREATE TABLE transition_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  operation_seq INTEGER NOT NULL CHECK (operation_seq > 0),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'project',
    'version',
    'work_item',
    'todo',
    'undo',
    'deferred_item',
    'constraint',
    'asset',
    'pending_operation',
    'approval_artifact'
  )),
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  note TEXT,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_display_name TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (operation_id, operation_seq)
);

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
)
SELECT
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
FROM transition_events_old;

DROP TABLE transition_events_old;

CREATE INDEX idx_transition_events_project_operation
  ON transition_events(project_id, operation_id, operation_seq);
CREATE INDEX idx_transition_events_target
  ON transition_events(project_id, target_type, target_id);
`;

const PROJECT_ROOT_SQL = `
ALTER TABLE projects RENAME COLUMN initial_version_id TO legacy_initial_version_id;
ALTER TABLE projects ADD COLUMN initial_version_id TEXT;
UPDATE projects SET initial_version_id = legacy_initial_version_id;
ALTER TABLE projects DROP COLUMN legacy_initial_version_id;
`;

const ADVANCE_TO_VERSION_APPROVAL_SQL = `
DROP INDEX idx_approval_artifacts_project_created;
DROP INDEX idx_pending_operations_project_created;

ALTER TABLE approval_artifacts RENAME TO approval_artifacts_old;
ALTER TABLE pending_operations RENAME TO pending_operations_old;

CREATE TABLE pending_operations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'advance_to_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected')),
  reason TEXT NOT NULL,
  gate_snapshot_json TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  approval_artifact_id TEXT
);

CREATE INDEX idx_pending_operations_project_created
  ON pending_operations(project_id, created_at, id);

CREATE TABLE approval_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pending_operation_id TEXT NOT NULL REFERENCES pending_operations(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start_version',
    'close_version',
    'shutdown_version',
    'reopen_version',
    'set_current_version',
    'advance_to_version',
    'create_version',
    'insert_version',
    'create_child_version',
    'reorder_versions'
  )),
  target_id TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  approver_id TEXT NOT NULL,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('user', 'agent', 'system')),
  approver_display_name TEXT,
  decision_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_approval_artifacts_project_created
  ON approval_artifacts(project_id, created_at, id);

INSERT INTO pending_operations SELECT * FROM pending_operations_old;
INSERT INTO approval_artifacts SELECT * FROM approval_artifacts_old;

DROP TABLE approval_artifacts_old;
DROP TABLE pending_operations_old;
`;

const L3_AUTHORIZATION_PROVENANCE_SQL = `
ALTER TABLE approval_artifacts ADD COLUMN authorization_provenance_json TEXT;
`;

const EXACT_AUTHORIZATION_RECORD_SQL = `
ALTER TABLE approval_artifacts
  RENAME COLUMN authorization_provenance_json TO authorization_record_json;
UPDATE approval_artifacts
SET authorization_record_json = json_object(
  'kind', 'legacy_audit',
  'provenance', json(authorization_record_json)
)
WHERE authorization_record_json IS NOT NULL;
`;

const ORDINARY_WRITE_RECEIPTS_SQL = `
CREATE TABLE ordinary_write_receipts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result_schema_version INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_display_name TEXT,
  committed_at TEXT NOT NULL,
  UNIQUE(project_id, command_name, idempotency_key)
);

CREATE INDEX idx_ordinary_write_receipts_project_committed
  ON ordinary_write_receipts(project_id, committed_at, id);
`;

export const SQLITE_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: "0001_initial_schema",
    sql: INITIAL_SCHEMA_SQL
  },
  {
    id: "0002_d2_pending_operations_and_approval_artifacts",
    sql: D2_APPROVAL_SQL
  },
  {
    id: "0003_d2_flow_friction_sqlite_alignment",
    sql: D2_FLOW_FRICTION_SQL
  },
  {
    id: "0004_d2a_deferred_items_and_constraints",
    sql: D2A_DEFERRED_CONSTRAINT_SQL
  },
  {
    id: "0005_project_root",
    sql: PROJECT_ROOT_SQL
  },
  {
    id: "0006_advance_to_version_approval",
    sql: ADVANCE_TO_VERSION_APPROVAL_SQL
  },
  {
    id: "0007_l3_authorization_provenance",
    sql: L3_AUTHORIZATION_PROVENANCE_SQL
  },
  {
    id: "0008_exact_authorization_record",
    sql: EXACT_AUTHORIZATION_RECORD_SQL
  },
  {
    id: "0009_ordinary_write_receipts",
    sql: ORDINARY_WRITE_RECEIPTS_SQL
  }
];

export const ensureSchemaMigrationsTable = (database: BetterSqlite3.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
};

export const applyMigrations = (database: BetterSqlite3.Database): void => {
  ensureSchemaMigrationsTable(database);
  const appliedIds = (
    database.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>
  ).map(({ id }) => id);
  for (const [index, id] of appliedIds.entries()) {
    if (SQLITE_MIGRATIONS[index]?.id !== id) {
      throw new Error(`Unsupported or non-prefix SQLite migration history: ${id}.`);
    }
  }
  const selectApplied = database.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const insertApplied = database.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  );

  for (const migration of SQLITE_MIGRATIONS) {
    const existing = selectApplied.get(migration.id) as { id: string } | undefined;

    if (existing !== undefined) {
      continue;
    }

    const applySingleMigration = database.transaction(() => {
      database.exec(migration.sql);
      insertApplied.run(migration.id, new Date().toISOString());
    });

    applySingleMigration();
  }
};
