import { DomainError } from "../domain/errors.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { createDomainContext } from "./operation.js";
import { suspendVersion } from "./version-service.js";
import { requireConcreteContentLocale } from "../domain/locale.js";
const validateVersionId = (versionId) => {
    if (versionId === "0") {
        throw new DomainError("MISSING_REQUIRED_FIELD", "version_id 不允许使用 0", {
            versionId
        });
    }
};
export const createProject = ({ name, description = "", contentLocale, firstVersion, actor, deps }) => {
    const context = createDomainContext(deps, actor);
    const normalizedContentLocale = requireConcreteContentLocale(contentLocale);
    const requestedFirstVersion = firstVersion ?? null;
    const normalizedFirstVersion = requestedFirstVersion === null
        ? undefined
        : {
            title: requestedFirstVersion.title.trim(),
            description: requestedFirstVersion.description?.trim() ?? ""
        };
    if (normalizedFirstVersion !== undefined && normalizedFirstVersion.title.length === 0) {
        throw new DomainError("MISSING_REQUIRED_FIELD", "firstVersion.title 不能为空", {
            field: "firstVersion.title"
        });
    }
    const projectId = deps.idGenerator.nextId();
    const firstVersionId = normalizedFirstVersion === undefined ? null : deps.idGenerator.nextId();
    if (firstVersionId !== null) {
        validateVersionId(firstVersionId);
    }
    const project = {
        id: projectId,
        name,
        description,
        status: "active",
        currentVersionId: firstVersionId,
        initialVersionId: null,
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
    const createdFirstVersion = firstVersionId === null || normalizedFirstVersion === undefined
        ? null
        : {
            id: firstVersionId,
            projectId,
            title: normalizedFirstVersion.title,
            description: normalizedFirstVersion.description,
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
    const eventDrafts = [
        {
            targetType: "project",
            targetId: project.id,
            eventType: "project.created"
        }
    ];
    if (createdFirstVersion !== null) {
        eventDrafts.push({
            targetType: "version",
            targetId: createdFirstVersion.id,
            eventType: "version.created",
            toState: createdFirstVersion.state
        });
    }
    return {
        project,
        firstVersion: createdFirstVersion,
        events: createTransitionEvents(eventDrafts, {
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
export const setCurrentVersion = ({ project, currentVersion, nextVersion, actor, deps, operationContext }) => {
    const context = operationContext ?? createDomainContext(deps, actor);
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
