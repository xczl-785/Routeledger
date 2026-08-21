import type { Actor } from "../domain/actor.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import { createTransitionEvents } from "../services/transition-event-service.js";
import { createDomainContext, type DomainDependencies } from "../services/operation.js";

import { ApplicationError } from "./errors.js";
import {
  rebuildCanonicalL3ProposalDigest,
  type L3ProposalSecurityPort
} from "./l3-proposal-security-port.js";
import {
  cloneProjectAggregateSnapshot,
  loadRequiredProjectAggregate,
  persistProjectAggregate,
  type ProjectSnapshotReader,
  type ProjectSnapshotWriter
} from "./project-aggregate-access.js";
import {
  getProjectAggregateHeadRevision,
  type ProjectAggregateSnapshot
} from "../ports/storage-port.js";
import type { L3ActionType, PendingOperation, PendingOperationPayload } from "./types.js";

export interface L3ProposalWriteInput {
  projectId: string;
  actionType: L3ActionType;
  targetId: string;
  reason: string;
  actor: Actor;
  payload?: PendingOperationPayload;
  requirePassingGate?: boolean;
}

export interface L3ProposalWriteUseCases {
  proposeL3Operation(input: L3ProposalWriteInput): Promise<PendingOperation>;
}

type L3ProposalWriteStorage = ProjectSnapshotReader & ProjectSnapshotWriter;

const appendRecord = <T extends { id: string }>(records: T[], nextRecord: T): T[] =>
  records.some((record) => record.id === nextRecord.id)
    ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
    : records.concat(nextRecord);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(sortKeys(value));

const applyPendingOperation = (
  snapshot: ProjectAggregateSnapshot,
  operation: PendingOperation
): ProjectAggregateSnapshot => ({
  ...snapshot,
  pendingOperations: appendRecord(snapshot.pendingOperations, operation)
});

export class L3ProposalWriteService implements L3ProposalWriteUseCases {
  constructor(
    private readonly options: {
      storage: L3ProposalWriteStorage;
      deps: DomainDependencies;
      securityPort: L3ProposalSecurityPort;
    }
  ) {}

  async proposeL3Operation(input: L3ProposalWriteInput): Promise<PendingOperation> {
    const snapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
    const now = this.options.deps.clock.now();
    const description = this.options.securityPort.describe({
      snapshot,
      actionType: input.actionType,
      targetId: input.targetId,
      payload: input.payload ?? {},
      evaluatedAt: now
    });

    if (input.requirePassingGate === true && !description.gateSnapshot.allowed) {
      throw new ApplicationError(
        "START_GATE_FAILED",
        "L3 operation gate 校验失败，未创建 pending proposal",
        {
          projectId: input.projectId,
          actionType: description.actionType,
          targetId: description.targetId,
          blockers: description.gateSnapshot.blockers
        }
      );
    }

    const proposal: PendingOperation = {
      id: this.options.deps.idGenerator.nextId(),
      projectId: input.projectId,
      actionType: description.actionType,
      targetId: description.targetId,
      status: "pending",
      reason: input.reason,
      gateSnapshot: description.gateSnapshot,
      digest: description.digest,
      payload: description.payload,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
      committedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      approvalArtifactId: null
    };
    const context = createDomainContext(this.options.deps, input.actor);
    const proposalEvents: TransitionEvent[] = createTransitionEvents(
      [
        {
          targetType: "pending_operation",
          targetId: proposal.id,
          eventType: "pending_operation.proposed",
          toState: proposal.status,
          note: proposal.reason,
          metadata: {
            actionType: proposal.actionType,
            targetId: proposal.targetId,
            digest: proposal.digest.value
          }
        }
      ],
      {
        projectId: snapshot.project.id,
        actor: input.actor,
        now,
        operationId: context.operationId
      },
      this.options.deps.idGenerator
    );

    const updatedSnapshot = applyPendingOperation(snapshot, proposal);
    updatedSnapshot.events = updatedSnapshot.events.concat(proposalEvents);
    await persistProjectAggregate(this.options.storage, updatedSnapshot);

    const savedHeadRevision = getProjectAggregateHeadRevision(updatedSnapshot);
    const persistedSnapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
    const persistedProposal = persistedSnapshot.pendingOperations.find(
      (operation) => operation.id === proposal.id
    );
    const rebuiltDigest =
      persistedProposal === undefined
        ? null
        : rebuildCanonicalL3ProposalDigest({
            projectId: persistedSnapshot.project.id,
            actionType: persistedProposal.actionType,
            targetId: persistedProposal.targetId,
            payload: persistedProposal.payload,
            gateSnapshot: persistedProposal.gateSnapshot
          });
    const persistenceIsSelfConsistent =
      persistedProposal !== undefined &&
      persistedProposal.projectId === proposal.projectId &&
      persistedProposal.actionType === proposal.actionType &&
      persistedProposal.targetId === proposal.targetId &&
      persistedProposal.digest.value === proposal.digest.value &&
      rebuiltDigest?.value === persistedProposal.digest.value;

    if (!persistenceIsSelfConsistent) {
      const persistedHeadRevision = getProjectAggregateHeadRevision(persistedSnapshot);
      const proposalEventIds = new Set(proposalEvents.map((event) => event.id));
      const linkedApprovalArtifactIds = persistedSnapshot.approvalArtifacts
        .filter((artifact) => artifact.pendingOperationId === proposal.id)
        .map((artifact) => artifact.id);
      const rollbackSnapshot = cloneProjectAggregateSnapshot(persistedSnapshot);
      rollbackSnapshot.pendingOperations = rollbackSnapshot.pendingOperations.filter(
        (operation) => operation.id !== proposal.id
      );
      rollbackSnapshot.events = rollbackSnapshot.events.filter(
        (event) => !proposalEventIds.has(event.id)
      );

      const headStillMatchesOwnWrite =
        savedHeadRevision !== undefined && persistedHeadRevision === savedHeadRevision;
      const unrevisionedRemainderMatchesOriginal =
        savedHeadRevision === undefined &&
        stableStringify(rollbackSnapshot) === stableStringify(snapshot);
      const canRollbackSafely =
        linkedApprovalArtifactIds.length === 0 &&
        (headStillMatchesOwnWrite || unrevisionedRemainderMatchesOriginal);
      let rollbackStatus: "rolled_back" | "skipped_concurrent_change" | "failed" =
        "skipped_concurrent_change";
      let rollbackError: string | null = null;

      if (canRollbackSafely) {
        try {
          await persistProjectAggregate(this.options.storage, rollbackSnapshot);
          rollbackStatus = "rolled_back";
        } catch (error) {
          rollbackStatus = "failed";
          rollbackError = error instanceof Error ? error.message : String(error);
        }
      }

      throw new ApplicationError(
        "PENDING_OPERATION_PERSISTENCE_MISMATCH",
        rollbackStatus === "rolled_back"
          ? "pending operation 持久化后与原始 proposal/digest 不自洽，已回滚 proposal"
          : "pending operation 持久化后与原始 proposal/digest 不自洽；检测到并发变化或补偿失败，未覆盖当前数据",
        {
          pendingOperationId: proposal.id,
          proposedDigest: proposal.digest.value,
          persistedDigest: persistedProposal?.digest.value ?? null,
          rebuiltDigest: rebuiltDigest?.value ?? null,
          rollbackStatus,
          rollbackError,
          linkedApprovalArtifactIds
        }
      );
    }

    return persistedProposal;
  }
}
