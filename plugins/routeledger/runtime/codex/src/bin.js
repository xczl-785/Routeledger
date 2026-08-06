#!/usr/bin/env node
import process from "node:process";
import { CodexProjectConfigError, renderCodexProjectConfig, writeCodexProjectConfig } from "./index.js";
const DEFAULT_ACTOR_ID = "codex-agent";
const DEFAULT_ACTOR_NAME = "Codex";
const DEFAULT_APPROVER_ID = "routeledger-approver";
const DEFAULT_APPROVER_NAME = "RouteLedger Approver";
const getFlagValue = (argv, name) => {
    const index = argv.findIndex((argument) => argument === name);
    if (index === -1) {
        return undefined;
    }
    return argv[index + 1];
};
const hasFlag = (argv, name) => argv.includes(name);
const requireFlagValue = (argv, name) => {
    const value = getFlagValue(argv, name);
    if (value === undefined) {
        throw new CodexProjectConfigError("MISSING_FLAG", `Missing required flag: ${name}`);
    }
    return value;
};
const parseArgs = (argv) => {
    const mode = hasFlag(argv, "--write") ? "write" : "render";
    const workspaceRoot = requireFlagValue(argv, "--workspace-root");
    const routeledgerRoot = requireFlagValue(argv, "--routeledger-root");
    const serverName = getFlagValue(argv, "--server-name");
    const hostProfile = getFlagValue(argv, "--profile");
    const actorId = getFlagValue(argv, "--actor-id");
    const actorName = getFlagValue(argv, "--actor-name");
    const approverId = getFlagValue(argv, "--approver-id");
    const approverName = getFlagValue(argv, "--approver-name");
    const outputPath = getFlagValue(argv, "--output");
    const existingConfigStrategy = hasFlag(argv, "--overwrite")
        ? "overwrite"
        : hasFlag(argv, "--fail-on-existing")
            ? "error"
            : "write-fragment";
    const routeLedgerWorkspaceRoot = getFlagValue(argv, "--routeledger-workspace-root");
    const installRoot = getFlagValue(argv, "--install-root");
    const binPath = getFlagValue(argv, "--bin-path");
    if (routeLedgerWorkspaceRoot !== undefined) {
        return {
            mode,
            options: {
                workspaceRoot,
                routeledgerRoot,
                source: {
                    kind: "workspace",
                    routeLedgerWorkspaceRoot
                },
                serverName,
                hostProfile,
                actor: actorId === undefined && actorName === undefined
                    ? undefined
                    : {
                        id: actorId ?? DEFAULT_ACTOR_ID,
                        displayName: actorName ?? DEFAULT_ACTOR_NAME
                    },
                approver: approverId === undefined && approverName === undefined
                    ? undefined
                    : {
                        id: approverId ?? DEFAULT_APPROVER_ID,
                        displayName: approverName ?? DEFAULT_APPROVER_NAME
                    },
                outputPath,
                existingConfigStrategy
            }
        };
    }
    if (installRoot !== undefined || binPath !== undefined) {
        if (installRoot === undefined || binPath === undefined) {
            throw new CodexProjectConfigError("SOURCE_FLAGS_INCOMPLETE", "--install-root and --bin-path must be provided together.");
        }
        return {
            mode,
            options: {
                workspaceRoot,
                routeledgerRoot,
                source: {
                    kind: "installed-package",
                    installRoot,
                    binPath
                },
                serverName,
                hostProfile,
                actor: actorId === undefined && actorName === undefined
                    ? undefined
                    : {
                        id: actorId ?? DEFAULT_ACTOR_ID,
                        displayName: actorName ?? DEFAULT_ACTOR_NAME
                    },
                approver: approverId === undefined && approverName === undefined
                    ? undefined
                    : {
                        id: approverId ?? DEFAULT_APPROVER_ID,
                        displayName: approverName ?? DEFAULT_APPROVER_NAME
                    },
                outputPath,
                existingConfigStrategy
            }
        };
    }
    throw new CodexProjectConfigError("SOURCE_MODE_REQUIRED", "Provide either --routeledger-workspace-root or both --install-root and --bin-path.");
};
export const main = async (argv = process.argv.slice(2)) => {
    const parsed = parseArgs(argv);
    if (parsed.mode === "render") {
        process.stdout.write(renderCodexProjectConfig(parsed.options));
        return;
    }
    const result = await writeCodexProjectConfig(parsed.options);
    process.stdout.write(`${JSON.stringify({
        path: result.path,
        kind: result.kind,
        created: result.created,
        warnings: result.warnings
    }, null, 2)}\n`);
};
void main().catch((error) => {
    if (error instanceof CodexProjectConfigError) {
        process.stderr.write(`[${error.code}] ${error.message}\n`);
        process.exitCode = 1;
        return;
    }
    if (error instanceof Error) {
        process.stderr.write(`${error.name}: ${error.message}\n`);
    }
    else {
        process.stderr.write(`Unknown error: ${String(error)}\n`);
    }
    process.exitCode = 1;
});
