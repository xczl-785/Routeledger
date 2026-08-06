import type { Actor } from "../domain/actor.js";
import type { Project } from "../domain/project.js";
import type { Todo } from "../domain/todo.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";
import type { WorkItem } from "../domain/work-item.js";
import type { DomainDependencies } from "../services/operation.js";

export const TEST_ACTOR: Actor = {
  id: "actor-1",
  type: "agent",
  displayName: "test-agent"
};

export const createTestDependencies = (): DomainDependencies => {
  let sequence = 0;

  return {
    clock: {
      now: () => "2026-06-27T00:00:00.000Z"
    },
    idGenerator: {
      nextId: () => `id-${++sequence}`
    }
  };
};

export const createVersionFixture = (overrides: Partial<Version> = {}): Version => ({
  id: "version-1",
  projectId: "project-1",
  title: "Version 1",
  description: "",
  state: "wait",
  parentVersionId: null,
  previousVersionId: null,
  nextVersionId: null,
  order: 1,
  isCurrent: false,
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  closedAt: null,
  stateReason: null,
  ...overrides
});

export const createProjectFixture = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "RouteLedger",
  description: "",
  status: "active",
  currentVersionId: "version-1",
  initialVersionId: "version-1",
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  archivedAt: null,
  settings: {
    enforceStartGate: true,
    enforceCloseGate: true,
    contextBudgetBytes: 32768
  },
  ...overrides
});

export const createWorkItemFixture = (
  overrides: Partial<WorkItem> = {}
): WorkItem => ({
  id: "work-item-1",
  projectId: "project-1",
  title: "Example work item",
  type: "other",
  status: "active",
  originVersionId: "version-1",
  activeRecordType: "todo",
  activeRecordId: "todo-1",
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  closedAt: null,
  summary: "Example work item",
  ...overrides
});

export const createTodoFixture = (overrides: Partial<Todo> = {}): Todo => ({
  id: "todo-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  versionId: "version-1",
  title: "Example todo",
  description: "",
  status: "wait",
  sourceType: "manual",
  sourceId: null,
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  closedAt: null,
  closeReason: null,
  closeNote: null,
  ...overrides
});

export const createUndoFixture = (overrides: Partial<Undo> = {}): Undo => ({
  id: "undo-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  versionId: "version-1",
  originVersionId: "version-1",
  preferredResolutionVersionId: "version-2",
  sourceType: "manual",
  sourceId: null,
  title: "Example undo",
  description: "",
  status: "wait",
  reason: "deferred",
  triggerCondition: null,
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  carriedForwardAt: null,
  carriedForwardToVersionId: null,
  closedAt: null,
  closeReason: null,
  closeNote: null,
  ...overrides
});
