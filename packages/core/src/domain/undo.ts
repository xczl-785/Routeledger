import type { Actor } from "./actor.js";
import type { UndoStatus } from "./states.js";

export interface Undo {
  id: string;
  projectId: string;
  workItemId: string;
  versionId: string;
  originVersionId: string;
  preferredResolutionVersionId: string;
  sourceType:
    | "manual"
    | "roadmap_planning"
    | "agent_discovery"
    | "residual_audit"
    | "conversion"
    | "import";
  sourceId: string | null;
  title: string;
  description: string;
  status: UndoStatus;
  reason: string;
  triggerCondition: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  carriedForwardAt: string | null;
  carriedForwardToVersionId: string | null;
  closedAt: string | null;
  closeReason: string | null;
  closeNote: string | null;
}
