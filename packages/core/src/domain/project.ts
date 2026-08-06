import type { Actor } from "./actor.js";

export type ProjectStatus = "active" | "archived";

export interface ProjectSettings {
  enforceStartGate: boolean;
  enforceCloseGate: boolean;
  contextBudgetBytes: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  currentVersionId: string | null;
  initialVersionId: string;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settings: ProjectSettings;
}
