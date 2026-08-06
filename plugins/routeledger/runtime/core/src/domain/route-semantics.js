export const SHUTDOWN_STATE_REASON_PREFIX = "shutdown:";
export const isShutdownStateReason = (stateReason) => typeof stateReason === "string" && stateReason.startsWith(SHUTDOWN_STATE_REASON_PREFIX);
export const buildShutdownStateReason = (shutdownReason) => {
    const normalized = shutdownReason.trim();
    if (normalized.length === 0) {
        throw new Error("shutdownReason must not be empty");
    }
    return normalized.startsWith(SHUTDOWN_STATE_REASON_PREFIX)
        ? normalized
        : `${SHUTDOWN_STATE_REASON_PREFIX}${normalized}`;
};
export const describeVersionState = (version) => {
    const isShutdown = version.state === "close" && isShutdownStateReason(version.stateReason);
    return {
        displayState: isShutdown ? "shutdown" : version.state,
        displayLabel: isShutdown ? "SHUTDOWN" : version.state.toUpperCase(),
        isShutdown,
        stateReason: version.stateReason
    };
};
export const isUndoCarriedForwardAwayFromVersion = (undo, versionId) => undo.carriedForwardAt !== null &&
    undo.carriedForwardToVersionId !== null &&
    undo.carriedForwardToVersionId !== versionId &&
    (undo.versionId === versionId || undo.originVersionId === versionId);
export const isUndoBlockingCloseForVersion = (undo, versionId) => undo.status === "wait" && !isUndoCarriedForwardAwayFromVersion(undo, versionId);
