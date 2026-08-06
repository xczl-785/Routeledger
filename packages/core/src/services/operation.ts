import { DomainError } from "../domain/errors.js";
import type { Actor } from "../domain/actor.js";
import type { ClockPort } from "../ports/clock-port.js";
import type { IdGeneratorPort } from "../ports/id-generator-port.js";

const OPERATION_ID_PREFIX = "op_";

export interface DomainDependencies {
  clock: ClockPort;
  idGenerator: IdGeneratorPort;
}

export interface DomainContext {
  actor: Actor;
  now: string;
  operationId: string;
}

export const buildOperationId = (idGenerator: IdGeneratorPort): string => {
  const rawId = idGenerator.nextId().trim();

  if (rawId.length === 0) {
    throw new DomainError("INVALID_OPERATION_ID", "operation_id 不能为空");
  }

  return rawId.startsWith(OPERATION_ID_PREFIX)
    ? rawId
    : `${OPERATION_ID_PREFIX}${rawId}`;
};

export const createDomainContext = (
  deps: DomainDependencies,
  actor: Actor,
  operationId?: string
): DomainContext => ({
  actor,
  now: deps.clock.now(),
  operationId: operationId ?? buildOperationId(deps.idGenerator)
});
