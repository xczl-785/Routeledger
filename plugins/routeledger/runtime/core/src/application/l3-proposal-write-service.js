import { createTransitionEvents } from "../services/transition-event-service.js";
import { createDomainContext } from "../services/operation.js";
import { ApplicationError } from "./errors.js";
import { rebuildCanonicalL3ProposalDigest } from "./l3-proposal-security-port.js";
import { cloneProjectAggregateSnapshot, loadRequiredProjectAggregate, persistProjectAggregate } from "./project-aggregate-access.js";
const appendRecord = (records, nextRecord) => records.some((record) => record.id === nextRecord.id)
    ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
    : records.concat(nextRecord);
const applyPendingOperation = (snapshot, operation) => ({
    ...snapshot,
    pendingOperations: appendRecord(snapshot.pendingOperations, operation)
});
export class L3ProposalWriteService {
    options;
    constructor(options) {
        this.options = options;
    }
    async proposeL3Operation(input) {
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
            throw new ApplicationError("START_GATE_FAILED", "L3 operation gate 校验失败，未创建 pending proposal", {
                projectId: input.projectId,
                actionType: description.actionType,
                targetId: description.targetId,
                blockers: description.gateSnapshot.blockers
            });
        }
        const proposal = {
            id: this.options.deps.idGenerator.nextId(),
            projectId: input.projectId,
            actionType: description.actionType,
            targetId: description.targetId,
            status: "pending",
            reason: input.reason,
            reasonSource: input.reasonSource ?? "explicit_input",
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
        const proposalEvents = createTransitionEvents([
            {
                targetType: "pending_operation",
                targetId: proposal.id,
                eventType: "pending_operation.proposed",
                toState: proposal.status,
                note: proposal.reason,
                metadata: {
                    actionType: proposal.actionType,
                    targetId: proposal.targetId,
                    digest: proposal.digest.value,
                    reasonSource: proposal.reasonSource
                }
            }
        ], {
            projectId: snapshot.project.id,
            actor: input.actor,
            now,
            operationId: context.operationId
        }, this.options.deps.idGenerator);
        const updatedSnapshot = applyPendingOperation(snapshot, proposal);
        updatedSnapshot.events = updatedSnapshot.events.concat(proposalEvents);
        await persistProjectAggregate(this.options.storage, updatedSnapshot);
        const savedHeadRevision = updatedSnapshot.headRevision;
        const persistedSnapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
        const persistedProposal = persistedSnapshot.pendingOperations.find((operation) => operation.id === proposal.id);
        const rebuiltDigest = persistedProposal === undefined
            ? null
            : rebuildCanonicalL3ProposalDigest({
                projectId: persistedSnapshot.project.id,
                actionType: persistedProposal.actionType,
                targetId: persistedProposal.targetId,
                payload: persistedProposal.payload,
                gateSnapshot: persistedProposal.gateSnapshot
            });
        const persistenceIsSelfConsistent = persistedProposal !== undefined &&
            persistedProposal.projectId === proposal.projectId &&
            persistedProposal.actionType === proposal.actionType &&
            persistedProposal.targetId === proposal.targetId &&
            persistedProposal.digest.value === proposal.digest.value &&
            rebuiltDigest?.value === persistedProposal.digest.value;
        if (!persistenceIsSelfConsistent) {
            const persistedHeadRevision = persistedSnapshot.headRevision;
            const proposalEventIds = new Set(proposalEvents.map((event) => event.id));
            const linkedApprovalArtifactIds = persistedSnapshot.approvalArtifacts
                .filter((artifact) => artifact.pendingOperationId === proposal.id)
                .map((artifact) => artifact.id);
            const rollbackSnapshot = cloneProjectAggregateSnapshot(persistedSnapshot);
            rollbackSnapshot.pendingOperations = rollbackSnapshot.pendingOperations.filter((operation) => operation.id !== proposal.id);
            rollbackSnapshot.events = rollbackSnapshot.events.filter((event) => !proposalEventIds.has(event.id));
            const headStillMatchesOwnWrite = savedHeadRevision !== null && persistedHeadRevision === savedHeadRevision;
            const canRollbackSafely = linkedApprovalArtifactIds.length === 0 &&
                headStillMatchesOwnWrite;
            let rollbackStatus = "skipped_concurrent_change";
            let rollbackError = null;
            if (canRollbackSafely) {
                try {
                    await persistProjectAggregate(this.options.storage, rollbackSnapshot);
                    rollbackStatus = "rolled_back";
                }
                catch (error) {
                    rollbackStatus = "failed";
                    rollbackError = error instanceof Error ? error.message : String(error);
                }
            }
            throw new ApplicationError("PENDING_OPERATION_PERSISTENCE_MISMATCH", rollbackStatus === "rolled_back"
                ? "pending operation 持久化后与原始 proposal/digest 不自洽，已回滚 proposal"
                : "pending operation 持久化后与原始 proposal/digest 不自洽；检测到并发变化或补偿失败，未覆盖当前数据", {
                pendingOperationId: proposal.id,
                proposedDigest: proposal.digest.value,
                persistedDigest: persistedProposal?.digest.value ?? null,
                rebuiltDigest: rebuiltDigest?.value ?? null,
                rollbackStatus,
                rollbackError,
                linkedApprovalArtifactIds
            });
        }
        return persistedProposal;
    }
}
