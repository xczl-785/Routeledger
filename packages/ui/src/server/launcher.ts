import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMissionControlResponse } from "./mission-control-vm.js";

export type LauncherArgs = {
  workspaceRoot: string;
  routeledgerRoot: string;
  devBuild: boolean;
};

export type LauncherHealthResponse = {
  ok: boolean;
  instanceId: string;
  pid: number;
  workspaceRoot: string;
  routeledgerRoot: string;
  projectId: string | null;
};

export type LauncherInstanceRecord = {
  id: string;
  projectId: string | null;
  workspaceRoot: string;
  routeledgerRoot: string;
  pid: number;
  port: number;
  url: string;
  updatedAt: string;
};

export type LauncherRegistry = {
  schemaVersion: 1;
  instances: LauncherInstanceRecord[];
};

export type MissionControlOpenOptions = {
  workspaceRoot: string;
  routeledgerRoot: string;
  devBuild?: boolean;
  timeoutMs?: number;
};

export type MissionControlOpenResult = {
  url: string;
  projectId: string | null;
  pid: number;
  port: number;
  reused: boolean;
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
};

export type MissionControlStaleEntrySummary = {
  id: string;
  projectId: string | null;
  workspaceRoot: string;
  routeledgerRoot: string;
  pid: number;
  port: number;
  url: string;
  updatedAt: string;
  reason: "health_check_failed";
};

export type MissionControlStatusResult = {
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  projectId: string | null;
  matchingInstance: LauncherInstanceRecord | null;
  healthyInstances: LauncherInstanceRecord[];
  staleEntries: MissionControlStaleEntrySummary[];
};

const serverFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(serverFilePath), "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const distRoot = path.join(packageRoot, "dist");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceLauncherEntryPath = path.join(packageRoot, "src", "server", "cli.ts");
const staticMimeTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

const usageText =
  "Usage: pnpm --filter @routeledger/ui run launch -- --workspace-root <abs> --routeledger-root <abs> [--dev-build]";

const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const resolveRootInputs = (options: {
  workspaceRoot: string;
  routeledgerRoot: string;
}): { workspaceRoot: string; routeledgerRoot: string } => ({
  workspaceRoot: path.resolve(options.workspaceRoot),
  routeledgerRoot: path.resolve(options.routeledgerRoot)
});

const createInstanceRecord = (options: {
  id: string;
  projectId: string | null;
  workspaceRoot: string;
  routeledgerRoot: string;
  pid: number;
  port: number;
  url: string;
  updatedAt: string;
}): LauncherInstanceRecord => ({
  id: options.id,
  projectId: options.projectId,
  workspaceRoot: options.workspaceRoot,
  routeledgerRoot: options.routeledgerRoot,
  pid: options.pid,
  port: options.port,
  url: options.url,
  updatedAt: options.updatedAt
});

const toOpenResult = (options: {
  instance: LauncherInstanceRecord;
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  reused: boolean;
}): MissionControlOpenResult => ({
  url: options.instance.url,
  projectId: options.instance.projectId,
  pid: options.instance.pid,
  port: options.instance.port,
  reused: options.reused,
  registryPath: options.registryPath,
  workspaceRoot: options.workspaceRoot,
  routeledgerRoot: options.routeledgerRoot
});

export const parseLauncherArgs = (argv: string[]): LauncherArgs => {
  const args = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!token.startsWith("--")) {
      continue;
    }

    if (token === "--help") {
      throw new Error(usageText);
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(token.slice(2), next);
      index += 1;
      continue;
    }

    args.set(token.slice(2), true);
  }

  const workspaceRoot = args.get("workspace-root") ?? args.get("workspaceRoot");
  const routeledgerRoot =
    args.get("routeledger-root") ?? args.get("routeledgerRoot");

  if (typeof workspaceRoot !== "string" || typeof routeledgerRoot !== "string") {
    throw new Error(
      `${usageText}\nPrimary flags use kebab-case: --workspace-root / --routeledger-root.`
    );
  }

  const resolved = resolveRootInputs({
    workspaceRoot,
    routeledgerRoot
  });

  return {
    workspaceRoot: resolved.workspaceRoot,
    routeledgerRoot: resolved.routeledgerRoot,
    devBuild: args.get("dev-build") === true
  };
};

export const getRegistryPath = (): string => {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const stateRoot =
    typeof xdgStateHome === "string" && xdgStateHome.length > 0
      ? xdgStateHome
      : null;

  return stateRoot === null
    ? path.join(os.homedir(), ".routeledger", "ui", "instances.json")
    : path.join(stateRoot, "routeledger", "ui", "instances.json");
};

export const readRegistry = async (
  registryPath: string
): Promise<LauncherRegistry> => {
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as LauncherRegistry;

    return parsed.schemaVersion === 1 && Array.isArray(parsed.instances)
      ? parsed
      : {
          schemaVersion: 1,
          instances: []
        };
  } catch {
    return {
      schemaVersion: 1,
      instances: []
    };
  }
};

export const writeRegistry = async (
  registryPath: string,
  instances: LauncherInstanceRecord[]
): Promise<void> => {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    toJson({
      schemaVersion: 1,
      instances
    }),
    "utf8"
  );
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const ensureDistReady = async (devBuild: boolean): Promise<void> => {
  const builtIndexPath = path.join(distRoot, "index.html");

  if (await pathExists(builtIndexPath)) {
    return;
  }

  if (!devBuild) {
    throw new Error(
      `Missing prebuilt UI dist at ${builtIndexPath}. Run "pnpm --filter @routeledger/ui run build" first, or relaunch with --dev-build in development.`
    );
  }

  const viteModule = await import("vite");
  await viteModule.build({
    root: packageRoot,
    logLevel: "warn"
  });
};

const serveStatic = async (
  requestPath: string
): Promise<{ body: Buffer; contentType: string }> => {
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const safeSegments = pathname
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "..");
  const resolvedPath = path.join(distRoot, ...safeSegments);

  try {
    const file = await fs.readFile(resolvedPath);
    return {
      body: file,
      contentType:
        staticMimeTypes.get(path.extname(resolvedPath)) ??
        "application/octet-stream"
    };
  } catch {
    const indexFile = await fs.readFile(path.join(distRoot, "index.html"));
    return {
      body: indexFile,
      contentType: "text/html; charset=utf-8"
    };
  }
};

const readStartupState = async (options: {
  workspaceRoot: string;
  routeledgerRoot: string;
}) =>
  buildMissionControlResponse({
    workspaceRoot: options.workspaceRoot,
    routeledgerRoot: options.routeledgerRoot
  });

const readProjectId = async (options: {
  workspaceRoot: string;
  routeledgerRoot: string;
}): Promise<string | null> => {
  const startupState = await readStartupState(options);
  return startupState.identity?.projectId ?? null;
};

export const healthCheckInstance = async (
  entry: LauncherInstanceRecord
): Promise<LauncherHealthResponse | null> => {
  try {
    const response = await fetch(`${entry.url}/api/health`, {
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as LauncherHealthResponse;
  } catch {
    return null;
  }
};

export const reconcileRegistry = async (options: {
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  projectId: string | null;
}): Promise<{ registry: LauncherRegistry; reusable: LauncherInstanceRecord | null }> => {
  const registry = await readRegistry(options.registryPath);
  const kept: LauncherInstanceRecord[] = [];
  let reusable: LauncherInstanceRecord | null = null;

  for (const entry of registry.instances) {
    const sameIdentity =
      entry.workspaceRoot === options.workspaceRoot &&
      entry.routeledgerRoot === options.routeledgerRoot &&
      entry.projectId === options.projectId;

    if (!sameIdentity) {
      kept.push(entry);
      continue;
    }

    const health = await healthCheckInstance(entry);

    if (
      health !== null &&
      health.ok &&
      health.workspaceRoot === options.workspaceRoot &&
      health.routeledgerRoot === options.routeledgerRoot &&
      health.projectId === options.projectId
    ) {
      const refreshedEntry = createInstanceRecord({
        ...entry,
        pid: health.pid,
        updatedAt: new Date().toISOString()
      });

      kept.push(refreshedEntry);
      reusable = refreshedEntry;
      continue;
    }
  }

  await writeRegistry(options.registryPath, kept);
  return {
    registry: {
      schemaVersion: 1,
      instances: kept
    },
    reusable
  };
};

const waitForHealthyInstance = async (options: {
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  projectId: string | null;
  timeoutMs: number;
}): Promise<LauncherInstanceRecord | null> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    const { reusable } = await reconcileRegistry(options);
    if (reusable !== null) {
      return reusable;
    }

    await delay(200);
  }

  return null;
};

const resolveLogTail = async (logPath: string): Promise<string> => {
  try {
    const output = await fs.readFile(logPath, "utf8");
    const trimmed = output.trim();

    if (trimmed.length === 0) {
      return "";
    }

    const tail = trimmed.split(/\r?\n/).slice(-20).join("\n");
    return `\nLauncher log tail:\n${tail}`;
  } catch {
    return "";
  }
};

const spawnMissionControlSourceProcess = (options: {
  workspaceRoot: string;
  routeledgerRoot: string;
  devBuild: boolean;
}): { logPath: string } => {
  if (!fsSync.existsSync(tsxCliPath)) {
    throw new Error(`Missing tsx runtime at ${tsxCliPath}. Run "pnpm install" first.`);
  }

  const logPath = path.join(
    os.tmpdir(),
    `routeledger-mission-control-source-${randomUUID()}.log`
  );
  const logFd = fsSync.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      tsxCliPath,
      sourceLauncherEntryPath,
      "--workspace-root",
      options.workspaceRoot,
      "--routeledger-root",
      options.routeledgerRoot,
      ...(options.devBuild ? ["--dev-build"] : [])
    ],
    {
      cwd: repoRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    }
  );

  fsSync.closeSync(logFd);
  child.unref();

  return {
    logPath
  };
};

export const getMissionControlStatus = async (
  options: {
    workspaceRoot: string;
    routeledgerRoot: string;
    registryPath?: string;
  }
): Promise<MissionControlStatusResult> => {
  const resolved = resolveRootInputs(options);
  const projectId = await readProjectId(resolved);
  const registryPath = options.registryPath ?? getRegistryPath();
  const registry = await readRegistry(registryPath);
  const healthyInstances: LauncherInstanceRecord[] = [];
  const staleEntries: MissionControlStaleEntrySummary[] = [];
  let matchingInstance: LauncherInstanceRecord | null = null;

  for (const entry of registry.instances) {
    const health = await healthCheckInstance(entry);

    if (health === null || !health.ok) {
      staleEntries.push({
        ...entry,
        reason: "health_check_failed"
      });
      continue;
    }

    const healthyEntry = createInstanceRecord({
      ...entry,
      workspaceRoot: health.workspaceRoot,
      routeledgerRoot: health.routeledgerRoot,
      projectId: health.projectId,
      pid: health.pid,
      updatedAt: new Date().toISOString()
    });

    healthyInstances.push(healthyEntry);

    if (
      healthyEntry.workspaceRoot === resolved.workspaceRoot &&
      healthyEntry.routeledgerRoot === resolved.routeledgerRoot &&
      healthyEntry.projectId === projectId
    ) {
      matchingInstance = healthyEntry;
    }
  }

  return {
    registryPath,
    workspaceRoot: resolved.workspaceRoot,
    routeledgerRoot: resolved.routeledgerRoot,
    projectId,
    matchingInstance,
    healthyInstances,
    staleEntries
  };
};

export const openMissionControlSource = async (
  options: MissionControlOpenOptions
): Promise<MissionControlOpenResult> => {
  const resolved = resolveRootInputs(options);
  const projectId = await readProjectId(resolved);
  const registryPath = getRegistryPath();
  const { reusable } = await reconcileRegistry({
    registryPath,
    workspaceRoot: resolved.workspaceRoot,
    routeledgerRoot: resolved.routeledgerRoot,
    projectId
  });

  if (reusable !== null) {
    return toOpenResult({
      instance: reusable,
      registryPath,
      workspaceRoot: resolved.workspaceRoot,
      routeledgerRoot: resolved.routeledgerRoot,
      reused: true
    });
  }

  await ensureDistReady(options.devBuild === true);
  const timeoutMs = options.timeoutMs ?? 10000;
  const { logPath } = spawnMissionControlSourceProcess({
    workspaceRoot: resolved.workspaceRoot,
    routeledgerRoot: resolved.routeledgerRoot,
    devBuild: options.devBuild === true
  });

  try {
    const launched = await waitForHealthyInstance({
      registryPath,
      workspaceRoot: resolved.workspaceRoot,
      routeledgerRoot: resolved.routeledgerRoot,
      projectId,
      timeoutMs
    });

    if (launched === null) {
      throw new Error(
        `Mission Control source launcher did not become healthy within ${timeoutMs}ms.${await resolveLogTail(
          logPath
        )}`
      );
    }

    return toOpenResult({
      instance: launched,
      registryPath,
      workspaceRoot: resolved.workspaceRoot,
      routeledgerRoot: resolved.routeledgerRoot,
      reused: false
    });
  } finally {
    await fs.rm(logPath, { force: true });
  }
};

export const runMissionControlServer = async (inputArgs: LauncherArgs): Promise<void> => {
  const args = {
    ...inputArgs,
    ...resolveRootInputs(inputArgs)
  };

  await ensureDistReady(args.devBuild);

  const projectId = await readProjectId(args);
  const registryPath = getRegistryPath();
  const { registry, reusable } = await reconcileRegistry({
    registryPath,
    workspaceRoot: args.workspaceRoot,
    routeledgerRoot: args.routeledgerRoot,
    projectId
  });

  if (reusable !== null) {
    console.log(`RouteLedger Mission Control already running at ${reusable.url}`);
    console.log(`workspaceRoot=${args.workspaceRoot}`);
    console.log(`routeledgerRoot=${args.routeledgerRoot}`);
    console.log(`projectId=${projectId ?? "null"}`);
    console.log(`registry=${registryPath}`);
    return;
  }

  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  let instanceRecord: LauncherInstanceRecord | null = null;
  let shuttingDown = false;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/api/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(
        toJson({
          ok: true,
          instanceId,
          pid: process.pid,
          workspaceRoot: args.workspaceRoot,
          routeledgerRoot: args.routeledgerRoot,
          projectId
        })
      );
      return;
    }

    if (requestUrl.pathname === "/api/state") {
      const state = await readStartupState(args);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(toJson(state));
      return;
    }

    const asset = await serveStatic(requestUrl.pathname);
    response.writeHead(200, {
      "content-type": asset.contentType
    });
    response.end(asset.body);
  });

  const closeServer = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    if (instanceRecord !== null) {
      const currentRegistry = await readRegistry(registryPath);
      await writeRegistry(
        registryPath,
        currentRegistry.instances.filter((entry) => entry.id !== instanceRecord!.id)
      );
    }

    await closeServer();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("failed to resolve Mission Control listen address");
  }

  const url = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${url}/api/health`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!health.ok) {
    throw new Error(`health check failed with ${health.status}`);
  }

  instanceRecord = createInstanceRecord({
    id: instanceId,
    projectId,
    workspaceRoot: args.workspaceRoot,
    routeledgerRoot: args.routeledgerRoot,
    pid: process.pid,
    port: address.port,
    url,
    updatedAt: startedAt
  });

  await writeRegistry(registryPath, registry.instances.concat(instanceRecord));

  console.log(`RouteLedger Mission Control running at ${url}`);
  console.log(`workspaceRoot=${args.workspaceRoot}`);
  console.log(`routeledgerRoot=${args.routeledgerRoot}`);
  console.log(`projectId=${projectId ?? "null"}`);
  console.log(`registry=${registryPath}`);
};

export const usage = usageText;
