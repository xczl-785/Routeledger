import type { Actor } from "./actor.js";
import type { ConstraintStatus } from "./states.js";

export type ConstraintScope =
  | {
      type: "project";
    }
  | {
      type: "version";
      versionId: string;
    };

export interface Constraint {
  id: string;
  projectId: string;
  rule: string;
  rationale: string;
  scope: ConstraintScope;
  status: ConstraintStatus;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
  retireReason: string | null;
  retireNote: string | null;
}
