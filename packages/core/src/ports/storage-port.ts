import type { Project } from "../domain/project.js";
import type { Asset } from "../domain/asset.js";
import type { Constraint } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import type { Todo } from "../domain/todo.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";
import type { WorkItem } from "../domain/work-item.js";
import type { ApprovalArtifact, PendingOperation } from "../application/types.js";
import type { OrdinaryWriteReceipt } from "../application/ordinary-write-idempotency.js";

export interface ProjectAggregateSnapshot {
  project: Project;
  versions: Version[];
  workItems: WorkItem[];
  todos: Todo[];
  undos: Undo[];
  deferredItems: DeferredItem[];
  constraints: Constraint[];
  assets: Asset[];
  events: TransitionEvent[];
  pendingOperations: PendingOperation[];
  approvalArtifacts: ApprovalArtifact[];
  /** Absent only on in-memory/legacy snapshots created before persistent ordinary-write idempotency. */
  ordinaryWriteReceipts?: OrdinaryWriteReceipt[];
}

const SNAPSHOT_HEAD_REVISION = Symbol("routeledger.snapshotHeadRevision");

export type ProjectAggregateHeadRevision = string | null;

export const attachProjectAggregateHeadRevision = <T extends ProjectAggregateSnapshot>(
  snapshot: T,
  headRevision: ProjectAggregateHeadRevision
): T => {
  Object.defineProperty(snapshot, SNAPSHOT_HEAD_REVISION, {
    value: headRevision,
    enumerable: true,
    writable: true,
    configurable: true
  });

  return snapshot;
};

export const getProjectAggregateHeadRevision = (
  snapshot: ProjectAggregateSnapshot
): ProjectAggregateHeadRevision | undefined =>
  (snapshot as ProjectAggregateSnapshot & {
    [SNAPSHOT_HEAD_REVISION]?: ProjectAggregateHeadRevision;
  })[SNAPSHOT_HEAD_REVISION];

export interface StoragePort {
  loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null>;
  /**
   * Persists the complete project aggregate snapshot.
   * Callers must pass the full aggregate for the project instead of a partial patch.
   */
  saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void>;
}
