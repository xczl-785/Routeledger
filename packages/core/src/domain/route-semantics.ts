import type { Undo } from "./undo.js";
import type { Version } from "./version.js";

export const SHUTDOWN_STATE_REASON_PREFIX = "shutdown:";

export type VersionDisplayState = Version["state"] | "shutdown";

export interface VersionStatePresentation {
  displayState: VersionDisplayState;
  displayLabel: string;
  isShutdown: boolean;
  stateReason: string | null;
}

export const isShutdownStateReason = (stateReason: string | null): boolean =>
  typeof stateReason === "string" && stateReason.startsWith(SHUTDOWN_STATE_REASON_PREFIX);

export const buildShutdownStateReason = (shutdownReason: string): string => {
  const normalized = shutdownReason.trim();

  if (normalized.length === 0) {
    throw new Error("shutdownReason must not be empty");
  }

  return normalized.startsWith(SHUTDOWN_STATE_REASON_PREFIX)
    ? normalized
    : `${SHUTDOWN_STATE_REASON_PREFIX}${normalized}`;
};

export const describeVersionState = (
  version: Pick<Version, "state" | "stateReason">
): VersionStatePresentation => {
  const isShutdown = version.state === "close" && isShutdownStateReason(version.stateReason);

  return {
    displayState: isShutdown ? "shutdown" : version.state,
    displayLabel: isShutdown ? "SHUTDOWN" : version.state.toUpperCase(),
    isShutdown,
    stateReason: version.stateReason
  };
};

export const isUndoCarriedForwardAwayFromVersion = (
  undo: Pick<
    Undo,
    "versionId" | "originVersionId" | "carriedForwardAt" | "carriedForwardToVersionId"
  >,
  versionId: string
): boolean =>
  undo.carriedForwardAt !== null &&
  undo.carriedForwardToVersionId !== null &&
  undo.carriedForwardToVersionId !== versionId &&
  (undo.versionId === versionId || undo.originVersionId === versionId);

export const isUndoBlockingCloseForVersion = (
  undo: Pick<
    Undo,
    | "status"
    | "versionId"
    | "originVersionId"
    | "carriedForwardAt"
    | "carriedForwardToVersionId"
  >,
  versionId: string
): boolean =>
  undo.status === "wait" && !isUndoCarriedForwardAwayFromVersion(undo, versionId);
