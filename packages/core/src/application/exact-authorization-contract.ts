import type { L3ActionType } from "./types.js";

/**
 * Frozen target contract for the exact-only authorization migration.
 *
 * This module is intentionally not wired into the 0.7.2 runtime. EA0 owns the
 * contract and migration oracle; EA1 and later Versions own runtime adoption.
 */
export const EXACT_AUTHORIZATION_SCHEMA_VERSION = 2 as const;

export type ExactAuthorizationSource =
  | "user_interaction"
  | "delegated_policy"
  | "preauthorized"
  | "host_admission";

export interface ExactAuthorizationContext {
  readonly audience: string;
  readonly subjectId: string;
  readonly projectId: string;
  readonly routeledgerRootDigest: string;
  readonly profileId?: string;
  readonly modeEpoch?: number;
  readonly profileDigest?: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly now: string;
  readonly hostKind: string;
  readonly clientId?: string;
}

export interface ExactAuthorizationBinding {
  readonly proposalId: string;
  readonly projectId: string;
  readonly routeledgerRootDigest: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
}

export interface ExactAuthorization {
  readonly schemaVersion: typeof EXACT_AUTHORIZATION_SCHEMA_VERSION;
  /** Stable authorization identity; deliberately distinct from artifactId. */
  readonly authorizationId: string;
  readonly artifactId: string;
  readonly binding: ExactAuthorizationBinding;
  readonly source: ExactAuthorizationSource;
  readonly decisionRef: string;
  readonly issuer: string;
  readonly audience: string;
  readonly subjectId: string;
  readonly policyId: string | null;
  readonly policyDigest: string | null;
  readonly profileId: string | null;
  readonly modeEpoch: number | null;
  readonly profileDigest: string | null;
  readonly hostKind: string;
  readonly clientId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Exact decision before the canonical approval artifact is minted. */
export type ExactAuthorizationCandidate = Omit<ExactAuthorization, "artifactId">;

export type ExactAuthorizationReceiptStatus =
  | "authorized"
  | "commit_claimed"
  | "committed"
  | "revoked";

export interface ExactAuthorizationReceipt {
  readonly authorizationId: string;
  readonly artifactId: string;
  readonly binding: ExactAuthorizationBinding;
  readonly issuer: string;
  readonly audience: string;
  readonly subjectId: string;
  readonly source: ExactAuthorizationSource;
  readonly decisionRef: string;
  readonly policyId: string | null;
  readonly policyDigest: string | null;
  readonly profileId: string | null;
  readonly modeEpoch: number | null;
  readonly profileDigest: string | null;
  readonly hostKind: string;
  readonly clientId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ExactAuthorizationReceiptStatus;
  readonly commitClaimId: string | null;
  readonly commitClaimedAt: string | null;
  readonly committedAt: string | null;
  readonly revokedAt: string | null;
}

export type ExactAuthorizationReceiptBinding = Omit<
  ExactAuthorizationReceipt,
  | "status"
  | "commitClaimId"
  | "commitClaimedAt"
  | "committedAt"
  | "revokedAt"
>;

export interface ExactDecisionArtifactResponse {
  readonly artifactId: string;
  readonly authorizationId: string;
  readonly proposalId: string;
  readonly projectId: string;
  readonly routeledgerRootDigest: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly source: ExactAuthorizationSource;
  readonly decisionRef: string;
  readonly status: "approved" | "consumed";
}

export const GENERIC_EXACT_DECISION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    approve: { type: "boolean" }
  },
  required: ["approve"],
  additionalProperties: false
} as const;
