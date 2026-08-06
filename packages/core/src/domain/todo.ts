import type { Actor } from "./actor.js";
import type { TodoStatus } from "./states.js";

export interface Todo {
  id: string;
  projectId: string;
  workItemId: string;
  versionId: string;
  title: string;
  description: string;
  status: TodoStatus;
  sourceType: "manual" | "conversion" | "residual_audit";
  sourceId: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  closeNote: string | null;
}
