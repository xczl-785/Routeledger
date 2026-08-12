import type { L3AuthorizationGrantSource } from "./l3-authorization-grant.js";
import type { L3ActionType } from "./types.js";

/**
 * Frozen target contract for the exact-only authorization migration.
 *
 * This module is intentionally not wired into the 0.7.2 runtime. EA0 owns the
 * contract and migration oracle; EA1 and later Versions own runtime adoption.
 */
export const EXACT_AUTHORIZATION_SCHEMA_VERSION = 2 as const;

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
  readonly source: L3AuthorizationGrantSource;
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
  /**
   * 0.8 compatibility provenance only. It is never a matching, reuse, or
   * authority key. Writers SHOULD emit null; 0.9 removes the field.
   */
  readonly sessionId?: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

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
  readonly source: L3AuthorizationGrantSource;
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

export interface ExactDecisionArtifactResponse {
  readonly artifactId: string;
  readonly authorizationId: string;
  readonly proposalId: string;
  readonly projectId: string;
  readonly actionType: L3ActionType;
  readonly targetId: string;
  readonly operationDigest: string;
  readonly source: L3AuthorizationGrantSource;
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

export type LegacyAuthorizationRecordKind =
  | "grant"
  | "approval_artifact"
  | "receipt"
  | "host_state";

export interface LegacyAuthorizationRecordDescriptor {
  readonly kind: LegacyAuthorizationRecordKind;
  readonly status?: string;
  readonly scope?: "operation" | "turn" | "session" | "time_window";
  readonly operationDigest?: string | null;
}

export type LegacyAuthorizationDisposition =
  | "revoke_and_tombstone_then_reauthorize"
  | "retain_as_immutable_audit_evidence"
  | "migrate_policy_configuration_without_authority";

/**
 * Migration is deliberately conservative: no legacy grant, including an
 * exact operation-scoped one-shot grant, becomes active v2 authority.
 */
export const classifyLegacyAuthorizationRecord = (
  record: LegacyAuthorizationRecordDescriptor
): LegacyAuthorizationDisposition => {
  if (record.kind === "grant") {
    return "revoke_and_tombstone_then_reauthorize";
  }
  if (record.kind === "host_state") {
    return "migrate_policy_configuration_without_authority";
  }
  return "retain_as_immutable_audit_evidence";
};
