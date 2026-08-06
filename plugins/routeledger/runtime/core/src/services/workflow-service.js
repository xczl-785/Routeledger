import { DomainError } from "../domain/errors.js";
import { createConstraint, retireConstraint } from "./constraint-service.js";
import { activateDeferred, createDeferred, deferAgain, deferTodo, resolveDeferred } from "./deferred-service.js";
const assertNever = (value, workflow) => {
    const received = value;
    throw new DomainError("INVALID_DEFERRED_TRANSITION", `${workflow} 收到不支持的动作`, {
        action: received.action,
        mode: received.mode
    });
};
const requireResolvedDeferredRecords = (value) => {
    if (typeof value !== "object" ||
        value === null ||
        !("deferred" in value) ||
        !("workItem" in value) ||
        typeof value.deferred !== "object" ||
        value.deferred === null ||
        typeof value.workItem !== "object" ||
        value.workItem === null) {
        throw new DomainError("MISSING_REQUIRED_FIELD", "reviewDeferred 必须提供 application 已解析的 Deferred 与 WorkItem records");
    }
    return value;
};
export const deferWork = (input) => {
    switch (input.mode) {
        case "new": {
            const result = createDeferred({
                projectId: input.projectId,
                originVersionId: input.currentVersionId,
                targetReviewVersionId: input.targetReviewVersionId,
                title: input.title,
                description: input.description,
                reason: input.reason,
                reviewTrigger: input.reviewTrigger,
                actor: input.actor,
                deps: input.deps
            });
            return {
                mode: "new",
                ...result
            };
        }
        case "todo": {
            const result = deferTodo({
                todo: input.resolvedRecords.todo,
                workItem: input.resolvedRecords.workItem,
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger,
                actor: input.actor,
                deps: input.deps
            });
            return {
                mode: "todo",
                ...result
            };
        }
        default:
            return assertNever(input, "deferWork");
    }
};
export const reviewDeferred = (input) => {
    if (typeof input !== "object" || input === null) {
        throw new DomainError("INVALID_DEFERRED_TRANSITION", "reviewDeferred 输入必须是带 action 的对象");
    }
    switch (input.action) {
        case "activate": {
            const { deferred, workItem } = requireResolvedDeferredRecords(input.resolvedRecords);
            const result = activateDeferred({
                deferred,
                workItem,
                versionId: input.targetVersionId,
                reason: input.reason,
                note: input.note,
                actor: input.actor,
                deps: input.deps
            });
            return {
                action: "activate",
                ...result
            };
        }
        case "defer_again": {
            const { deferred, workItem } = requireResolvedDeferredRecords(input.resolvedRecords);
            const result = deferAgain({
                deferred,
                workItem,
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger,
                actor: input.actor,
                deps: input.deps
            });
            return {
                action: "defer_again",
                ...result
            };
        }
        case "resolve": {
            const { deferred, workItem } = requireResolvedDeferredRecords(input.resolvedRecords);
            const result = resolveDeferred({
                deferred,
                workItem,
                outcome: input.outcome,
                reason: input.reason,
                note: input.note,
                decisionRef: input.decisionRef,
                actor: input.actor,
                deps: input.deps
            });
            return {
                action: "resolve",
                ...result
            };
        }
        default:
            return assertNever(input, "reviewDeferred");
    }
};
export const recordConstraint = (input) => createConstraint(input);
export const retireRecordedConstraint = (input) => retireConstraint(input);
