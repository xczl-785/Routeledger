/**
 * RouteLedger storage layout names owned by the MCP runtime boundary.
 *
 * These names intentionally do not require loading the SQLite read-model
 * package: JSON-only hosts still need to locate canonical documents and
 * report an existing legacy database without initializing its native module.
 */
export const ROUTELEDGER_DIRECTORY = ".routeledger";
export const ROUTELEDGER_DB_DIRECTORY = `${ROUTELEDGER_DIRECTORY}/db`;
export const ROUTELEDGER_DB_FILENAME = "routeledger.sqlite3";
