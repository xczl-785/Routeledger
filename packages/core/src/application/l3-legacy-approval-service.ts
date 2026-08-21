import type { Actor } from "../domain/actor.js";
import { createDomainContext, type DomainDependencies } from "../services/operation.js";
import { createTransitionEvents } from "../services/transition-event-service.js";

import { ApplicationError } from "./errors.js";
import {
  loadRequiredProjectAggregate,
  persistProjectAggregate,
  type ProjectSnapshotReader,
  type ProjectSnapshotWriter
} from "./project-aggregate-access.js";
import type { ApprovalArtifact, PendingOperation } from "./types.js";

const DEFAULT_APPROVAL_WINDOW_MS = 60 * 60 * 1000;

export interface LegacyApproveL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  approver: Actor;
  actor: Actor;
  decisionRef?: string;
  expiresAt?: string;
}

export interface RejectL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  reason: string;
  actor: Actor;
}

export interface L3LegacyApprovalUseCases {
  approveL3Operation(input: LegacyApproveL3OperationInput): Promise<ApprovalArtifact>;
  rejectL3Operation(input: RejectL3OperationInput): Promise<PendingOperation>;
}

type L3LegacyApprovalStorage = ProjectSnapshotReader & ProjectSnapshotWriter;

const addMilliseconds = (isoString: string, milliseconds: number): string =>
  new Date(new Date(isoString).getTime() + milliseconds).toISOString();

const requirePendingOperation = (
  snapshot: Awaited<ReturnType<typeof loadRequiredProjectAggregate>>,
  pendingOperationId: string
): PendingOperation => {
  const pendingOperation = snapshot.pendingOperations.find(
    (item) => item.id === pendingOperationId
  );

  if (pendingOperation === undefined) {
    throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
      projectId: snapshot.project.id,
      pendingOperationId
    });
  }

  return pendingOperation;
};

const appendRecord = <T extends { id: string }>(records: T[], nextRecord: T): T[] =>
  records.some((record) => record.id === nextRecord.id)
    ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
    : records.concat(nextRecord);

export class L3LegacyApprovalService implements L3LegacyApprovalUseCases {
  private readonly storage: L3LegacyApprovalStorage;

  private readonly deps: DomainDependencies;

  private readonly trustedControlPlaneConfigured: boolean;

  constructor(options: {
    storage: L3LegacyApprovalStorage;
    deps: DomainDependencies;
    trustedControlPlaneConfigured: boolean;
  }) {
    this.storage = options.storage;
    this.deps = options.deps;
    this.trustedControlPlaneConfigured = options.trustedControlPlaneConfigured;
  }

  async approveL3Operation(input: LegacyApproveL3OperationInput): Promise<ApprovalArtifact> {
    if (this.trustedControlPlaneConfigured) {
      throw new ApplicationError(
        "EXACT_AUTHORIZATION_REJECTED",
        "Legacy L3 approval cannot bypass the configured trusted authorization control plane",
        { pendingOperationId: input.pendingOperationId, reason: "LEGACY_APPROVAL_DISABLED" }
      );
    }

    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);

    if (pendingOperation.status !== "pending") {
      throw new ApplicationError(
        "PENDING_OPERATION_NOT_PENDING",
        "pending operation 不是待审批状态",
        {
          pendingOperationId: pendingOperation.id,
          status: pendingOperation.status
        }
      );
    }

    const now = this.deps.clock.now();
    const artifact: ApprovalArtifact = {
      id: this.deps.idGenerator.nextId(),
      projectId: input.projectId,
      pendingOperationId: pendingOperation.id,
      actionType: pendingOperation.actionType,
      targetId: pendingOperation.targetId,
      digest: pendingOperation.digest,
      status: "approved",
      approver: input.approver,
      decisionRef: input.decisionRef ?? `decision_${this.deps.idGenerator.nextId()}`,
      createdAt: now,
      expiresAt: input.expiresAt ?? addMilliseconds(now, DEFAULT_APPROVAL_WINDOW_MS),
      consumedAt: null
    };
    const context = createDomainContext(this.deps, input.actor);
    const events = createTransitionEvents(
      [
        {
          targetType: "approval_artifact",
          targetId: artifact.id,
          eventType: "approval_artifact.approved",
          toState: artifact.status,
          metadata: {
            pendingOperationId: pendingOperation.id,
            decisionRef: artifact.decisionRef,
            expiresAt: artifact.expiresAt,
            approverId: artifact.approver.id,
            approverType: artifact.approver.type,
            approverDisplayName: artifact.approver.displayName ?? null
          }
        }
      ],
      {
        projectId: snapshot.project.id,
        actor: input.actor,
        now,
        operationId: context.operationId
      },
      this.deps.idGenerator
    );

    snapshot.approvalArtifacts = appendRecord(snapshot.approvalArtifacts, artifact);
    snapshot.events = snapshot.events.concat(events);
    await persistProjectAggregate(this.storage, snapshot);

    return artifact;
  }

  async rejectL3Operation(input: RejectL3OperationInput): Promise<PendingOperation> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);

    if (pendingOperation.status !== "pending") {
      throw new ApplicationError(
        "PENDING_OPERATION_NOT_PENDING",
        "pending operation 不是待拒绝状态",
        {
          pendingOperationId: pendingOperation.id,
          status: pendingOperation.status
        }
      );
    }

    const now = this.deps.clock.now();
    const rejected: PendingOperation = {
      ...pendingOperation,
      status: "rejected",
      updatedAt: now,
      rejectedAt: now,
      rejectionReason: input.reason
    };
    const context = createDomainContext(this.deps, input.actor);
    const events = createTransitionEvents(
      [
        {
          targetType: "pending_operation",
          targetId: rejected.id,
          eventType: "pending_operation.rejected",
          fromState: pendingOperation.status,
          toState: rejected.status,
          note: input.reason
        }
      ],
      {
        projectId: snapshot.project.id,
        actor: input.actor,
        now,
        operationId: context.operationId
      },
      this.deps.idGenerator
    );

    snapshot.pendingOperations = snapshot.pendingOperations.map((operation) =>
      operation.id === rejected.id ? rejected : operation
    );
    snapshot.events = snapshot.events.concat(events);
    await persistProjectAggregate(this.storage, snapshot);

    return rejected;
  }
}
