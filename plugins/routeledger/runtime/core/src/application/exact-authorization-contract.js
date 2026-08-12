/**
 * Frozen target contract for the exact-only authorization migration.
 *
 * This module is the active 0.8 exact-only authorization contract. Legacy
 * decoders may classify older records for audit, but cannot mint authority.
 */
export const EXACT_AUTHORIZATION_SCHEMA_VERSION = 2;
export const GENERIC_EXACT_DECISION_INPUT_SCHEMA = {
    type: "object",
    properties: {
        approve: { type: "boolean" }
    },
    required: ["approve"],
    additionalProperties: false
};
