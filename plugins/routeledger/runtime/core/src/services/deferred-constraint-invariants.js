import { DomainError } from "../domain/errors.js";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonBlankString = (value) => typeof value === "string" && value.trim().length > 0;
const isNullableString = (value) => value === null || typeof value === "string";
const hasValidActorShape = (value) => isRecord(value) &&
    isNonBlankString(value.id) &&
    (value.type === "user" || value.type === "agent" || value.type === "system") &&
    (value.displayName === undefined || typeof value.displayName === "string");
export const collectDeferredItemInvariantViolations = (value, todos = []) => {
    if (!isRecord(value)) {
        return [
            {
                code: "DEFERRED_SHAPE_INVALID",
                message: "DeferredItem 必须是对象"
            }
        ];
    }
    const violations = [];
    const status = value.status;
    const outcome = value.resolutionOutcome;
    const requiredNonBlankFields = [
        "id",
        "projectId",
        "workItemId",
        "originVersionId",
        "targetReviewVersionId",
        "title",
        "reason",
        "createdAt",
        "updatedAt"
    ];
    const nullableStringFields = [
        "reviewTrigger",
        "resolutionReason",
        "resolutionNote",
        "decisionRef",
        "activatedTodoId",
        "reviewedAt"
    ];
    if (requiredNonBlankFields.some((field) => !isNonBlankString(value[field])) ||
        typeof value.description !== "string" ||
        nullableStringFields.some((field) => !isNullableString(value[field])) ||
        !hasValidActorShape(value.createdBy) ||
        (status !== "pending" && status !== "activated" && status !== "resolved") ||
        (outcome !== null &&
            outcome !== "activated" &&
            outcome !== "superseded" &&
            outcome !== "rejected" &&
            outcome !== "out_of_scope")) {
        violations.push({
            code: "DEFERRED_SHAPE_INVALID",
            message: "DeferredItem 字段类型、必填值、状态或结果枚举无效"
        });
        return violations;
    }
    const deferred = value;
    if (deferred.status === "pending") {
        if (deferred.resolutionOutcome !== null ||
            deferred.resolutionReason !== null ||
            deferred.resolutionNote !== null ||
            deferred.decisionRef !== null ||
            deferred.activatedTodoId !== null) {
            violations.push({
                code: "DEFERRED_PENDING_RESOLUTION_FIELDS_INVALID",
                message: "pending DeferredItem 不应包含 resolution 或 activated_todo 字段"
            });
        }
    }
    else if (!isNonBlankString(deferred.reviewedAt) ||
        deferred.resolutionOutcome === null ||
        !isNonBlankString(deferred.resolutionReason) ||
        !isNonBlankString(deferred.resolutionNote)) {
        violations.push({
            code: "DEFERRED_RESOLUTION_FIELDS_MISSING",
            message: "非 pending DeferredItem 必须包含完整 review 与 resolution 字段"
        });
    }
    if (deferred.status === "activated" &&
        deferred.resolutionOutcome !== "activated") {
        violations.push({
            code: "DEFERRED_ACTIVATED_OUTCOME_INVALID",
            message: "activated DeferredItem 的 resolution_outcome 必须为 activated"
        });
    }
    if (deferred.status === "resolved" &&
        (deferred.resolutionOutcome === null ||
            deferred.resolutionOutcome === "activated")) {
        violations.push({
            code: "DEFERRED_RESOLVED_OUTCOME_INVALID",
            message: "resolved DeferredItem 的 resolution_outcome 必须是非 activated 结果"
        });
    }
    if (deferred.status === "activated") {
        const activatedTodo = deferred.activatedTodoId === null
            ? undefined
            : todos.find((todo) => todo.id === deferred.activatedTodoId);
        if (activatedTodo === undefined ||
            activatedTodo.projectId !== deferred.projectId ||
            activatedTodo.workItemId !== deferred.workItemId ||
            activatedTodo.sourceType !== "conversion" ||
            activatedTodo.sourceId !== deferred.id) {
            violations.push({
                code: "DEFERRED_ACTIVATED_TODO_NOT_FOUND",
                message: "activated DeferredItem 必须指向同一 project/work item 且以自身为来源的现有 Todo"
            });
        }
    }
    else if (deferred.activatedTodoId !== null) {
        violations.push({
            code: "DEFERRED_ACTIVATED_TODO_INVALID",
            message: "只有 activated DeferredItem 可以包含 activated_todo_id"
        });
    }
    if ((deferred.resolutionOutcome === "rejected" ||
        deferred.resolutionOutcome === "out_of_scope") &&
        !isNonBlankString(deferred.decisionRef)) {
        violations.push({
            code: "DEFERRED_DECISION_REF_MISSING",
            message: "rejected 或 out_of_scope DeferredItem 必须包含 decision_ref"
        });
    }
    return violations;
};
export const collectConstraintInvariantViolations = (value) => {
    if (!isRecord(value)) {
        return [
            {
                code: "CONSTRAINT_SHAPE_INVALID",
                message: "Constraint 必须是对象"
            }
        ];
    }
    const violations = [];
    const scope = value.scope;
    const scopeIsValid = isRecord(scope) &&
        ((scope.type === "project" && scope.versionId === undefined) ||
            (scope.type === "version" && isNonBlankString(scope.versionId)));
    if (!isNonBlankString(value.id) ||
        !isNonBlankString(value.projectId) ||
        !isNonBlankString(value.rule) ||
        !isNonBlankString(value.rationale) ||
        !scopeIsValid ||
        (value.status !== "active" && value.status !== "retired") ||
        !hasValidActorShape(value.createdBy) ||
        !isNonBlankString(value.createdAt) ||
        !isNonBlankString(value.updatedAt) ||
        !isNullableString(value.retiredAt) ||
        !isNullableString(value.retireReason) ||
        !isNullableString(value.retireNote)) {
        violations.push({
            code: "CONSTRAINT_SHAPE_INVALID",
            message: "Constraint 字段类型、必填值、状态或 scope 无效"
        });
        return violations;
    }
    const constraint = value;
    if (constraint.status === "active" &&
        (constraint.retiredAt !== null ||
            constraint.retireReason !== null ||
            constraint.retireNote !== null)) {
        violations.push({
            code: "CONSTRAINT_ACTIVE_RETIREMENT_FIELDS_INVALID",
            message: "active Constraint 不应包含 retirement 字段"
        });
    }
    if (constraint.status === "retired" &&
        (!isNonBlankString(constraint.retiredAt) ||
            !isNonBlankString(constraint.retireReason) ||
            !isNonBlankString(constraint.retireNote))) {
        violations.push({
            code: "CONSTRAINT_RETIREMENT_FIELDS_MISSING",
            message: "retired Constraint 必须包含完整 retirement 字段"
        });
    }
    return violations;
};
export const assertDeferredItemInvariant = (value, todos = []) => {
    const violations = collectDeferredItemInvariantViolations(value, todos);
    if (violations.length > 0) {
        throw new DomainError("INVALID_DEFERRED_TRANSITION", violations.map((violation) => violation.message).join("; "), {
            violations
        });
    }
};
export const assertConstraintInvariant = (value) => {
    const violations = collectConstraintInvariantViolations(value);
    if (violations.length > 0) {
        throw new DomainError("INVALID_CONSTRAINT_TRANSITION", violations.map((violation) => violation.message).join("; "), {
            violations
        });
    }
};
