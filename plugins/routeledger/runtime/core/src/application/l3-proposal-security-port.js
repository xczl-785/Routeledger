import crypto from "node:crypto";
const sortKeys = (value) => {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((accumulator, key) => {
            accumulator[key] = sortKeys(value[key]);
            return accumulator;
        }, {});
    }
    return value;
};
const stableStringify = (value) => JSON.stringify(sortKeys(value));
const buildDigestGateSnapshot = (gateSnapshot, includeExtendedGateState) => {
    if (gateSnapshot.kind === "start") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            openTodoIds: gateSnapshot.openTodoIds,
            dueUndoIds: gateSnapshot.dueUndoIds,
            ...(includeExtendedGateState
                ? {
                    dueDeferredIds: gateSnapshot.dueDeferredIds,
                    blockedConstraintIds: gateSnapshot.blockedConstraintIds
                }
                : {}),
            missingDecisionRefs: gateSnapshot.missingDecisionRefs
        };
    }
    if (gateSnapshot.kind === "close") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            unresolvedTodoIds: gateSnapshot.unresolvedTodoIds,
            unresolvedUndoIds: gateSnapshot.unresolvedUndoIds,
            ...(includeExtendedGateState
                ? {
                    unresolvedDeferredIds: gateSnapshot.unresolvedDeferredIds,
                    blockedConstraintIds: gateSnapshot.blockedConstraintIds
                }
                : {}),
            residualAudit: gateSnapshot.residualAudit,
            residualAuditReviewed: gateSnapshot.residualAuditReviewed === true
        };
    }
    if (gateSnapshot.kind === "shutdown") {
        return {
            kind: gateSnapshot.kind,
            allowed: gateSnapshot.allowed,
            blockers: gateSnapshot.blockers,
            forced: gateSnapshot.forced,
            stateReason: gateSnapshot.stateReason,
            ordinaryCloseGate: {
                allowed: gateSnapshot.ordinaryCloseGate.allowed,
                blockers: gateSnapshot.ordinaryCloseGate.blockers,
                unresolvedTodoIds: gateSnapshot.ordinaryCloseGate.unresolvedTodoIds,
                unresolvedUndoIds: gateSnapshot.ordinaryCloseGate.unresolvedUndoIds,
                ...(includeExtendedGateState
                    ? {
                        unresolvedDeferredIds: gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds,
                        blockedConstraintIds: gateSnapshot.ordinaryCloseGate.blockedConstraintIds
                    }
                    : {})
            }
        };
    }
    return {
        kind: gateSnapshot.kind,
        allowed: gateSnapshot.allowed,
        blockers: gateSnapshot.blockers
    };
};
const rebuildL3ProposalDigest = (material, includeExtendedGateState) => {
    const digestPayload = {
        projectId: material.projectId,
        actionType: material.actionType,
        targetId: material.targetId,
        payload: material.payload,
        gateSnapshot: buildDigestGateSnapshot(material.gateSnapshot, includeExtendedGateState)
    };
    return {
        algorithm: "sha256",
        value: crypto.createHash("sha256").update(stableStringify(digestPayload)).digest("hex"),
        payload: digestPayload
    };
};
/** Non-injectable canonical verifier used by proposal persistence and commit. */
export const rebuildCanonicalL3ProposalDigest = (material) => rebuildL3ProposalDigest(material, true);
/** Compatibility verifier for stored proposals written before extended gate state. */
export const rebuildLegacyL3ProposalDigest = (material) => rebuildL3ProposalDigest(material, false);
