import type { Actor, ActorType } from "./actor.js";

export type TransitionTargetType =
  | "project"
  | "version"
  | "work_item"
  | "todo"
  | "undo"
  | "deferred_item"
  | "constraint"
  | "asset"
  | "pending_operation"
  | "approval_artifact";

export interface TransitionEventDraft {
  targetType: TransitionTargetType;
  targetId: string;
  eventType: string;
  fromState?: string | null;
  toState?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TransitionEvent {
  id: string;
  projectId: string;
  operationId: string;
  operationSeq: number;
  targetType: TransitionTargetType;
  targetId: string;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  note: string | null;
  actorId: string;
  actorType: ActorType;
  actorDisplayName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface TransitionEventContext {
  projectId: string;
  operationId: string;
  now: string;
  actor: Actor;
}
