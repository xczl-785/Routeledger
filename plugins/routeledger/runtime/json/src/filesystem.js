import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import { encodeProjectAggregateToJsonDocuments } from "./codec.js";
import { validateRouteLedgerJsonDocuments } from "./validator.js";
export class RouteLedgerJsonWriteError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "RouteLedgerJsonWriteError";
        this.code = code;
        this.details = details;
    }
}
export class RouteLedgerJsonBusyError extends Error {
    code;
    details;
    constructor(message, details) {
        super(message);
        this.name = "RouteLedgerJsonBusyError";
        this.code = "WRITE_IN_PROGRESS";
        this.details = details;
    }
}
const compareByString = (left, right) => left.localeCompare(right, "en");
export const ROUTELEDGER_CANONICAL_DOCUMENT_PATTERNS = [
    /^\.routeledger\/schema\/routeledger\.schema\.json$/,
    /^\.routeledger\/project\.json$/,
    /^\.routeledger\/refs\/current\.json$/,
    /^\.routeledger\/versions\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/work_items\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/todos\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/undos\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/deferred_items\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/constraints\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/assets\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/events\/\d{4}\/\d{2}\/[^/]+\.json$/,
    /^\.routeledger\/pending_operations\/[^/]+\/[^/]+\.json$/,
    /^\.routeledger\/approval_artifacts\/[^/]+\/[^/]+\.json$/
];
const ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES = [
    "project.json",
    "schema",
    "refs",
    "versions",
    "work_items",
    "todos",
    "undos",
    "deferred_items",
    "constraints",
    "assets",
    "events",
    "pending_operations",
    "approval_artifacts"
];
const REPLACEMENT_DIRECTORY_NAME = ".canonical-replace";
const REPLACEMENT_MANIFEST_FILENAME = "manifest.json";
const REPLACEMENT_NEXT_DIRECTORY = "next";
const REPLACEMENT_BACKUP_DIRECTORY = "backup";
const WRITE_LOCK_DIRECTORY_NAME = ".write-lock";
const WRITE_LOCK_METADATA_FILENAME = "metadata.json";
const DEFAULT_WRITE_LOCK_RETRY_AFTER_MS = 250;
const DEFAULT_WRITE_LOCK_STALE_AFTER_MS = 30_000;
const TRANSIENT_FILESYSTEM_ERROR_CODES = new Set(["EPERM", "EACCES"]);
const TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS = [100, 300, 1_000, 2_000];
export const isCanonicalRouteLedgerJsonPath = (documentPath) => ROUTELEDGER_CANONICAL_DOCUMENT_PATTERNS.some((pattern) => pattern.test(documentPath));
let routeLedgerJsonFilesystemTestHooks = null;
export const setRouteLedgerJsonFilesystemTestHooks = (hooks) => {
    routeLedgerJsonFilesystemTestHooks = hooks;
};
const normalizeDocumentPath = (documentPath) => {
    const normalizedPath = path.posix.normalize(documentPath);
    if (normalizedPath === "." ||
        normalizedPath.startsWith("../") ||
        path.posix.isAbsolute(normalizedPath)) {
        throw new RouteLedgerJsonWriteError("DOCUMENT_PATH_ESCAPE", `document path escapes output root: ${documentPath}`, {
            path: documentPath
        });
    }
    return normalizedPath;
};
const resolveDocumentPath = (outputRoot, documentPath) => {
    const normalizedPath = normalizeDocumentPath(documentPath);
    const absoluteOutputRoot = path.resolve(outputRoot);
    const absolutePath = path.resolve(absoluteOutputRoot, ...normalizedPath.split("/"));
    const relativeToRoot = path.relative(absoluteOutputRoot, absolutePath);
    if (relativeToRoot === "" ||
        relativeToRoot.startsWith("..") ||
        path.isAbsolute(relativeToRoot)) {
        throw new RouteLedgerJsonWriteError("DOCUMENT_PATH_ESCAPE", `document path escapes output root: ${documentPath}`, {
            path: documentPath
        });
    }
    return {
        relativePath: normalizedPath,
        absolutePath,
        content: ""
    };
};
const prepareDocumentWrites = (outputRoot, documents) => [...documents].map((document) => {
    const resolved = resolveDocumentPath(outputRoot, document.path);
    return {
        ...resolved,
        content: document.content
    };
});
const getAbsoluteJsonRoot = (outputRoot) => path.join(path.resolve(outputRoot), ROUTELEDGER_JSON_ROOT);
const getReplacementRoot = (outputRoot) => path.join(getAbsoluteJsonRoot(outputRoot), REPLACEMENT_DIRECTORY_NAME);
const getReplacementManifestPath = (outputRoot) => path.join(getReplacementRoot(outputRoot), REPLACEMENT_MANIFEST_FILENAME);
const getReplacementNextRoot = (outputRoot) => path.join(getReplacementRoot(outputRoot), REPLACEMENT_NEXT_DIRECTORY);
const getReplacementBackupRoot = (outputRoot) => path.join(getReplacementRoot(outputRoot), REPLACEMENT_BACKUP_DIRECTORY);
const getWriteLockRoot = (outputRoot) => path.join(getAbsoluteJsonRoot(outputRoot), WRITE_LOCK_DIRECTORY_NAME);
const getWriteLockMetadataPath = (outputRoot) => path.join(getWriteLockRoot(outputRoot), WRITE_LOCK_METADATA_FILENAME);
const getWriteLockMarkerPath = (outputRoot, lockId) => path.join(getWriteLockRoot(outputRoot), `.lock-owner-${lockId}.marker`);
const toReplacementRelativePath = (documentPath) => {
    const normalizedPath = normalizeDocumentPath(documentPath);
    if (!normalizedPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/`)) {
        throw new RouteLedgerJsonWriteError("DOCUMENT_PATH_ESCAPE", `document path must stay inside ${ROUTELEDGER_JSON_ROOT}: ${documentPath}`, {
            path: documentPath
        });
    }
    return normalizedPath.slice(`${ROUTELEDGER_JSON_ROOT}/`.length);
};
const readCanonicalDocumentsFromJsonRoot = async (absoluteJsonRoot) => {
    const visit = async (directory, relativeDirectory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const documents = [];
        for (const entry of entries) {
            const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
            if (entry.isDirectory()) {
                const topLevelDirectory = relativePath.split("/")[0];
                if (topLevelDirectory === "db" || topLevelDirectory === "views") {
                    continue;
                }
                documents.push(...(await visit(path.join(directory, entry.name), relativePath)));
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".json")) {
                continue;
            }
            const documentPath = `${ROUTELEDGER_JSON_ROOT}/${relativePath}`;
            if (!isCanonicalRouteLedgerJsonPath(documentPath)) {
                continue;
            }
            documents.push({
                path: documentPath,
                content: await fs.readFile(path.join(directory, entry.name), "utf8")
            });
        }
        return documents;
    };
    try {
        const documents = await visit(absoluteJsonRoot, "");
        return documents.sort((left, right) => compareByString(left.path, right.path));
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
};
const writeReplacementManifest = async (outputRoot, manifest) => {
    const manifestPath = getReplacementManifestPath(outputRoot);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const tempPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await fs.rename(tempPath, manifestPath);
};
const readReplacementManifest = async (outputRoot) => {
    try {
        const manifestContent = await fs.readFile(getReplacementManifestPath(outputRoot), "utf8");
        return JSON.parse(manifestContent);
    }
    catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT") ||
            error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
};
const writeWriteLockMetadata = async (outputRoot, metadata) => {
    const metadataPath = getWriteLockMetadataPath(outputRoot);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    const tempPath = `${metadataPath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(tempPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    await fs.rename(tempPath, metadataPath);
};
const readWriteLockMetadata = async (outputRoot) => {
    try {
        const content = await fs.readFile(getWriteLockMetadataPath(outputRoot), "utf8");
        const parsed = JSON.parse(content);
        if (typeof parsed.lockId === "string" &&
            typeof parsed.ownerId === "string" &&
            typeof parsed.createdAt === "string" &&
            typeof parsed.updatedAt === "string" &&
            typeof parsed.retryAfterMs === "number" &&
            typeof parsed.staleAfterMs === "number" &&
            typeof parsed.pid === "number") {
            return {
                lockId: parsed.lockId,
                ownerId: parsed.ownerId,
                createdAt: parsed.createdAt,
                updatedAt: parsed.updatedAt,
                retryAfterMs: parsed.retryAfterMs,
                staleAfterMs: parsed.staleAfterMs,
                pid: parsed.pid
            };
        }
        return null;
    }
    catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT") ||
            error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
};
const pathExists = async (targetPath) => {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
};
const getErrorCode = (error) => error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
const isTransientFilesystemError = (error) => {
    const code = getErrorCode(error);
    return code !== null && TRANSIENT_FILESYSTEM_ERROR_CODES.has(code);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const renameWithTransientRetry = async ({ operation, sourcePath, destinationPath, entryName }) => {
    const maxAttempts = TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS.length + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await routeLedgerJsonFilesystemTestHooks?.beforeRename?.({
                operation,
                sourcePath,
                destinationPath,
                attempt,
                entryName
            });
            await fs.rename(sourcePath, destinationPath);
            return;
        }
        catch (error) {
            lastError = error;
            if (!isTransientFilesystemError(error) || attempt === maxAttempts) {
                throw error;
            }
            await sleep(TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS[attempt - 1]);
        }
    }
    throw lastError;
};
const createRenameFailureError = ({ operation, sourcePath, destinationPath, entryName, error }) => new RouteLedgerJsonWriteError("FILESYSTEM_RENAME_FAILED", `failed to rename RouteLedger canonical JSON entry during ${operation}`, {
    operation,
    sourcePath,
    destinationPath,
    entryName: entryName ?? null,
    errorCode: getErrorCode(error),
    causeMessage: error instanceof Error ? error.message : String(error)
});
const parseIsoTimestamp = (value) => {
    if (typeof value !== "string") {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
};
const computeWriteLockExpiry = (metadata, fallbackUpdatedAtMs, fallbackStaleAfterMs = DEFAULT_WRITE_LOCK_STALE_AFTER_MS) => {
    if (metadata === null) {
        if (fallbackUpdatedAtMs === null || fallbackUpdatedAtMs === undefined) {
            return {
                expiresAt: null,
                isStale: false
            };
        }
        const expiresAtMs = fallbackUpdatedAtMs + fallbackStaleAfterMs;
        return {
            expiresAt: new Date(expiresAtMs).toISOString(),
            isStale: Date.now() >= expiresAtMs
        };
    }
    const updatedAtMs = parseIsoTimestamp(metadata.updatedAt);
    if (updatedAtMs === null) {
        return {
            expiresAt: null,
            isStale: false
        };
    }
    const expiresAtMs = updatedAtMs + metadata.staleAfterMs;
    return {
        expiresAt: new Date(expiresAtMs).toISOString(),
        isStale: Date.now() >= expiresAtMs
    };
};
const toWriteLockInfo = (outputRoot, metadata, fallbackUpdatedAtMs) => {
    const expiry = computeWriteLockExpiry(metadata, fallbackUpdatedAtMs);
    return {
        projectRoot: path.resolve(outputRoot),
        lockPath: getWriteLockRoot(outputRoot),
        ownerId: metadata?.ownerId ?? null,
        createdAt: metadata?.createdAt ?? null,
        updatedAt: metadata?.updatedAt ?? null,
        retryAfterMs: metadata?.retryAfterMs ?? null,
        staleAfterMs: metadata?.staleAfterMs ?? null,
        expiresAt: expiry.expiresAt,
        pid: metadata?.pid ?? null
    };
};
const writeLockMetadataMatches = (left, right) => left?.lockId === right?.lockId &&
    left?.ownerId === right?.ownerId &&
    left?.createdAt === right?.createdAt &&
    left?.updatedAt === right?.updatedAt &&
    left?.retryAfterMs === right?.retryAfterMs &&
    left?.staleAfterMs === right?.staleAfterMs &&
    left?.pid === right?.pid;
const getWriteLockDirectoryMtimeMs = async (outputRoot) => {
    try {
        const stat = await fs.stat(getWriteLockRoot(outputRoot));
        return stat.mtimeMs;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
};
const listExistingCanonicalEntries = async (rootPath) => {
    const existingEntries = [];
    for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
        if (await pathExists(path.join(rootPath, entryName))) {
            existingEntries.push(entryName);
        }
    }
    return existingEntries;
};
const clearReplacementDirectory = async (outputRoot) => {
    await fs.rm(getReplacementRoot(outputRoot), { recursive: true, force: true });
};
const moveExistingCanonicalEntriesToBackup = async (outputRoot) => {
    const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
    const backupRoot = getReplacementBackupRoot(outputRoot);
    await fs.mkdir(backupRoot, { recursive: true });
    for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
        const sourcePath = path.join(absoluteJsonRoot, entryName);
        const destinationPath = path.join(backupRoot, entryName);
        try {
            await renameWithTransientRetry({
                operation: "backup_existing_canonical_entry",
                sourcePath,
                destinationPath,
                entryName
            });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }
            throw createRenameFailureError({
                operation: "backup_existing_canonical_entry",
                sourcePath,
                destinationPath,
                entryName,
                error
            });
        }
    }
};
const moveReplacementEntriesIntoCanonicalRoot = async (outputRoot) => {
    const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
    const nextRoot = getReplacementNextRoot(outputRoot);
    for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
        const sourcePath = path.join(nextRoot, entryName);
        const destinationPath = path.join(absoluteJsonRoot, entryName);
        try {
            await renameWithTransientRetry({
                operation: "apply_replacement_canonical_entry",
                sourcePath,
                destinationPath,
                entryName
            });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }
            throw createRenameFailureError({
                operation: "apply_replacement_canonical_entry",
                sourcePath,
                destinationPath,
                entryName,
                error
            });
        }
    }
};
const removeSelectedCanonicalEntriesFromJsonRoot = async (outputRoot, entryNames) => {
    const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
    for (const entryName of entryNames) {
        await fs.rm(path.join(absoluteJsonRoot, entryName), {
            recursive: true,
            force: true
        });
    }
};
const restoreCanonicalEntriesFromBackup = async (outputRoot, entryNames) => {
    const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
    const backupRoot = getReplacementBackupRoot(outputRoot);
    await removeSelectedCanonicalEntriesFromJsonRoot(outputRoot, entryNames);
    await fs.mkdir(absoluteJsonRoot, { recursive: true });
    for (const entryName of entryNames) {
        const sourcePath = path.join(backupRoot, entryName);
        const destinationPath = path.join(absoluteJsonRoot, entryName);
        try {
            await fs.cp(sourcePath, destinationPath, {
                recursive: true,
                force: true
            });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }
            throw error;
        }
    }
};
const validatePreparedDocumentSet = (documents) => {
    const validation = validateRouteLedgerJsonDocuments(documents);
    if (!validation.valid) {
        throw new RouteLedgerJsonWriteError("DOCUMENT_SET_INVALID", "canonical JSON document set is invalid", {
            issues: validation.issues
        });
    }
};
const tryReadValidCanonicalDocuments = async (outputRoot) => {
    const documents = await readCanonicalDocumentsFromJsonRoot(getAbsoluteJsonRoot(outputRoot));
    try {
        validatePreparedDocumentSet(documents);
        return documents;
    }
    catch (error) {
        if (error instanceof RouteLedgerJsonWriteError && error.code === "DOCUMENT_SET_INVALID") {
            return null;
        }
        throw error;
    }
};
const stageReplacementDocumentSet = async (outputRoot, documents) => {
    const nextRoot = getReplacementNextRoot(outputRoot);
    await fs.rm(nextRoot, { recursive: true, force: true });
    for (const document of documents) {
        const replacementRelativePath = toReplacementRelativePath(document.path);
        const absolutePath = path.join(nextRoot, ...replacementRelativePath.split("/"));
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, document.content, "utf8");
    }
    const stagedDocuments = await readCanonicalDocumentsFromJsonRoot(nextRoot);
    validatePreparedDocumentSet(stagedDocuments);
    if (stagedDocuments.length !== documents.length) {
        throw new RouteLedgerJsonWriteError("DOCUMENT_SET_INVALID", "staged canonical JSON document set is incomplete", {
            expectedDocumentCount: documents.length,
            stagedDocumentCount: stagedDocuments.length
        });
    }
};
export const getRouteLedgerJsonWriteLockInfo = async (outputRoot) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    const lockRoot = getWriteLockRoot(absoluteOutputRoot);
    if (!(await pathExists(lockRoot))) {
        return null;
    }
    const metadata = await readWriteLockMetadata(absoluteOutputRoot);
    const directoryMtimeMs = await getWriteLockDirectoryMtimeMs(absoluteOutputRoot);
    return toWriteLockInfo(absoluteOutputRoot, metadata, directoryMtimeMs);
};
const tryRecoverStaleRouteLedgerWriteLock = async (outputRoot) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    const lockRoot = getWriteLockRoot(absoluteOutputRoot);
    if (!(await pathExists(lockRoot))) {
        return false;
    }
    const observedMetadata = await readWriteLockMetadata(absoluteOutputRoot);
    const directoryMtimeMs = await getWriteLockDirectoryMtimeMs(absoluteOutputRoot);
    const observedExpiry = computeWriteLockExpiry(observedMetadata, directoryMtimeMs);
    if (!observedExpiry.isStale) {
        return false;
    }
    await routeLedgerJsonFilesystemTestHooks?.beforeClaimStaleLock?.({
        outputRoot: absoluteOutputRoot,
        lockRoot,
        metadata: observedMetadata
    });
    if (observedMetadata !== null) {
        const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);
        if (!writeLockMetadataMatches(observedMetadata, currentMetadata)) {
            return false;
        }
        const ownerMarkerPath = getWriteLockMarkerPath(absoluteOutputRoot, observedMetadata.lockId);
        const claimedMarkerPath = path.join(lockRoot, `.reap-claim-${observedMetadata.lockId}-${process.pid}-${randomUUID()}`);
        try {
            await fs.rename(ownerMarkerPath, claimedMarkerPath);
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return false;
            }
            throw error;
        }
        const verifiedMetadata = await readWriteLockMetadata(absoluteOutputRoot);
        if (!writeLockMetadataMatches(observedMetadata, verifiedMetadata)) {
            try {
                await fs.rename(claimedMarkerPath, ownerMarkerPath);
            }
            catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
            }
            return false;
        }
        await fs.rm(lockRoot, { recursive: true, force: true });
        return true;
    }
    const reaperClaimPath = path.join(lockRoot, `.reap-claim-corrupt-${process.pid}-${randomUUID()}`);
    try {
        await fs.writeFile(reaperClaimPath, "stale-corrupt-lock\n", {
            flag: "wx"
        });
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);
    if (currentMetadata !== null) {
        await fs.rm(reaperClaimPath, { force: true });
        return false;
    }
    await fs.rm(lockRoot, { recursive: true, force: true });
    return true;
};
export const getActiveRouteLedgerJsonWriteLockInfo = async (outputRoot) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    if (await tryRecoverStaleRouteLedgerWriteLock(absoluteOutputRoot)) {
        return null;
    }
    return getRouteLedgerJsonWriteLockInfo(absoluteOutputRoot);
};
const assertNoActiveRouteLedgerWriteLock = async (outputRoot, options = {}) => {
    const lockInfo = await getActiveRouteLedgerJsonWriteLockInfo(outputRoot);
    if (lockInfo === null) {
        return;
    }
    if (options.writeLockOwnerId !== undefined &&
        lockInfo.ownerId !== null &&
        lockInfo.ownerId === options.writeLockOwnerId) {
        return;
    }
    throw new RouteLedgerJsonBusyError("RouteLedger canonical JSON write is already in progress for this projectRoot", lockInfo);
};
export const acquireRouteLedgerJsonWriteLock = async (outputRoot, options = {}) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    const lockRoot = getWriteLockRoot(absoluteOutputRoot);
    const lockId = randomUUID();
    const retryAfterMs = options.retryAfterMs ?? DEFAULT_WRITE_LOCK_RETRY_AFTER_MS;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_WRITE_LOCK_STALE_AFTER_MS;
    const ownerId = options.ownerId ?? randomUUID();
    const now = new Date().toISOString();
    const metadata = {
        lockId,
        ownerId,
        createdAt: now,
        updatedAt: now,
        retryAfterMs,
        staleAfterMs,
        pid: process.pid
    };
    let acquired = false;
    while (!acquired) {
        try {
            await fs.mkdir(path.dirname(lockRoot), { recursive: true });
            await fs.mkdir(lockRoot, { recursive: false });
            acquired = true;
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") {
                if (await tryRecoverStaleRouteLedgerWriteLock(absoluteOutputRoot)) {
                    continue;
                }
                const lockInfo = (await getRouteLedgerJsonWriteLockInfo(absoluteOutputRoot)) ??
                    toWriteLockInfo(absoluteOutputRoot, null);
                throw new RouteLedgerJsonBusyError("RouteLedger canonical JSON write is already in progress for this projectRoot", lockInfo);
            }
            throw error;
        }
    }
    try {
        await fs.writeFile(getWriteLockMarkerPath(absoluteOutputRoot, lockId), `${ownerId}\n`, {
            flag: "wx"
        });
        await writeWriteLockMetadata(absoluteOutputRoot, metadata);
    }
    catch (error) {
        await fs.rm(lockRoot, { recursive: true, force: true });
        throw error;
    }
    let released = false;
    const assertLockStillOwned = async () => {
        const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);
        if (currentMetadata !== null && currentMetadata.ownerId !== ownerId) {
            throw new RouteLedgerJsonBusyError("RouteLedger canonical JSON write lock was reclaimed by another owner", toWriteLockInfo(absoluteOutputRoot, currentMetadata));
        }
    };
    return {
        ...toWriteLockInfo(absoluteOutputRoot, metadata),
        renew: async () => {
            if (released) {
                return;
            }
            await assertLockStillOwned();
            const refreshed = {
                ...metadata,
                updatedAt: new Date().toISOString()
            };
            await writeWriteLockMetadata(absoluteOutputRoot, refreshed);
            metadata.updatedAt = refreshed.updatedAt;
        },
        release: async () => {
            if (released) {
                return;
            }
            released = true;
            const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);
            if (currentMetadata !== null && currentMetadata.ownerId !== ownerId) {
                return;
            }
            await fs.rm(lockRoot, { recursive: true, force: true });
        }
    };
};
export const recoverRouteLedgerJsonReplacement = async (outputRoot, options = {}) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    const replacementRoot = getReplacementRoot(absoluteOutputRoot);
    const backupRoot = getReplacementBackupRoot(absoluteOutputRoot);
    await assertNoActiveRouteLedgerWriteLock(absoluteOutputRoot, options);
    try {
        await fs.access(replacementRoot);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {
                outputRoot: absoluteOutputRoot,
                recovered: false,
                action: "none"
            };
        }
        throw error;
    }
    const manifest = await readReplacementManifest(absoluteOutputRoot);
    const backupEntries = await listExistingCanonicalEntries(backupRoot);
    const hasRecoverableBackup = backupEntries.length > 0;
    const currentCanonicalDocuments = await tryReadValidCanonicalDocuments(absoluteOutputRoot);
    const hasValidCurrentCanonical = currentCanonicalDocuments !== null;
    if (manifest === null) {
        if (hasValidCurrentCanonical) {
            await clearReplacementDirectory(absoluteOutputRoot);
            return {
                outputRoot: absoluteOutputRoot,
                recovered: true,
                action: "cleanup_applied"
            };
        }
        if (hasRecoverableBackup) {
            await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
            await clearReplacementDirectory(absoluteOutputRoot);
            return {
                outputRoot: absoluteOutputRoot,
                recovered: true,
                action: "restore_backup"
            };
        }
        await clearReplacementDirectory(absoluteOutputRoot);
        return {
            outputRoot: absoluteOutputRoot,
            recovered: true,
            action: "discard_staged"
        };
    }
    if (manifest.state === "applied") {
        if (hasValidCurrentCanonical) {
            await clearReplacementDirectory(absoluteOutputRoot);
            return {
                outputRoot: absoluteOutputRoot,
                recovered: true,
                action: "cleanup_applied"
            };
        }
        if (hasRecoverableBackup) {
            await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
            await clearReplacementDirectory(absoluteOutputRoot);
            return {
                outputRoot: absoluteOutputRoot,
                recovered: true,
                action: "restore_backup"
            };
        }
        await clearReplacementDirectory(absoluteOutputRoot);
        return {
            outputRoot: absoluteOutputRoot,
            recovered: true,
            action: "cleanup_applied"
        };
    }
    if (manifest.state === "backup_created") {
        await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES);
        await clearReplacementDirectory(absoluteOutputRoot);
        return {
            outputRoot: absoluteOutputRoot,
            recovered: true,
            action: "restore_backup"
        };
    }
    if (hasRecoverableBackup) {
        await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
        await clearReplacementDirectory(absoluteOutputRoot);
        return {
            outputRoot: absoluteOutputRoot,
            recovered: true,
            action: "restore_backup"
        };
    }
    await clearReplacementDirectory(absoluteOutputRoot);
    return {
        outputRoot: absoluteOutputRoot,
        recovered: true,
        action: "discard_staged"
    };
};
export const writeRouteLedgerJsonDocuments = async ({ outputRoot, documents, overwrite = false }) => {
    const preparedDocuments = prepareDocumentWrites(outputRoot, documents);
    if (!overwrite) {
        for (const document of preparedDocuments) {
            try {
                await fs.access(document.absolutePath);
                throw new RouteLedgerJsonWriteError("DOCUMENT_ALREADY_EXISTS", `document already exists: ${document.relativePath}`, {
                    path: document.relativePath
                });
            }
            catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }
    for (const document of preparedDocuments) {
        await fs.mkdir(path.dirname(document.absolutePath), { recursive: true });
        await fs.writeFile(document.absolutePath, document.content, "utf8");
    }
    const absoluteOutputRoot = path.resolve(outputRoot);
    return {
        outputRoot: absoluteOutputRoot,
        jsonRoot: path.join(absoluteOutputRoot, ROUTELEDGER_JSON_ROOT),
        documentCount: preparedDocuments.length,
        paths: preparedDocuments.map((document) => document.relativePath)
    };
};
export const replaceRouteLedgerJsonDocuments = async ({ outputRoot, documents, writeLockOwnerId, renewLock }) => {
    const absoluteOutputRoot = path.resolve(outputRoot);
    const normalizedDocuments = [...documents].map((document) => ({
        path: normalizeDocumentPath(document.path),
        content: document.content
    }));
    validatePreparedDocumentSet(normalizedDocuments);
    await recoverRouteLedgerJsonReplacement(absoluteOutputRoot, {
        writeLockOwnerId
    });
    await clearReplacementDirectory(absoluteOutputRoot);
    const now = new Date().toISOString();
    const manifestBase = {
        transactionId: randomUUID(),
        state: "staged",
        createdAt: now,
        updatedAt: now,
        documentCount: normalizedDocuments.length,
        paths: normalizedDocuments.map((document) => document.path)
    };
    await writeReplacementManifest(absoluteOutputRoot, manifestBase);
    await stageReplacementDocumentSet(absoluteOutputRoot, normalizedDocuments);
    await renewLock?.();
    await moveExistingCanonicalEntriesToBackup(absoluteOutputRoot);
    await writeReplacementManifest(absoluteOutputRoot, {
        ...manifestBase,
        state: "backup_created",
        updatedAt: new Date().toISOString()
    });
    await renewLock?.();
    await moveReplacementEntriesIntoCanonicalRoot(absoluteOutputRoot);
    await writeReplacementManifest(absoluteOutputRoot, {
        ...manifestBase,
        state: "applied",
        updatedAt: new Date().toISOString()
    });
    await renewLock?.();
    await clearReplacementDirectory(absoluteOutputRoot);
    return {
        outputRoot: absoluteOutputRoot,
        jsonRoot: path.join(absoluteOutputRoot, ROUTELEDGER_JSON_ROOT),
        documentCount: normalizedDocuments.length,
        paths: normalizedDocuments.map((document) => document.path)
    };
};
export const exportProjectAggregateToJsonDirectory = async ({ outputRoot, snapshot, overwrite = false }) => writeRouteLedgerJsonDocuments({
    outputRoot,
    documents: encodeProjectAggregateToJsonDocuments(snapshot),
    overwrite
});
export const readRouteLedgerJsonDocuments = async (inputRoot, options = {}) => {
    const absoluteInputRoot = path.resolve(inputRoot);
    await recoverRouteLedgerJsonReplacement(absoluteInputRoot, options);
    return readCanonicalDocumentsFromJsonRoot(getAbsoluteJsonRoot(absoluteInputRoot));
};
