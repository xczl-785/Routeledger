import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { attachProjectAggregateHeadRevision, getProjectAggregateHeadRevision } from "../../core/src/index.js";
import { RouteLedgerJsonBusyError, RouteLedgerJsonImportError, RouteLedgerJsonWriteError, PROJECT_DOCUMENT_PATH, SCHEMA_DOCUMENT_PATH, acquireRouteLedgerJsonWriteLock, decodeProjectAggregateFromJsonDocuments, encodeProjectAggregateToJsonDocuments, getActiveRouteLedgerJsonWriteLockInfo, isCanonicalRouteLedgerJsonPath, loadValidatedProjectAggregateFromJsonDirectory, replaceRouteLedgerJsonDocuments, validateRouteLedgerJsonDocuments } from "../../json/src/index.js";
import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";
import { ensureRouteLedgerGitAttributes, resolveWorkspaceConfigSync } from "./workspace-config.js";
export class JsonFirstStorageError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "JsonFirstStorageError";
        this.code = code;
        this.details = details;
    }
}
const compareByPath = (left, right) => left.path.localeCompare(right.path, "en");
const getSemanticDocuments = (documents) => documents.filter((document) => document.path !== SCHEMA_DOCUMENT_PATH);
const getComparableDocumentContent = (document) => {
    if (document.path !== PROJECT_DOCUMENT_PATH) {
        return document.content;
    }
    try {
        const project = JSON.parse(document.content);
        if (project.settings === undefined ||
            Object.prototype.hasOwnProperty.call(project.settings, "content_locale")) {
            return document.content;
        }
        return `${JSON.stringify({
            ...project,
            settings: {
                ...project.settings,
                content_locale: null
            }
        }, null, 2)}\n`;
    }
    catch {
        return document.content;
    }
};
const documentSetsEqual = (left, right) => {
    const semanticLeft = getSemanticDocuments(left);
    const semanticRight = getSemanticDocuments(right);
    if (semanticLeft.length !== semanticRight.length) {
        return false;
    }
    const sortedLeft = semanticLeft.slice().sort(compareByPath);
    const sortedRight = semanticRight.slice().sort(compareByPath);
    return sortedLeft.every((document, index) => {
        return (document.path === sortedRight[index].path &&
            getComparableDocumentContent(document) ===
                getComparableDocumentContent(sortedRight[index]));
    });
};
const collectDocumentDiffPaths = (left, right) => {
    const semanticLeft = getSemanticDocuments(left);
    const semanticRight = getSemanticDocuments(right);
    const leftMap = new Map(semanticLeft.map((document) => [document.path, getComparableDocumentContent(document)]));
    const rightMap = new Map(semanticRight.map((document) => [document.path, getComparableDocumentContent(document)]));
    const allPaths = new Set([...leftMap.keys(), ...rightMap.keys()]);
    return [...allPaths]
        .filter((documentPath) => {
        return leftMap.get(documentPath) !== rightMap.get(documentPath);
    })
        .sort((a, b) => a.localeCompare(b, "en"));
};
const getSnapshotFreshnessTimestamp = (snapshot) => {
    const candidates = [
        snapshot.project.updatedAt,
        ...snapshot.versions.map((version) => version.updatedAt),
        ...snapshot.workItems.map((workItem) => workItem.updatedAt),
        ...snapshot.todos.map((todo) => todo.updatedAt),
        ...snapshot.undos.map((undo) => undo.updatedAt),
        ...snapshot.deferredItems.map((deferredItem) => deferredItem.updatedAt),
        ...snapshot.constraints.map((constraint) => constraint.updatedAt),
        ...snapshot.assets.map((asset) => asset.updatedAt),
        ...snapshot.pendingOperations.map((operation) => operation.updatedAt),
        ...snapshot.approvalArtifacts.map((artifact) => artifact.consumedAt ?? artifact.createdAt),
        ...snapshot.events.map((event) => event.createdAt)
    ].filter((value) => typeof value === "string" && value.length > 0);
    return candidates.sort((left, right) => right.localeCompare(left))[0] ?? snapshot.project.updatedAt;
};
const formatUnknownError = (error) => error instanceof Error
    ? {
        name: error.name,
        message: error.message
    }
    : {
        message: String(error)
    };
const resolveSqliteReadModelMode = (value) => {
    if (value === undefined || value === "enabled") {
        return "enabled";
    }
    if (value === "disabled") {
        return "disabled";
    }
    throw new JsonFirstStorageError("JSON_SOURCE_INVALID", "sqliteReadModel must be enabled or disabled", { sqliteReadModel: value });
};
export class JsonFirstStorageAdapter {
    workspaceRoot;
    routeledgerRoot;
    workspaceConfigPath;
    dataRoot;
    routeledgerDir;
    jsonProjectPath;
    databasePath;
    sqliteReadModel;
    testHooks;
    constructor(options) {
        this.workspaceRoot = path.resolve(options.workspaceRoot);
        this.routeledgerRoot = path.resolve(options.routeledgerRoot);
        const defaultDataDir = path.relative(this.workspaceRoot, this.routeledgerRoot) || ".";
        const workspaceConfig = resolveWorkspaceConfigSync({
            projectRoot: this.workspaceRoot,
            autoCreate: options.autoCreateWorkspaceConfig ?? true,
            defaultDataDir
        });
        if (workspaceConfig.status !== "ready") {
            throw new JsonFirstStorageError("JSON_SOURCE_INVALID", "workspace config is not ready for JsonFirstStorageAdapter", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                workspaceConfigPath: workspaceConfig.workspaceConfigPath,
                diagnostics: workspaceConfig.diagnostics
            });
        }
        if (path.resolve(workspaceConfig.dataRoot) !== this.routeledgerRoot) {
            throw new JsonFirstStorageError("JSON_SOURCE_INVALID", "workspace config dataDir does not match the bound routeledgerRoot", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                dataRoot: workspaceConfig.dataRoot,
                workspaceConfigPath: workspaceConfig.workspaceConfigPath
            });
        }
        this.workspaceConfigPath = workspaceConfig.workspaceConfigPath;
        this.dataRoot = workspaceConfig.dataRoot;
        this.routeledgerDir = workspaceConfig.routeledgerDir;
        ensureRouteLedgerGitAttributes(this.routeledgerDir);
        this.jsonProjectPath = workspaceConfig.jsonProjectPath;
        this.databasePath = workspaceConfig.sqliteDbPath;
        this.sqliteReadModel = resolveSqliteReadModelMode(options.sqliteReadModel);
        this.testHooks = options.testHooks;
    }
    close() { }
    async loadProjectAggregate(projectId) {
        await this.throwIfWriteInProgress();
        const jsonSource = await this.loadJsonSourceIfPresent();
        if (jsonSource === null) {
            if (this.sqliteReadModel === "disabled") {
                return null;
            }
            const snapshot = await this.withSqliteAdapter((adapter) => adapter.loadProjectAggregate(projectId));
            return snapshot === null ? null : attachProjectAggregateHeadRevision(snapshot, null);
        }
        if (this.sqliteReadModel === "enabled") {
            await this.assertNoBlockingConflict(jsonSource);
        }
        if (jsonSource.snapshot.project.id !== projectId) {
            return null;
        }
        await this.rebuildSqliteReadModelIfNeeded(jsonSource);
        return attachProjectAggregateHeadRevision(jsonSource.snapshot, jsonSource.headRevision);
    }
    async saveProjectAggregate(snapshot) {
        const writerLock = await this.acquireWriteLock(snapshot.project.id);
        try {
            const jsonSource = await this.loadJsonSourceIfPresent(writerLock.ownerId ?? undefined);
            if (jsonSource !== null) {
                if (jsonSource.snapshot.project.id !== snapshot.project.id) {
                    throw new JsonFirstStorageError("JSON_SQLITE_CONFLICT", "canonical JSON 与待保存 project 不一致，拒绝覆盖", {
                        canonicalProjectId: jsonSource.snapshot.project.id,
                        requestedProjectId: snapshot.project.id
                    });
                }
                if (this.sqliteReadModel === "enabled") {
                    await this.assertNoBlockingConflict(jsonSource);
                }
            }
            else {
                if (this.sqliteReadModel === "disabled") {
                    // A legacy SQLite-only directory is deliberately not a source in JSON-only mode.
                }
                else {
                    const sqliteState = await this.inspectSqliteState();
                    if (sqliteState.kind === "multiple") {
                        throw new JsonFirstStorageError("JSON_SQLITE_CONFLICT", "SQLite read model 包含多个 project，无法映射到单个 canonical JSON 真源", {
                            sqliteProjectIds: sqliteState.projectIds
                        });
                    }
                    if (sqliteState.kind === "single" && sqliteState.projectId !== snapshot.project.id) {
                        throw new JsonFirstStorageError("JSON_SQLITE_CONFLICT", "SQLite read model 与待保存 project 不一致，拒绝静默覆盖", {
                            sqliteProjectId: sqliteState.projectId,
                            requestedProjectId: snapshot.project.id
                        });
                    }
                }
            }
            this.assertExpectedHeadRevision({
                snapshot,
                jsonSource
            });
            const encodedDocuments = encodeProjectAggregateToJsonDocuments(snapshot);
            try {
                await replaceRouteLedgerJsonDocuments({
                    outputRoot: this.dataRoot,
                    documents: encodedDocuments,
                    compactAudit: jsonSource === null && this.sqliteReadModel === "disabled",
                    writeLockOwnerId: writerLock.ownerId ?? undefined,
                    renewLock: writerLock.renew
                });
            }
            catch (error) {
                if (error instanceof RouteLedgerJsonBusyError) {
                    throw new JsonFirstStorageError("WRITE_IN_PROGRESS", error.message, {
                        workspaceRoot: this.workspaceRoot,
                        routeledgerRoot: this.routeledgerRoot,
                        ...error.details
                    });
                }
                if (error instanceof RouteLedgerJsonWriteError) {
                    throw new JsonFirstStorageError("JSON_WRITE_FAILED", error.message, {
                        workspaceRoot: this.workspaceRoot,
                        routeledgerRoot: this.routeledgerRoot,
                        writeErrorCode: error.code,
                        ...error.details
                    });
                }
                throw error;
            }
            const headRevision = this.computeHeadRevision(encodedDocuments);
            attachProjectAggregateHeadRevision(snapshot, headRevision);
            if (this.sqliteReadModel === "enabled") {
                await this.syncJsonSnapshotToSqlite(snapshot);
            }
        }
        finally {
            await writerLock.release();
        }
    }
    async inspectRuntimeBinding() {
        const [hasCanonicalJson, hasSqlite, writeLockInfo] = await Promise.all([
            this.pathExists(this.jsonProjectPath),
            this.pathExists(this.databasePath),
            getActiveRouteLedgerJsonWriteLockInfo(this.dataRoot)
        ]);
        let jsonSource = null;
        let jsonError = null;
        if (writeLockInfo === null && hasCanonicalJson) {
            try {
                jsonSource = await this.loadJsonSourceIfPresentWithoutRecovery();
            }
            catch (error) {
                if (error instanceof JsonFirstStorageError) {
                    jsonError = error;
                }
                else {
                    throw error;
                }
            }
        }
        const sqliteState = this.sqliteReadModel === "enabled"
            ? await this.inspectSqliteState({
                allowCreate: false,
                hasSqliteHint: hasSqlite
            })
            : { kind: "empty" };
        const conflict = jsonSource === null ? null : this.getBlockingConflict(jsonSource, sqliteState);
        const activeProject = jsonSource !== null
            ? this.toActiveProject(jsonSource.snapshot, "canonical_json")
            : sqliteState.kind === "single" && sqliteState.snapshot !== null
                ? this.toActiveProject(sqliteState.snapshot, "sqlite")
                : null;
        const storageMode = this.determineRuntimeBindingStorageMode({
            hasCanonicalJson,
            hasSqlite,
            writeLockInfo,
            jsonSource,
            jsonError,
            sqliteState,
            conflict
        });
        const normalizedJsonError = jsonError === null ? null : this.toInspectionError(jsonError);
        const normalizedSqliteError = sqliteState.kind === "unavailable" ? formatUnknownError(sqliteState.error) : null;
        return {
            workspaceRoot: this.workspaceRoot,
            routeledgerRoot: this.routeledgerRoot,
            processCwd: process.cwd(),
            workspaceConfigPath: this.workspaceConfigPath,
            dataRoot: this.dataRoot,
            routeledgerDir: this.routeledgerDir,
            jsonProjectPath: this.jsonProjectPath,
            sqliteDbPath: this.databasePath,
            sqliteReadModel: this.sqliteReadModel,
            storageMode,
            hasCanonicalJson,
            hasSqlite,
            activeProject,
            blockingIssue: this.toBlockingIssue({
                storageMode,
                jsonError: normalizedJsonError,
                sqliteError: normalizedSqliteError,
                conflict,
                sqliteState,
                writeLockInfo
            }),
            conflict,
            jsonError: normalizedJsonError,
            sqliteError: normalizedSqliteError,
            writeLock: writeLockInfo
        };
    }
    async loadJsonSourceIfPresentWithoutRecovery() {
        try {
            await fs.access(this.jsonProjectPath);
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return null;
            }
            throw error;
        }
        try {
            const documents = await this.readCanonicalDocumentsWithoutRecovery();
            const validation = validateRouteLedgerJsonDocuments(documents);
            if (!validation.valid) {
                throw new JsonFirstStorageError("JSON_SOURCE_INVALID", "JSON validate 发现错误", {
                    inputDir: this.routeledgerDir,
                    documentCount: documents.length,
                    valid: validation.valid,
                    issues: validation.issues
                });
            }
            return {
                snapshot: decodeProjectAggregateFromJsonDocuments(documents),
                documents,
                headRevision: this.computeHeadRevision(documents)
            };
        }
        catch (error) {
            if (error instanceof JsonFirstStorageError) {
                throw error;
            }
            throw new JsonFirstStorageError("JSON_SOURCE_INVALID", "JSON 文档集无法还原为 aggregate snapshot", {
                inputDir: this.routeledgerDir,
                error: formatUnknownError(error)
            });
        }
    }
    async loadJsonSourceIfPresent(writeLockOwnerId) {
        try {
            await fs.access(this.jsonProjectPath);
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return null;
            }
            throw error;
        }
        try {
            const loaded = await loadValidatedProjectAggregateFromJsonDirectory(this.dataRoot, {
                writeLockOwnerId
            });
            return {
                snapshot: loaded.snapshot,
                documents: loaded.documents,
                headRevision: this.computeHeadRevision(loaded.documents)
            };
        }
        catch (error) {
            if (error instanceof RouteLedgerJsonBusyError) {
                throw new JsonFirstStorageError("WRITE_IN_PROGRESS", error.message, {
                    workspaceRoot: this.workspaceRoot,
                    routeledgerRoot: this.routeledgerRoot,
                    ...error.details
                });
            }
            if (error instanceof RouteLedgerJsonImportError) {
                throw new JsonFirstStorageError("JSON_SOURCE_INVALID", error.message, error.details);
            }
            throw error;
        }
    }
    async assertNoBlockingConflict(jsonSource) {
        const sqliteState = await this.inspectSqliteState();
        const conflict = this.getBlockingConflict(jsonSource, sqliteState);
        if (conflict !== null) {
            throw new JsonFirstStorageError("JSON_SQLITE_CONFLICT", conflict.message, conflict.details);
        }
    }
    async rebuildSqliteReadModelIfNeeded(jsonSource) {
        if (this.sqliteReadModel === "disabled") {
            return;
        }
        const sqliteState = await this.inspectSqliteState();
        if (sqliteState.kind === "empty" || sqliteState.kind === "unavailable") {
            await this.syncJsonSnapshotToSqlite(jsonSource.snapshot);
            return;
        }
        if (sqliteState.kind !== "single" || sqliteState.projectId !== jsonSource.snapshot.project.id) {
            return;
        }
        if (sqliteState.snapshot === null) {
            await this.syncJsonSnapshotToSqlite(jsonSource.snapshot);
            return;
        }
        const sqliteDocuments = encodeProjectAggregateToJsonDocuments(sqliteState.snapshot);
        if (!documentSetsEqual(jsonSource.documents, sqliteDocuments)) {
            await this.syncJsonSnapshotToSqlite(jsonSource.snapshot);
        }
    }
    async inspectSqliteState(options) {
        if (options?.allowCreate === false && options.hasSqliteHint !== true) {
            return {
                kind: "empty"
            };
        }
        try {
            return await this.withSqliteAdapter(async (adapter) => {
                const rows = adapter.db
                    .prepare(`SELECT id, updated_at FROM projects ORDER BY id ASC`)
                    .all();
                if (rows.length === 0) {
                    return {
                        kind: "empty"
                    };
                }
                if (rows.length > 1) {
                    return {
                        kind: "multiple",
                        projectIds: rows.map((row) => row.id)
                    };
                }
                const row = rows[0];
                const snapshot = await adapter.loadProjectAggregate(row.id);
                return {
                    kind: "single",
                    projectId: row.id,
                    updatedAt: snapshot === null ? row.updated_at : getSnapshotFreshnessTimestamp(snapshot),
                    snapshot
                };
            });
        }
        catch (error) {
            return {
                kind: "unavailable",
                error
            };
        }
    }
    getBlockingConflict(jsonSource, sqliteState) {
        if (sqliteState.kind === "unavailable" || sqliteState.kind === "empty") {
            return null;
        }
        if (sqliteState.kind === "multiple") {
            return {
                message: "SQLite read model 包含多个 project，无法与单个 canonical JSON 真源对齐",
                details: {
                    canonicalProjectId: jsonSource.snapshot.project.id,
                    sqliteProjectIds: sqliteState.projectIds
                }
            };
        }
        if (sqliteState.projectId !== jsonSource.snapshot.project.id) {
            return {
                message: "canonical JSON 与 SQLite read model 指向不同 project",
                details: {
                    canonicalProjectId: jsonSource.snapshot.project.id,
                    sqliteProjectId: sqliteState.projectId
                }
            };
        }
        if (sqliteState.snapshot === null) {
            return null;
        }
        const sqliteDocuments = encodeProjectAggregateToJsonDocuments(sqliteState.snapshot);
        if (documentSetsEqual(jsonSource.documents, sqliteDocuments)) {
            return null;
        }
        if (sqliteState.updatedAt < getSnapshotFreshnessTimestamp(jsonSource.snapshot)) {
            return null;
        }
        return {
            message: "canonical JSON 与 SQLite read model 内容冲突，拒绝静默覆盖",
            details: {
                canonicalProjectId: jsonSource.snapshot.project.id,
                sqliteProjectId: sqliteState.projectId,
                canonicalUpdatedAt: jsonSource.snapshot.project.updatedAt,
                sqliteUpdatedAt: sqliteState.updatedAt,
                differingDocumentPaths: collectDocumentDiffPaths(jsonSource.documents, sqliteDocuments).slice(0, 20)
            }
        };
    }
    determineRuntimeBindingStorageMode(options) {
        if (options.writeLockInfo !== null || options.jsonError?.code === "WRITE_IN_PROGRESS") {
            return "write_in_progress";
        }
        if (options.jsonError?.code === "JSON_SOURCE_INVALID") {
            return "json_invalid";
        }
        if (this.sqliteReadModel === "disabled") {
            return options.jsonSource !== null ? "json" : "uninitialized";
        }
        if (options.conflict !== null || options.sqliteState.kind === "multiple") {
            return "conflict";
        }
        if (options.sqliteState.kind === "unavailable") {
            return options.hasSqlite || options.hasCanonicalJson ? "sqlite_unavailable" : "uninitialized";
        }
        if (options.jsonSource !== null) {
            return options.sqliteState.kind === "single" ? "json+sqlite" : "json";
        }
        if (options.sqliteState.kind === "single") {
            return "sqlite";
        }
        if (options.hasSqlite) {
            return "sqlite";
        }
        return "uninitialized";
    }
    toActiveProject(snapshot, source) {
        return {
            source,
            id: snapshot.project.id,
            name: snapshot.project.name,
            currentVersionId: snapshot.project.currentVersionId,
            contentLocale: snapshot.project.settings.contentLocale
        };
    }
    toInspectionError(error) {
        return {
            code: error.code,
            message: error.message,
            details: error.details ?? null
        };
    }
    toBlockingIssue(options) {
        if (options.storageMode === "json_invalid" && options.jsonError !== null) {
            return {
                kind: "canonical_json_invalid",
                source: "canonical_json",
                code: String(options.jsonError.code ?? "JSON_SOURCE_INVALID"),
                message: String(options.jsonError.message ?? "Canonical RouteLedger JSON is invalid."),
                details: options.jsonError.details !== null && typeof options.jsonError.details === "object"
                    ? options.jsonError.details
                    : null
            };
        }
        if (options.storageMode === "conflict") {
            if (options.conflict !== null) {
                return {
                    kind: "json_sqlite_divergence",
                    source: "sqlite_read_model",
                    code: "JSON_SQLITE_CONFLICT",
                    message: String(options.conflict.message ?? "Canonical JSON and SQLite differ."),
                    details: options.conflict.details !== null && typeof options.conflict.details === "object"
                        ? options.conflict.details
                        : null
                };
            }
            if (options.sqliteState.kind === "multiple") {
                return {
                    kind: "multiple_sqlite_projects",
                    source: "sqlite_read_model",
                    code: "MULTIPLE_SQLITE_PROJECTS",
                    message: "The SQLite read model contains multiple RouteLedger projects.",
                    details: { projectIds: options.sqliteState.projectIds }
                };
            }
        }
        if (options.storageMode === "sqlite_unavailable" && options.sqliteError !== null) {
            return {
                kind: "sqlite_read_model_unavailable",
                source: "sqlite_read_model",
                code: "SQLITE_READ_MODEL_UNAVAILABLE",
                message: String(options.sqliteError.message ?? "The SQLite read model is unavailable."),
                details: options.sqliteError
            };
        }
        if (options.storageMode === "write_in_progress") {
            return {
                kind: "write_in_progress",
                source: "writer_lock",
                code: "WRITE_IN_PROGRESS",
                message: "A canonical RouteLedger JSON write is in progress.",
                details: options.writeLockInfo
            };
        }
        return null;
    }
    async pathExists(candidatePath) {
        try {
            await fs.access(candidatePath);
            return true;
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return false;
            }
            throw error;
        }
    }
    async readCanonicalDocumentsWithoutRecovery() {
        const jsonRoot = this.routeledgerDir;
        const documents = [];
        const visit = async (directory, relativeDirectory) => {
            const entries = await fs.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
                if (entry.isDirectory()) {
                    const topLevelDirectory = relativePath.split("/")[0];
                    if (topLevelDirectory === "db" ||
                        topLevelDirectory === "views" ||
                        topLevelDirectory === "runtime" ||
                        topLevelDirectory === ".canonical-replace") {
                        continue;
                    }
                    await visit(path.join(directory, entry.name), relativePath);
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith(".json")) {
                    continue;
                }
                const documentPath = `${ROUTELEDGER_DIRECTORY}/${relativePath}`;
                if (!isCanonicalRouteLedgerJsonPath(documentPath)) {
                    continue;
                }
                documents.push({
                    path: documentPath,
                    content: await fs.readFile(path.join(directory, entry.name), "utf8")
                });
            }
        };
        await visit(jsonRoot, "");
        return documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
    }
    computeHeadRevision(documents) {
        const hash = createHash("sha256");
        for (const document of documents.slice().sort(compareByPath)) {
            hash.update(document.path, "utf8");
            hash.update("\n", "utf8");
            hash.update(document.content, "utf8");
            hash.update("\n---\n", "utf8");
        }
        return hash.digest("hex");
    }
    assertExpectedHeadRevision(options) {
        const expectedHeadRevision = getProjectAggregateHeadRevision(options.snapshot);
        if (expectedHeadRevision === undefined) {
            return;
        }
        if (expectedHeadRevision === null) {
            if (options.jsonSource === null) {
                return;
            }
            throw new JsonFirstStorageError("STALE_SNAPSHOT", "当前 canonical JSON head 已变化，拒绝用过期 snapshot 覆盖", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                projectId: options.snapshot.project.id,
                expectedHeadRevision,
                actualHeadRevision: options.jsonSource.headRevision
            });
        }
        if (options.jsonSource === null) {
            throw new JsonFirstStorageError("STALE_SNAPSHOT", "当前 canonical JSON head 已变化，拒绝用过期 snapshot 覆盖", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                projectId: options.snapshot.project.id,
                expectedHeadRevision,
                actualHeadRevision: null
            });
        }
        if (expectedHeadRevision !== options.jsonSource.headRevision) {
            throw new JsonFirstStorageError("STALE_SNAPSHOT", "当前 canonical JSON head 已变化，拒绝用过期 snapshot 覆盖", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                projectId: options.snapshot.project.id,
                expectedHeadRevision,
                actualHeadRevision: options.jsonSource.headRevision
            });
        }
    }
    async throwIfWriteInProgress() {
        const lockInfo = await getActiveRouteLedgerJsonWriteLockInfo(this.dataRoot);
        if (lockInfo !== null) {
            throw new JsonFirstStorageError("WRITE_IN_PROGRESS", "RouteLedger canonical JSON write is already in progress for this routeledgerRoot", {
                workspaceRoot: this.workspaceRoot,
                routeledgerRoot: this.routeledgerRoot,
                ...lockInfo
            });
        }
    }
    async acquireWriteLock(projectId) {
        try {
            const writerLock = await acquireRouteLedgerJsonWriteLock(this.dataRoot, {
                ownerId: randomUUID()
            });
            if (this.testHooks?.afterWriteLockAcquired !== undefined) {
                await this.testHooks.afterWriteLockAcquired({
                    workspaceRoot: this.workspaceRoot,
                    routeledgerRoot: this.routeledgerRoot,
                    projectId,
                    lockPath: writerLock.lockPath
                });
            }
            return writerLock;
        }
        catch (error) {
            if (error instanceof RouteLedgerJsonBusyError) {
                throw new JsonFirstStorageError("WRITE_IN_PROGRESS", error.message, {
                    workspaceRoot: this.workspaceRoot,
                    routeledgerRoot: this.routeledgerRoot,
                    ...error.details
                });
            }
            throw error;
        }
    }
    async syncJsonSnapshotToSqlite(snapshot) {
        try {
            await this.withSqliteAdapter((adapter) => adapter.saveProjectAggregate(snapshot));
            return;
        }
        catch (error) {
            await this.resetSqliteReadModelFiles();
            try {
                await this.withSqliteAdapter((adapter) => adapter.saveProjectAggregate(snapshot));
            }
            catch (syncError) {
                console.warn("[routeledger-mcp] failed to sync sqlite read model from canonical JSON", {
                    workspaceRoot: this.workspaceRoot,
                    routeledgerRoot: this.routeledgerRoot,
                    databasePath: this.databasePath,
                    initialError: formatUnknownError(error),
                    retryError: formatUnknownError(syncError)
                });
            }
        }
    }
    async resetSqliteReadModelFiles() {
        await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
        for (const candidatePath of [
            this.databasePath,
            `${this.databasePath}-wal`,
            `${this.databasePath}-shm`,
            `${this.databasePath}-journal`
        ]) {
            await fs.rm(candidatePath, { force: true });
        }
    }
    async withSqliteAdapter(callback) {
        if (this.sqliteReadModel === "disabled") {
            throw new Error("SQLite read model is disabled for this MCP runtime");
        }
        const sqliteModule = await import("../../sqlite/src/index.js");
        const adapter = new sqliteModule.SQLiteStorageAdapter({
            projectRoot: this.dataRoot
        });
        try {
            return await callback(adapter);
        }
        finally {
            adapter.close();
        }
    }
}
