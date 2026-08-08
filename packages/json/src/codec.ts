import type {
  Actor,
  ApprovalArtifact,
  ApprovalArtifactStatus,
  Asset,
  AssetPathBase,
  AssetPathHistoryEntry,
  AssetStatus,
  BatchCreateVersionsAnchor,
  BatchCreateVersionsItemInput,
  BatchCreateVersionsNormalizedItem,
  BatchCreateVersionsResolvedAnchors,
  BatchPreviousCurrentPolicy,
  Constraint,
  ConstraintScope,
  ConstraintStatus,
  DeferredItem,
  DeferredResolutionOutcome,
  DeferredStatus,
  GateSnapshot,
  L3ActionType,
  OperationDigest,
  PendingOperation,
  PendingOperationPayload,
  PendingOperationStatus,
  Project,
  ProjectAggregateSnapshot,
  ProjectSettings,
  ProjectStatus,
  Todo,
  TodoStatus,
  TransitionEvent,
  TransitionTargetType,
  Undo,
  UndoStatus,
  Version,
  VersionState,
  WorkItem,
  WorkItemStatus,
  WorkItemType
} from "@routeledger/core";
import {
  collectConstraintInvariantViolations,
  collectDeferredItemInvariantViolations
} from "@routeledger/core";

import { buildRouteLedgerSchemaDocument } from "./schema.js";
import {
  CURRENT_REF_DOCUMENT_PATH,
  PROJECT_DOCUMENT_PATH,
  ROUTELEDGER_JSON_ROOT,
  ROUTELEDGER_SCHEMA_VERSION,
  SCHEMA_DOCUMENT_PATH
} from "./constants.js";

export interface RouteLedgerJsonDocument {
  path: string;
  content: string;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface JsonActor {
  id: string;
  type: Actor["type"];
  display_name?: string;
}

interface JsonProjectSettings {
  enforce_start_gate: boolean;
  enforce_close_gate: boolean;
  context_budget_bytes: number;
  content_locale?: string | null;
}

interface JsonProject {
  schema_version: number;
  kind: "project";
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  current_version_id: string | null;
  initial_version_id: string | null;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  settings: JsonProjectSettings;
}

interface JsonCurrentRef {
  schema_version: number;
  kind: "current_ref";
  project_id: string;
  current_version_id: string | null;
}

interface JsonVersion {
  schema_version: number;
  kind: "version";
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: VersionState;
  parent_version_id: string | null;
  previous_version_id: string | null;
  next_version_id: string | null;
  order: number;
  is_current: boolean;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  state_reason: string | null;
}

interface JsonWorkItem {
  schema_version: number;
  kind: "work_item";
  id: string;
  project_id: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  origin_version_id: string;
  active_record_type: WorkItem["activeRecordType"];
  active_record_id: string | null;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  summary: string;
}

interface JsonTodo {
  schema_version: number;
  kind: "todo";
  id: string;
  project_id: string;
  work_item_id: string;
  version_id: string;
  title: string;
  description: string;
  status: TodoStatus;
  source_type: Todo["sourceType"];
  source_id: string | null;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
  close_note: string | null;
}

interface JsonUndo {
  schema_version: number;
  kind: "undo";
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
  status: UndoStatus;
  reason: string;
  trigger_condition: string | null;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  carried_forward_at: string | null;
  carried_forward_to_version_id: string | null;
  closed_at: string | null;
  close_reason: string | null;
  close_note: string | null;
}

interface JsonDeferredItem {
  schema_version: number;
  kind: "deferred_item";
  id: string;
  project_id: string;
  work_item_id: string;
  origin_version_id: string;
  target_review_version_id: string;
  title: string;
  description: string;
  status: DeferredStatus;
  reason: string;
  review_trigger: string | null;
  resolution_outcome: DeferredResolutionOutcome | null;
  resolution_reason: string | null;
  resolution_note: string | null;
  decision_ref: string | null;
  activated_todo_id: string | null;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

interface JsonConstraintScope {
  type: ConstraintScope["type"];
  version_id?: string;
}

interface JsonConstraint {
  schema_version: number;
  kind: "constraint";
  id: string;
  project_id: string;
  rule: string;
  rationale: string;
  scope: JsonConstraintScope;
  status: ConstraintStatus;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
  retire_reason: string | null;
  retire_note: string | null;
}

interface JsonAssetPathHistoryEntry {
  path_base: AssetPathBase;
  relative_path: string;
  recorded_at: string;
}

interface JsonAsset {
  schema_version: number;
  kind: "asset";
  id: string;
  project_id: string;
  work_item_ids: string[];
  path_base: AssetPathBase;
  relative_path: string;
  status: AssetStatus;
  path_history: JsonAssetPathHistoryEntry[];
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
}

interface JsonTransitionEvent {
  schema_version: number;
  kind: "transition_event";
  id: string;
  project_id: string;
  operation_id: string;
  operation_seq: number;
  target_type: TransitionTargetType;
  target_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  note: string | null;
  actor_id: string;
  actor_type: Actor["type"];
  actor_display_name: string | null;
  created_at: string;
  metadata: Record<string, JsonValue>;
}

type JsonGateBlocker = {
  code: string;
  message: string;
  record_ids: string[];
};

type JsonResidualAuditItem = {
  kind: "bug" | "risk" | "open_question" | "debt";
  summary: string;
  destination:
    | "close"
    | "create_undo"
    | "create_todo"
    | "defer_work"
    | "record_constraint"
    | null;
  preferred_resolution_version_id?: string | null;
  target_review_version_id?: string | null;
};

type JsonGateSnapshot =
  | {
      kind: "start";
      evaluated_at: string;
      allowed: boolean;
      blockers: JsonGateBlocker[];
      open_todo_ids: string[];
      due_undo_ids: string[];
      due_deferred_ids?: string[];
      missing_decision_refs: string[];
      blocked_constraint_ids?: string[];
    }
  | {
      kind: "close";
      evaluated_at: string;
      allowed: boolean;
      blockers: JsonGateBlocker[];
      unresolved_todo_ids: string[];
      unresolved_undo_ids: string[];
      unresolved_deferred_ids?: string[];
      blocked_constraint_ids?: string[];
      residual_audit: JsonResidualAuditItem[] | null;
      residual_audit_reviewed?: boolean;
    }
  | {
      kind: "shutdown";
      evaluated_at: string;
      allowed: boolean;
      blockers: JsonGateBlocker[];
      forced: true;
      state_reason: string;
      ordinary_close_gate: {
        allowed: boolean;
        blockers: JsonGateBlocker[];
        unresolved_todo_ids: string[];
        unresolved_undo_ids: string[];
        unresolved_deferred_ids?: string[];
        blocked_constraint_ids?: string[];
      };
    }
  | {
      kind: "none";
      evaluated_at: string;
      allowed: true;
      blockers: [];
    };

interface JsonOperationDigest {
  algorithm: OperationDigest["algorithm"];
  value: string;
  payload: Record<string, JsonValue>;
}

type JsonPendingOperationPayload = Record<string, JsonValue>;

interface JsonBatchCreateVersionsAnchor {
  parent_version_id?: string | null;
  after_version_id?: string | null;
  before_version_id?: string | null;
}

interface JsonBatchCreateVersionsItem {
  client_key: string;
  title: string;
  description: string;
  initial_todos: string[];
}

interface JsonBatchCreateVersionsNormalizedItem {
  index: number;
  client_key: string;
  preview_version_id: string;
  title: string;
  description: string;
  parent_version_id: string | null;
  previous_ref: string | null;
  next_ref: string | null;
  initial_todos: string[];
}

interface JsonBatchCreateVersionsResolvedAnchors {
  parent_version_id: string | null;
  after_version_id: string | null;
  before_version_id: string | null;
}

interface JsonPendingOperation {
  schema_version: number;
  kind: "pending_operation";
  id: string;
  project_id: string;
  action_type: L3ActionType;
  target_id: string;
  status: PendingOperationStatus;
  reason: string;
  gate_snapshot: JsonGateSnapshot;
  digest: JsonOperationDigest;
  payload: JsonPendingOperationPayload;
  created_by: JsonActor;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  approval_artifact_id: string | null;
}

interface JsonApprovalArtifact {
  schema_version: number;
  kind: "approval_artifact";
  id: string;
  project_id: string;
  pending_operation_id: string;
  action_type: L3ActionType;
  target_id: string;
  digest: JsonOperationDigest;
  status: ApprovalArtifactStatus;
  approver: JsonActor;
  decision_ref: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

type JsonDocumentPayload =
  | JsonProject
  | JsonCurrentRef
  | JsonVersion
  | JsonWorkItem
  | JsonTodo
  | JsonUndo
  | JsonDeferredItem
  | JsonConstraint
  | JsonAsset
  | JsonTransitionEvent
  | JsonPendingOperation
  | JsonApprovalArtifact;

const compareByString = (left: string, right: string): number => left.localeCompare(right, "en");

const createCanonicalContent = (value: JsonDocumentPayload): string =>
  `${JSON.stringify(stripUndefined(value), null, 2)}\n`;

const stripUndefined = (value: JsonValue | { [key: string]: unknown } | unknown[] | unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry));
  }

  if (typeof value === "object") {
    const cleaned: { [key: string]: JsonValue } = {};

    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        cleaned[key] = stripUndefined(entry);
      }
    }

    return cleaned;
  }

  throw new Error(`unsupported JSON value: ${String(value)}`);
};

const sortJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareByString(left, right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }

  throw new Error(`unsupported JSON freeform value: ${String(value)}`);
};

const toSnakeCaseKey = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const toCamelCaseKey = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const transformObjectKeysDeep = (
  value: unknown,
  keyTransformer: (key: string) => string
): JsonValue | Record<string, unknown> | unknown[] | unknown => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => transformObjectKeysDeep(entry, keyTransformer));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [keyTransformer(key), transformObjectKeysDeep(entry, keyTransformer)])
    );
  }

  throw new Error(`unsupported JSON freeform value: ${String(value)}`);
};

const encodeDigestPayload = (payload: OperationDigest["payload"]): Record<string, JsonValue> =>
  sortJsonValue(transformObjectKeysDeep(payload, toSnakeCaseKey)) as Record<string, JsonValue>;

const decodeDigestPayload = (
  payload: JsonOperationDigest["payload"]
): OperationDigest["payload"] => {
  const decoded = transformObjectKeysDeep(
    payload,
    toCamelCaseKey
  ) as Record<string, unknown>;
  const gateSnapshot = decoded.gateSnapshot;

  if (
    gateSnapshot !== null &&
    typeof gateSnapshot === "object" &&
    !Array.isArray(gateSnapshot)
  ) {
    const gate = gateSnapshot as Record<string, unknown>;

    if (gate.kind === "start") {
      gate.dueDeferredIds ??= [];
      gate.blockedConstraintIds ??= [];
    } else if (gate.kind === "close") {
      gate.unresolvedDeferredIds ??= [];
      gate.blockedConstraintIds ??= [];
    } else if (
      gate.kind === "shutdown" &&
      gate.ordinaryCloseGate !== null &&
      typeof gate.ordinaryCloseGate === "object" &&
      !Array.isArray(gate.ordinaryCloseGate)
    ) {
      const ordinaryCloseGate = gate.ordinaryCloseGate as Record<
        string,
        unknown
      >;
      ordinaryCloseGate.unresolvedDeferredIds ??= [];
      ordinaryCloseGate.blockedConstraintIds ??= [];
    }
  }

  return decoded;
};

const encodeMetadataPayload = (payload: Record<string, unknown>): Record<string, JsonValue> =>
  sortJsonValue(transformObjectKeysDeep(payload, toSnakeCaseKey)) as Record<string, JsonValue>;

const decodeMetadataPayload = (payload: Record<string, JsonValue>): Record<string, unknown> =>
  transformObjectKeysDeep(payload, toCamelCaseKey) as Record<string, unknown>;

const encodeActor = (actor: Actor): JsonActor => ({
  id: actor.id,
  type: actor.type,
  display_name: actor.displayName
});

const decodeActor = (actor: JsonActor): Actor => ({
  id: actor.id,
  type: actor.type,
  displayName: actor.display_name
});

const encodeProjectSettings = (settings: ProjectSettings): JsonProjectSettings => ({
  enforce_start_gate: settings.enforceStartGate,
  enforce_close_gate: settings.enforceCloseGate,
  context_budget_bytes: settings.contextBudgetBytes,
  content_locale: settings.contentLocale
});

const decodeProjectSettings = (settings: JsonProjectSettings): ProjectSettings => ({
  enforceStartGate: settings.enforce_start_gate,
  enforceCloseGate: settings.enforce_close_gate,
  contextBudgetBytes: settings.context_budget_bytes,
  contentLocale:
    typeof settings.content_locale === "string" ? settings.content_locale : null
});

const encodeGateSnapshot = (snapshot: GateSnapshot): JsonGateSnapshot => {
  if (snapshot.kind === "start") {
    return {
      kind: "start",
      evaluated_at: snapshot.evaluatedAt,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        record_ids: blocker.recordIds
      })),
      open_todo_ids: snapshot.openTodoIds,
      due_undo_ids: snapshot.dueUndoIds,
      due_deferred_ids: snapshot.dueDeferredIds,
      missing_decision_refs: snapshot.missingDecisionRefs,
      blocked_constraint_ids: snapshot.blockedConstraintIds
    };
  }

  if (snapshot.kind === "close") {
    return {
      kind: "close",
      evaluated_at: snapshot.evaluatedAt,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        record_ids: blocker.recordIds
      })),
      unresolved_todo_ids: snapshot.unresolvedTodoIds,
      unresolved_undo_ids: snapshot.unresolvedUndoIds,
      unresolved_deferred_ids: snapshot.unresolvedDeferredIds,
      blocked_constraint_ids: snapshot.blockedConstraintIds,
      residual_audit: snapshot.residualAudit?.map((item) => ({
        kind: item.kind,
        summary: item.summary,
        destination: item.destination,
        preferred_resolution_version_id: item.preferredResolutionVersionId,
        target_review_version_id: item.targetReviewVersionId
      })) ?? null,
      ...(snapshot.residualAuditReviewed === true
        ? { residual_audit_reviewed: true }
        : {})
    };
  }

  if (snapshot.kind === "shutdown") {
    return {
      kind: "shutdown",
      evaluated_at: snapshot.evaluatedAt,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        record_ids: blocker.recordIds
      })),
      forced: true,
      state_reason: snapshot.stateReason,
      ordinary_close_gate: {
        allowed: snapshot.ordinaryCloseGate.allowed,
        blockers: snapshot.ordinaryCloseGate.blockers.map((blocker) => ({
          code: blocker.code,
          message: blocker.message,
          record_ids: blocker.recordIds
        })),
        unresolved_todo_ids: snapshot.ordinaryCloseGate.unresolvedTodoIds,
        unresolved_undo_ids: snapshot.ordinaryCloseGate.unresolvedUndoIds,
        unresolved_deferred_ids: snapshot.ordinaryCloseGate.unresolvedDeferredIds,
        blocked_constraint_ids: snapshot.ordinaryCloseGate.blockedConstraintIds
      }
    };
  }

  return {
    kind: "none",
    evaluated_at: snapshot.evaluatedAt,
    allowed: snapshot.allowed,
    blockers: []
  };
};

const decodeGateSnapshot = (snapshot: JsonGateSnapshot): GateSnapshot => {
  if (snapshot.kind === "start") {
    return {
      kind: "start",
      evaluatedAt: snapshot.evaluated_at,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        recordIds: blocker.record_ids
      })),
      openTodoIds: snapshot.open_todo_ids,
      dueUndoIds: snapshot.due_undo_ids,
      dueDeferredIds: snapshot.due_deferred_ids ?? [],
      missingDecisionRefs: snapshot.missing_decision_refs,
      blockedConstraintIds: snapshot.blocked_constraint_ids ?? []
    };
  }

  if (snapshot.kind === "close") {
    return {
      kind: "close",
      evaluatedAt: snapshot.evaluated_at,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        recordIds: blocker.record_ids
      })),
      unresolvedTodoIds: snapshot.unresolved_todo_ids,
      unresolvedUndoIds: snapshot.unresolved_undo_ids,
      unresolvedDeferredIds: snapshot.unresolved_deferred_ids ?? [],
      blockedConstraintIds: snapshot.blocked_constraint_ids ?? [],
      residualAudit: snapshot.residual_audit?.map((item) => ({
        kind: item.kind,
        summary: item.summary,
        destination: item.destination,
        preferredResolutionVersionId: item.preferred_resolution_version_id,
        targetReviewVersionId: item.target_review_version_id
      })) ?? null,
      ...(snapshot.residual_audit_reviewed === true
        ? { residualAuditReviewed: true }
        : {})
    };
  }

  if (snapshot.kind === "shutdown") {
    return {
      kind: "shutdown",
      evaluatedAt: snapshot.evaluated_at,
      allowed: snapshot.allowed,
      blockers: snapshot.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        recordIds: blocker.record_ids
      })),
      forced: true,
      stateReason: snapshot.state_reason,
      ordinaryCloseGate: {
        allowed: snapshot.ordinary_close_gate.allowed,
        blockers: snapshot.ordinary_close_gate.blockers.map((blocker) => ({
          code: blocker.code,
          message: blocker.message,
          recordIds: blocker.record_ids
        })),
        unresolvedTodoIds: snapshot.ordinary_close_gate.unresolved_todo_ids,
        unresolvedUndoIds: snapshot.ordinary_close_gate.unresolved_undo_ids,
        unresolvedDeferredIds:
          snapshot.ordinary_close_gate.unresolved_deferred_ids ?? [],
        blockedConstraintIds:
          snapshot.ordinary_close_gate.blocked_constraint_ids ?? []
      }
    };
  }

  return {
    kind: "none",
    evaluatedAt: snapshot.evaluated_at,
    allowed: true,
    blockers: []
  };
};

const encodeDigest = (digest: OperationDigest): JsonOperationDigest => ({
  algorithm: digest.algorithm,
  value: digest.value,
  payload: encodeDigestPayload(digest.payload)
});

const decodeDigest = (digest: JsonOperationDigest): OperationDigest => ({
  algorithm: digest.algorithm,
  value: digest.value,
  payload: decodeDigestPayload(digest.payload)
});

const encodeBatchCreateVersionsAnchor = (
  anchor: BatchCreateVersionsAnchor
): JsonBatchCreateVersionsAnchor =>
  stripUndefined({
    parent_version_id: anchor.parentVersionId,
    after_version_id: anchor.afterVersionId,
    before_version_id: anchor.beforeVersionId
  }) as JsonBatchCreateVersionsAnchor;

const decodeBatchCreateVersionsAnchor = (
  anchor: JsonValue | undefined
): BatchCreateVersionsAnchor | undefined => {
  if (anchor === undefined || anchor === null || Array.isArray(anchor) || typeof anchor !== "object") {
    return undefined;
  }

  const record = anchor as Record<string, JsonValue>;
  return {
    parentVersionId:
      typeof record.parent_version_id === "string" || record.parent_version_id === null
        ? record.parent_version_id
        : undefined,
    afterVersionId:
      typeof record.after_version_id === "string" || record.after_version_id === null
        ? record.after_version_id
        : undefined,
    beforeVersionId:
      typeof record.before_version_id === "string" || record.before_version_id === null
        ? record.before_version_id
        : undefined
  };
};

const encodeBatchCreateVersionsItems = (
  items: BatchCreateVersionsItemInput[]
): JsonBatchCreateVersionsItem[] =>
  items.map((item) => ({
    client_key: item.clientKey,
    title: item.title,
    description: item.description,
    initial_todos: item.initialTodos
  }));

const decodeBatchCreateVersionsItems = (
  items: JsonValue | undefined
): BatchCreateVersionsItemInput[] | undefined => {
  if (!Array.isArray(items)) {
    return undefined;
  }

  return items.map((item) => {
    const record = item as Record<string, JsonValue>;
    return {
      clientKey: String(record.client_key),
      title: String(record.title),
      description: String(record.description),
      initialTodos: Array.isArray(record.initial_todos)
        ? record.initial_todos.map((entry) => String(entry))
        : []
    };
  });
};

const encodeBatchCreateVersionsNormalizedPlan = (
  items: BatchCreateVersionsNormalizedItem[]
): JsonBatchCreateVersionsNormalizedItem[] =>
  items.map((item) => ({
    index: item.index,
    client_key: item.clientKey,
    preview_version_id: item.previewVersionId,
    title: item.title,
    description: item.description,
    parent_version_id: item.parentVersionId,
    previous_ref: item.previousRef,
    next_ref: item.nextRef,
    initial_todos: item.initialTodos
  }));

const decodeBatchCreateVersionsNormalizedPlan = (
  items: JsonValue | undefined
): BatchCreateVersionsNormalizedItem[] | undefined => {
  if (!Array.isArray(items)) {
    return undefined;
  }

  return items.map((item) => {
    const record = item as Record<string, JsonValue>;
    return {
      index: Number(record.index),
      clientKey: String(record.client_key),
      previewVersionId: String(record.preview_version_id),
      title: String(record.title),
      description: String(record.description),
      parentVersionId:
        typeof record.parent_version_id === "string" || record.parent_version_id === null
          ? record.parent_version_id
          : null,
      previousRef:
        typeof record.previous_ref === "string" || record.previous_ref === null
          ? record.previous_ref
          : null,
      nextRef:
        typeof record.next_ref === "string" || record.next_ref === null
          ? record.next_ref
          : null,
      initialTodos: Array.isArray(record.initial_todos)
        ? record.initial_todos.map((entry) => String(entry))
        : []
    };
  });
};

const encodeBatchCreateVersionsResolvedAnchors = (
  anchors: BatchCreateVersionsResolvedAnchors
): JsonBatchCreateVersionsResolvedAnchors => ({
  parent_version_id: anchors.parentVersionId,
  after_version_id: anchors.afterVersionId,
  before_version_id: anchors.beforeVersionId
});

const decodeBatchCreateVersionsResolvedAnchors = (
  anchors: JsonValue | undefined
): BatchCreateVersionsResolvedAnchors | undefined => {
  if (anchors === undefined || anchors === null || Array.isArray(anchors) || typeof anchors !== "object") {
    return undefined;
  }

  const record = anchors as Record<string, JsonValue>;
  return {
    parentVersionId:
      typeof record.parent_version_id === "string" || record.parent_version_id === null
        ? record.parent_version_id
        : null,
    afterVersionId:
      typeof record.after_version_id === "string" || record.after_version_id === null
        ? record.after_version_id
        : null,
    beforeVersionId:
      typeof record.before_version_id === "string" || record.before_version_id === null
        ? record.before_version_id
        : null
  };
};

const encodePendingOperationPayload = (
  payload: PendingOperationPayload
): JsonPendingOperationPayload =>
  stripUndefined({
    current_version_id: payload.currentVersionId,
    residual_audit:
      payload.residualAudit?.map((item) => ({
        kind: item.kind,
        summary: item.summary,
        destination: item.destination,
        preferred_resolution_version_id: item.preferredResolutionVersionId,
        target_review_version_id: item.targetReviewVersionId
      })) ?? undefined,
    ...(payload.residualAuditReviewed === true
      ? { residual_audit_reviewed: true }
      : {}),
    shutdown_reason: payload.shutdownReason,
    title: payload.title,
    description: payload.description,
    parent_version_id: payload.parentVersionId,
    previous_version_id: payload.previousVersionId,
    next_version_id: payload.nextVersionId,
    sibling_version_ids: payload.siblingVersionIds,
    batch_items:
      payload.batchItems === undefined
        ? undefined
        : encodeBatchCreateVersionsItems(payload.batchItems),
    batch_anchor:
      payload.batchAnchor === undefined
        ? undefined
        : encodeBatchCreateVersionsAnchor(payload.batchAnchor),
    batch_normalized_plan:
      payload.batchNormalizedPlan === undefined
        ? undefined
        : encodeBatchCreateVersionsNormalizedPlan(payload.batchNormalizedPlan),
    batch_resolved_anchors:
      payload.batchResolvedAnchors === undefined
        ? undefined
        : encodeBatchCreateVersionsResolvedAnchors(payload.batchResolvedAnchors),
    batch_set_current_to: payload.batchSetCurrentTo,
    batch_previous_current_policy: payload.batchPreviousCurrentPolicy,
    batch_preflight_snapshot_hash: payload.batchPreflightSnapshotHash
  }) as JsonPendingOperationPayload;

const decodePendingOperationPayload = (
  payload: JsonPendingOperationPayload
): PendingOperationPayload => {
  const decoded: PendingOperationPayload = {
    currentVersionId:
      typeof payload.current_version_id === "string" ||
      payload.current_version_id === null
        ? payload.current_version_id
        : undefined,
    residualAudit: Array.isArray(payload.residual_audit)
      ? payload.residual_audit.map((item) => {
          const auditItem = item as Record<string, unknown>;

          return {
            kind: auditItem.kind as "bug" | "risk" | "open_question" | "debt",
            summary: auditItem.summary as string,
            destination: auditItem.destination as
              | "close"
              | "create_undo"
              | "create_todo"
              | "defer_work"
              | "record_constraint"
              | null,
            preferredResolutionVersionId:
              auditItem.preferred_resolution_version_id as
                | string
                | null
                | undefined,
            targetReviewVersionId:
              auditItem.target_review_version_id as
                | string
                | null
                | undefined
          };
        })
      : payload.residual_audit === null
        ? null
        : undefined,
    ...(payload.residual_audit_reviewed === true
      ? { residualAuditReviewed: true }
      : {}),
    shutdownReason:
      typeof payload.shutdown_reason === "string"
        ? payload.shutdown_reason
        : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined,
    description:
      typeof payload.description === "string" ? payload.description : undefined,
    parentVersionId:
      typeof payload.parent_version_id === "string" ||
      payload.parent_version_id === null
        ? payload.parent_version_id
        : undefined,
    previousVersionId:
      typeof payload.previous_version_id === "string" ||
      payload.previous_version_id === null
        ? payload.previous_version_id
        : undefined,
    nextVersionId:
      typeof payload.next_version_id === "string" ||
      payload.next_version_id === null
        ? payload.next_version_id
        : undefined,
    siblingVersionIds: Array.isArray(payload.sibling_version_ids)
      ? payload.sibling_version_ids.map((entry) => String(entry))
      : undefined,
    batchItems: decodeBatchCreateVersionsItems(payload.batch_items),
    batchAnchor: decodeBatchCreateVersionsAnchor(payload.batch_anchor),
    batchNormalizedPlan: decodeBatchCreateVersionsNormalizedPlan(
      payload.batch_normalized_plan
    ),
    batchResolvedAnchors: decodeBatchCreateVersionsResolvedAnchors(
      payload.batch_resolved_anchors
    ),
    batchSetCurrentTo:
      typeof payload.batch_set_current_to === "string" ||
      payload.batch_set_current_to === null
        ? payload.batch_set_current_to
        : undefined,
    batchPreviousCurrentPolicy:
      payload.batch_previous_current_policy === "leave_as_is" ||
      payload.batch_previous_current_policy === "require_complete_or_close"
        ? (payload.batch_previous_current_policy as BatchPreviousCurrentPolicy)
        : undefined,
    batchPreflightSnapshotHash:
      typeof payload.batch_preflight_snapshot_hash === "string"
        ? payload.batch_preflight_snapshot_hash
        : undefined
  };

  return Object.fromEntries(
    Object.entries(decoded).filter(([, value]) => value !== undefined)
  ) as PendingOperationPayload;
};

const parseDocument = <T extends JsonDocumentPayload>(document: RouteLedgerJsonDocument): T =>
  JSON.parse(document.content) as T;

const createDocument = (path: string, payload: JsonDocumentPayload): RouteLedgerJsonDocument => ({
  path,
  content: createCanonicalContent(payload)
});

const getIdPrefix = (id: string): string => id.slice(0, 2).padEnd(2, "_");

const getVersionDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/versions/${getIdPrefix(id)}/${id}.json`;

const getWorkItemDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/work_items/${getIdPrefix(id)}/${id}.json`;

const getTodoDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/todos/${getIdPrefix(id)}/${id}.json`;

const getUndoDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/undos/${getIdPrefix(id)}/${id}.json`;

const getDeferredItemDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/deferred_items/${getIdPrefix(id)}/${id}.json`;

const getConstraintDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/constraints/${getIdPrefix(id)}/${id}.json`;

const getAssetDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/assets/${getIdPrefix(id)}/${id}.json`;

const getPendingOperationDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/pending_operations/${getIdPrefix(id)}/${id}.json`;

const getApprovalArtifactDocumentPath = (id: string): string =>
  `${ROUTELEDGER_JSON_ROOT}/approval_artifacts/${getIdPrefix(id)}/${id}.json`;

const getEventDocumentPath = (event: Pick<TransitionEvent, "id" | "createdAt">): string => {
  const match = /^(\d{4})-(\d{2})/.exec(event.createdAt);

  if (match === null) {
    throw new Error(`invalid event createdAt: ${event.createdAt}`);
  }

  const [, year, month] = match;

  return `${ROUTELEDGER_JSON_ROOT}/events/${year}/${month}/${event.id}.json`;
};

const encodeProject = (project: Project): JsonProject => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "project",
  id: project.id,
  name: project.name,
  description: project.description,
  status: project.status,
  current_version_id: project.currentVersionId,
  initial_version_id: project.initialVersionId,
  created_by: encodeActor(project.createdBy),
  created_at: project.createdAt,
  updated_at: project.updatedAt,
  archived_at: project.archivedAt,
  settings: encodeProjectSettings(project.settings)
});

const decodeProject = (project: JsonProject): Project => ({
  id: project.id,
  name: project.name,
  description: project.description,
  status: project.status,
  currentVersionId: project.current_version_id,
  initialVersionId: project.initial_version_id,
  createdBy: decodeActor(project.created_by),
  createdAt: project.created_at,
  updatedAt: project.updated_at,
  archivedAt: project.archived_at,
  settings: decodeProjectSettings(project.settings)
});

const encodeVersion = (version: Version): JsonVersion => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "version",
  id: version.id,
  project_id: version.projectId,
  title: version.title,
  description: version.description,
  state: version.state,
  parent_version_id: version.parentVersionId,
  previous_version_id: version.previousVersionId,
  next_version_id: version.nextVersionId,
  order: version.order,
  is_current: version.isCurrent,
  created_by: encodeActor(version.createdBy),
  created_at: version.createdAt,
  updated_at: version.updatedAt,
  closed_at: version.closedAt,
  state_reason: version.stateReason
});

const decodeVersion = (version: JsonVersion): Version => ({
  id: version.id,
  projectId: version.project_id,
  title: version.title,
  description: version.description,
  state: version.state,
  parentVersionId: version.parent_version_id,
  previousVersionId: version.previous_version_id,
  nextVersionId: version.next_version_id,
  order: version.order,
  isCurrent: version.is_current,
  createdBy: decodeActor(version.created_by),
  createdAt: version.created_at,
  updatedAt: version.updated_at,
  closedAt: version.closed_at,
  stateReason: version.state_reason
});

const encodeWorkItem = (workItem: WorkItem): JsonWorkItem => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "work_item",
  id: workItem.id,
  project_id: workItem.projectId,
  title: workItem.title,
  type: workItem.type,
  status: workItem.status,
  origin_version_id: workItem.originVersionId,
  active_record_type: workItem.activeRecordType,
  active_record_id: workItem.activeRecordId,
  created_by: encodeActor(workItem.createdBy),
  created_at: workItem.createdAt,
  updated_at: workItem.updatedAt,
  closed_at: workItem.closedAt,
  summary: workItem.summary
});

const decodeWorkItem = (workItem: JsonWorkItem): WorkItem => ({
  id: workItem.id,
  projectId: workItem.project_id,
  title: workItem.title,
  type: workItem.type,
  status: workItem.status,
  originVersionId: workItem.origin_version_id,
  activeRecordType: workItem.active_record_type,
  activeRecordId: workItem.active_record_id,
  createdBy: decodeActor(workItem.created_by),
  createdAt: workItem.created_at,
  updatedAt: workItem.updated_at,
  closedAt: workItem.closed_at,
  summary: workItem.summary
});

const encodeTodo = (todo: Todo): JsonTodo => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "todo",
  id: todo.id,
  project_id: todo.projectId,
  work_item_id: todo.workItemId,
  version_id: todo.versionId,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  source_type: todo.sourceType,
  source_id: todo.sourceId,
  created_by: encodeActor(todo.createdBy),
  created_at: todo.createdAt,
  updated_at: todo.updatedAt,
  closed_at: todo.closedAt,
  close_reason: todo.closeReason,
  close_note: todo.closeNote
});

const decodeTodo = (todo: JsonTodo): Todo => ({
  id: todo.id,
  projectId: todo.project_id,
  workItemId: todo.work_item_id,
  versionId: todo.version_id,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  sourceType: todo.source_type,
  sourceId: todo.source_id,
  createdBy: decodeActor(todo.created_by),
  createdAt: todo.created_at,
  updatedAt: todo.updated_at,
  closedAt: todo.closed_at,
  closeReason: todo.close_reason,
  closeNote: todo.close_note
});

const encodeUndo = (undo: Undo): JsonUndo => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "undo",
  id: undo.id,
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
  created_by: encodeActor(undo.createdBy),
  created_at: undo.createdAt,
  updated_at: undo.updatedAt,
  carried_forward_at: undo.carriedForwardAt,
  carried_forward_to_version_id: undo.carriedForwardToVersionId,
  closed_at: undo.closedAt,
  close_reason: undo.closeReason,
  close_note: undo.closeNote
});

const decodeUndo = (undo: JsonUndo): Undo => ({
  id: undo.id,
  projectId: undo.project_id,
  workItemId: undo.work_item_id,
  versionId: undo.version_id,
  originVersionId: undo.origin_version_id,
  preferredResolutionVersionId: undo.preferred_resolution_version_id,
  sourceType: undo.source_type,
  sourceId: undo.source_id,
  title: undo.title,
  description: undo.description,
  status: undo.status,
  reason: undo.reason,
  triggerCondition: undo.trigger_condition,
  createdBy: decodeActor(undo.created_by),
  createdAt: undo.created_at,
  updatedAt: undo.updated_at,
  carriedForwardAt: undo.carried_forward_at ?? null,
  carriedForwardToVersionId: undo.carried_forward_to_version_id ?? null,
  closedAt: undo.closed_at,
  closeReason: undo.close_reason,
  closeNote: undo.close_note
});

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonBlankJsonString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isNullableJsonString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const hasValidJsonActorShape = (value: unknown): value is JsonActor =>
  isJsonRecord(value) &&
  isNonBlankJsonString(value.id) &&
  (value.type === "user" || value.type === "agent" || value.type === "system") &&
  (value.display_name === undefined || typeof value.display_name === "string");

function assertDeferredItemJsonShape(
  value: unknown
): asserts value is JsonDeferredItem {
  if (!isJsonRecord(value)) {
    throw new Error("deferred_item document must be an object");
  }

  const requiredNonBlankFields = [
    "id",
    "project_id",
    "work_item_id",
    "origin_version_id",
    "target_review_version_id",
    "title",
    "reason",
    "created_at",
    "updated_at"
  ] as const;
  const nullableStringFields = [
    "review_trigger",
    "resolution_reason",
    "resolution_note",
    "decision_ref",
    "activated_todo_id",
    "reviewed_at"
  ] as const;

  if (
    value.kind !== "deferred_item" ||
    typeof value.schema_version !== "number" ||
    requiredNonBlankFields.some(
      (field) => !isNonBlankJsonString(value[field])
    ) ||
    typeof value.description !== "string" ||
    nullableStringFields.some(
      (field) => !isNullableJsonString(value[field])
    ) ||
    (value.status !== "pending" &&
      value.status !== "activated" &&
      value.status !== "resolved") ||
    (value.resolution_outcome !== null &&
      value.resolution_outcome !== "activated" &&
      value.resolution_outcome !== "superseded" &&
      value.resolution_outcome !== "rejected" &&
      value.resolution_outcome !== "out_of_scope") ||
    !hasValidJsonActorShape(value.created_by)
  ) {
    throw new Error(
      "deferred_item document has invalid required fields, types, or enums"
    );
  }
}

function assertConstraintJsonShape(
  value: unknown
): asserts value is JsonConstraint {
  if (!isJsonRecord(value)) {
    throw new Error("constraint document must be an object");
  }

  const scope = value.scope;
  const scopeIsValid =
    isJsonRecord(scope) &&
    ((scope.type === "project" && scope.version_id === undefined) ||
      (scope.type === "version" &&
        isNonBlankJsonString(scope.version_id)));

  if (
    value.kind !== "constraint" ||
    typeof value.schema_version !== "number" ||
    !isNonBlankJsonString(value.id) ||
    !isNonBlankJsonString(value.project_id) ||
    !isNonBlankJsonString(value.rule) ||
    !isNonBlankJsonString(value.rationale) ||
    !scopeIsValid ||
    (value.status !== "active" && value.status !== "retired") ||
    !hasValidJsonActorShape(value.created_by) ||
    !isNonBlankJsonString(value.created_at) ||
    !isNonBlankJsonString(value.updated_at) ||
    !isNullableJsonString(value.retired_at) ||
    !isNullableJsonString(value.retire_reason) ||
    !isNullableJsonString(value.retire_note)
  ) {
    throw new Error(
      "constraint document has invalid required fields, types, enums, or scope"
    );
  }
}

const encodeDeferredItem = (deferredItem: DeferredItem): JsonDeferredItem => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "deferred_item",
  id: deferredItem.id,
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
  created_by: encodeActor(deferredItem.createdBy),
  created_at: deferredItem.createdAt,
  updated_at: deferredItem.updatedAt,
  reviewed_at: deferredItem.reviewedAt
});

const decodeDeferredItem = (value: JsonDeferredItem): DeferredItem => {
  assertDeferredItemJsonShape(value);

  return {
    id: value.id,
    projectId: value.project_id,
    workItemId: value.work_item_id,
    originVersionId: value.origin_version_id,
    targetReviewVersionId: value.target_review_version_id,
    title: value.title,
    description: value.description,
    status: value.status,
    reason: value.reason,
    reviewTrigger: value.review_trigger,
    resolutionOutcome: value.resolution_outcome,
    resolutionReason: value.resolution_reason,
    resolutionNote: value.resolution_note,
    decisionRef: value.decision_ref,
    activatedTodoId: value.activated_todo_id,
    createdBy: decodeActor(value.created_by),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    reviewedAt: value.reviewed_at
  };
};

const encodeConstraintScope = (scope: ConstraintScope): JsonConstraintScope =>
  scope.type === "version"
    ? {
        type: "version",
        version_id: scope.versionId
      }
    : {
        type: "project"
      };

const decodeConstraintScope = (scope: JsonConstraintScope): ConstraintScope => {
  if (scope.type === "project" && scope.version_id === undefined) {
    return {
      type: "project"
    };
  }

  if (
    scope.type === "version" &&
    typeof scope.version_id === "string" &&
    scope.version_id.trim().length > 0
  ) {
    return {
      type: "version",
      versionId: scope.version_id
    };
  }

  throw new Error("constraint scope must be project or a version with version_id");
};

const encodeConstraint = (constraint: Constraint): JsonConstraint => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "constraint",
  id: constraint.id,
  project_id: constraint.projectId,
  rule: constraint.rule,
  rationale: constraint.rationale,
  scope: encodeConstraintScope(constraint.scope),
  status: constraint.status,
  created_by: encodeActor(constraint.createdBy),
  created_at: constraint.createdAt,
  updated_at: constraint.updatedAt,
  retired_at: constraint.retiredAt,
  retire_reason: constraint.retireReason,
  retire_note: constraint.retireNote
});

const decodeConstraint = (value: JsonConstraint): Constraint => {
  assertConstraintJsonShape(value);

  return {
    id: value.id,
    projectId: value.project_id,
    rule: value.rule,
    rationale: value.rationale,
    scope: decodeConstraintScope(value.scope),
    status: value.status,
    createdBy: decodeActor(value.created_by),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    retiredAt: value.retired_at,
    retireReason: value.retire_reason,
    retireNote: value.retire_note
  };
};

const encodeAssetPathHistoryEntry = (entry: AssetPathHistoryEntry): JsonAssetPathHistoryEntry => ({
  path_base: entry.pathBase,
  relative_path: entry.relativePath,
  recorded_at: entry.recordedAt
});

const decodeAssetPathHistoryEntry = (entry: JsonAssetPathHistoryEntry): AssetPathHistoryEntry => ({
  pathBase: entry.path_base,
  relativePath: entry.relative_path,
  recordedAt: entry.recorded_at
});

const encodeAsset = (asset: Asset): JsonAsset => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "asset",
  id: asset.id,
  project_id: asset.projectId,
  work_item_ids: asset.workItemIds,
  path_base: asset.pathBase,
  relative_path: asset.relativePath,
  status: asset.status,
  path_history: asset.pathHistory.map(encodeAssetPathHistoryEntry),
  created_by: encodeActor(asset.createdBy),
  created_at: asset.createdAt,
  updated_at: asset.updatedAt
});

const decodeAsset = (asset: JsonAsset): Asset => ({
  id: asset.id,
  projectId: asset.project_id,
  workItemIds: asset.work_item_ids,
  pathBase: asset.path_base,
  relativePath: asset.relative_path,
  status: asset.status,
  pathHistory: asset.path_history.map(decodeAssetPathHistoryEntry),
  createdBy: decodeActor(asset.created_by),
  createdAt: asset.created_at,
  updatedAt: asset.updated_at
});

const encodeTransitionEvent = (event: TransitionEvent): JsonTransitionEvent => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "transition_event",
  id: event.id,
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
  metadata: encodeMetadataPayload(event.metadata)
});

const decodeTransitionEvent = (event: JsonTransitionEvent): TransitionEvent => ({
  id: event.id,
  projectId: event.project_id,
  operationId: event.operation_id,
  operationSeq: event.operation_seq,
  targetType: event.target_type,
  targetId: event.target_id,
  eventType: event.event_type,
  fromState: event.from_state,
  toState: event.to_state,
  note: event.note,
  actorId: event.actor_id,
  actorType: event.actor_type,
  actorDisplayName: event.actor_display_name,
  createdAt: event.created_at,
  metadata: decodeMetadataPayload(event.metadata)
});

const encodePendingOperation = (operation: PendingOperation): JsonPendingOperation => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "pending_operation",
  id: operation.id,
  project_id: operation.projectId,
  action_type: operation.actionType,
  target_id: operation.targetId,
  status: operation.status,
  reason: operation.reason,
  gate_snapshot: encodeGateSnapshot(operation.gateSnapshot),
  digest: encodeDigest(operation.digest),
  payload: encodePendingOperationPayload(operation.payload),
  created_by: encodeActor(operation.createdBy),
  created_at: operation.createdAt,
  updated_at: operation.updatedAt,
  committed_at: operation.committedAt,
  rejected_at: operation.rejectedAt,
  rejection_reason: operation.rejectionReason,
  approval_artifact_id: operation.approvalArtifactId
});

const decodePendingOperation = (operation: JsonPendingOperation): PendingOperation => ({
  id: operation.id,
  projectId: operation.project_id,
  actionType: operation.action_type,
  targetId: operation.target_id,
  status: operation.status,
  reason: operation.reason,
  gateSnapshot: decodeGateSnapshot(operation.gate_snapshot),
  digest: decodeDigest(operation.digest),
  payload: decodePendingOperationPayload(operation.payload),
  createdBy: decodeActor(operation.created_by),
  createdAt: operation.created_at,
  updatedAt: operation.updated_at,
  committedAt: operation.committed_at,
  rejectedAt: operation.rejected_at,
  rejectionReason: operation.rejection_reason,
  approvalArtifactId: operation.approval_artifact_id
});

const encodeApprovalArtifact = (artifact: ApprovalArtifact): JsonApprovalArtifact => ({
  schema_version: ROUTELEDGER_SCHEMA_VERSION,
  kind: "approval_artifact",
  id: artifact.id,
  project_id: artifact.projectId,
  pending_operation_id: artifact.pendingOperationId,
  action_type: artifact.actionType,
  target_id: artifact.targetId,
  digest: encodeDigest(artifact.digest),
  status: artifact.status,
  approver: encodeActor(artifact.approver),
  decision_ref: artifact.decisionRef,
  created_at: artifact.createdAt,
  expires_at: artifact.expiresAt,
  consumed_at: artifact.consumedAt
});

const decodeApprovalArtifact = (artifact: JsonApprovalArtifact): ApprovalArtifact => ({
  id: artifact.id,
  projectId: artifact.project_id,
  pendingOperationId: artifact.pending_operation_id,
  actionType: artifact.action_type,
  targetId: artifact.target_id,
  digest: decodeDigest(artifact.digest),
  status: artifact.status,
  approver: decodeActor(artifact.approver),
  decisionRef: artifact.decision_ref,
  createdAt: artifact.created_at,
  expiresAt: artifact.expires_at,
  consumedAt: artifact.consumed_at
});

export const encodeProjectAggregateToJsonDocuments = (
  snapshot: ProjectAggregateSnapshot
): RouteLedgerJsonDocument[] => {
  const documents: RouteLedgerJsonDocument[] = [
    buildRouteLedgerSchemaDocument(),
    createDocument(PROJECT_DOCUMENT_PATH, encodeProject(snapshot.project)),
    createDocument(CURRENT_REF_DOCUMENT_PATH, {
      schema_version: ROUTELEDGER_SCHEMA_VERSION,
      kind: "current_ref",
      project_id: snapshot.project.id,
      current_version_id: snapshot.project.currentVersionId
    })
  ];

  for (const version of [...snapshot.versions].sort((left, right) =>
    compareByString(getVersionDocumentPath(left.id), getVersionDocumentPath(right.id))
  )) {
    documents.push(createDocument(getVersionDocumentPath(version.id), encodeVersion(version)));
  }

  for (const workItem of [...snapshot.workItems].sort((left, right) =>
    compareByString(getWorkItemDocumentPath(left.id), getWorkItemDocumentPath(right.id))
  )) {
    documents.push(createDocument(getWorkItemDocumentPath(workItem.id), encodeWorkItem(workItem)));
  }

  for (const todo of [...snapshot.todos].sort((left, right) =>
    compareByString(getTodoDocumentPath(left.id), getTodoDocumentPath(right.id))
  )) {
    documents.push(createDocument(getTodoDocumentPath(todo.id), encodeTodo(todo)));
  }

  for (const undo of [...snapshot.undos].sort((left, right) =>
    compareByString(getUndoDocumentPath(left.id), getUndoDocumentPath(right.id))
  )) {
    documents.push(createDocument(getUndoDocumentPath(undo.id), encodeUndo(undo)));
  }

  for (const deferredItem of [...snapshot.deferredItems].sort((left, right) =>
    compareByString(
      getDeferredItemDocumentPath(left.id),
      getDeferredItemDocumentPath(right.id)
    )
  )) {
    documents.push(
      createDocument(
        getDeferredItemDocumentPath(deferredItem.id),
        encodeDeferredItem(deferredItem)
      )
    );
  }

  for (const constraint of [...snapshot.constraints].sort((left, right) =>
    compareByString(getConstraintDocumentPath(left.id), getConstraintDocumentPath(right.id))
  )) {
    documents.push(
      createDocument(getConstraintDocumentPath(constraint.id), encodeConstraint(constraint))
    );
  }

  for (const asset of [...snapshot.assets].sort((left, right) =>
    compareByString(getAssetDocumentPath(left.id), getAssetDocumentPath(right.id))
  )) {
    documents.push(createDocument(getAssetDocumentPath(asset.id), encodeAsset(asset)));
  }

  for (const event of [...snapshot.events].sort((left, right) =>
    compareByString(getEventDocumentPath(left), getEventDocumentPath(right))
  )) {
    documents.push(createDocument(getEventDocumentPath(event), encodeTransitionEvent(event)));
  }

  for (const operation of [...snapshot.pendingOperations].sort((left, right) =>
    compareByString(
      getPendingOperationDocumentPath(left.id),
      getPendingOperationDocumentPath(right.id)
    )
  )) {
    documents.push(
      createDocument(getPendingOperationDocumentPath(operation.id), encodePendingOperation(operation))
    );
  }

  for (const artifact of [...snapshot.approvalArtifacts].sort((left, right) =>
    compareByString(
      getApprovalArtifactDocumentPath(left.id),
      getApprovalArtifactDocumentPath(right.id)
    )
  )) {
    documents.push(
      createDocument(
        getApprovalArtifactDocumentPath(artifact.id),
        encodeApprovalArtifact(artifact)
      )
    );
  }

  return documents.sort((left, right) => compareByString(left.path, right.path));
};

const decodeProjectAggregateFromJsonDocumentsInternal = (
  documents: Iterable<RouteLedgerJsonDocument>,
  validateLifecycle: boolean
): ProjectAggregateSnapshot => {
  const documentMap = new Map<string, RouteLedgerJsonDocument>();

  for (const document of documents) {
    documentMap.set(document.path, document);
  }

  const projectDocument = documentMap.get(PROJECT_DOCUMENT_PATH);
  const currentRefDocument = documentMap.get(CURRENT_REF_DOCUMENT_PATH);

  if (projectDocument === undefined) {
    throw new Error("missing .routeledger/project.json");
  }

  if (currentRefDocument === undefined) {
    throw new Error("missing .routeledger/refs/current.json");
  }

  const project = decodeProject(parseDocument<JsonProject>(projectDocument));
  const currentRef = parseDocument<JsonCurrentRef>(currentRefDocument);

  if (currentRef.project_id !== project.id) {
    throw new Error("current ref project_id does not match project.json");
  }

  if (currentRef.current_version_id !== project.currentVersionId) {
    throw new Error("current ref does not mirror project.current_version_id");
  }

  const versions: Version[] = [];
  const workItems: WorkItem[] = [];
  const todos: Todo[] = [];
  const undos: Undo[] = [];
  const deferredItems: DeferredItem[] = [];
  const constraints: Constraint[] = [];
  const assets: Asset[] = [];
  const events: TransitionEvent[] = [];
  const pendingOperations: PendingOperation[] = [];
  const approvalArtifacts: ApprovalArtifact[] = [];

  for (const document of [...documentMap.values()].sort((left, right) =>
    compareByString(left.path, right.path)
  )) {
    if (document.path === PROJECT_DOCUMENT_PATH || document.path === CURRENT_REF_DOCUMENT_PATH) {
      continue;
    }

    if (document.path === SCHEMA_DOCUMENT_PATH) {
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/versions/`)) {
      versions.push(decodeVersion(parseDocument<JsonVersion>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/work_items/`)) {
      workItems.push(decodeWorkItem(parseDocument<JsonWorkItem>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/todos/`)) {
      todos.push(decodeTodo(parseDocument<JsonTodo>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/undos/`)) {
      undos.push(decodeUndo(parseDocument<JsonUndo>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/deferred_items/`)) {
      deferredItems.push(decodeDeferredItem(parseDocument<JsonDeferredItem>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/constraints/`)) {
      constraints.push(decodeConstraint(parseDocument<JsonConstraint>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/assets/`)) {
      assets.push(decodeAsset(parseDocument<JsonAsset>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/events/`)) {
      events.push(decodeTransitionEvent(parseDocument<JsonTransitionEvent>(document)));
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/pending_operations/`)) {
      pendingOperations.push(
        decodePendingOperation(parseDocument<JsonPendingOperation>(document))
      );
      continue;
    }

    if (document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/approval_artifacts/`)) {
      approvalArtifacts.push(
        decodeApprovalArtifact(parseDocument<JsonApprovalArtifact>(document))
      );
      continue;
    }

    throw new Error(`unsupported RouteLedger JSON document: ${document.path}`);
  }

  if (validateLifecycle) {
    for (const deferredItem of deferredItems) {
      const violations = collectDeferredItemInvariantViolations(deferredItem, todos);

      if (violations.length > 0) {
        throw new Error(
          `invalid deferred_item ${deferredItem.id}: ${violations
            .map((violation) => violation.code)
            .join(", ")}`
        );
      }
    }

    for (const constraint of constraints) {
      const violations = collectConstraintInvariantViolations(constraint);

      if (violations.length > 0) {
        throw new Error(
          `invalid constraint ${constraint.id}: ${violations
            .map((violation) => violation.code)
            .join(", ")}`
        );
      }
    }
  }

  return {
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
};

export const decodeProjectAggregateFromJsonDocuments = (
  documents: Iterable<RouteLedgerJsonDocument>
): ProjectAggregateSnapshot =>
  decodeProjectAggregateFromJsonDocumentsInternal(documents, true);

export const decodeProjectAggregateFromJsonDocumentsForValidation = (
  documents: Iterable<RouteLedgerJsonDocument>
): ProjectAggregateSnapshot =>
  decodeProjectAggregateFromJsonDocumentsInternal(documents, false);
