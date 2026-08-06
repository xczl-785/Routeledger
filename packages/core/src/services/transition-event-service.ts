import type { TransitionEvent, TransitionEventContext, TransitionEventDraft } from "../domain/transition-event.js";
import type { IdGeneratorPort } from "../ports/id-generator-port.js";

export interface CreateTransitionEventsOptions {
  startSeq?: number;
}

export const createTransitionEvents = (
  drafts: TransitionEventDraft[],
  context: TransitionEventContext,
  idGenerator: IdGeneratorPort,
  options: CreateTransitionEventsOptions = {}
): TransitionEvent[] =>
  drafts.map((draft, index) => ({
    id: idGenerator.nextId(),
    projectId: context.projectId,
    operationId: context.operationId,
    operationSeq: (options.startSeq ?? 0) + index + 1,
    targetType: draft.targetType,
    targetId: draft.targetId,
    eventType: draft.eventType,
    fromState: draft.fromState ?? null,
    toState: draft.toState ?? null,
    note: draft.note ?? null,
    actorId: context.actor.id,
    actorType: context.actor.type,
    actorDisplayName: context.actor.displayName ?? null,
    createdAt: context.now,
    metadata: draft.metadata ?? {}
  }));
