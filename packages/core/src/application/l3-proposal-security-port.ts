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
