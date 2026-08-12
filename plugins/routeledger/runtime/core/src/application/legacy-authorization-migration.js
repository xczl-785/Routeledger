/** No legacy record is promoted into live exact authority. */
export const classifyLegacyAuthorizationRecord = (record) => {
    if (record.kind === "grant")
        return "revoke_and_tombstone_then_reauthorize";
    if (record.kind === "host_state") {
        return "migrate_policy_configuration_without_authority";
    }
    return "retain_as_immutable_audit_evidence";
};
