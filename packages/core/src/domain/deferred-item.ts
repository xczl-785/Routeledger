import type { Actor } from "./actor.js";
import type { DeferredStatus } from "./states.js";

export type DeferredResolutionOutcome =
  | "activated"
  | "superseded"
  | "rejected"
  | "out_of_scope";

export interface DeferredItem {
  id: string;
  projectId: string;
  workItemId: string;
  originVersionId: string;
  targetReviewVersionId: string;
  title: string;
  description: string;
  status: DeferredStatus;
  reason: string;
  reviewTrigger: string | null;
  resolutionOutcome: DeferredResolutionOutcome | null;
  resolutionReason: string | null;
  resolutionNote: string | null;
  decisionRef: string | null;
  activatedTodoId: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}
