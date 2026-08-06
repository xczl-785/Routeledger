import { DomainError } from "../domain/errors.js";
import type { Project } from "../domain/project.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Version } from "../domain/version.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { createDomainContext, type DomainDependencies } from "./operation.js";
import { suspendVersion } from "./version-service.js";
import type { Actor } from "../domain/actor.js";

export interface CreateProjectInput {
  name: string;
  description?: string;
  actor: Actor;
  deps: DomainDependencies;
}

export interface ProjectCreation {
  project: Project;
  initialVersion: Version;
  events: TransitionEvent[];
}

export interface SetCurrentVersionInput {
  project: Project;
  currentVersion: Version | null;
  nextVersion: Version;
  actor: Actor;
  deps: DomainDependencies;
}

const validateVersionId = (versionId: string): void => {
  if (versionId === "0") {
    throw new DomainError("MISSING_REQUIRED_FIELD", "version_id 不允许使用 0", {
      versionId
    });
  }
};

export const createProject = ({
  name,
  description = "",
  actor,
  deps
}: CreateProjectInput): ProjectCreation => {
  const context = createDomainContext(deps, actor);
  const projectId = deps.idGenerator.nextId();
  const initialVersionId = deps.idGenerator.nextId();
  validateVersionId(initialVersionId);

  const project: Project = {
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
      contextBudgetBytes: 32768
    }
  };

  const initialVersion: Version = {
    id: initialVersionId,
    projectId,
    title: "Initial Version",
    description: "Project bootstrap version",
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
    events: createTransitionEvents(
      [
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
      ],
      {
        projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface SetCurrentVersionResult {
  project: Project;
  currentVersion: Version | null;
  nextVersion: Version;
  events: TransitionEvent[];
}

export const setCurrentVersion = ({
  project,
  currentVersion,
  nextVersion,
  actor,
  deps
}: SetCurrentVersionInput): SetCurrentVersionResult => {
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
      throw new DomainError(
        "PROJECT_VERSION_MISMATCH",
        "project.current_version_id 非空时必须传入匹配的旧 current version",
        {
          projectId: project.id,
          currentVersionId: project.currentVersionId
        }
      );
    }

    if (currentVersion.id !== project.currentVersionId) {
      throw new DomainError(
        "PROJECT_VERSION_MISMATCH",
        "传入的旧 current version 与 project.current_version_id 不一致",
        {
          projectId: project.id,
          expectedVersionId: project.currentVersionId,
          actualVersionId: currentVersion.id
        }
      );
    }
  }

  let updatedCurrentVersion: Version | null = currentVersion;
  let events: TransitionEvent[] = [];

  if (currentVersion !== null) {
    if (currentVersion.projectId !== project.id) {
      throw new DomainError("PROJECT_VERSION_MISMATCH", "当前 version 不属于该 project", {
        projectId: project.id,
        versionId: currentVersion.id
      });
    }

    if (currentVersion.id !== nextVersion.id) {
      if (currentVersion.state === "running") {
        const suspended = suspendVersion(
          currentVersion,
          context,
          deps,
          "current version switched"
        );
        updatedCurrentVersion = {
          ...suspended.version,
          isCurrent: false
        };
        events = events.concat(suspended.events);
      } else {
        updatedCurrentVersion = {
          ...currentVersion,
          isCurrent: false,
          updatedAt: context.now
        };
      }
    }
  }

  const updatedNextVersion: Version = {
    ...nextVersion,
    isCurrent: true,
    updatedAt: context.now
  };

  const updatedProject: Project = {
    ...project,
    currentVersionId: nextVersion.id,
    updatedAt: context.now
  };

  const projectEvents = createTransitionEvents(
    [
      {
        targetType: "project",
        targetId: project.id,
        eventType: "project.current_version_changed",
        fromState: project.currentVersionId,
        toState: nextVersion.id
      }
    ],
      {
        projectId: project.id,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator,
      {
        startSeq: events.length
      }
    );

  return {
    project: updatedProject,
    currentVersion: updatedCurrentVersion,
    nextVersion: updatedNextVersion,
    events: events.concat(projectEvents)
  };
};
