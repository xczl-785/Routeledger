/** @internal Field names accepted only while decoding pre-exact host authority files. */
export const LEGACY_AUTHORITY_CONFIG_TTL_FIELD = "grantTtlSeconds";
/** @internal Field names accepted only while tombstoning pre-exact records. */
export const LEGACY_GRANT_FIELDS = {
    actions: "allowedActions",
    targets: "allowedTargetIds",
    limit: "maxUses",
    count: "uses"
};
