import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const accessTokenHeaderName = "x-routeledger-ui-token";
const missionControlProtocolVersion = 1;
const sourceRuntimeIdentity = {
    runtimePackageVersion: "source",
    runtimeProfile: "source",
    artifactKind: "source",
    pluginVersion: null,
    runtimePayloadDigest: null
};
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
const usageText = "Usage: routeledger-ui <open|add|remove|status|stop|serve> [--workspace-root <abs> --routeledger-root <abs>] [--dev-build]";
const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const delay = async (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const resolveRootInputs = (options) => ({
    workspaceRoot: path.resolve(options.workspaceRoot),
    routeledgerRoot: path.resolve(options.routeledgerRoot)
});
const comparablePhysicalPath = (value) => {
    const physical = fsSync.realpathSync.native(value);
    return process.platform === "win32" ? physical.toLocaleLowerCase("en-US") : physical;
};
const arePhysicalPathsEqual = (left, right) => comparablePhysicalPath(left) === comparablePhysicalPath(right);
const isPhysicalPathContainedWithin = (root, candidate) => {
    const relative = path.relative(comparablePhysicalPath(root), comparablePhysicalPath(candidate));
    return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const normalizeProjectInputPath = (inputPath) => {
    if (!path.isAbsolute(inputPath))
        throw new Error("工程目录必须是绝对路径。");
    const resolved = path.resolve(inputPath);
    if (path.basename(resolved) === "project.json" && path.basename(path.dirname(resolved)) === ".routeledger") {
        return path.dirname(path.dirname(resolved));
    }
    return resolved;
};
const resolveWorkspaceDataRoot = (workspaceRoot) => {
    const configPath = path.join(workspaceRoot, ".routeledger", "config.json");
    let parsed;
    try {
        parsed = JSON.parse(fsSync.readFileSync(configPath, "utf8"));
    }
    catch (error) {
        throw new Error(`无法读取 workspace 配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${configPath} 必须包含 JSON 对象。`);
    }
    const config = parsed;
    if (config.version !== 1 || typeof config.dataDir !== "string" || config.dataDir.trim().length === 0) {
        throw new Error(`${configPath} 必须包含 version=1 和非空 dataDir。`);
    }
    if (path.isAbsolute(config.dataDir))
        throw new Error(`${configPath} 的 dataDir 必须是 workspace 相对路径。`);
    const dataRoot = path.resolve(workspaceRoot, config.dataDir);
    if (!fsSync.existsSync(dataRoot) || !fsSync.statSync(dataRoot).isDirectory()) {
        throw new Error(`RouteLedger dataDir 不存在或不是目录：${dataRoot}`);
    }
    if (!isPhysicalPathContainedWithin(workspaceRoot, dataRoot)) {
        throw new Error(`${configPath} 的 dataDir 越出了 workspace。`);
    }
    return dataRoot;
};
export const resolveMissionControlProjectPath = (inputPath) => {
    const candidate = normalizeProjectInputPath(inputPath);
    if (!fsSync.existsSync(candidate) || !fsSync.statSync(candidate).isDirectory()) {
        throw new Error(`工程目录不存在或不是目录：${candidate}`);
    }
    const candidateConfig = path.join(candidate, ".routeledger", "config.json");
    if (fsSync.existsSync(candidateConfig)) {
        const routeledgerRoot = resolveWorkspaceDataRoot(candidate);
        const projectPath = path.join(routeledgerRoot, ".routeledger", "project.json");
        if (!fsSync.existsSync(projectPath))
            throw new Error(`未找到 canonical RouteLedger 项目：${projectPath}`);
        return {
            workspaceRoot: comparablePhysicalPath(candidate),
            routeledgerRoot: comparablePhysicalPath(routeledgerRoot)
        };
    }
    const candidateProject = path.join(candidate, ".routeledger", "project.json");
    if (!fsSync.existsSync(candidateProject)) {
        throw new Error(`未找到 .routeledger/config.json 或 .routeledger/project.json：${candidate}`);
    }
    let current = candidate;
    while (true) {
        const configPath = path.join(current, ".routeledger", "config.json");
        if (fsSync.existsSync(configPath)) {
            const dataRoot = resolveWorkspaceDataRoot(current);
            if (arePhysicalPathsEqual(dataRoot, candidate)) {
                return {
                    workspaceRoot: comparablePhysicalPath(current),
                    routeledgerRoot: comparablePhysicalPath(dataRoot)
                };
            }
        }
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    throw new Error("找到了 canonical 项目，但无法证明它与 workspace config 的绑定关系。");
};
const parseRuntimeIdentityFromEnvironment = () => {
    const raw = process.env.ROUTELEDGER_UI_RUNTIME_IDENTITY;
    if (typeof raw !== "string" || raw.length === 0)
        return sourceRuntimeIdentity;
    try {
        const value = JSON.parse(raw);
        if (typeof value.runtimePackageVersion !== "string" || typeof value.runtimeProfile !== "string" || typeof value.artifactKind !== "string") {
            throw new Error("invalid runtime identity");
        }
        return value;
    }
    catch (error) {
        throw new Error(`ROUTELEDGER_UI_RUNTIME_IDENTITY 无效：${error instanceof Error ? error.message : String(error)}`);
    }
};
const projectKeyFor = (options) => createHash("sha256")
    .update(`${options.projectId ?? "uninitialized"}\0${options.workspaceRoot}\0${options.routeledgerRoot}`)
    .digest("hex")
    .slice(0, 24);
const emptyRegistry = () => ({
    schemaVersion: 3,
    hub: null,
    projects: []
});
const migrateLegacyRegistry = (legacy) => {
    if (legacy.schemaVersion === 2 && Array.isArray(legacy.projects)) {
        return { schemaVersion: 3, hub: legacy.hub ?? null, projects: legacy.projects };
    }
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
        schemaVersion: 3,
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
        devBuild: args.get("dev-build") === true,
        runtimeIdentity: parseRuntimeIdentityFromEnvironment()
    };
};
export const getRegistryPath = () => {
    const xdgStateHome = process.env.XDG_STATE_HOME;
    const stateRoot = typeof xdgStateHome === "string" && xdgStateHome.length > 0 ? xdgStateHome : null;
    return stateRoot === null
        ? path.join(os.homedir(), ".routeledger", "ui", "hub.json")
        : path.join(stateRoot, "routeledger", "ui", "hub.json");
};
export const getProjectRegistryPath = (hubRegistryPath = getRegistryPath()) => path.join(path.dirname(hubRegistryPath), "projects.json");
const readOptionalJson = async (filePath) => {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw new Error(`RouteLedger UI 状态文件无效，已保留原文件：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
};
export const readRegistry = async (registryPath) => {
    const projectRegistryPath = getProjectRegistryPath(registryPath);
    const [hubValue, projectValue] = await Promise.all([
        readOptionalJson(registryPath),
        readOptionalJson(projectRegistryPath)
    ]);
    let legacy = null;
    let hub = null;
    if (hubValue !== null) {
        if (typeof hubValue !== "object" || Array.isArray(hubValue)) {
            throw new Error(`RouteLedger UI Hub 状态格式无效：${registryPath}`);
        }
        const hubRecord = hubValue;
        if (hubRecord.schemaVersion === 3 && Object.prototype.hasOwnProperty.call(hubRecord, "hub")) {
            hub = hubRecord.hub ?? null;
        }
        else if (hubRecord.schemaVersion === 1 || hubRecord.schemaVersion === 2) {
            legacy = migrateLegacyRegistry(hubRecord);
            hub = legacy.hub;
        }
        else {
            throw new Error(`RouteLedger UI Hub 状态版本不受支持：${registryPath}`);
        }
    }
    let projects = legacy?.projects ?? [];
    if (projectValue !== null) {
        if (typeof projectValue !== "object" || Array.isArray(projectValue)) {
            throw new Error(`RouteLedger UI 项目目录格式无效：${projectRegistryPath}`);
        }
        const projectRecord = projectValue;
        if (projectRecord.schemaVersion !== 1 || !Array.isArray(projectRecord.projects)) {
            throw new Error(`RouteLedger UI 项目目录版本不受支持：${projectRegistryPath}`);
        }
        projects = projectRecord.projects;
    }
    return { schemaVersion: 3, hub, projects };
};
const writeJsonAtomic = async (filePath, value) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, toJson(value), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
};
export const writeRegistry = async (registryPath, registryOrProjects) => {
    const registry = Array.isArray(registryOrProjects)
        ? { ...emptyRegistry(), projects: registryOrProjects }
        : registryOrProjects;
    await writeJsonAtomic(getProjectRegistryPath(registryPath), {
        schemaVersion: 1,
        projects: registry.projects
    });
    await writeJsonAtomic(registryPath, {
        schemaVersion: 3,
        hub: registry.hub
    });
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
export const registerMissionControlProjectPath = async (inputPath, registryPath = getRegistryPath()) => {
    const roots = resolveMissionControlProjectPath(inputPath);
    const state = await readProjectState(roots);
    if (state.identity === null) {
        throw new Error(state.message || "该目录不是可读取的 canonical RouteLedger 项目。");
    }
    return registerMissionControlProject({ ...roots, registryPath });
};
export const removeMissionControlProject = async (projectKey, registryPath = getRegistryPath()) => withRegistryLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);
    const projects = registry.projects.filter((project) => project.id !== projectKey);
    const removed = projects.length !== registry.projects.length;
    if (removed)
        await writeRegistry(registryPath, { ...registry, projects });
    return { registryPath, removed, projectKey };
});
const runtimeIdentityMatches = (left, right) => left.runtimePackageVersion === right.runtimePackageVersion &&
    left.runtimeProfile === right.runtimeProfile &&
    left.artifactKind === right.artifactKind &&
    left.pluginVersion === right.pluginVersion &&
    left.runtimePayloadDigest === right.runtimePayloadDigest;
export const healthCheckHub = async (hub) => {
    try {
        const response = await fetch(`${hub.url}/api/health`, { headers: {
                accept: "application/json",
                [accessTokenHeaderName]: hub.accessToken
            } });
        if (!response.ok)
            return null;
        const health = (await response.json());
        return health.ok &&
            health.instanceId === hub.id &&
            health.protocolVersion === hub.protocolVersion &&
            runtimeIdentityMatches(health.runtimeIdentity, hub.runtimeIdentity)
            ? health
            : null;
    }
    catch {
        return null;
    }
};
const reconcileHub = async (registryPath, expectedRuntimeIdentity) => {
    const registry = await readRegistry(registryPath);
    if (registry.hub === null)
        return registry;
    const health = await healthCheckHub(registry.hub);
    if (health !== null &&
        (expectedRuntimeIdentity === undefined || runtimeIdentityMatches(health.runtimeIdentity, expectedRuntimeIdentity)))
        return registry;
    if (health !== null && expectedRuntimeIdentity !== undefined) {
        await stopMissionControlHub(registryPath, { skipReconcile: true });
    }
    return withRegistryLock(registryPath, async () => {
        const latest = await readRegistry(registryPath);
        if (latest.hub?.id !== registry.hub?.id)
            return latest;
        const reconciled = { ...latest, hub: null };
        await writeRegistry(registryPath, reconciled);
        return reconciled;
    });
};
const waitForHealthyHub = async (registryPath, timeoutMs, expectedRuntimeIdentity) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const registry = await reconcileHub(registryPath, expectedRuntimeIdentity);
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
    ], {
        cwd: repoRoot,
        detached: true,
        env: {
            ...process.env,
            ROUTELEDGER_UI_RUNTIME_IDENTITY: JSON.stringify(options.runtimeIdentity)
        },
        stdio: ["ignore", logFd, logFd]
    });
    fsSync.closeSync(logFd);
    child.unref();
    return { logPath };
};
export const resolveBrowserOpenCommand = (url, platform = process.platform) => {
    if (platform === "darwin")
        return { command: "open", args: [url] };
    if (platform === "win32")
        return { command: "cmd", args: ["/d", "/s", "/c", "start", "", url] };
    return { command: "xdg-open", args: [url] };
};
export const openUrlInBrowser = async (url) => {
    const invocation = resolveBrowserOpenCommand(url);
    return new Promise((resolve) => {
        const child = spawn(invocation.command, invocation.args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true
        });
        child.once("error", (error) => resolve({ opened: false, error: error.message }));
        child.once("spawn", () => {
            child.unref();
            resolve({ opened: true, error: null });
        });
    });
};
export const getMissionControlStatus = async (options = {}) => {
    const registryPath = options.registryPath ?? getRegistryPath();
    const registry = await reconcileHub(registryPath);
    const matchingProject = typeof options.workspaceRoot === "string" && typeof options.routeledgerRoot === "string"
        ? registry.projects.find((project) => {
            const resolved = resolveRootInputs(options);
            try {
                return arePhysicalPathsEqual(project.workspaceRoot, resolved.workspaceRoot) &&
                    arePhysicalPathsEqual(project.routeledgerRoot, resolved.routeledgerRoot);
            }
            catch {
                return project.workspaceRoot === resolved.workspaceRoot && project.routeledgerRoot === resolved.routeledgerRoot;
            }
        }) ?? null
        : null;
    const publicHub = registry.hub === null ? null : {
        id: registry.hub.id,
        pid: registry.hub.pid,
        port: registry.hub.port,
        url: registry.hub.url,
        startedAt: registry.hub.startedAt,
        updatedAt: registry.hub.updatedAt,
        protocolVersion: registry.hub.protocolVersion,
        runtimeIdentity: registry.hub.runtimeIdentity
    };
    const runtimeCompatible = registry.hub === null
        ? null
        : options.expectedRuntimeIdentity === undefined
            ? true
            : runtimeIdentityMatches(registry.hub.runtimeIdentity, options.expectedRuntimeIdentity);
    const accessUrl = registry.hub !== null && matchingProject !== null && runtimeCompatible
        ? `${registry.hub.url}/?project=${encodeURIComponent(matchingProject.id)}#token=${encodeURIComponent(registry.hub.accessToken)}`
        : null;
    return {
        registryPath,
        projectId: matchingProject?.projectId ?? null,
        hub: publicHub,
        healthy: registry.hub !== null,
        runtimeCompatible,
        accessUrl,
        projects: registry.projects,
        matchingProject
    };
};
export const openMissionControlSource = async (options) => {
    const resolved = resolveRootInputs(options);
    const runtimeIdentity = options.runtimeIdentity ?? sourceRuntimeIdentity;
    const registryPath = getRegistryPath();
    const project = await registerMissionControlProject({ ...resolved, registryPath });
    const startup = await withStartupLock(registryPath, async () => {
        let registry = await reconcileHub(registryPath, runtimeIdentity);
        const reused = registry.hub !== null;
        if (registry.hub === null) {
            await ensureDistReady(options.devBuild === true);
            const { logPath } = spawnMissionControlProcess({
                ...resolved,
                devBuild: options.devBuild === true,
                runtimeIdentity
            });
            try {
                const hub = await waitForHealthyHub(registryPath, options.timeoutMs ?? 10000, runtimeIdentity);
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
    const url = `${registry.hub.url}/?project=${encodeURIComponent(project.id)}#token=${encodeURIComponent(registry.hub.accessToken)}`;
    const browser = options.openBrowser === false
        ? { opened: false, error: null }
        : await openUrlInBrowser(url);
    return {
        url,
        projectKey: project.id,
        projectId: project.projectId,
        pid: registry.hub.pid,
        port: registry.hub.port,
        reused,
        registryPath,
        browserOpened: browser.opened,
        browserError: browser.error,
        runtimeIdentity: registry.hub.runtimeIdentity,
        ...resolved
    };
};
export const stopMissionControlHub = async (registryPath = getRegistryPath(), options = {}) => {
    const registry = options.skipReconcile === true ? await readRegistry(registryPath) : await reconcileHub(registryPath);
    if (registry.hub === null)
        return { registryPath, stopped: false, pid: null };
    const pid = registry.hub.pid;
    try {
        const response = await fetch(`${registry.hub.url}/api/shutdown`, {
            method: "POST",
            headers: {
                [clientHeaderName]: "1",
                [accessTokenHeaderName]: registry.hub.accessToken
            }
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
const hasAccessToken = (request, accessToken) => request.headers[accessTokenHeaderName] === accessToken;
const isSameOriginMutation = (request, accessToken) => {
    if (!hasAccessToken(request, accessToken))
        return false;
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
    const existingRegistry = await reconcileHub(registryPath, args.runtimeIdentity);
    if (existingRegistry.hub !== null) {
        console.log(`RouteLedger UI Hub already running at ${existingRegistry.hub.url}`);
        return;
    }
    const instanceId = randomUUID();
    const accessToken = randomBytes(32).toString("base64url");
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
        if (requestUrl.pathname.startsWith("/api/") && !hasAccessToken(request, accessToken)) {
            response.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({ error: "MISSION_CONTROL_ACCESS_TOKEN_REQUIRED" }));
            return;
        }
        if (requestUrl.pathname === "/api/health") {
            const registry = await readRegistry(registryPath);
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({
                ok: true,
                instanceId,
                pid: process.pid,
                projectCount: registry.projects.length,
                startedAt,
                lastActivityAt: new Date(lastActivityAt).toISOString(),
                protocolVersion: missionControlProtocolVersion,
                runtimeIdentity: args.runtimeIdentity
            }));
            return;
        }
        if (requestUrl.pathname === "/api/projects") {
            if (request.method === "POST") {
                if (!isSameOriginMutation(request, accessToken)) {
                    response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                    response.end(toJson({ error: "CLIENT_HEADER_REQUIRED" }));
                    return;
                }
                try {
                    const input = await readJsonBody(request);
                    if (typeof input.path !== "string")
                        throw new Error("path is required");
                    const project = await registerMissionControlProjectPath(input.path, registryPath);
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
            const projects = await Promise.all(registry.projects.map(async (project) => {
                try {
                    const state = await readProjectState(project);
                    return {
                        id: project.id,
                        projectId: project.projectId,
                        projectName: project.projectName,
                        available: state.identity !== null,
                        availabilityReason: state.identity === null ? state.message : null,
                        lastOpenedAt: project.lastOpenedAt
                    };
                }
                catch (error) {
                    return {
                        id: project.id,
                        projectId: project.projectId,
                        projectName: project.projectName,
                        available: false,
                        availabilityReason: error instanceof Error ? error.message : "项目暂不可用。",
                        lastOpenedAt: project.lastOpenedAt
                    };
                }
            }));
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson({ projects }));
            return;
        }
        if (requestUrl.pathname.startsWith("/api/projects/") && request.method === "DELETE") {
            if (!isSameOriginMutation(request, accessToken)) {
                response.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                response.end(toJson({ error: "MISSION_CONTROL_MUTATION_FORBIDDEN" }));
                return;
            }
            const projectKey = decodeURIComponent(requestUrl.pathname.slice("/api/projects/".length));
            const result = await removeMissionControlProject(projectKey, registryPath);
            touch();
            response.writeHead(result.removed ? 200 : 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(toJson(result.removed ? result : { error: "PROJECT_NOT_REGISTERED" }));
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
            await withRegistryLock(registryPath, async () => {
                const latest = await readRegistry(registryPath);
                await writeRegistry(registryPath, {
                    ...latest,
                    projects: latest.projects.map((candidate) => candidate.id === project.id
                        ? { ...candidate, lastOpenedAt: new Date().toISOString() }
                        : candidate)
                });
            });
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
            if (!isSameOriginMutation(request, accessToken)) {
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
        updatedAt: now,
        protocolVersion: missionControlProtocolVersion,
        runtimeIdentity: args.runtimeIdentity,
        accessToken
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
