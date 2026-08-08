import type { Actor } from "./actor.js";
import type { ContentLocale } from "./locale.js";

export type ProjectStatus = "active" | "archived";

export interface ProjectSettings {
  enforceStartGate: boolean;
  enforceCloseGate: boolean;
  contextBudgetBytes: number;
  contentLocale: ContentLocale;
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
