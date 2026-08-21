import crypto from "node:crypto";
import { createDomainContext, } from "../services/operation.js";
import { createTransitionEvents } from "../services/transition-event-service.js";
import { closeVersion as closeVersionDomain, reopenVersion as reopenVersionDomain, shutdownVersion as shutdownVersionDomain, startVersion as startVersionDomain, } from "../services/version-service.js";
import { setCurrentVersion as setCurrentVersionDomain } from "../services/project-service.js";
import { applyVersionTreeMutation } from "../services/version-tree-service.js";
import { createTodo as createTodoDomain } from "../services/work-item-service.js";
import { ApplicationError } from "./errors.js";
import { buildAuthorizationCommitClaimId, getExactArtifactReceiptBinding, hasV2AuthorizationProfile, } from "./l3-exact-authorization-service.js";
import { rebuildCanonicalL3ProposalDigest, rebuildLegacyL3ProposalDigest, } from "./l3-proposal-security-port.js";
import { loadRequiredProjectAggregate, persistProjectAggregate, } from "./project-aggregate-access.js";
const replaceRecord = (records, nextRecord) => records.map((record) => (record.id === nextRecord.id ? nextRecord : record));
const createAuditEvents = (drafts, projectId, actor, now, operationId, deps, startSeq = 0) => createTransitionEvents(drafts, { projectId, actor, now, operationId }, deps.idGenerator, { startSeq });
const requirePendingOperation = (snapshot, pendingOperationId) => {
    const pendingOperation = snapshot.pendingOperations.find((item) => item.id === pendingOperationId);
    if (pendingOperation === undefined) {
        throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
            projectId: snapshot.project.id,
            pendingOperationId,
        });
    }
    return pendingOperation;
};
const requireApprovalArtifact = (snapshot, approvalArtifactId) => {
    const artifact = snapshot.approvalArtifacts.find((item) => item.id === approvalArtifactId);
    if (artifact === undefined) {
        throw new ApplicationError("APPROVAL_ARTIFACT_NOT_FOUND", "approval artifact 不存在", {
            projectId: snapshot.project.id,
            approvalArtifactId,
        });
    }
    return artifact;
};
const requireVersion = (snapshot, versionId) => {
    const version = snapshot.versions.find((item) => item.id === versionId);
    if (version === undefined) {
        throw new ApplicationError("VERSION_NOT_FOUND", "version 不存在", {
            projectId: snapshot.project.id,
            versionId,
        });
    }
    if (version.projectId !== snapshot.project.id) {
        throw new ApplicationError("VERSION_OWNERSHIP_MISMATCH", "version 不属于当前 project", {
            projectId: snapshot.project.id,
            versionId,
            actualProjectId: version.projectId,
        });
    }
    return version;
};
const hasEmptyExtendedGateState = (gateSnapshot) => {
    const empty = (value) => !Array.isArray(value) || value.length === 0;
    const isNew = (code) => code === "DUE_DEFERRED_REQUIRES_REVIEW" ||
        code.startsWith("DEFERRED_ROUTE_") ||
        code.startsWith("CONSTRAINT_") ||
        code === "UNKNOWN_CONSTRAINT_GATE_CHECK" ||
        code === "MISMATCHED_CONSTRAINT_GATE_CHECK";
    if (gateSnapshot.kind === "start") {
        return (empty(gateSnapshot.dueDeferredIds) &&
            empty(gateSnapshot.blockedConstraintIds) &&
            !gateSnapshot.blockers.some((blocker) => isNew(blocker.code)));
    }
    if (gateSnapshot.kind === "close") {
        return (empty(gateSnapshot.unresolvedDeferredIds) &&
            empty(gateSnapshot.blockedConstraintIds) &&
            !gateSnapshot.blockers.some((blocker) => isNew(blocker.code)));
    }
    if (gateSnapshot.kind === "shutdown") {
        return (empty(gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds) &&
            empty(gateSnapshot.ordinaryCloseGate.blockedConstraintIds) &&
            !gateSnapshot.blockers.some((blocker) => isNew(blocker.code)) &&
            !gateSnapshot.ordinaryCloseGate.blockers.some((blocker) => isNew(blocker.code)));
    }
    return true;
};
const summarizeGate = (gateSnapshot) => ({
    kind: gateSnapshot.kind,
    allowed: gateSnapshot.allowed,
    blockerCodes: [
        ...new Set(gateSnapshot.blockers.map((blocker) => blocker.code)),
    ],
    recordIds: [
        ...new Set(gateSnapshot.blockers.flatMap((blocker) => blocker.recordIds)),
    ],
});
const staleDetails = (projectId, pendingOperation, artifact, liveGateSnapshot) => {
    const stored = summarizeGate(pendingOperation.gateSnapshot);
    const live = summarizeGate(liveGateSnapshot);
    const storedCodes = new Set(stored.blockerCodes);
    const liveCodes = new Set(live.blockerCodes);
    const storedIds = new Set(stored.recordIds);
    const liveIds = new Set(live.recordIds);
    const recommendedNextActions = [
        {
            action: "reject_stale_proposal",
            tool: "reject_l3_operation",
            input: {
                projectId,
                pendingOperationId: pendingOperation.id,
                reason: "Route state changed after approval; reject stale proposal.",
            },
        },
        {
            action: "refresh_context",
            tool: "get_current_context",
            input: { projectId },
        },
    ];
    if (liveGateSnapshot.kind === "close") {
        for (const todoId of liveGateSnapshot.unresolvedTodoIds) {
            recommendedNextActions.push({
                action: "resolve_live_blocker",
                tool: "close_todo",
                input: { projectId, todoId },
                requiredInputs: ["reason", "note"],
            });
        }
        const residualAudit = {
            status: "reviewed",
            items: pendingOperation.payload.residualAudit ?? [],
        };
        recommendedNextActions.push({
            action: "recheck_close_gate",
            tool: "check_close_gate",
            input: {
                projectId,
                versionId: pendingOperation.targetId,
                residualAudit,
            },
        }, {
            action: "propose_replacement",
            tool: "preview_or_propose_version_close",
            input: {
                projectId,
                versionId: pendingOperation.targetId,
                mode: "propose",
                residualAudit,
            },
        });
    }
    return {
        staleProposal: true,
        pendingOperationId: pendingOperation.id,
        approvalArtifactId: artifact.id,
        proposalStatus: pendingOperation.status,
        artifactStatus: artifact.status,
        gateDifference: {
            stored,
            live,
            addedBlockerCodes: live.blockerCodes.filter((code) => !storedCodes.has(code)),
            removedBlockerCodes: stored.blockerCodes.filter((code) => !liveCodes.has(code)),
            addedRecordIds: live.recordIds.filter((id) => !storedIds.has(id)),
            removedRecordIds: stored.recordIds.filter((id) => !liveIds.has(id)),
        },
        artifactConsumed: false,
        routeStateWritesPerformed: false,
        writesPerformed: false,
        recommendedNextActions,
    };
};
export class L3OperationCommitService {
    options;
    constructor(options) {
        this.options = options;
    }
    async commitL3Operation(input) {
        const ownership = this.options.commitCoordinator === null
            ? null
            : await this.options.commitCoordinator.acquire({
                commitKey: `${input.projectId}/${input.pendingOperationId}`,
                attemptId: crypto.randomUUID(),
            });
        if (ownership !== null && !ownership.ok)
            throw new ApplicationError("WRITE_IN_PROGRESS", "The exact L3 commit is already owned by another in-flight call", {
                projectId: input.projectId,
                pendingOperationId: input.pendingOperationId,
                reason: "EXACT_COMMIT_ALREADY_IN_PROGRESS",
                coordinatorReason: ownership.code,
            });
        const token = ownership?.ok === true ? ownership.token : null;
        try {
            return await this.commitOwned(input, token);
        }
        finally {
            if (token !== null)
                await this.options.commitCoordinator.release(token);
        }
    }
    async requireOwnership(token) {
        if (token === null)
            return null;
        const renewed = await this.options.commitCoordinator.renew(token);
        if (!renewed.ok ||
            !(await this.options.commitCoordinator.assertOwned(renewed.token)))
            throw new ApplicationError("WRITE_IN_PROGRESS", "The exact L3 commit ownership was lost before a durable boundary", { reason: "COMMIT_OWNERSHIP_LOST", commitKey: token.commitKey });
        return renewed.token;
    }
    async commitOwned(input, ownershipToken) {
        let token = ownershipToken;
        const snapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
        const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
        if (pendingOperation.status === "committed")
            return this.replay(input, pendingOperation, snapshot, token);
        if (pendingOperation.status !== "pending")
            throw new ApplicationError("PENDING_OPERATION_NOT_PENDING", "pending operation 不是可提交状态", {
                pendingOperationId: pendingOperation.id,
                status: pendingOperation.status,
            });
        if (input.approvalArtifactId === undefined ||
            input.approvalArtifactId.trim().length === 0)
            throw new ApplicationError("CONFIRMATION_REQUIRED", "提交 L3 operation 需要 approval artifact", {
                pendingOperationId: pendingOperation.id,
                confirmBooleanRejected: input.confirm === true,
            });
        const artifact = requireApprovalArtifact(snapshot, input.approvalArtifactId);
        this.assertArtifact(snapshot, pendingOperation, artifact);
        const exactReceiptBinding = await getExactArtifactReceiptBinding({
            artifact,
            pendingOperation,
            controlPlane: this.options.controlPlane,
        });
        if (this.options.controlPlane !== null &&
            (exactReceiptBinding === null ||
                !(await this.options.controlPlane.exactStore.verifyReceipt(exactReceiptBinding))))
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The approval artifact has no matching trusted authorization receipt", {
                approvalArtifactId: artifact.id,
                pendingOperationId: pendingOperation.id,
                authorizationId: artifact.authorizationId,
                reason: "AUTHORIZATION_RECEIPT_INVALID",
            });
        const now = this.options.deps.clock.now();
        if (new Date(artifact.expiresAt).getTime() <= new Date(now).getTime()) {
            snapshot.approvalArtifacts = replaceRecord(snapshot.approvalArtifacts, {
                ...artifact,
                status: "expired",
            });
            await persistProjectAggregate(this.options.storage, snapshot);
            throw new ApplicationError("APPROVAL_ARTIFACT_EXPIRED", "approval artifact 已过期", { approvalArtifactId: artifact.id, expiresAt: artifact.expiresAt });
        }
        const liveDescription = this.options.securityPort.describe({
            snapshot,
            actionType: pendingOperation.actionType,
            targetId: pendingOperation.targetId,
            payload: pendingOperation.payload,
            evaluatedAt: now,
        });
        const storedV2Digest = rebuildCanonicalL3ProposalDigest({
            projectId: snapshot.project.id,
            actionType: pendingOperation.actionType,
            targetId: pendingOperation.targetId,
            payload: pendingOperation.payload,
            gateSnapshot: pendingOperation.gateSnapshot,
        });
        const storedLegacyDigest = rebuildLegacyL3ProposalDigest({
            projectId: snapshot.project.id,
            actionType: pendingOperation.actionType,
            targetId: pendingOperation.targetId,
            payload: pendingOperation.payload,
            gateSnapshot: pendingOperation.gateSnapshot,
        });
        const format = storedV2Digest.value === pendingOperation.digest.value
            ? "v2"
            : hasEmptyExtendedGateState(pendingOperation.gateSnapshot) &&
                storedLegacyDigest.value === pendingOperation.digest.value
                ? "legacy"
                : null;
        if (format === null)
            throw new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "pending operation 的 stored gate/payload 与 digest 不自洽", {
                pendingOperationId: pendingOperation.id,
                storedDigest: pendingOperation.digest.value,
                storedV2Digest: storedV2Digest.value,
                storedLegacyDigest: storedLegacyDigest.value,
                storedExtendedGateStateEmpty: hasEmptyExtendedGateState(pendingOperation.gateSnapshot),
            });
        const legacyLiveDigest = rebuildLegacyL3ProposalDigest({
            projectId: snapshot.project.id,
            actionType: pendingOperation.actionType,
            targetId: pendingOperation.targetId,
            payload: pendingOperation.payload,
            gateSnapshot: liveDescription.gateSnapshot,
        });
        const liveMatches = format === "v2"
            ? liveDescription.digest.value === pendingOperation.digest.value
            : hasEmptyExtendedGateState(liveDescription.gateSnapshot) &&
                legacyLiveDigest.value === pendingOperation.digest.value;
        if (!liveMatches)
            throw new ApplicationError("APPROVAL_ARTIFACT_DIGEST_MISMATCH", "live route state 与审批时 digest 不一致", {
                ...staleDetails(snapshot.project.id, pendingOperation, artifact, liveDescription.gateSnapshot),
                expectedDigest: pendingOperation.digest.value,
                actualDigest: liveDescription.digest.value,
                liveLegacyDigest: legacyLiveDigest.value,
                storedDigestFormat: format,
                legacyCompatibilityAllowed: format === "legacy" &&
                    hasEmptyExtendedGateState(liveDescription.gateSnapshot),
            });
        token = await this.requireOwnership(token);
        const claim = exactReceiptBinding === null || this.options.controlPlane === null
            ? null
            : await this.options.controlPlane.exactStore.claimCommit(exactReceiptBinding, {
                claimId: buildAuthorizationCommitClaimId(artifact, pendingOperation),
                claimedAt: now,
            });
        if (claim !== null && !claim.ok)
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The trusted authorization receipt could not be claimed for commit", {
                approvalArtifactId: artifact.id,
                pendingOperationId: pendingOperation.id,
                reason: claim.code,
            });
        const context = createDomainContext(this.options.deps, input.actor);
        const applied = this.applyCommittedOperation(snapshot, pendingOperation, liveDescription, { actor: input.actor, now, operationId: context.operationId });
        const consumedArtifact = {
            ...artifact,
            status: "consumed",
            consumedAt: now,
        };
        const committedOperation = {
            ...pendingOperation,
            status: "committed",
            updatedAt: now,
            committedAt: now,
            approvalArtifactId: artifact.id,
        };
        const auditEvents = createAuditEvents([
            {
                targetType: "pending_operation",
                targetId: committedOperation.id,
                eventType: "pending_operation.committed",
                fromState: pendingOperation.status,
                toState: committedOperation.status,
                metadata: { approvalArtifactId: artifact.id },
            },
            {
                targetType: "approval_artifact",
                targetId: consumedArtifact.id,
                eventType: "approval_artifact.consumed",
                fromState: artifact.status,
                toState: consumedArtifact.status,
                metadata: {
                    pendingOperationId: committedOperation.id,
                    decisionRef: artifact.decisionRef,
                    approverId: artifact.approver.id,
                    approverType: artifact.approver.type,
                    approverDisplayName: artifact.approver.displayName ?? null,
                },
            },
        ], snapshot.project.id, input.actor, now, context.operationId, this.options.deps, applied.events.length);
        applied.snapshot.pendingOperations = replaceRecord(applied.snapshot.pendingOperations, committedOperation);
        applied.snapshot.approvalArtifacts = replaceRecord(applied.snapshot.approvalArtifacts, consumedArtifact);
        applied.snapshot.events = applied.snapshot.events
            .concat(applied.events)
            .concat(auditEvents);
        token = await this.requireOwnership(token);
        await persistProjectAggregate(this.options.storage, applied.snapshot);
        if (claim !== null &&
            exactReceiptBinding !== null &&
            this.options.controlPlane !== null) {
            await this.requireOwnership(token);
            const finalized = await this.options.controlPlane.exactStore.finalizeCommit(exactReceiptBinding, buildAuthorizationCommitClaimId(artifact, pendingOperation), now);
            if (!finalized.ok)
                throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The canonical commit succeeded but its trusted authorization receipt needs recovery", {
                    approvalArtifactId: artifact.id,
                    pendingOperationId: pendingOperation.id,
                    reason: finalized.code,
                    canonicalCommitSucceeded: true,
                });
        }
        return {
            pendingOperation: committedOperation,
            approvalArtifact: consumedArtifact,
            replayed: false,
        };
    }
    assertArtifact(snapshot, pendingOperation, artifact) {
        if (this.options.controlPlane !== null &&
            artifact.authorizationId === undefined)
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "Legacy unconsumed approval artifacts must be reauthorized by the trusted control plane", {
                approvalArtifactId: artifact.id,
                pendingOperationId: pendingOperation.id,
                reason: "LEGACY_ARTIFACT_REAUTHORIZATION_REQUIRED",
            });
        const mismatch = (condition, code, message, details) => {
            if (condition)
                throw new ApplicationError(code, message, details);
        };
        mismatch(artifact.projectId !== pendingOperation.projectId, "APPROVAL_ARTIFACT_PROJECT_MISMATCH", "approval artifact project 与 pending operation 不一致", {
            expectedProjectId: pendingOperation.projectId,
            actualProjectId: artifact.projectId,
            approvalArtifactId: artifact.id,
        });
        mismatch(artifact.pendingOperationId !== pendingOperation.id, "APPROVAL_ARTIFACT_PENDING_OPERATION_MISMATCH", "approval artifact 未绑定到当前 pending operation", {
            expectedPendingOperationId: pendingOperation.id,
            actualPendingOperationId: artifact.pendingOperationId,
            approvalArtifactId: artifact.id,
        });
        mismatch(artifact.consumedAt !== null || artifact.status === "consumed", "APPROVAL_ARTIFACT_ALREADY_CONSUMED", "approval artifact 已被消费", { approvalArtifactId: artifact.id, consumedAt: artifact.consumedAt });
        if (artifact.status === "expired")
            throw new ApplicationError("APPROVAL_ARTIFACT_EXPIRED", "approval artifact 已过期", { approvalArtifactId: artifact.id, expiresAt: artifact.expiresAt });
        mismatch(artifact.status !== "approved", "APPROVAL_ARTIFACT_STATUS_INVALID", "approval artifact 必须处于 approved 状态", { approvalArtifactId: artifact.id, status: artifact.status });
        mismatch(artifact.actionType !== pendingOperation.actionType, "APPROVAL_ARTIFACT_ACTION_MISMATCH", "approval artifact action 与 pending operation 不一致", {
            expectedActionType: pendingOperation.actionType,
            actualActionType: artifact.actionType,
        });
        mismatch(artifact.targetId !== pendingOperation.targetId, "APPROVAL_ARTIFACT_TARGET_MISMATCH", "approval artifact target 与 pending operation 不一致", {
            expectedTargetId: pendingOperation.targetId,
            actualTargetId: artifact.targetId,
        });
        mismatch(artifact.digest.value !== pendingOperation.digest.value, "APPROVAL_ARTIFACT_DIGEST_MISMATCH", "approval artifact digest 与 pending operation 不一致", {
            expectedDigest: pendingOperation.digest.value,
            actualDigest: artifact.digest.value,
        });
        if (this.options.controlPlane !== null &&
            hasV2AuthorizationProfile(artifact) &&
            (artifact.profileId !== this.options.controlPlane.profileId ||
                artifact.modeEpoch !== this.options.controlPlane.modeEpoch ||
                artifact.profileDigest !== this.options.controlPlane.profileDigest))
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The approval artifact belongs to an inactive authorization profile epoch", {
                approvalArtifactId: artifact.id,
                pendingOperationId: pendingOperation.id,
                reason: "AUTHORIZATION_PROFILE_EPOCH_INACTIVE",
                artifactProfileId: artifact.profileId,
                artifactModeEpoch: artifact.modeEpoch,
                activeProfileId: this.options.controlPlane.profileId,
                activeModeEpoch: this.options.controlPlane.modeEpoch,
            });
    }
    async replay(input, pendingOperation, snapshot, token) {
        if (input.approvalArtifactId === undefined ||
            input.approvalArtifactId.trim().length === 0)
            throw new ApplicationError("CONFIRMATION_REQUIRED", "重放已提交的 L3 operation 仍需要原 approval artifact", {
                pendingOperationId: pendingOperation.id,
                confirmBooleanRejected: input.confirm === true,
            });
        const artifact = requireApprovalArtifact(snapshot, input.approvalArtifactId);
        const matches = pendingOperation.projectId === input.projectId &&
            pendingOperation.committedAt !== null &&
            pendingOperation.approvalArtifactId === artifact.id &&
            artifact.projectId === pendingOperation.projectId &&
            artifact.pendingOperationId === pendingOperation.id &&
            artifact.actionType === pendingOperation.actionType &&
            artifact.targetId === pendingOperation.targetId &&
            artifact.digest.value === pendingOperation.digest.value &&
            artifact.status === "consumed" &&
            artifact.consumedAt !== null &&
            artifact.consumedAt === pendingOperation.committedAt;
        if (!matches)
            throw new ApplicationError("COMMIT_REPLAY_MISMATCH", "已提交 operation 只能使用原始且完全匹配的 approval artifact 重放", {
                pendingOperationId: pendingOperation.id,
                pendingOperationProjectId: pendingOperation.projectId,
                pendingOperationCommittedAt: pendingOperation.committedAt,
                expectedApprovalArtifactId: pendingOperation.approvalArtifactId,
                actualApprovalArtifactId: artifact.id,
                artifactProjectId: artifact.projectId,
                artifactPendingOperationId: artifact.pendingOperationId,
                artifactActionType: artifact.actionType,
                artifactTargetId: artifact.targetId,
                artifactDigest: artifact.digest.value,
                artifactStatus: artifact.status,
                artifactConsumedAt: artifact.consumedAt,
            });
        const binding = await getExactArtifactReceiptBinding({
            artifact,
            pendingOperation,
            controlPlane: this.options.controlPlane,
        });
        if (this.options.controlPlane !== null && binding === null)
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "A committed trusted operation cannot replay without its exact authorization receipt", {
                approvalArtifactId: artifact.id,
                pendingOperationId: pendingOperation.id,
                reason: "AUTHORIZATION_RECEIPT_INVALID",
            });
        if (binding !== null && this.options.controlPlane !== null) {
            await this.requireOwnership(token);
            const finalized = await this.options.controlPlane.exactStore.finalizeCommit(binding, buildAuthorizationCommitClaimId(artifact, pendingOperation), pendingOperation.committedAt);
            if (!finalized.ok)
                throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The trusted authorization commit receipt could not be recovered", {
                    approvalArtifactId: artifact.id,
                    pendingOperationId: pendingOperation.id,
                    reason: finalized.code,
                });
        }
        return { pendingOperation, approvalArtifact: artifact, replayed: true };
    }
    applyCommittedOperation(snapshot, pending, live, context) {
        const startGate = live.gateSnapshot.kind === "start"
            ? {
                allowed: live.gateSnapshot.allowed,
                blockers: live.gateSnapshot.blockers,
                openTodoIds: live.gateSnapshot.openTodoIds,
                dueUndoIds: live.gateSnapshot.dueUndoIds,
                dueDeferredIds: live.gateSnapshot.dueDeferredIds,
                selfReferentialUndoIds: [],
                missingDecisionRefs: live.gateSnapshot.missingDecisionRefs,
                blockedConstraintIds: live.gateSnapshot.blockedConstraintIds,
            }
            : {
                allowed: false,
                blockers: [],
                openTodoIds: [],
                dueUndoIds: [],
                dueDeferredIds: [],
                selfReferentialUndoIds: [],
                missingDecisionRefs: [],
                blockedConstraintIds: [],
            };
        switch (pending.actionType) {
            case "start_version": {
                const started = startVersionDomain(requireVersion(snapshot, pending.targetId), startGate, context, this.options.deps);
                snapshot.versions = replaceRecord(snapshot.versions, started.version);
                return { snapshot, events: started.events };
            }
            case "advance_to_version": {
                const nextVersion = requireVersion(snapshot, pending.targetId);
                const current = snapshot.project.currentVersionId === null
                    ? null
                    : requireVersion(snapshot, snapshot.project.currentVersionId);
                if (current === null)
                    throw new ApplicationError("ROUTE_EMPTY", "空路线不能提交 advance_to_version");
                const switched = setCurrentVersionDomain({
                    project: snapshot.project,
                    currentVersion: current,
                    nextVersion,
                    actor: context.actor,
                    deps: this.options.deps,
                    operationContext: context,
                });
                const started = startVersionDomain(switched.nextVersion, startGate, context, this.options.deps);
                snapshot.project = switched.project;
                snapshot.versions = snapshot.versions.map((version) => version.id === started.version.id
                    ? started.version
                    : switched.currentVersion !== null &&
                        version.id === switched.currentVersion.id
                        ? switched.currentVersion
                        : version);
                return {
                    snapshot,
                    events: switched.events.concat(started.events.map((event) => ({
                        ...event,
                        operationSeq: event.operationSeq + switched.events.length,
                    }))),
                };
            }
            case "close_version": {
                const closeGate = live.gateSnapshot.kind === "close"
                    ? {
                        allowed: live.gateSnapshot.allowed,
                        blockers: live.gateSnapshot.blockers,
                        unresolvedTodoIds: live.gateSnapshot.unresolvedTodoIds,
                        unresolvedUndoIds: live.gateSnapshot.unresolvedUndoIds,
                        unresolvedDeferredIds: live.gateSnapshot.unresolvedDeferredIds,
                        blockedConstraintIds: live.gateSnapshot.blockedConstraintIds,
                    }
                    : {
                        allowed: false,
                        blockers: [],
                        unresolvedTodoIds: [],
                        unresolvedUndoIds: [],
                        unresolvedDeferredIds: [],
                        blockedConstraintIds: [],
                    };
                const closed = closeVersionDomain(requireVersion(snapshot, pending.targetId), closeGate, context, this.options.deps);
                snapshot.versions = replaceRecord(snapshot.versions, closed.version);
                return { snapshot, events: closed.events };
            }
            case "shutdown_version": {
                const reason = pending.payload.shutdownReason;
                if (typeof reason !== "string" || reason.trim().length === 0)
                    throw new ApplicationError("MISSING_REQUIRED_FIELD", "shutdown_version payload 缺少 shutdownReason", { pendingOperationId: pending.id });
                const shutdown = shutdownVersionDomain(requireVersion(snapshot, pending.targetId), reason, context, this.options.deps, pending.reason);
                snapshot.versions = replaceRecord(snapshot.versions, shutdown.version);
                return { snapshot, events: shutdown.events };
            }
            case "reopen_version": {
                const reopened = reopenVersionDomain(requireVersion(snapshot, pending.targetId), context, this.options.deps);
                snapshot.versions = replaceRecord(snapshot.versions, reopened.version);
                return { snapshot, events: reopened.events };
            }
            case "set_current_version": {
                const nextVersion = requireVersion(snapshot, pending.targetId);
                const current = snapshot.project.currentVersionId === null
                    ? null
                    : requireVersion(snapshot, snapshot.project.currentVersionId);
                const switched = setCurrentVersionDomain({
                    project: snapshot.project,
                    currentVersion: current,
                    nextVersion,
                    actor: context.actor,
                    deps: this.options.deps,
                    operationContext: context,
                });
                snapshot.project = switched.project;
                snapshot.versions = snapshot.versions.map((version) => version.id === switched.nextVersion.id
                    ? switched.nextVersion
                    : switched.currentVersion !== null &&
                        version.id === switched.currentVersion.id
                        ? switched.currentVersion
                        : version);
                return { snapshot, events: switched.events };
            }
            case "create_version":
            case "insert_version":
            case "create_child_version":
            case "reorder_versions": {
                if (pending.actionType === "insert_version" &&
                    live.payload.batchNormalizedPlan)
                    return this.applyBatch(snapshot, live.payload, context);
                const changed = applyVersionTreeMutation({
                    projectId: snapshot.project.id,
                    versions: snapshot.versions,
                    actionType: pending.actionType,
                    targetId: pending.targetId,
                    payload: live.payload,
                    actor: context.actor,
                    now: context.now,
                });
                snapshot.versions = changed.versions;
                const setCurrent = pending.actionType === "create_version" &&
                    live.payload.setAsCurrent === true;
                if (setCurrent) {
                    if (snapshot.project.currentVersionId !== null)
                        throw new ApplicationError("INVALID_VERSION_TRANSITION", "仅空路线允许 create_version 原子设置首个 current Version", { currentVersionId: snapshot.project.currentVersionId });
                    snapshot.project = {
                        ...snapshot.project,
                        currentVersionId: pending.targetId,
                        updatedAt: context.now,
                    };
                    snapshot.versions = snapshot.versions.map((version) => version.id === pending.targetId
                        ? { ...version, isCurrent: true, updatedAt: context.now }
                        : version);
                }
                const drafts = setCurrent
                    ? changed.eventDrafts.concat({
                        targetType: "project",
                        targetId: snapshot.project.id,
                        eventType: "project.current_version_changed",
                        fromState: null,
                        toState: pending.targetId,
                    })
                    : changed.eventDrafts;
                return {
                    snapshot,
                    events: createAuditEvents(drafts, snapshot.project.id, context.actor, context.now, context.operationId, this.options.deps),
                };
            }
            default: {
                const exhaustive = pending.actionType;
                throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "未支持的 L3 action", { actionType: exhaustive });
            }
        }
    }
    applyBatch(snapshot, payload, context) {
        const plan = payload.batchNormalizedPlan;
        if (plan === undefined || plan.length === 0)
            throw new ApplicationError("BATCH_VERSION_PLAN_INVALID", "batch_create_versions 缺少 normalized plan");
        let next = {
            ...snapshot,
            versions: snapshot.versions.slice(),
            workItems: snapshot.workItems.slice(),
            todos: snapshot.todos.slice(),
        };
        let events = [];
        const ids = new Map();
        const previewIds = new Map();
        for (const item of plan) {
            const id = this.options.deps.idGenerator.nextId();
            const previousVersionId = item.previousRef === null
                ? null
                : (previewIds.get(item.previousRef) ?? item.previousRef);
            const nextVersionId = item.nextRef === null
                ? null
                : (previewIds.get(item.nextRef) ?? item.nextRef);
            const actionType = item.parentVersionId === null &&
                item.previousRef === null &&
                item.nextRef === null
                ? "create_version"
                : item.parentVersionId === null
                    ? "insert_version"
                    : "create_child_version";
            const changed = applyVersionTreeMutation({
                projectId: next.project.id,
                versions: next.versions,
                actionType,
                targetId: id,
                payload: {
                    title: item.title,
                    description: item.description,
                    parentVersionId: item.parentVersionId,
                    previousVersionId,
                    nextVersionId,
                },
                actor: context.actor,
                now: context.now,
            });
            ids.set(item.clientKey, id);
            previewIds.set(item.previewVersionId, id);
            next = { ...next, versions: changed.versions };
            events = events.concat(createAuditEvents(changed.eventDrafts, next.project.id, context.actor, context.now, context.operationId, this.options.deps, events.length));
        }
        for (const item of plan) {
            const versionId = ids.get(item.clientKey);
            if (versionId === undefined)
                throw new ApplicationError("BATCH_VERSION_PLAN_INVALID", "clientKey 无法映射到实际 version id", { clientKey: item.clientKey });
            for (const title of item.initialTodos) {
                const created = createTodoDomain({
                    projectId: next.project.id,
                    versionId,
                    title,
                    actor: context.actor,
                    deps: this.options.deps,
                });
                next = {
                    ...next,
                    workItems: next.workItems.concat(created.workItem),
                    todos: next.todos.concat(created.todo),
                };
                events = events.concat(createAuditEvents([
                    {
                        targetType: "todo",
                        targetId: created.todo.id,
                        eventType: "todo.created",
                        toState: created.todo.status,
                    },
                    {
                        targetType: "work_item",
                        targetId: created.workItem.id,
                        eventType: "work_item.created",
                        toState: created.workItem.status,
                    },
                ], next.project.id, context.actor, context.now, context.operationId, this.options.deps, events.length));
            }
        }
        if (payload.batchSetCurrentTo !== undefined &&
            payload.batchSetCurrentTo !== null) {
            const target = ids.get(payload.batchSetCurrentTo) ??
                previewIds.get(payload.batchSetCurrentTo);
            if (target === undefined)
                throw new ApplicationError("SET_CURRENT_TARGET_INVALID", "batch setCurrentTo 无法映射到实际 version", { setCurrentTo: payload.batchSetCurrentTo });
            if (next.project.currentVersionId !== target) {
                const previous = next.project.currentVersionId;
                next = {
                    ...next,
                    project: {
                        ...next.project,
                        currentVersionId: target,
                        updatedAt: context.now,
                    },
                    versions: next.versions.map((version) => version.id === target
                        ? { ...version, isCurrent: true, updatedAt: context.now }
                        : previous !== null && version.id === previous
                            ? { ...version, isCurrent: false, updatedAt: context.now }
                            : version),
                };
                events = events.concat(createAuditEvents([
                    {
                        targetType: "project",
                        targetId: next.project.id,
                        eventType: "project.current_version_changed",
                        fromState: previous,
                        toState: target,
                    },
                ], next.project.id, context.actor, context.now, context.operationId, this.options.deps, events.length));
            }
        }
        return { snapshot: next, events };
    }
}
