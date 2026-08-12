/** @internal Decoder/migration-only representation of pre-exact authorization data. */
export type LegacyAuthorizationRecordKind =
  | "grant"
  | "approval_artifact"
  | "receipt"
  | "host_state";

/** @internal Never use this shape to authorize a live operation. */
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

/** No legacy record is promoted into live exact authority. */
export const classifyLegacyAuthorizationRecord = (
  record: LegacyAuthorizationRecordDescriptor
): LegacyAuthorizationDisposition => {
  if (record.kind === "grant") return "revoke_and_tombstone_then_reauthorize";
  if (record.kind === "host_state") {
    return "migrate_policy_configuration_without_authority";
  }
  return "retain_as_immutable_audit_evidence";
};
