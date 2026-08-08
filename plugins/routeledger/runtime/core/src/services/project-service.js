import { DomainError } from "../domain/errors.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { createDomainContext } from "./operation.js";
import { suspendVersion } from "./version-service.js";
import { isChineseLocale, requireConcreteContentLocale } from "../domain/locale.js";
const validateVersionId = (versionId) => {
    if (versionId === "0") {
        throw new DomainError("MISSING_REQUIRED_FIELD", "version_id 不允许使用 0", {
            versionId
        });
    }
};
export const createProject = ({ name, description = "", contentLocale, actor, deps }) => {
    const context = createDomainContext(deps, actor);
    const normalizedContentLocale = requireConcreteContentLocale(contentLocale);
    const projectId = deps.idGenerator.nextId();
    const initialVersionId = deps.idGenerator.nextId();
    validateVersionId(initialVersionId);
    const project = {
        id: projectId,
        name,
        description,
        status: "active",
        currentVersionId: initialVersionId,
        initialVersionId,
        createdBy: actor,
        createdAt: context.now,
        updatedAt: context.now,
        archivedAt: null,
        settings: {
            enforceStartGate: true,
            enforceCloseGate: true,
            contextBudgetBytes: 32768,
            contentLocale: normalizedContentLocale
        }
    };
    const initialVersion = {
        id: initialVersionId,
        projectId,
        title: isChineseLocale(normalizedContentLocale) ? "初始 Version" : "Initial Version",
        description: isChineseLocale(normalizedContentLocale)
            ? "项目初始化 Version"
            : "Project bootstrap version",
        state: "wait",
        parentVersionId: null,
        previousVersionId: null,
        nextVersionId: null,
        order: 1,
        isCurrent: true,
        createdBy: actor,
        createdAt: context.now,
        updatedAt: context.now,
        closedAt: null,
        stateReason: null
    };
    return {
        project,
        initialVersion,
        events: createTransitionEvents([
            {
                targetType: "project",
                targetId: project.id,
                eventType: "project.created"
            },
            {
                targetType: "version",
                targetId: initialVersion.id,
                eventType: "version.created",
                toState: initialVersion.state
            }
        ], {
            projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const setProjectContentLocale = ({ project, contentLocale, reason, actor, deps }) => {
    const normalizedContentLocale = requireConcreteContentLocale(contentLocale);
    const context = createDomainContext(deps, actor);
    const previousContentLocale = project.settings.contentLocale;
    const updatedProject = {
        ...project,
        settings: {
            ...project.settings,
            contentLocale: normalizedContentLocale
        },
        updatedAt: context.now
    };
    return {
        project: updatedProject,
        events: createTransitionEvents([
            {
                targetType: "project",
                targetId: project.id,
                eventType: "project.content_locale_changed",
                fromState: previousContentLocale,
                toState: normalizedContentLocale,
                note: reason,
                metadata: {
                    previousContentLocale,
                    contentLocale: normalizedContentLocale
                }
            }
        ], {
            projectId: project.id,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
export const setCurrentVersion = ({ project, currentVersion, nextVersion, actor, deps }) => {
    const context = createDomainContext(deps, actor);
    validateVersionId(nextVersion.id);
    if (nextVersion.projectId !== project.id) {
        throw new DomainError("PROJECT_VERSION_MISMATCH", "目标 version 不属于该 project", {
            projectId: project.id,
            versionId: nextVersion.id
        });
    }
    if (project.currentVersionId !== null) {
        if (currentVersion === null) {
            throw new DomainError("PROJECT_VERSION_MISMATCH", "project.current_version_id 非空时必须传入匹配的旧 current version", {
                projectId: project.id,
                currentVersionId: project.currentVersionId
            });
        }
        if (currentVersion.id !== project.currentVersionId) {
            throw new DomainError("PROJECT_VERSION_MISMATCH", "传入的旧 current version 与 project.current_version_id 不一致", {
                projectId: project.id,
                expectedVersionId: project.currentVersionId,
                actualVersionId: currentVersion.id
            });
        }
    }
    let updatedCurrentVersion = currentVersion;
    let events = [];
    if (currentVersion !== null) {
        if (currentVersion.projectId !== project.id) {
            throw new DomainError("PROJECT_VERSION_MISMATCH", "当前 version 不属于该 project", {
                projectId: project.id,
                versionId: currentVersion.id
            });
        }
        if (currentVersion.id !== nextVersion.id) {
            if (currentVersion.state === "running") {
                const suspended = suspendVersion(currentVersion, context, deps, "current version switched");
                updatedCurrentVersion = {
                    ...suspended.version,
                    isCurrent: false
                };
                events = events.concat(suspended.events);
            }
            else {
                updatedCurrentVersion = {
                    ...currentVersion,
                    isCurrent: false,
                    updatedAt: context.now
                };
            }
        }
    }
    const updatedNextVersion = {
        ...nextVersion,
        isCurrent: true,
        updatedAt: context.now
    };
    const updatedProject = {
        ...project,
        currentVersionId: nextVersion.id,
        updatedAt: context.now
    };
    const projectEvents = createTransitionEvents([
        {
            targetType: "project",
            targetId: project.id,
            eventType: "project.current_version_changed",
            fromState: project.currentVersionId,
            toState: nextVersion.id
        }
    ], {
        projectId: project.id,
        operationId: context.operationId,
        actor,
        now: context.now
    }, deps.idGenerator, {
        startSeq: events.length
    });
    return {
        project: updatedProject,
        currentVersion: updatedCurrentVersion,
        nextVersion: updatedNextVersion,
        events: events.concat(projectEvents)
    };
};
