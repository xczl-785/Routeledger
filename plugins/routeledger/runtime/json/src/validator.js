import path from "node:path";
import { canonicalizeLocale, collectConstraintInvariantViolations, collectDeferredItemInvariantViolations, validateWorkItemActive } from "../../core/src/index.js";
import { decodeProjectAggregateFromJsonDocumentsForValidation } from "./codec.js";
import { CURRENT_REF_DOCUMENT_PATH, PROJECT_DOCUMENT_PATH, ROUTELEDGER_JSON_ROOT, ROUTELEDGER_SCHEMA_VERSION, SCHEMA_DOCUMENT_PATH } from "./constants.js";
const KNOWN_DOCUMENT_PREFIXES = [
    `${ROUTELEDGER_JSON_ROOT}/versions/`,
    `${ROUTELEDGER_JSON_ROOT}/work_items/`,
    `${ROUTELEDGER_JSON_ROOT}/todos/`,
    `${ROUTELEDGER_JSON_ROOT}/undos/`,
    `${ROUTELEDGER_JSON_ROOT}/deferred_items/`,
    `${ROUTELEDGER_JSON_ROOT}/constraints/`,
    `${ROUTELEDGER_JSON_ROOT}/assets/`,
    `${ROUTELEDGER_JSON_ROOT}/events/`,
    `${ROUTELEDGER_JSON_ROOT}/pending_operations/`,
    `${ROUTELEDGER_JSON_ROOT}/approval_artifacts/`
];
const getDocumentContract = (documentPath) => {
    if (documentPath === PROJECT_DOCUMENT_PATH) {
        return {
            kind: "project",
            requireSchemaVersion: true
        };
    }
    if (documentPath === CURRENT_REF_DOCUMENT_PATH) {
        return {
            kind: "current_ref",
            requireSchemaVersion: true
        };
    }
    if (documentPath === SCHEMA_DOCUMENT_PATH) {
        return {
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/versions/`)) {
        return {
            kind: "version",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/work_items/`)) {
        return {
            kind: "work_item",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/todos/`)) {
        return {
            kind: "todo",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/undos/`)) {
        return {
            kind: "undo",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/deferred_items/`)) {
        return {
            kind: "deferred_item",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/constraints/`)) {
        return {
            kind: "constraint",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/assets/`)) {
        return {
            kind: "asset",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/events/`)) {
        return {
            kind: "transition_event",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/pending_operations/`)) {
        return {
            kind: "pending_operation",
            requireSchemaVersion: true
        };
    }
    if (documentPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/approval_artifacts/`)) {
        return {
            kind: "approval_artifact",
            requireSchemaVersion: true
        };
    }
    return undefined;
};
const compareByString = (left, right) => left.localeCompare(right, "en");
const createIssue = (severity, code, message, extras = {}) => ({
    severity,
    code,
    message,
    ...extras
});
const isKnownRouteLedgerJsonPath = (documentPath) => documentPath === PROJECT_DOCUMENT_PATH ||
    documentPath === CURRENT_REF_DOCUMENT_PATH ||
    documentPath === SCHEMA_DOCUMENT_PATH ||
    KNOWN_DOCUMENT_PREFIXES.some((prefix) => documentPath.startsWith(prefix));
const parseDocumentJson = (document) => {
    try {
        const parsed = JSON.parse(document.content);
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
            return {
                issue: createIssue("error", "JSON_DOCUMENT_INVALID", "JSON 文档顶层必须是对象", {
                    path: document.path
                })
            };
        }
        return {
            value: parsed
        };
    }
    catch (error) {
        return {
            issue: createIssue("error", "JSON_DOCUMENT_PARSE_FAILED", "JSON 文档解析失败", {
                path: document.path,
                details: {
                    error: error instanceof Error ? error.message : String(error)
                }
            })
        };
    }
};
const asString = (value) => typeof value === "string" ? value : undefined;
const asNullableString = (value) => value === null ? null : asString(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonBlankString = (value) => typeof value === "string" && value.trim().length > 0;
const isNullableString = (value) => value === null || typeof value === "string";
const hasValidJsonActorShape = (value) => isRecord(value) &&
    isNonBlankString(value.id) &&
    (value.type === "user" || value.type === "agent" || value.type === "system") &&
    (value.display_name === undefined || typeof value.display_name === "string");
const getIdPrefix = (id) => id.slice(0, 2).padEnd(2, "_");
const getSafePathId = (id) => typeof id === "string" && id.trim().length > 0 ? id : "invalid";
const getVersionPath = (id) => `${ROUTELEDGER_JSON_ROOT}/versions/${getIdPrefix(id)}/${id}.json`;
const getWorkItemPath = (id) => `${ROUTELEDGER_JSON_ROOT}/work_items/${getIdPrefix(id)}/${id}.json`;
const getTodoPath = (id) => `${ROUTELEDGER_JSON_ROOT}/todos/${getIdPrefix(id)}/${id}.json`;
const getUndoPath = (id) => `${ROUTELEDGER_JSON_ROOT}/undos/${getIdPrefix(id)}/${id}.json`;
const getDeferredItemPath = (id) => `${ROUTELEDGER_JSON_ROOT}/deferred_items/${getIdPrefix(id)}/${id}.json`;
const getConstraintPath = (id) => `${ROUTELEDGER_JSON_ROOT}/constraints/${getIdPrefix(id)}/${id}.json`;
const getAssetPath = (id) => `${ROUTELEDGER_JSON_ROOT}/assets/${getIdPrefix(id)}/${id}.json`;
const getPendingOperationPath = (id) => `${ROUTELEDGER_JSON_ROOT}/pending_operations/${getIdPrefix(id)}/${id}.json`;
const getApprovalArtifactPath = (id) => `${ROUTELEDGER_JSON_ROOT}/approval_artifacts/${getIdPrefix(id)}/${id}.json`;
const getEventPath = (event) => {
    const match = /^(\d{4})-(\d{2})/.exec(event.createdAt);
    if (match === null) {
        return `${ROUTELEDGER_JSON_ROOT}/events/unknown/${event.id}.json`;
    }
    const [, year, month] = match;
    return `${ROUTELEDGER_JSON_ROOT}/events/${year}/${month}/${event.id}.json`;
};
const sortKeysDeep = (value) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => sortKeysDeep(entry));
    }
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => compareByString(left, right))
            .map(([key, entry]) => [key, sortKeysDeep(entry)]));
    }
    return String(value);
};
const digestsMatch = (left, right) => left.algorithm === right.algorithm &&
    left.value === right.value &&
    JSON.stringify(sortKeysDeep(left.payload)) === JSON.stringify(sortKeysDeep(right.payload));
const validateProjectScope = (issues, projectId, records) => {
    for (const record of records) {
        if (record.projectId !== projectId) {
            issues.push(createIssue("error", "PROJECT_SCOPE_ID_MISMATCH", `${record.kind} 的 project_id 必须等于 root project id`, {
                path: record.path,
                details: {
                    recordKind: record.kind,
                    recordId: record.id,
                    projectId: record.projectId,
                    expectedProjectId: projectId
                }
            }));
        }
    }
};
const validateVersionReference = (issues, versionsById, version, field, jsonField, code) => {
    const targetId = version[field];
    if (targetId === null) {
        return;
    }
    if (targetId === version.id) {
        issues.push(createIssue("error", `${code}_SELF`, `${jsonField} 不能自指向`, {
            path: getVersionPath(version.id),
            details: {
                versionId: version.id,
                field: jsonField,
                targetId
            }
        }));
        return;
    }
    if (!versionsById.has(targetId)) {
        issues.push(createIssue("error", code, `${jsonField} 必须指向现有 version`, {
            path: getVersionPath(version.id),
            details: {
                versionId: version.id,
                field: jsonField,
                targetId
            }
        }));
    }
};
const validateVersionChainCycles = (issues, versions, versionsById, field, code) => {
    const reportedCycles = new Set();
    for (const version of versions) {
        const visited = new Map();
        let current = version;
        while (current !== undefined) {
            if (visited.has(current.id)) {
                const cycleIds = [...visited.keys()].slice(visited.get(current.id));
                const cycleKey = `${field}:${cycleIds.join("->")}`;
                if (!reportedCycles.has(cycleKey)) {
                    reportedCycles.add(cycleKey);
                    issues.push(createIssue("error", code, `${field} 引用链存在循环`, {
                        path: getVersionPath(version.id),
                        details: {
                            versionId: version.id,
                            cycle: [...cycleIds, current.id]
                        }
                    }));
                }
                break;
            }
            visited.set(current.id, visited.size);
            const nextId = current[field];
            if (nextId === null) {
                break;
            }
            current = versionsById.get(nextId);
        }
    }
};
const createVersionSiblingIssueDetails = (version, relatedVersion) => ({
    versionId: version.id,
    relatedVersionId: relatedVersion.id,
    projectId: version.projectId,
    relatedProjectId: relatedVersion.projectId,
    parentVersionId: version.parentVersionId,
    relatedParentVersionId: relatedVersion.parentVersionId
});
const validateVersionSiblingStructure = (issues, versions, versionsById) => {
    for (const version of versions) {
        const previousVersion = version.previousVersionId === null ? undefined : versionsById.get(version.previousVersionId);
        if (previousVersion !== undefined) {
            if (previousVersion.projectId !== version.projectId) {
                issues.push(createIssue("error", "VERSION_SIBLING_PROJECT_MISMATCH", "Version sibling 必须属于同一 project", {
                    path: getVersionPath(version.id),
                    details: {
                        ...createVersionSiblingIssueDetails(version, previousVersion),
                        field: "previous_version_id"
                    }
                }));
            }
            if (previousVersion.parentVersionId !== version.parentVersionId) {
                issues.push(createIssue("error", "VERSION_SIBLING_PARENT_MISMATCH", "Version sibling 必须属于同一 parent group", {
                    path: getVersionPath(version.id),
                    details: {
                        ...createVersionSiblingIssueDetails(version, previousVersion),
                        field: "previous_version_id"
                    }
                }));
            }
            if (previousVersion.nextVersionId !== version.id) {
                issues.push(createIssue("error", "VERSION_SIBLING_PREVIOUS_MISMATCH", "previous_version_id 与上游 sibling 的 next_version_id 必须双向一致", {
                    path: getVersionPath(version.id),
                    details: {
                        versionId: version.id,
                        previousVersionId: previousVersion.id,
                        previousNextVersionId: previousVersion.nextVersionId
                    }
                }));
            }
        }
        const nextVersion = version.nextVersionId === null ? undefined : versionsById.get(version.nextVersionId);
        if (nextVersion !== undefined) {
            if (nextVersion.projectId !== version.projectId) {
                issues.push(createIssue("error", "VERSION_SIBLING_PROJECT_MISMATCH", "Version sibling 必须属于同一 project", {
                    path: getVersionPath(version.id),
                    details: {
                        ...createVersionSiblingIssueDetails(version, nextVersion),
                        field: "next_version_id"
                    }
                }));
            }
            if (nextVersion.parentVersionId !== version.parentVersionId) {
                issues.push(createIssue("error", "VERSION_SIBLING_PARENT_MISMATCH", "Version sibling 必须属于同一 parent group", {
                    path: getVersionPath(version.id),
                    details: {
                        ...createVersionSiblingIssueDetails(version, nextVersion),
                        field: "next_version_id"
                    }
                }));
            }
            if (nextVersion.previousVersionId !== version.id) {
                issues.push(createIssue("error", "VERSION_SIBLING_NEXT_MISMATCH", "next_version_id 与下游 sibling 的 previous_version_id 必须双向一致", {
                    path: getVersionPath(version.id),
                    details: {
                        versionId: version.id,
                        nextVersionId: nextVersion.id,
                        nextPreviousVersionId: nextVersion.previousVersionId
                    }
                }));
            }
        }
    }
    const siblingGroupsByProject = new Map();
    for (const version of versions) {
        let siblingGroupsByParent = siblingGroupsByProject.get(version.projectId);
        if (siblingGroupsByParent === undefined) {
            siblingGroupsByParent = new Map();
            siblingGroupsByProject.set(version.projectId, siblingGroupsByParent);
        }
        const group = siblingGroupsByParent.get(version.parentVersionId);
        if (group === undefined) {
            siblingGroupsByParent.set(version.parentVersionId, [version]);
            continue;
        }
        group.push(version);
    }
    for (const siblingGroupsByParent of siblingGroupsByProject.values()) {
        for (const group of siblingGroupsByParent.values()) {
            if (group.length <= 1) {
                continue;
            }
            const siblingVersionIds = group.map((version) => version.id).sort(compareByString);
            const heads = group.filter((version) => version.previousVersionId === null);
            const tails = group.filter((version) => version.nextVersionId === null);
            const representative = [...group].sort((left, right) => compareByString(left.id, right.id))[0];
            if (heads.length !== 1) {
                issues.push(createIssue("error", "VERSION_SIBLING_HEAD_COUNT_INVALID", "同一 parent group 必须且只能有一个 sibling head", {
                    path: getVersionPath(representative.id),
                    details: {
                        projectId: representative.projectId,
                        parentVersionId: representative.parentVersionId,
                        siblingVersionIds,
                        headVersionIds: heads.map((version) => version.id).sort(compareByString)
                    }
                }));
            }
            if (tails.length !== 1) {
                issues.push(createIssue("error", "VERSION_SIBLING_TAIL_COUNT_INVALID", "同一 parent group 必须且只能有一个 sibling tail", {
                    path: getVersionPath(representative.id),
                    details: {
                        projectId: representative.projectId,
                        parentVersionId: representative.parentVersionId,
                        siblingVersionIds,
                        tailVersionIds: tails.map((version) => version.id).sort(compareByString)
                    }
                }));
            }
            const groupIds = new Set(group.map((version) => version.id));
            const visited = new Set();
            let current = heads.length === 1
                ? heads[0]
                : [...group].sort((left, right) => compareByString(left.id, right.id))[0];
            while (!visited.has(current.id)) {
                visited.add(current.id);
                if (current.nextVersionId === null) {
                    break;
                }
                const nextVersion = versionsById.get(current.nextVersionId);
                if (nextVersion === undefined ||
                    nextVersion.projectId !== current.projectId ||
                    nextVersion.parentVersionId !== current.parentVersionId ||
                    !groupIds.has(nextVersion.id)) {
                    break;
                }
                current = nextVersion;
            }
            if (visited.size !== group.length) {
                issues.push(createIssue("error", "VERSION_SIBLING_CHAIN_DISCONNECTED", "Version sibling 链必须覆盖同一 parent group 下的全部节点", {
                    path: getVersionPath(representative.id),
                    details: {
                        projectId: representative.projectId,
                        parentVersionId: representative.parentVersionId,
                        siblingVersionIds,
                        visitedVersionIds: [...visited].sort(compareByString),
                        missingVersionIds: siblingVersionIds.filter((versionId) => !visited.has(versionId))
                    }
                }));
            }
        }
    }
};
const validateNewEntityRawShape = (kind, record) => {
    if (kind === "deferred_item") {
        const requiredNonBlankFields = [
            "id",
            "project_id",
            "work_item_id",
            "origin_version_id",
            "target_review_version_id",
            "title",
            "reason",
            "created_at",
            "updated_at"
        ];
        const nullableStringFields = [
            "review_trigger",
            "resolution_reason",
            "resolution_note",
            "decision_ref",
            "activated_todo_id",
            "reviewed_at"
        ];
        return (requiredNonBlankFields.every((field) => isNonBlankString(record[field])) &&
            typeof record.description === "string" &&
            nullableStringFields.every((field) => isNullableString(record[field])) &&
            (record.status === "pending" ||
                record.status === "activated" ||
                record.status === "resolved") &&
            (record.resolution_outcome === null ||
                record.resolution_outcome === "activated" ||
                record.resolution_outcome === "superseded" ||
                record.resolution_outcome === "rejected" ||
                record.resolution_outcome === "out_of_scope") &&
            hasValidJsonActorShape(record.created_by));
    }
    const scope = record.scope;
    const scopeIsValid = isRecord(scope) &&
        ((scope.type === "project" && scope.version_id === undefined) ||
            (scope.type === "version" && isNonBlankString(scope.version_id)));
    return (isNonBlankString(record.id) &&
        isNonBlankString(record.project_id) &&
        isNonBlankString(record.rule) &&
        isNonBlankString(record.rationale) &&
        scopeIsValid &&
        (record.status === "active" || record.status === "retired") &&
        hasValidJsonActorShape(record.created_by) &&
        isNonBlankString(record.created_at) &&
        isNonBlankString(record.updated_at) &&
        isNullableString(record.retired_at) &&
        isNullableString(record.retire_reason) &&
        isNullableString(record.retire_note));
};
const validateDocumentContract = (issues, documentPath, record) => {
    const contract = getDocumentContract(documentPath);
    const issueCountBefore = issues.length;
    if (contract === undefined) {
        return true;
    }
    if (contract.kind !== undefined && record.kind !== contract.kind) {
        issues.push(createIssue("error", "JSON_DOCUMENT_KIND_INVALID", "JSON 文档 kind 与 canonical 路径类型不匹配", {
            path: documentPath,
            details: {
                expectedKind: contract.kind,
                actualKind: record.kind
            }
        }));
    }
    if (contract.requireSchemaVersion && record.schema_version !== ROUTELEDGER_SCHEMA_VERSION) {
        issues.push(createIssue("error", "JSON_DOCUMENT_SCHEMA_VERSION_INVALID", `JSON 文档 schema_version 必须等于 ${ROUTELEDGER_SCHEMA_VERSION}`, {
            path: documentPath,
            details: {
                expectedSchemaVersion: ROUTELEDGER_SCHEMA_VERSION,
                actualSchemaVersion: record.schema_version
            }
        }));
    }
    const recordId = asString(record.id);
    if (recordId !== undefined &&
        ((contract.kind === "deferred_item" &&
            documentPath !== getDeferredItemPath(recordId)) ||
            (contract.kind === "constraint" &&
                documentPath !== getConstraintPath(recordId)))) {
        issues.push(createIssue("error", "JSON_DOCUMENT_PATH_INVALID", "JSON 文档路径必须由 kind 与 id 唯一确定", {
            path: documentPath,
            details: {
                kind: contract.kind,
                id: recordId,
                expectedPath: contract.kind === "deferred_item"
                    ? getDeferredItemPath(recordId)
                    : getConstraintPath(recordId)
            }
        }));
    }
    if ((contract.kind === "deferred_item" || contract.kind === "constraint") &&
        !validateNewEntityRawShape(contract.kind, record)) {
        issues.push(createIssue("error", "JSON_DOCUMENT_SHAPE_INVALID", `${contract.kind} JSON 文档字段类型、必填值或枚举无效`, {
            path: documentPath,
            details: {
                kind: contract.kind
            }
        }));
    }
    return issues.length === issueCountBefore;
};
const isUnsafeAbsolutePath = (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
const isUnsafeRelativePath = (value) => {
    if (value.trim().length === 0 || isUnsafeAbsolutePath(value)) {
        return true;
    }
    const segments = value.split(/[\\/]+/);
    if (segments.includes("..")) {
        return true;
    }
    const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
    return normalized === "." || normalized.startsWith("../");
};
const validateAssetRelativePath = (issues, assetId, documentPath, value, field) => {
    if (isUnsafeRelativePath(value)) {
        issues.push(createIssue("error", "ASSET_RELATIVE_PATH_INVALID", `${field} 必须是 project_root 下的非空相对路径`, {
            path: documentPath,
            details: {
                assetId,
                field,
                relativePath: value
            }
        }));
    }
};
const validateTransitionTarget = (issues, projectId, event, versionsById, workItemsById, todosById, undosById, deferredItemsById, constraintsById, assetsById, pendingOperationsById, approvalArtifactsById) => {
    const exists = (event.targetType === "project" && event.targetId === projectId) ||
        (event.targetType === "version" && versionsById.has(event.targetId)) ||
        (event.targetType === "work_item" && workItemsById.has(event.targetId)) ||
        (event.targetType === "todo" && todosById.has(event.targetId)) ||
        (event.targetType === "undo" && undosById.has(event.targetId)) ||
        (event.targetType === "deferred_item" && deferredItemsById.has(event.targetId)) ||
        (event.targetType === "constraint" && constraintsById.has(event.targetId)) ||
        (event.targetType === "asset" && assetsById.has(event.targetId)) ||
        (event.targetType === "pending_operation" && pendingOperationsById.has(event.targetId)) ||
        (event.targetType === "approval_artifact" && approvalArtifactsById.has(event.targetId));
    if (!exists) {
        issues.push(createIssue("error", "TRANSITION_EVENT_TARGET_NOT_FOUND", "TransitionEvent target 必须指向现有对象", {
            path: getEventPath(event),
            details: {
                eventId: event.id,
                targetType: event.targetType,
                targetId: event.targetId
            }
        }));
    }
};
export const validateProjectAggregateSnapshot = (snapshot, options = {}) => {
    const issues = [];
    const rawSnapshot = snapshot;
    if (!isRecord(rawSnapshot) || !isRecord(rawSnapshot.project)) {
        return {
            valid: false,
            issues: [
                createIssue("error", "AGGREGATE_SHAPE_INVALID", "ProjectAggregateSnapshot 顶层与 project 必须是对象")
            ]
        };
    }
    const collectionNames = [
        "versions",
        "workItems",
        "todos",
        "undos",
        "deferredItems",
        "constraints",
        "assets",
        "events",
        "pendingOperations",
        "approvalArtifacts"
    ];
    for (const collectionName of collectionNames) {
        if (!Array.isArray(rawSnapshot[collectionName])) {
            issues.push(createIssue("error", "AGGREGATE_COLLECTION_INVALID", `ProjectAggregateSnapshot.${collectionName} 必须是数组`, {
                details: {
                    collection: collectionName
                }
            }));
        }
    }
    if (issues.length > 0) {
        return {
            valid: false,
            issues
        };
    }
    if (!isNonBlankString(rawSnapshot.project.id) ||
        (rawSnapshot.project.initialVersionId !== null &&
            !isNonBlankString(rawSnapshot.project.initialVersionId)) ||
        (rawSnapshot.project.currentVersionId !== null &&
            !isNonBlankString(rawSnapshot.project.currentVersionId))) {
        return {
            valid: false,
            issues: [
                createIssue("error", "AGGREGATE_SHAPE_INVALID", "ProjectAggregateSnapshot.project 的关键 id 字段无效", {
                    path: PROJECT_DOCUMENT_PATH
                })
            ]
        };
    }
    const legacyEntityCollections = [
        ["versions", snapshot.versions],
        ["workItems", snapshot.workItems],
        ["todos", snapshot.todos],
        ["undos", snapshot.undos],
        ["assets", snapshot.assets],
        ["events", snapshot.events],
        ["pendingOperations", snapshot.pendingOperations],
        ["approvalArtifacts", snapshot.approvalArtifacts]
    ];
    for (const [collectionName, entities] of legacyEntityCollections) {
        for (const entity of entities) {
            if (!isRecord(entity) || !isNonBlankString(entity.id)) {
                issues.push(createIssue("error", "AGGREGATE_ENTITY_ID_INVALID", `ProjectAggregateSnapshot.${collectionName} 中的实体 id 必须是非空字符串`, {
                    details: {
                        collection: collectionName
                    }
                }));
            }
        }
    }
    if (issues.length > 0) {
        return {
            valid: false,
            issues
        };
    }
    const { project } = snapshot;
    if (project.settings.contentLocale === null) {
        issues.push(createIssue("warning", "PROJECT_CONTENT_LOCALE_UNRESOLVED", "Project.settings.content_locale 尚未确认；项目保持可读，但写操作必须先设置具体 locale。", { path: PROJECT_DOCUMENT_PATH, details: { projectId: project.id } }));
    }
    else {
        try {
            canonicalizeLocale(project.settings.contentLocale);
        }
        catch (error) {
            issues.push(createIssue("error", "PROJECT_CONTENT_LOCALE_INVALID", "Project.settings.content_locale 必须是具体且有效的 BCP 47 locale。", {
                path: PROJECT_DOCUMENT_PATH,
                details: {
                    projectId: project.id,
                    contentLocale: project.settings.contentLocale,
                    error: error instanceof Error ? error.message : String(error)
                }
            }));
        }
    }
    const versionsById = new Map(snapshot.versions.map((version) => [version.id, version]));
    const workItemsById = new Map(snapshot.workItems.map((workItem) => [workItem.id, workItem]));
    const todosById = new Map(snapshot.todos.map((todo) => [todo.id, todo]));
    const undosById = new Map(snapshot.undos.map((undo) => [undo.id, undo]));
    const deferredItemsById = new Map(snapshot.deferredItems.map((deferredItem) => [deferredItem.id, deferredItem]));
    const constraintsById = new Map(snapshot.constraints.map((constraint) => [constraint.id, constraint]));
    const assetsById = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
    const pendingOperationsById = new Map(snapshot.pendingOperations.map((operation) => [operation.id, operation]));
    const approvalArtifactsById = new Map(snapshot.approvalArtifacts.map((artifact) => [artifact.id, artifact]));
    if (project.currentVersionId === null && snapshot.versions.length > 0) {
        issues.push(createIssue("error", "PROJECT_CURRENT_VERSION_MISSING", "Project.current_version_id 不能为空", {
            path: PROJECT_DOCUMENT_PATH,
            details: {
                projectId: project.id
            }
        }));
    }
    else if (project.currentVersionId !== null && !versionsById.has(project.currentVersionId)) {
        issues.push(createIssue("error", "PROJECT_CURRENT_VERSION_NOT_FOUND", "Project.current_version_id 必须指向现有 version", {
            path: PROJECT_DOCUMENT_PATH,
            details: {
                projectId: project.id,
                currentVersionId: project.currentVersionId
            }
        }));
    }
    if (project.initialVersionId !== null && !versionsById.has(project.initialVersionId)) {
        issues.push(createIssue("error", "PROJECT_INITIAL_VERSION_NOT_FOUND", "Project.initial_version_id 必须指向现有 version", {
            path: PROJECT_DOCUMENT_PATH,
            details: {
                projectId: project.id,
                initialVersionId: project.initialVersionId
            }
        }));
    }
    if (options.currentRef !== undefined) {
        if (options.currentRef.projectId !== project.id) {
            issues.push(createIssue("error", "CURRENT_REF_PROJECT_MISMATCH", "refs/current.json 的 project_id 必须与 project.json 一致", {
                path: options.currentRef.path,
                details: {
                    projectId: options.currentRef.projectId,
                    expectedProjectId: project.id
                }
            }));
        }
        if (options.currentRef.currentVersionId !== project.currentVersionId) {
            issues.push(createIssue("error", "CURRENT_REF_OUT_OF_SYNC", "refs/current.json 必须镜像 project.current_version_id", {
                path: options.currentRef.path,
                details: {
                    currentVersionId: options.currentRef.currentVersionId,
                    expectedCurrentVersionId: project.currentVersionId
                }
            }));
        }
    }
    for (const version of snapshot.versions) {
        const expectedIsCurrent = project.currentVersionId !== null && version.id === project.currentVersionId;
        if (version.isCurrent !== expectedIsCurrent) {
            issues.push(createIssue("error", "VERSION_IS_CURRENT_MISMATCH", "Version.is_current 是镜像字段，必须与 project.current_version_id 一致", {
                path: getVersionPath(version.id),
                details: {
                    versionId: version.id,
                    isCurrent: version.isCurrent,
                    expectedIsCurrent
                }
            }));
        }
        validateVersionReference(issues, versionsById, version, "parentVersionId", "parent_version_id", "VERSION_PARENT_NOT_FOUND");
        validateVersionReference(issues, versionsById, version, "previousVersionId", "previous_version_id", "VERSION_PREVIOUS_NOT_FOUND");
        validateVersionReference(issues, versionsById, version, "nextVersionId", "next_version_id", "VERSION_NEXT_NOT_FOUND");
    }
    validateVersionChainCycles(issues, snapshot.versions, versionsById, "parentVersionId", "VERSION_PARENT_CYCLE");
    validateVersionChainCycles(issues, snapshot.versions, versionsById, "previousVersionId", "VERSION_PREVIOUS_CYCLE");
    validateVersionChainCycles(issues, snapshot.versions, versionsById, "nextVersionId", "VERSION_NEXT_CYCLE");
    validateVersionSiblingStructure(issues, snapshot.versions, versionsById);
    for (const workItem of snapshot.workItems) {
        try {
            validateWorkItemActive(workItem, snapshot.todos, snapshot.undos, snapshot.deferredItems);
        }
        catch (error) {
            issues.push(createIssue("error", "WORK_ITEM_ACTIVE_INVALID", "WorkItem active 指针语义无效", {
                path: getWorkItemPath(workItem.id),
                details: {
                    workItemId: workItem.id,
                    error: error instanceof Error ? error.message : String(error)
                }
            }));
        }
    }
    for (const todo of snapshot.todos) {
        if (!workItemsById.has(todo.workItemId)) {
            issues.push(createIssue("error", "TODO_WORK_ITEM_NOT_FOUND", "Todo.work_item_id 必须指向现有 WorkItem", {
                path: getTodoPath(todo.id),
                details: {
                    todoId: todo.id,
                    workItemId: todo.workItemId
                }
            }));
        }
        if (!versionsById.has(todo.versionId)) {
            issues.push(createIssue("error", "TODO_VERSION_NOT_FOUND", "Todo.version_id 必须指向现有 version", {
                path: getTodoPath(todo.id),
                details: {
                    todoId: todo.id,
                    versionId: todo.versionId
                }
            }));
        }
    }
    for (const undo of snapshot.undos) {
        if (!workItemsById.has(undo.workItemId)) {
            issues.push(createIssue("error", "UNDO_WORK_ITEM_NOT_FOUND", "Undo.work_item_id 必须指向现有 WorkItem", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    workItemId: undo.workItemId
                }
            }));
        }
        if (!versionsById.has(undo.versionId)) {
            issues.push(createIssue("error", "UNDO_VERSION_NOT_FOUND", "Undo.version_id 必须指向现有 version", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    versionId: undo.versionId
                }
            }));
        }
        if (undo.originVersionId.trim().length === 0) {
            issues.push(createIssue("error", "UNDO_ORIGIN_VERSION_MISSING", "Undo 必须包含 origin_version_id", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id
                }
            }));
        }
        else if (!versionsById.has(undo.originVersionId)) {
            issues.push(createIssue("error", "UNDO_ORIGIN_VERSION_NOT_FOUND", "Undo.origin_version_id 必须指向现有 version", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    originVersionId: undo.originVersionId
                }
            }));
        }
        if (undo.preferredResolutionVersionId.trim().length === 0) {
            issues.push(createIssue("error", "UNDO_PREFERRED_RESOLUTION_VERSION_MISSING", "Undo 必须包含 preferred_resolution_version_id", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id
                }
            }));
        }
        else if (!versionsById.has(undo.preferredResolutionVersionId)) {
            issues.push(createIssue("error", "UNDO_PREFERRED_RESOLUTION_VERSION_NOT_FOUND", "Undo.preferred_resolution_version_id 必须指向现有 version", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    preferredResolutionVersionId: undo.preferredResolutionVersionId
                }
            }));
        }
        if (undo.carriedForwardAt === null && undo.carriedForwardToVersionId !== null) {
            issues.push(createIssue("error", "UNDO_CARRIED_FORWARD_TIMESTAMP_MISSING", "Undo.carried_forward_to_version_id 存在时必须同时提供 carried_forward_at", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    carriedForwardToVersionId: undo.carriedForwardToVersionId
                }
            }));
        }
        if (undo.carriedForwardAt !== null && undo.carriedForwardToVersionId === null) {
            issues.push(createIssue("error", "UNDO_CARRIED_FORWARD_TARGET_MISSING", "Undo.carried_forward_at 存在时必须同时提供 carried_forward_to_version_id", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    carriedForwardAt: undo.carriedForwardAt
                }
            }));
        }
        if (undo.carriedForwardToVersionId !== null &&
            !versionsById.has(undo.carriedForwardToVersionId)) {
            issues.push(createIssue("error", "UNDO_CARRIED_FORWARD_TARGET_NOT_FOUND", "Undo.carried_forward_to_version_id 必须指向现有 version", {
                path: getUndoPath(undo.id),
                details: {
                    undoId: undo.id,
                    carriedForwardToVersionId: undo.carriedForwardToVersionId
                }
            }));
        }
    }
    for (const deferredItem of snapshot.deferredItems) {
        const invariantViolations = collectDeferredItemInvariantViolations(deferredItem, snapshot.todos);
        const deferredPath = getDeferredItemPath(typeof deferredItem.id === "string" ? deferredItem.id : "invalid");
        for (const violation of invariantViolations) {
            issues.push(createIssue("error", violation.code, violation.message, {
                path: deferredPath,
                details: {
                    deferredItemId: typeof deferredItem.id === "string" ? deferredItem.id : null
                }
            }));
        }
        if (invariantViolations.some((violation) => violation.code === "DEFERRED_SHAPE_INVALID")) {
            continue;
        }
        if (!workItemsById.has(deferredItem.workItemId)) {
            issues.push(createIssue("error", "DEFERRED_WORK_ITEM_NOT_FOUND", "DeferredItem.work_item_id 必须指向现有 WorkItem", {
                path: deferredPath,
                details: {
                    deferredItemId: deferredItem.id,
                    workItemId: deferredItem.workItemId
                }
            }));
        }
        if (!versionsById.has(deferredItem.originVersionId)) {
            issues.push(createIssue("error", "DEFERRED_ORIGIN_VERSION_NOT_FOUND", "DeferredItem.origin_version_id 必须指向现有 version", {
                path: deferredPath,
                details: {
                    deferredItemId: deferredItem.id,
                    originVersionId: deferredItem.originVersionId
                }
            }));
        }
        if (!versionsById.has(deferredItem.targetReviewVersionId)) {
            issues.push(createIssue("error", "DEFERRED_TARGET_REVIEW_VERSION_NOT_FOUND", "DeferredItem.target_review_version_id 必须指向现有 version", {
                path: deferredPath,
                details: {
                    deferredItemId: deferredItem.id,
                    targetReviewVersionId: deferredItem.targetReviewVersionId
                }
            }));
        }
    }
    for (const constraint of snapshot.constraints) {
        const invariantViolations = collectConstraintInvariantViolations(constraint);
        const constraintPath = getConstraintPath(typeof constraint.id === "string" ? constraint.id : "invalid");
        for (const violation of invariantViolations) {
            issues.push(createIssue("error", violation.code, violation.message, {
                path: constraintPath,
                details: {
                    constraintId: typeof constraint.id === "string" ? constraint.id : null
                }
            }));
        }
        if (invariantViolations.some((violation) => violation.code === "CONSTRAINT_SHAPE_INVALID")) {
            continue;
        }
        if (constraint.scope.type === "version" &&
            !versionsById.has(constraint.scope.versionId)) {
            issues.push(createIssue("error", "CONSTRAINT_SCOPE_VERSION_NOT_FOUND", "version-scoped Constraint 必须指向现有 version", {
                path: constraintPath,
                details: {
                    constraintId: constraint.id,
                    versionId: constraint.scope.versionId
                }
            }));
        }
    }
    for (const asset of snapshot.assets) {
        const assetPath = getAssetPath(asset.id);
        if (asset.pathBase !== "project_root") {
            issues.push(createIssue("error", "ASSET_PATH_BASE_UNSUPPORTED", "Asset.path_base 只允许 project_root", {
                path: assetPath,
                details: {
                    assetId: asset.id,
                    pathBase: asset.pathBase
                }
            }));
        }
        validateAssetRelativePath(issues, asset.id, assetPath, asset.relativePath, "relative_path");
        asset.pathHistory.forEach((entry, index) => {
            if (entry.pathBase !== "project_root") {
                issues.push(createIssue("error", "ASSET_PATH_HISTORY_BASE_UNSUPPORTED", "Asset.path_history 只允许 project_root", {
                    path: assetPath,
                    details: {
                        assetId: asset.id,
                        entryIndex: index,
                        pathBase: entry.pathBase
                    }
                }));
            }
            validateAssetRelativePath(issues, asset.id, assetPath, entry.relativePath, `path_history[${index}].relative_path`);
        });
        for (const workItemId of asset.workItemIds) {
            if (!workItemsById.has(workItemId)) {
                issues.push(createIssue("error", "ASSET_WORK_ITEM_NOT_FOUND", "Asset.work_item_ids 必须指向现有 WorkItem", {
                    path: assetPath,
                    details: {
                        assetId: asset.id,
                        workItemId
                    }
                }));
            }
        }
    }
    for (const event of snapshot.events) {
        validateTransitionTarget(issues, project.id, event, versionsById, workItemsById, todosById, undosById, deferredItemsById, constraintsById, assetsById, pendingOperationsById, approvalArtifactsById);
    }
    for (const operation of snapshot.pendingOperations) {
        if (operation.approvalArtifactId !== null) {
            const artifact = approvalArtifactsById.get(operation.approvalArtifactId);
            if (artifact === undefined) {
                issues.push(createIssue("error", "PENDING_OPERATION_APPROVAL_NOT_FOUND", "PendingOperation.approval_artifact_id 必须指向现有 approval artifact", {
                    path: getPendingOperationPath(operation.id),
                    details: {
                        pendingOperationId: operation.id,
                        approvalArtifactId: operation.approvalArtifactId
                    }
                }));
            }
            else if (artifact.projectId !== operation.projectId ||
                artifact.actionType !== operation.actionType ||
                artifact.targetId !== operation.targetId ||
                !digestsMatch(artifact.digest, operation.digest)) {
                issues.push(createIssue("error", "PENDING_APPROVAL_MISMATCH", "PendingOperation 与 ApprovalArtifact 的 project/action/target/digest 必须匹配", {
                    path: getPendingOperationPath(operation.id),
                    details: {
                        pendingOperationId: operation.id,
                        approvalArtifactId: artifact.id
                    }
                }));
            }
        }
    }
    for (const artifact of snapshot.approvalArtifacts) {
        const operation = pendingOperationsById.get(artifact.pendingOperationId);
        if (operation === undefined) {
            issues.push(createIssue("error", "APPROVAL_ARTIFACT_PENDING_OPERATION_NOT_FOUND", "ApprovalArtifact.pending_operation_id 必须指向现有 pending operation", {
                path: getApprovalArtifactPath(artifact.id),
                details: {
                    approvalArtifactId: artifact.id,
                    pendingOperationId: artifact.pendingOperationId
                }
            }));
            continue;
        }
        if (operation.projectId !== artifact.projectId ||
            operation.actionType !== artifact.actionType ||
            operation.targetId !== artifact.targetId ||
            !digestsMatch(operation.digest, artifact.digest)) {
            issues.push(createIssue("error", "APPROVAL_ARTIFACT_MISMATCH", "ApprovalArtifact 与 PendingOperation 的 project/action/target/digest 必须匹配", {
                path: getApprovalArtifactPath(artifact.id),
                details: {
                    approvalArtifactId: artifact.id,
                    pendingOperationId: operation.id
                }
            }));
        }
    }
    const operationEventKeys = new Map();
    for (const event of snapshot.events) {
        const operationKey = `${event.operationId}::${event.operationSeq}`;
        const previous = operationEventKeys.get(operationKey);
        if (previous !== undefined) {
            issues.push(createIssue("error", "OPERATION_EVENT_SEQ_DUPLICATE", "同一 operation_id + operation_seq 不应重复", {
                path: getEventPath(event),
                details: {
                    eventId: event.id,
                    previousEventId: previous.id,
                    operationId: event.operationId,
                    operationSeq: event.operationSeq
                }
            }));
            continue;
        }
        operationEventKeys.set(operationKey, event);
    }
    validateProjectScope(issues, project.id, [
        ...snapshot.versions.map((version) => ({
            kind: "version",
            id: version.id,
            projectId: version.projectId,
            path: getVersionPath(version.id)
        })),
        ...snapshot.workItems.map((workItem) => ({
            kind: "work_item",
            id: workItem.id,
            projectId: workItem.projectId,
            path: getWorkItemPath(workItem.id)
        })),
        ...snapshot.todos.map((todo) => ({
            kind: "todo",
            id: todo.id,
            projectId: todo.projectId,
            path: getTodoPath(todo.id)
        })),
        ...snapshot.undos.map((undo) => ({
            kind: "undo",
            id: undo.id,
            projectId: undo.projectId,
            path: getUndoPath(undo.id)
        })),
        ...snapshot.deferredItems.map((deferredItem) => ({
            kind: "deferred_item",
            id: deferredItem.id,
            projectId: deferredItem.projectId,
            path: getDeferredItemPath(getSafePathId(deferredItem.id))
        })),
        ...snapshot.constraints.map((constraint) => ({
            kind: "constraint",
            id: constraint.id,
            projectId: constraint.projectId,
            path: getConstraintPath(getSafePathId(constraint.id))
        })),
        ...snapshot.assets.map((asset) => ({
            kind: "asset",
            id: asset.id,
            projectId: asset.projectId,
            path: getAssetPath(asset.id)
        })),
        ...snapshot.events.map((event) => ({
            kind: "transition_event",
            id: event.id,
            projectId: event.projectId,
            path: getEventPath(event)
        })),
        ...snapshot.pendingOperations.map((operation) => ({
            kind: "pending_operation",
            id: operation.id,
            projectId: operation.projectId,
            path: getPendingOperationPath(operation.id)
        })),
        ...snapshot.approvalArtifacts.map((artifact) => ({
            kind: "approval_artifact",
            id: artifact.id,
            projectId: artifact.projectId,
            path: getApprovalArtifactPath(artifact.id)
        }))
    ]);
    return {
        valid: !issues.some((issue) => issue.severity === "error"),
        issues
    };
};
export const validateRouteLedgerJsonDocuments = (documents) => {
    const issues = [];
    const parsedDocuments = new Map();
    const knownDocuments = [];
    for (const document of documents) {
        if (!isKnownRouteLedgerJsonPath(document.path)) {
            continue;
        }
        knownDocuments.push(document);
        const parsed = parseDocumentJson(document);
        if (parsed.issue !== undefined) {
            issues.push(parsed.issue);
            continue;
        }
        const contractValid = validateDocumentContract(issues, document.path, parsed.value);
        if (contractValid ||
            (!document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/deferred_items/`) &&
                !document.path.startsWith(`${ROUTELEDGER_JSON_ROOT}/constraints/`))) {
            parsedDocuments.set(document.path, parsed.value);
        }
    }
    const projectRecord = parsedDocuments.get(PROJECT_DOCUMENT_PATH);
    if (projectRecord === undefined) {
        issues.push(createIssue("error", "JSON_DOCUMENT_MISSING", "缺少 .routeledger/project.json", {
            path: PROJECT_DOCUMENT_PATH
        }));
    }
    const currentRefRecord = parsedDocuments.get(CURRENT_REF_DOCUMENT_PATH);
    if (currentRefRecord === undefined) {
        issues.push(createIssue("error", "JSON_DOCUMENT_MISSING", "缺少 .routeledger/refs/current.json", {
            path: CURRENT_REF_DOCUMENT_PATH
        }));
    }
    const currentRef = currentRefRecord === undefined
        ? undefined
        : {
            path: CURRENT_REF_DOCUMENT_PATH,
            projectId: asString(currentRefRecord.project_id),
            currentVersionId: asNullableString(currentRefRecord.current_version_id)
        };
    const projectId = projectRecord === undefined ? undefined : asString(projectRecord.id);
    const projectCurrentVersionId = projectRecord === undefined ? undefined : asNullableString(projectRecord.current_version_id);
    if (projectRecord !== undefined && projectId === undefined) {
        issues.push(createIssue("error", "JSON_DOCUMENT_INVALID", "project.json 缺少有效 id", {
            path: PROJECT_DOCUMENT_PATH
        }));
    }
    const syntheticCurrentRefDocument = projectId === undefined
        ? undefined
        : {
            path: CURRENT_REF_DOCUMENT_PATH,
            content: `${JSON.stringify({
                schema_version: typeof projectRecord?.schema_version === "number"
                    ? projectRecord.schema_version
                    : ROUTELEDGER_SCHEMA_VERSION,
                kind: "current_ref",
                project_id: projectId,
                current_version_id: projectCurrentVersionId ?? null
            }, null, 2)}\n`
        };
    let snapshot;
    if (projectRecord !== undefined && syntheticCurrentRefDocument !== undefined) {
        try {
            snapshot = decodeProjectAggregateFromJsonDocumentsForValidation([
                ...knownDocuments.filter((document) => document.path !== CURRENT_REF_DOCUMENT_PATH && parsedDocuments.has(document.path)),
                syntheticCurrentRefDocument
            ].sort((left, right) => compareByString(left.path, right.path)));
        }
        catch (error) {
            issues.push(createIssue("error", "JSON_DECODE_FAILED", "JSON 文档集无法还原为 aggregate snapshot", {
                details: {
                    error: error instanceof Error ? error.message : String(error)
                }
            }));
        }
    }
    if (snapshot !== undefined) {
        const validation = validateProjectAggregateSnapshot(snapshot, {
            currentRef
        });
        issues.push(...validation.issues);
    }
    return {
        valid: !issues.some((issue) => issue.severity === "error"),
        issues
    };
};
