import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMissionControlResponse } from "./mission-control-vm.js";
const serverFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(serverFilePath), "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const distRoot = path.join(packageRoot, "dist");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceLauncherEntryPath = path.join(packageRoot, "src", "server", "cli.ts");
const compiledLauncherEntryPath = path.join(packageRoot, "src", "server", "cli.js");
const defaultIdleTimeoutMs = 30 * 60 * 1000;
const defaultLockTimeoutMs = 15_000;
const staleLockAgeMs = 30_000;
const clientHeaderName = "x-routeledger-ui-client";
const staticMimeTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".map", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml; charset=utf-8"]
]);
const usageText = "Usage: routeledger-ui <open|add|status|stop|serve> [--workspace-root <abs> --routeledger-root <abs>] [--dev-build]";
const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const delay = async (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const resolveRootInputs = (options) => ({
    workspaceRoot: path.resolve(options.workspaceRoot),
    routeledgerRoot: path.resolve(options.routeledgerRoot)
});
const projectKeyFor = (options) => createHash("sha256")
    .update(`${options.projectId ?? "uninitialized"}\0${options.workspaceRoot}\0${options.routeledgerRoot}`)
    .digest("hex")
    .slice(0, 24);
const emptyRegistry = () => ({
    schemaVersion: 2,
    hub: null,
    projects: []
});
const migrateLegacyRegistry = (legacy) => {
    const projects = new Map();
    for (const entry of legacy.instances ?? []) {
        if (typeof entry.workspaceRoot !== "string" || typeof entry.routeledgerRoot !== "string")
            continue;
        const resolved = resolveRootInputs(entry);
        const projectId = typeof entry.projectId === "string" ? entry.projectId : null;
        const id = projectKeyFor({ ...resolved, projectId });
        const timestamp = typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString();
        projects.set(id, {
            id,
            projectId,
            projectName: path.basename(resolved.routeledgerRoot),
            ...resolved,
            addedAt: timestamp,
            lastOpenedAt: timestamp
        });
    }
    return {
        schemaVersion: 2,
        hub: null,
        projects: [...projects.values()]
    };
};
export const parseLauncherArgs = (argv) => {
    const args = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--"))
            continue;
        if (token === "--help")
            throw new Error(usageText);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
            args.set(token.slice(2), next);
            index += 1;
        }
        else {
            args.set(token.slice(2), true);
        }
    }
    const workspaceRoot = args.get("workspace-root") ?? args.get("workspaceRoot");
    const routeledgerRoot = args.get("routeledger-root") ?? args.get("routeledgerRoot");
    if (typeof workspaceRoot !== "string" || typeof routeledgerRoot !== "string") {
        throw new Error(`${usageText}\nBoth --workspace-root and --routeledger-root are required.`);
    }
    return {
        ...resolveRootInputs({ workspaceRoot, routeledgerRoot }),
        devBuild: args.get("dev-build") === true
    };
};
export const getRegistryPath = () => {
    const xdgStateHome = process.env.XDG_STATE_HOME;
    const stateRoot = typeof xdgStateHome === "string" && xdgStateHome.length > 0 ? xdgStateHome : null;
    return stateRoot === null
        ? path.join(os.homedir(), ".routeledger", "ui", "hub.json")
        : path.join(stateRoot, "routeledger", "ui", "hub.json");
};
export const readRegistry = async (registryPath) => {
    try {
        const parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
        if (parsed.schemaVersion === 2 && Array.isArray(parsed.projects)) {
            return parsed;
        }
        if (parsed.schemaVersion === 1)
            return migrateLegacyRegistry(parsed);
        return emptyRegistry();
    }
    catch {
        return emptyRegistry();
    }
};
export const writeRegistry = async (registryPath, registryOrProjects) => {
    const registry = Array.isArray(registryOrProjects)
        ? { ...emptyRegistry(), projects: registryOrProjects }
        : registryOrProjects;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, toJson(registry), "utf8");
    await fs.rename(temporaryPath, registryPath);
};
const withFileLock = async (lockPath, task) => {
    const startedAt = Date.now();
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    while (true) {
        try {
            await fs.mkdir(lockPath);
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const stat = await fs.stat(lockPath).catch(() => null);
            if (stat !== null && Date.now() - stat.mtimeMs > staleLockAgeMs) {
                await fs.rm(lockPath, { recursive: true, force: true });
                continue;
            }
            if (Date.now() - startedAt >= defaultLockTimeoutMs) {
                throw new Error(`Timed out waiting for RouteLedger UI lock: ${lockPath}`);
            }
            await delay(50);
        }
    }
    try {
        return await task();
    }
    finally {
        await fs.rm(lockPath, { recursive: true, force: true });
    }
};
const withRegistryLock = (registryPath, task) => withFileLock(`${registryPath}.registry-lock`, task);
const withStartupLock = (registryPath, task) => withFileLock(`${registryPath}.startup-lock`, task);
const pathExists = async (targetPath) => {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
};
export const ensureDistReady = async (devBuild) => {
    const builtIndexPath = path.join(distRoot, "index.html");
    if (await pathExists(builtIndexPath))
        return;
    if (!devBuild) {
        throw new Error(`Missing prebuilt UI dist at ${builtIndexPath}. Build the UI first or relaunch with --dev-build.`);
    }
    const viteModule = await import("vite");
    await viteModule.build({ root: packageRoot, logLevel: "warn" });
};
const serveStatic = async (requestPath) => {
    const pathname = requestPath === "/" ? "/index.html" : requestPath;
    const safeSegments = pathname.split("/").filter((segment) => segment.length > 0 && segment !== "..");
    const resolvedPath = path.join(distRoot, ...safeSegments);
    try {
        const file = await fs.readFile(resolvedPath);
        return { body: file, contentType: staticMimeTypes.get(path.extname(resolvedPath)) ?? "application/octet-stream" };
    }
    catch {
        return {
            body: await fs.readFile(path.join(distRoot, "index.html")),
            contentType: "text/html; charset=utf-8"
        };
    }
};
const readProjectState = async (project) => buildMissionControlResponse({ workspaceRoot: project.workspaceRoot, routeledgerRoot: project.routeledgerRoot });
const registerMissionControlProjectUnlocked = async (options) => {
    const resolved = resolveRootInputs(options);
    const state = await readProjectState(resolved);
    const projectId = state.identity?.projectId ?? null;
    const id = projectKeyFor({ ...resolved, projectId });
    const now = new Date().toISOString();
    const registryPath = options.registryPath;
    const registry = await readRegistry(registryPath);
    const existing = registry.projects.find((project) => project.id === id);
    const project = {
        id,
        projectId,
        projectName: state.identity?.projectName ?? path.basename(resolved.routeledgerRoot),
        ...resolved,
        addedAt: existing?.addedAt ?? now,
        lastOpenedAt: now
    };
    await writeRegistry(registryPath, {
        ...registry,
        projects: registry.projects.filter((candidate) => candidate.id !== id).concat(project)
    });
    return project;
};
export const registerMissionControlProject = async (options) => {
    const registryPath = options.registryPath ?? getRegistryPath();
    return withRegistryLock(registryPath, () => registerMissionControlProjectUnlocked({ ...options, registryPath }));
};
export const healthCheckHub = async (hub) => {
    try {
        const response = await fetch(`${hub.url}/api/health`, { headers: { accept: "application/json" } });
        if (!response.ok)
            return null;
        const health = (await response.json());
        return health.ok && health.instanceId === hub.id ? health : null;
    }
    catch {
        return null;
    }
};
const reconcileHub = async (registryPath) => {
    const registry = await readRegistry(registryPath);
    if (registry.hub === null)
        return registry;
    if ((await healthCheckHub(registry.hub)) !== null)
        return registry;
    return withRegistryLock(registryPath, async () => {
        const latest = await readRegistry(registryPath);
        if (latest.hub?.id !== registry.hub?.id)
            return latest;
        const reconciled = { ...latest, hub: null };
        await writeRegistry(registryPath, reconciled);
        return reconciled;
    });
};
const waitForHealthyHub = async (registryPath, timeoutMs) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const registry = await reconcileHub(registryPath);
        if (registry.hub !== null)
            return registry.hub;
        await delay(150);
    }
    return null;
};
const resolveLogTail = async (logPath) => {
    try {
        const trimmed = (await fs.readFile(logPath, "utf8")).trim();
        return trimmed.length === 0 ? "" : `\nLauncher log tail:\n${trimmed.split(/\r?\n/u).slice(-20).join("\n")}`;
    }
    catch {
        return "";
    }
};
const spawnMissionControlProcess = (options) => {
    const sourceMode = fsSync.existsSync(tsxCliPath) && fsSync.existsSync(sourceLauncherEntryPath);
    const entryPath = sourceMode ? sourceLauncherEntryPath : compiledLauncherEntryPath;
    if (!fsSync.existsSync(entryPath))
        throw new Error(`Missing Mission Control launcher at ${entryPath}.`);
    const logPath = path.join(os.tmpdir(), `routeledger-ui-hub-${randomUUID()}.log`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn(process.execPath, [
        ...(sourceMode ? [tsxCliPath] : []),
        entryPath,
        "serve",
        "--workspace-root",
        options.workspaceRoot,
        "--routeledger-root",
        options.routeledgerRoot,
        ...(options.devBuild ? ["--dev-build"] : [])
    ], { cwd: repoRoot, detached: true, env: process.env, stdio: ["ignore", logFd, logFd] });
    fsSync.closeSync(logFd);
    child.unref();
    return { logPath };
};
export const getMissionControlStatus = async (options = {}) => {
    const registryPath = options.registryPath ?? getRegistryPath();
    const registry = await reconcileHub(registryPath);
    const matchingProject = typeof options.workspaceRoot === "string" && typeof options.routeledgerRoot === "string"
        ? registry.projects.find((project) => {
            const resolved = resolveRootInputs(options);
            return project.workspaceRoot === resolved.workspaceRoot && project.routeledgerRoot === resolved.routeledgerRoot;
        }) ?? null
        : null;
    return {
        registryPath,
        projectId: matchingProject?.projectId ?? null,
        hub: registry.hub,
        healthy: registry.hub !== null,
        projects: registry.projects,
        matchingProject
    };
};
export const openMissionControlSource = async (options) => {
    const resolved = resolveRootInputs(options);
    const registryPath = getRegistryPath();
    const project = await registerMissionControlProject({ ...resolved, registryPath });
    const startup = await withStartupLock(registryPath, async () => {
        let registry = await reconcileHub(registryPath);
        const reused = registry.hub !== null;
        if (registry.hub === null) {
            await ensureDistReady(options.devBuild === true);
            const { logPath } = spawnMissionControlProcess({ ...resolved, devBuild: options.devBuild === true });
            try {
                const hub = await waitForHealthyHub(registryPath, options.timeoutMs ?? 10000);
                if (hub === null) {
                    throw new Error(`Mission Control UI Hub did not become healthy.${await resolveLogTail(logPath)}`);
                }
            }
            finally {
                await fs.rm(logPath, { force: true });
            }
            registry = await readRegistry(registryPath);
        }
        return { registry, reused };
    });
    const { registry, reused } = startup;
    if (registry.hub === null)
        throw new Error("Mission Control UI Hub registration is missing after startup.");
    return {
        url: `${registry.hub.url}/?project=${encodeURIComponent(project.id)}`,
        projectKey: project.id,
        projectId: project.projectId,
        pid: registry.hub.pid,
        port: registry.hub.port,
        reused,
        registryPath,
        ...resolved
    };
};
export const stopMissionControlHub = async (registryPath = getRegistryPath()) => {
    const registry = await reconcileHub(registryPath);
    if (registry.hub === null)
        return { registryPath, stopped: false, pid: null };
    const pid = registry.hub.pid;
    try {
        const response = await fetch(`${registry.hub.url}/api/shutdown`, {
            method: "POST",
            headers: { [clientHeaderName]: "1" }
        });
        if (!response.ok)
            return { registryPath, stopped: false, pid };
    }
    catch {
        return { registryPath, stopped: false, pid };
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(100);
        if ((await healthCheckHub(registry.hub)) === null) {
            await reconcileHub(registryPath);
            return { registryPath, stopped: true, pid };
        }
    }
    return { registryPath, stopped: false, pid };
};
const isSameOriginMutation = (request) => {
    if (request.headers[clientHeaderName] !== "1")
        return false;
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (typeof origin !== "string" || typeof host !== "string")
        return true;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
};
const readJsonBody = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 16_384)
            throw new Error("request body too large");
        chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("object body required");
    return parsed;
};
const resolveIdleTimeoutMs = () => {
    const configured = Number(process.env.ROUTELEDGER_UI_IDLE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 250 ? configured : defaultIdleTimeoutMs;
};
export const runMissionControlServer = async (inputArgs) => {
    const args = { ...inputArgs, ...resolveRootInputs(inputArgs) };
    await ensureDistReady(args.devBuild);
    const registryPath = getRegistryPath();
    const initialProject = await registerMissionControlProject({ ...args, registryPath });
    const existingRegistry = await reconcileHub(registryPath);
    if (existingRegistry.hub !== null) {
        console.log(`RouteLedger UI Hub already running at ${existingRegistry.hub.url}`);
        return;
    }
    const instanceId = randomUUID();
    const startedAt = new Date().toISOString();
    const idleTimeoutMs = resolveIdleTimeoutMs();
    let lastActivityAt = Date.now();
    let hubRecord = null;
    let shuttingDown = false;
    let idleTimer = null;
    const touch = () => {
        lastActivityAt = Date.now();
    };
    const server = createServer(async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/api/health") {
            const registry = await readRegistry(registryPath);
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({
                ok: true,
                instanceId,
                pid: process.pid,
                projectCount: registry.projects.length,
                startedAt,
                lastActivityAt: new Date(lastActivityAt).toISOString()
            }));
            return;
        }
        if (requestUrl.pathname === "/api/projects") {
            if (request.method === "POST") {
                if (!isSameOriginMutation(request)) {
                    response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                    response.end(toJson({ error: "CLIENT_HEADER_REQUIRED" }));
                    return;
                }
                try {
                    const input = await readJsonBody(request);
                    if (typeof input.workspaceRoot !== "string" || typeof input.routeledgerRoot !== "string") {
                        throw new Error("workspaceRoot and routeledgerRoot are required");
                    }
                    const project = await registerMissionControlProject({
                        workspaceRoot: input.workspaceRoot,
                        routeledgerRoot: input.routeledgerRoot,
                        registryPath
                    });
                    touch();
                    response.writeHead(201, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                    response.end(toJson({ project }));
                }
                catch (error) {
                    response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                    response.end(toJson({ error: error instanceof Error ? error.message : "PROJECT_REGISTRATION_FAILED" }));
                }
                return;
            }
            touch();
            const registry = await readRegistry(registryPath);
            const projects = await Promise.all(registry.projects.map(async (project) => ({
                id: project.id,
                projectId: project.projectId,
                projectName: project.projectName,
                available: await pathExists(path.join(project.routeledgerRoot, ".routeledger")),
                lastOpenedAt: project.lastOpenedAt
            })));
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({ projects }));
            return;
        }
        if (requestUrl.pathname === "/api/state") {
            touch();
            const registry = await readRegistry(registryPath);
            const requestedProject = requestUrl.searchParams.get("project") ?? initialProject.id;
            const project = registry.projects.find((candidate) => candidate.id === requestedProject);
            if (project === undefined) {
                response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                response.end(toJson({ error: "PROJECT_NOT_REGISTERED" }));
                return;
            }
            const state = await readProjectState(project);
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson(state));
            return;
        }
        if (requestUrl.pathname === "/api/heartbeat" && request.method === "POST") {
            touch();
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
            return;
        }
        if (requestUrl.pathname === "/api/shutdown" && request.method === "POST") {
            if (!isSameOriginMutation(request)) {
                response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                response.end(toJson({ error: "CLIENT_HEADER_REQUIRED" }));
                return;
            }
            response.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({ stopping: true }));
            setTimeout(() => void shutdown(), 25);
            return;
        }
        touch();
        const asset = await serveStatic(requestUrl.pathname);
        response.writeHead(200, {
            "content-type": asset.contentType,
            "cache-control": requestUrl.pathname === "/" ? "no-store" : "public, max-age=31536000, immutable",
            "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
        });
        response.end(asset.body);
    });
    const closeServer = async () => new Promise((resolve, reject) => {
        server.close((error) => error === undefined || error === null ? resolve() : reject(error));
    });
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        if (idleTimer !== null)
            clearInterval(idleTimer);
        await withRegistryLock(registryPath, async () => {
            const registry = await readRegistry(registryPath);
            if (registry.hub?.id === hubRecord?.id)
                await writeRegistry(registryPath, { ...registry, hub: null });
        });
        await closeServer();
        process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string")
        throw new Error("failed to resolve UI Hub address");
    const now = new Date().toISOString();
    hubRecord = {
        id: instanceId,
        pid: process.pid,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        startedAt,
        updatedAt: now
    };
    const registry = await withRegistryLock(registryPath, async () => {
        const latest = await readRegistry(registryPath);
        await writeRegistry(registryPath, { ...latest, hub: hubRecord });
        return latest;
    });
    idleTimer = setInterval(() => {
        if (Date.now() - lastActivityAt >= idleTimeoutMs)
            void shutdown();
    }, Math.min(60_000, Math.max(250, Math.floor(idleTimeoutMs / 4))));
    idleTimer.unref();
    console.log(`RouteLedger UI Hub running at ${hubRecord.url}`);
    console.log(`projects=${registry.projects.length}`);
    console.log(`idleTimeoutMs=${idleTimeoutMs}`);
    console.log(`registry=${registryPath}`);
};
export const usage = usageText;
