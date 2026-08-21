import { createDomainContext } from "../services/operation.js";
import { createTransitionEvents } from "../services/transition-event-service.js";
import { ApplicationError } from "./errors.js";
import { loadRequiredProjectAggregate, persistProjectAggregate } from "./project-aggregate-access.js";
const DEFAULT_APPROVAL_WINDOW_MS = 60 * 60 * 1000;
const addMilliseconds = (isoString, milliseconds) => new Date(new Date(isoString).getTime() + milliseconds).toISOString();
const requirePendingOperation = (snapshot, pendingOperationId) => {
    const pendingOperation = snapshot.pendingOperations.find((item) => item.id === pendingOperationId);
    if (pendingOperation === undefined) {
        throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
            projectId: snapshot.project.id,
            pendingOperationId
        });
    }
    return pendingOperation;
};
const appendRecord = (records, nextRecord) => records.some((record) => record.id === nextRecord.id)
    ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
    : records.concat(nextRecord);
export class L3LegacyApprovalService {
    storage;
    deps;
    trustedControlPlaneConfigured;
    constructor(options) {
        this.storage = options.storage;
        this.deps = options.deps;
        this.trustedControlPlaneConfigured = options.trustedControlPlaneConfigured;
    }
    async approveL3Operation(input) {
        if (this.trustedControlPlaneConfigured) {
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "Legacy L3 approval cannot bypass the configured trusted authorization control plane", { pendingOperationId: input.pendingOperationId, reason: "LEGACY_APPROVAL_DISABLED" });
        }
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status !== "pending") {
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是待审批状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status
            });
        }
        const now = this.deps.clock.now();
        const artifact = {
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
        const events = createTransitionEvents([
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
        ], {
            projectId: snapshot.project.id,
            actor: input.actor,
            now,
            operationId: context.operationId
        }, this.deps.idGenerator);
        snapshot.approvalArtifacts = appendRecord(snapshot.approvalArtifacts, artifact);
        snapshot.events = snapshot.events.concat(events);
        await persistProjectAggregate(this.storage, snapshot);
        return artifact;
    }
    async rejectL3Operation(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status !== "pending") {
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是待拒绝状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status
            });
        }
        const now = this.deps.clock.now();
        const rejected = {
            ...pendingOperation,
            status: "rejected",
            updatedAt: now,
            rejectedAt: now,
            rejectionReason: input.reason
        };
        const context = createDomainContext(this.deps, input.actor);
        const events = createTransitionEvents([
            {
                targetType: "pending_operation",
                targetId: rejected.id,
                eventType: "pending_operation.rejected",
                fromState: pendingOperation.status,
                toState: rejected.status,
                note: input.reason
            }
        ], {
            projectId: snapshot.project.id,
            actor: input.actor,
            now,
            operationId: context.operationId
        }, this.deps.idGenerator);
        snapshot.pendingOperations = snapshot.pendingOperations.map((operation) => operation.id === rejected.id ? rejected : operation);
        snapshot.events = snapshot.events.concat(events);
        await persistProjectAggregate(this.storage, snapshot);
        return rejected;
    }
}
