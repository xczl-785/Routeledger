export const ROUTELEDGER_JSON_ROOT = ".routeledger";
export const ROUTELEDGER_SCHEMA_VERSION = 2;
export const ROUTELEDGER_READABLE_SCHEMA_VERSIONS = [1, ROUTELEDGER_SCHEMA_VERSION] as const;
export const SCHEMA_DOCUMENT_PATH = `${ROUTELEDGER_JSON_ROOT}/schema/routeledger.schema.json`;
export const PROJECT_DOCUMENT_PATH = `${ROUTELEDGER_JSON_ROOT}/project.json`;
export const CURRENT_REF_DOCUMENT_PATH = `${ROUTELEDGER_JSON_ROOT}/refs/current.json`;
