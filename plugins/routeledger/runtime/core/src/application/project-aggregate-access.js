import { ApplicationError } from "./errors.js";
export const cloneProjectAggregateSnapshot = (snapshot) => {
    return structuredClone(snapshot);
};
export const loadRequiredProjectAggregate = async (storage, projectId) => {
    const snapshot = await storage.loadProjectAggregate(projectId);
    if (snapshot === null) {
        throw new ApplicationError("PROJECT_NOT_FOUND", "project 不存在", { projectId });
    }
    if (snapshot.project.id !== projectId) {
        throw new ApplicationError("PROJECT_OWNERSHIP_MISMATCH", "storage 返回的 project 与请求 project 不一致", { projectId, actualProjectId: snapshot.project.id });
    }
    return cloneProjectAggregateSnapshot(snapshot);
};
export const persistProjectAggregate = async (storage, snapshot) => {
    if (snapshot.project.settings.contentLocale === null) {
        throw new ApplicationError("CONTENT_LOCALE_REQUIRED", "Project content_locale is null. Confirm and set a concrete locale before writing project state.", { projectId: snapshot.project.id });
    }
    const committedRevision = await storage.saveProjectAggregate(snapshot);
    if (typeof committedRevision !== "string" || committedRevision.length === 0) {
        throw new ApplicationError("STORAGE_REVISION_INVALID", "storage 必须在成功保存后返回非空 aggregate revision", { projectId: snapshot.project.id });
    }
    snapshot.headRevision = committedRevision;
};
