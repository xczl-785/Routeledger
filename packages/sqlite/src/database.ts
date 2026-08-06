import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { applyMigrations } from "./migrations.js";

export const ROUTELEDGER_DIRECTORY = ".routeledger";
export const ROUTELEDGER_DB_DIRECTORY = path.join(ROUTELEDGER_DIRECTORY, "db");
export const ROUTELEDGER_VIEWS_DIRECTORY = path.join(ROUTELEDGER_DIRECTORY, "views");
export const ROUTELEDGER_DB_FILENAME = "routeledger.sqlite3";

export interface OpenRouteLedgerDatabaseOptions {
  projectRoot: string;
}

export interface OpenRouteLedgerDatabaseResult {
  db: BetterSqlite3.Database;
  databasePath: string;
  close: () => void;
}

export const openRouteLedgerDatabase = ({
  projectRoot
}: OpenRouteLedgerDatabaseOptions): OpenRouteLedgerDatabaseResult => {
  const databaseDirectory = path.join(projectRoot, ROUTELEDGER_DB_DIRECTORY);
  fs.mkdirSync(databaseDirectory, { recursive: true });

  const databasePath = path.join(databaseDirectory, ROUTELEDGER_DB_FILENAME);
  const db = new BetterSqlite3(databasePath);

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);

  return {
    db,
    databasePath,
    close: () => db.close()
  };
};
