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
  /**
   * Storage-owned optimistic-concurrency token for this complete aggregate.
   *
   * This is deliberately runtime metadata: codecs must neither serialize it nor
   * include it in canonical document bytes. `null` means the caller expects no
   * persisted aggregate yet. Production readers return a concrete token for an
   * existing aggregate.
   */
  headRevision: ProjectAggregateHeadRevision;
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

export type ProjectAggregateHeadRevision = string | null;

/** A concrete optimistic-concurrency token returned after a successful save. */
export type ProjectAggregateCommittedRevision = string;

/** @deprecated Read the public `snapshot.headRevision` field directly. */
export const attachProjectAggregateHeadRevision = <T extends ProjectAggregateSnapshot>(
  snapshot: T,
  headRevision: ProjectAggregateHeadRevision
): T => {
  snapshot.headRevision = headRevision;
  return snapshot;
};

/** @deprecated Read the public `snapshot.headRevision` field directly. */
export const getProjectAggregateHeadRevision = (
  snapshot: ProjectAggregateSnapshot
): ProjectAggregateHeadRevision => snapshot.headRevision;

export interface ProjectSnapshotReader {
  loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null>;
}

export interface ProjectSnapshotWriter {
  /**
   * Persists the complete project aggregate with `snapshot.headRevision` as the
   * expected revision and returns the concrete revision that was committed.
   * Implementations also update `snapshot.headRevision` after a successful
   * save so direct adapter callers and `persistProjectAggregate` agree.
   */
  saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<ProjectAggregateCommittedRevision>;
}

/** Compatibility facade for hosts that need both storage directions. */
export interface StoragePort extends ProjectSnapshotReader, ProjectSnapshotWriter {}
