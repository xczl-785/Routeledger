export const VERSION_STATES = [
  "wait",
  "ready",
  "running",
  "suspend",
  "complete",
  "close"
] as const;

export type VersionState = (typeof VERSION_STATES)[number];

export const TODO_STATUSES = ["wait", "running", "closed", "converted"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export const UNDO_STATUSES = ["wait", "closed", "converted"] as const;

export type UndoStatus = (typeof UNDO_STATUSES)[number];

export const DEFERRED_STATUSES = ["pending", "activated", "resolved"] as const;

export type DeferredStatus = (typeof DEFERRED_STATUSES)[number];

export const CONSTRAINT_STATUSES = ["active", "retired"] as const;

export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];

export const WORK_ITEM_STATUSES = ["active", "closed"] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
