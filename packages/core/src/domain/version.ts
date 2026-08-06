import type { Actor } from "./actor.js";
import type { VersionState } from "./states.js";

export interface Version {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: VersionState;
  parentVersionId: string | null;
  previousVersionId: string | null;
  nextVersionId: string | null;
  order: number;
  isCurrent: boolean;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  stateReason: string | null;
}
