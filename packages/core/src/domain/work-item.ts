import type { Actor } from "./actor.js";
import type { WorkItemStatus } from "./states.js";

export type WorkItemType =
  | "feature"
  | "bug"
  | "risk"
  | "open_question"
  | "debt"
  | "decision"
  | "other";

export type ActiveRecordType = "todo" | "undo" | "deferred";

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  originVersionId: string;
  activeRecordType: ActiveRecordType | null;
  activeRecordId: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  summary: string;
}
