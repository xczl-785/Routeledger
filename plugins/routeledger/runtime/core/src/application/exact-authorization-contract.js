/**
 * Frozen target contract for the exact-only authorization migration.
 *
 * This module is intentionally not wired into the 0.7.2 runtime. EA0 owns the
 * contract and migration oracle; EA1 and later Versions own runtime adoption.
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
