import crypto from "node:crypto";

import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";

import type {
  GateSnapshot,
  L3ActionType,
  OperationDigest,
  PendingOperationPayload
} from "./types.js";

/**
 * One atomically generated L3 proposal description. Consumers must keep these
 * fields together: the digest binds the normalized payload and gate snapshot.
 */
export interface L3ProposalSecurityDescription {
  actionType: L3ActionType;
  targetId: string;
  payload: PendingOperationPayload;
  gateSnapshot: GateSnapshot;
  digest: OperationDigest;
}

export interface L3DescribeProposalInput {
  snapshot: ProjectAggregateSnapshot;
  actionType: L3ActionType;
  targetId: string;
  payload: PendingOperationPayload;
  evaluatedAt: string;
}

/** Canonical verifier material deliberately excludes the stored digest. */
export interface L3CanonicalDigestMaterial {
  projectId: string;
  actionType: L3ActionType;
  targetId: string;
  payload: PendingOperationPayload;
  gateSnapshot: GateSnapshot;
}

/**
 * Security boundary for proposal normalization, live gates, and canonical
 * digests. It deliberately exposes no separately callable gate or digest
 * builders: descriptions are formed as one value. The RouteLedgerService
 * verifies persisted descriptions with its own non-injectable canonical
 * digest verifier.
 */
export interface L3ProposalSecurityPort {
  describe(input: L3DescribeProposalInput): L3ProposalSecurityDescription;
}

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

const buildDigestGateSnapshot = (
  gateSnapshot: GateSnapshot,
  includeExtendedGateState: boolean
): Record<string, unknown> => {
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

const rebuildL3ProposalDigest = (
  material: L3CanonicalDigestMaterial,
  includeExtendedGateState: boolean
): OperationDigest => {
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
export const rebuildCanonicalL3ProposalDigest = (
  material: L3CanonicalDigestMaterial
): OperationDigest => rebuildL3ProposalDigest(material, true);

/** Compatibility verifier for stored proposals written before extended gate state. */
export const rebuildLegacyL3ProposalDigest = (
  material: L3CanonicalDigestMaterial
): OperationDigest => rebuildL3ProposalDigest(material, false);
