#!/usr/bin/env tsx

import { runRouteLedgerStdioServer } from "./stdio-server.js";
import type { SqliteReadModelMode } from "./json-first-storage.js";
import type { RouteLedgerMcpRuntimeProfile } from "./index.js";

const getFlagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.findIndex((argument) => argument === name);

  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

const getConfigValue = (
  argv: string[],
  flagName: string,
  envName: string
): string | undefined => getFlagValue(argv, flagName) ?? process.env[envName];

export const parseSqliteReadModel = (value: string | undefined): SqliteReadModelMode => {
  if (value === undefined) {
    return "enabled";
  }

  if (value === "enabled" || value === "disabled") {
    return value;
  }

  throw new Error(
    "Invalid SQLite read-model setting. Use --sqlite-read-model enabled|disabled or ROUTELEDGER_MCP_SQLITE_READ_MODEL=enabled|disabled."
  );
};

export const parseRuntimeProfile = (
  value: string | undefined
): RouteLedgerMcpRuntimeProfile => {
  if (value === undefined) {
    return "full";
  }

  if (value === "full" || value === "json-only") {
    return value;
  }

  throw new Error(
    "Invalid MCP runtime profile. ROUTELEDGER_MCP_RUNTIME_PROFILE must be full or json-only."
  );
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const workspaceRootFlag = getFlagValue(argv, "--workspace-root");
  const workspaceRootEnv = process.env.ROUTELEDGER_MCP_WORKSPACE_ROOT;
  const workspaceRoot = workspaceRootFlag ?? workspaceRootEnv;
  const routeledgerRoot = getConfigValue(
    argv,
    "--routeledger-root",
    "ROUTELEDGER_MCP_ROUTELEDGER_ROOT"
  );
  const hostProfile = getConfigValue(argv, "--profile", "ROUTELEDGER_MCP_PROFILE");
  const defaultResponseLocale = getConfigValue(
    argv,
    "--response-locale",
    "ROUTELEDGER_MCP_RESPONSE_LOCALE"
  );
  const actorId = getConfigValue(argv, "--actor-id", "ROUTELEDGER_MCP_ACTOR_ID");
  const actorName = getConfigValue(argv, "--actor-name", "ROUTELEDGER_MCP_ACTOR_NAME");
  const approverId = getConfigValue(
    argv,
    "--approver-id",
    "ROUTELEDGER_MCP_APPROVER_ID"
  );
  const approverName = getConfigValue(
    argv,
    "--approver-name",
    "ROUTELEDGER_MCP_APPROVER_NAME"
  );
  const sqliteReadModelFlag = getFlagValue(argv, "--sqlite-read-model");
  const sqliteReadModel = parseSqliteReadModel(
    hasFlag(argv, "--sqlite-read-model")
      ? (sqliteReadModelFlag ?? "")
      : process.env.ROUTELEDGER_MCP_SQLITE_READ_MODEL
  );
  const runtimeProfile = parseRuntimeProfile(process.env.ROUTELEDGER_MCP_RUNTIME_PROFILE);

  await runRouteLedgerStdioServer({
    workspaceRoot,
    workspaceRootSource:
      workspaceRootFlag !== undefined
        ? "explicit_arg"
        : workspaceRootEnv !== undefined
          ? "explicit_env"
          : undefined,
    routeledgerRoot,
    sqliteReadModel,
    runtimeProfile,
    defaultResponseLocale,
    hostProfile:
      hostProfile === "generic" ||
      hostProfile === "codex" ||
      hostProfile === "claude-code" ||
      hostProfile === "cursor"
        ? hostProfile
        : undefined,
    actor:
      actorId === undefined && actorName === undefined
        ? undefined
        : {
            id: actorId,
            displayName: actorName
          },
    approver:
      approverId === undefined && approverName === undefined
        ? undefined
        : {
            id: approverId,
            displayName: approverName
          },
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    once: hasFlag(argv, "--once")
  });
};

void main();
