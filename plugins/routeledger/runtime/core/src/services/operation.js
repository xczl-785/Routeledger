import { DomainError } from "../domain/errors.js";
const OPERATION_ID_PREFIX = "op_";
export const buildOperationId = (idGenerator) => {
    const rawId = idGenerator.nextId().trim();
    if (rawId.length === 0) {
        throw new DomainError("INVALID_OPERATION_ID", "operation_id 不能为空");
    }
    return rawId.startsWith(OPERATION_ID_PREFIX)
        ? rawId
        : `${OPERATION_ID_PREFIX}${rawId}`;
};
export const createDomainContext = (deps, actor, operationId) => ({
    actor,
    now: deps.clock.now(),
    operationId: operationId ?? buildOperationId(deps.idGenerator)
});
