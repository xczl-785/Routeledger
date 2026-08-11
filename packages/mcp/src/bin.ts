#!/usr/bin/env tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runRouteLedgerStdioServer } from "./stdio-server.js";
import type { SqliteReadModelMode } from "./json-first-storage.js";
import type { RouteLedgerMcpRuntimeProfile } from "./index.js";
import { loadLocalL3AuthorityRuntime } from "./local-l3-authorization.js";
import { createLocalL3AuthorityBroker } from "./local-l3-authority-broker.js";
import { resolveCodexL3PermissionMode } from "@routeledger/codex";

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

export const discoverDefaultLocalL3AuthorityRegistry = async (): Promise<string | undefined> => {
  const registryRoot = path.join(
    os.homedir(),
    ".routeledger",
    "host-authority",
    "l3-v2"
  );
  try {
    const marker = await fs.lstat(path.join(registryRoot, "registry-v2.json"));
    if (!marker.isFile() || marker.isSymbolicLink()) {
      throw new Error("The default local L3 authority registry marker is not a trusted regular file.");
    }
    return registryRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  const l3AuthorityConfig = getConfigValue(
    argv,
    "--l3-authority-config",
    "ROUTELEDGER_MCP_L3_AUTHORITY_CONFIG"
  );
  const configuredL3AuthorityRegistry = getConfigValue(
    argv,
    "--l3-authority-registry",
    "ROUTELEDGER_MCP_L3_AUTHORITY_REGISTRY"
  );
  const l3TrustedClientId = getConfigValue(
    argv,
    "--l3-trusted-client-id",
    "ROUTELEDGER_MCP_L3_TRUSTED_CLIENT_ID"
  );
  const resolvedHostProfile =
    hostProfile === "generic" ||
    hostProfile === "codex" ||
    hostProfile === "claude-code" ||
    hostProfile === "cursor"
      ? hostProfile
      : "generic";
  const hostPermissionContext =
    resolvedHostProfile === "codex" ? resolveCodexL3PermissionMode(process.env) : undefined;
  const l3AuthorityRegistry =
    configuredL3AuthorityRegistry ??
    (resolvedHostProfile === "codex"
      ? await discoverDefaultLocalL3AuthorityRegistry()
      : undefined);
  if (l3AuthorityConfig !== undefined && l3AuthorityRegistry !== undefined) {
    throw new Error(
      "Use either the V1 --l3-authority-config compatibility path or the V2 --l3-authority-registry broker, not both."
    );
  }
  const l3AuthorityRuntime =
    l3AuthorityConfig === undefined
      ? undefined
      : await loadLocalL3AuthorityRuntime({
          configPath: l3AuthorityConfig,
          workspaceRoot:
            workspaceRoot ??
            (() => {
              throw new Error(
                "--l3-authority-config requires an explicit --workspace-root or ROUTELEDGER_MCP_WORKSPACE_ROOT."
              );
            })(),
          routeledgerRoot:
            routeledgerRoot ??
            (() => {
              throw new Error(
                "--l3-authority-config requires an explicit --routeledger-root or ROUTELEDGER_MCP_ROUTELEDGER_ROOT."
              );
            })(),
          hostKind: resolvedHostProfile,
          subjectId: approverId ?? "mcp-user"
        });

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
    hostProfile: resolvedHostProfile,
    ...(hostPermissionContext === undefined ? {} : { hostPermissionContext }),
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
    ...(l3AuthorityRuntime === undefined
      ? {}
      : {
          l3Authorization: {
            grantStore: l3AuthorityRuntime.grantStore,
            ...(l3AuthorityRuntime.trustedClientId === undefined
              ? {}
              : { trustedClientId: l3AuthorityRuntime.trustedClientId }),
            delegatedAuthority: l3AuthorityRuntime.authority
          }
        }),
    ...(l3AuthorityRegistry === undefined
      ? {}
      : {
          l3AuthorityBroker: createLocalL3AuthorityBroker({
            registryRoot: l3AuthorityRegistry,
            hostKind: resolvedHostProfile,
            subjectId:
              approverId ?? (resolvedHostProfile === "codex" ? "routeledger-approver" : "mcp-user"),
            trustedClientId:
              l3TrustedClientId ?? (resolvedHostProfile === "codex" ? "codex-local-host" : null)
          })
        }),
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    once: hasFlag(argv, "--once")
  });
};

void main();
