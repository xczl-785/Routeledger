import { DomainError } from "../domain/errors.js";
import { buildShutdownStateReason } from "../domain/route-semantics.js";
import { assertCloseGate, assertStartGate } from "./gate-service.js";
import { createTransitionEvents } from "./transition-event-service.js";
const updateVersion = (version, nextState, context, deps, reason) => {
    const updatedVersion = {
        ...version,
        state: nextState,
        updatedAt: context.now,
        closedAt: nextState === "close" ? context.now : version.closedAt,
        stateReason: reason ?? null
    };
    return {
        version: updatedVersion,
        events: createTransitionEvents([
            {
                targetType: "version",
                targetId: version.id,
                eventType: "version.state_changed",
                fromState: version.state,
                toState: nextState,
                note: reason ?? null
            }
        ], {
            projectId: version.projectId,
            operationId: context.operationId,
            actor: context.actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const prepareVersion = (version, context, deps) => {
    if (version.state !== "wait") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "prepare_version 仅允许 wait -> ready", { versionId: version.id, state: version.state });
    }
    return updateVersion(version, "ready", context, deps);
};
export const startVersion = (version, gate, context, deps) => {
    if (version.state !== "ready") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "start_version 仅允许 ready -> running", { versionId: version.id, state: version.state });
    }
    assertStartGate(gate);
    return updateVersion(version, "running", context, deps);
};
export const suspendVersion = (version, context, deps, reason = "current version switched") => {
    if (version.state !== "running") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "suspend_version 仅允许 running -> suspend", { versionId: version.id, state: version.state });
    }
    return updateVersion(version, "suspend", context, deps, reason);
};
export const reopenVersion = (version, context, deps) => {
    if (version.state !== "close" && version.state !== "suspend") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "reopen_version 仅允许 close|suspend -> ready", { versionId: version.id, state: version.state });
    }
    return updateVersion(version, "ready", context, deps);
};
export const markVersionComplete = (version, context, deps) => {
    if (version.state !== "running") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "mark_version_complete 仅允许 running -> complete", { versionId: version.id, state: version.state });
    }
    return updateVersion(version, "complete", context, deps);
};
export const closeVersion = (version, gate, context, deps) => {
    if (version.state !== "complete") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "close_version 仅允许 complete -> close", { versionId: version.id, state: version.state });
    }
    assertCloseGate(gate);
    return updateVersion(version, "close", context, deps);
};
export const shutdownVersion = (version, shutdownReason, context, deps, note) => {
    if (version.state === "close") {
        throw new DomainError("INVALID_VERSION_TRANSITION", "shutdown_version 不适用于已 close 的 version", { versionId: version.id, state: version.state });
    }
    const stateReason = buildShutdownStateReason(shutdownReason);
    const updatedVersion = {
        ...version,
        state: "close",
        updatedAt: context.now,
        closedAt: context.now,
        stateReason
    };
    return {
        version: updatedVersion,
        events: createTransitionEvents([
            {
                targetType: "version",
                targetId: version.id,
                eventType: "version.shutdown",
                fromState: version.state,
                toState: updatedVersion.state,
                note: note ?? shutdownReason,
                metadata: {
                    forced: true,
                    shutdownReason,
                    stateReason
                }
            },
            {
                targetType: "version",
                targetId: version.id,
                eventType: "version.state_changed",
                fromState: version.state,
                toState: updatedVersion.state,
                note: note ?? shutdownReason,
                metadata: {
                    forced: true,
                    shutdownReason,
                    stateReason
                }
            }
        ], {
            projectId: version.projectId,
            operationId: context.operationId,
            actor: context.actor,
            now: context.now
        }, deps.idGenerator)
    };
};
