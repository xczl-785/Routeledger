export class InvalidToolInputError extends Error {
    code = "INVALID_TOOL_INPUT";
    details;
    constructor(message, details) {
        super(message);
        this.name = "InvalidToolInputError";
        this.details = details;
    }
}
const hasOwn = (input, field) => Object.prototype.hasOwnProperty.call(input, field);
const describeType = (value) => {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    return typeof value;
};
const summarizeValue = (value) => {
    if (typeof value === "string") {
        return value.length > 200 ? `${value.slice(0, 200)}...` : value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (value === undefined) {
        return null;
    }
    return Object.prototype.toString.call(value);
};
const invalidToolInput = (options) => new InvalidToolInputError(options.message ?? `${options.toolName} received invalid input at ${options.path}.`, {
    toolName: options.toolName,
    path: options.path,
    expected: options.expected,
    receivedType: describeType(options.received),
    receivedValue: summarizeValue(options.received)
});
const expectInputObject = (toolName, input) => {
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
        return input;
    }
    throw invalidToolInput({
        toolName,
        path: "$",
        expected: "object",
        received: input,
        message: `${toolName} expects an object input.`
    });
};
const requireString = (input, toolName, field, pathPrefix = "$") => {
    if (!hasOwn(input, field)) {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "string",
            received: undefined,
            message: `Missing required string field ${field}.`
        });
    }
    const value = input[field];
    if (typeof value !== "string") {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "string",
            received: value
        });
    }
    return value;
};
const optionalString = (input, toolName, field, pathPrefix = "$") => {
    if (!hasOwn(input, field) || input[field] === undefined) {
        return undefined;
    }
    const value = input[field];
    if (typeof value !== "string") {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "string",
            received: value
        });
    }
    return value;
};
const requireEnumString = (input, toolName, field, allowed) => {
    const value = requireString(input, toolName, field);
    if (!allowed.includes(value)) {
        throw invalidToolInput({
            toolName,
            path: `$.${field}`,
            expected: allowed.join(" | "),
            received: value
        });
    }
    return value;
};
const optionalInteger = (input, toolName, field, pathPrefix = "$") => {
    if (!hasOwn(input, field) || input[field] === undefined) {
        return undefined;
    }
    const value = input[field];
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "integer",
            received: value
        });
    }
    return value;
};
const optionalBoolean = (input, toolName, field, pathPrefix = "$") => {
    if (!hasOwn(input, field) || input[field] === undefined) {
        return undefined;
    }
    const value = input[field];
    if (typeof value !== "boolean") {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "boolean",
            received: value
        });
    }
    return value;
};
const requireStringArray = (input, toolName, field, pathPrefix = "$") => {
    if (!hasOwn(input, field)) {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "array",
            received: undefined,
            message: `Missing required array field ${field}.`
        });
    }
    const value = input[field];
    if (!Array.isArray(value)) {
        throw invalidToolInput({
            toolName,
            path: `${pathPrefix}.${field}`,
            expected: "array",
            received: value
        });
    }
    return value.map((item, index) => {
        if (typeof item !== "string") {
            throw invalidToolInput({
                toolName,
                path: `${pathPrefix}.${field}[${index}]`,
                expected: "string",
                received: item
            });
        }
        return item;
    });
};
const optionalExpectedPointerArray = (input, toolName) => {
    if (!hasOwn(input, "expectedPointers") || input.expectedPointers === undefined) {
        return undefined;
    }
    const value = input.expectedPointers;
    if (!Array.isArray(value)) {
        throw invalidToolInput({
            toolName,
            path: "$.expectedPointers",
            expected: "array",
            received: value
        });
    }
    return value.map((item, index) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw invalidToolInput({
                toolName,
                path: `$.expectedPointers[${index}]`,
                expected: "object",
                received: item
            });
        }
        const pointer = item;
        const pathPrefix = `$.expectedPointers[${index}]`;
        const required = optionalBoolean(pointer, toolName, "required", pathPrefix);
        return {
            kind: requireString(pointer, toolName, "kind", pathPrefix),
            path: requireString(pointer, toolName, "path", pathPrefix),
            ...(required === undefined ? {} : { required })
        };
    });
};
export const adaptGetCurrentContextInput = (input) => {
    const normalized = expectInputObject("get_current_context", input);
    const budgetBytes = optionalInteger(normalized, "get_current_context", "budgetBytes");
    const includeAllVersions = optionalBoolean(normalized, "get_current_context", "includeAllVersions");
    const versionWindowBefore = optionalInteger(normalized, "get_current_context", "versionWindowBefore");
    const versionWindowAfter = optionalInteger(normalized, "get_current_context", "versionWindowAfter");
    const includeLegacyUndo = optionalBoolean(normalized, "get_current_context", "includeLegacyUndo");
    return {
        projectId: requireString(normalized, "get_current_context", "projectId"),
        ...(budgetBytes === undefined ? {} : { budgetBytes }),
        ...(includeAllVersions === undefined ? {} : { includeAllVersions }),
        ...(versionWindowBefore === undefined ? {} : { versionWindowBefore }),
        ...(versionWindowAfter === undefined ? {} : { versionWindowAfter }),
        ...(includeLegacyUndo === undefined ? {} : { includeLegacyUndo })
    };
};
export const adaptDeferWorkInput = (input) => {
    const normalized = expectInputObject("defer_work", input);
    const mode = requireEnumString(normalized, "defer_work", "mode", ["new", "todo"]);
    const base = {
        projectId: requireString(normalized, "defer_work", "projectId"),
        targetReviewVersionId: requireString(normalized, "defer_work", "targetReviewVersionId"),
        reason: requireString(normalized, "defer_work", "reason")
    };
    const reviewTrigger = optionalString(normalized, "defer_work", "reviewTrigger");
    if (mode === "new") {
        const description = optionalString(normalized, "defer_work", "description");
        return {
            mode,
            ...base,
            currentVersionId: requireString(normalized, "defer_work", "currentVersionId"),
            title: requireString(normalized, "defer_work", "title"),
            ...(description === undefined ? {} : { description }),
            ...(reviewTrigger === undefined ? {} : { reviewTrigger })
        };
    }
    return {
        mode,
        ...base,
        todoId: requireString(normalized, "defer_work", "todoId"),
        note: requireString(normalized, "defer_work", "note"),
        ...(reviewTrigger === undefined ? {} : { reviewTrigger })
    };
};
export const adaptReviewDeferredInput = (input) => {
    const normalized = expectInputObject("review_deferred", input);
    const action = requireEnumString(normalized, "review_deferred", "action", ["activate", "defer_again", "resolve"]);
    const base = {
        projectId: requireString(normalized, "review_deferred", "projectId"),
        deferredId: requireString(normalized, "review_deferred", "deferredId"),
        reason: requireString(normalized, "review_deferred", "reason")
    };
    const note = optionalString(normalized, "review_deferred", "note");
    if (action === "activate") {
        return {
            action,
            ...base,
            targetVersionId: requireString(normalized, "review_deferred", "targetVersionId"),
            ...(note === undefined ? {} : { note })
        };
    }
    if (action === "defer_again") {
        const reviewTrigger = optionalString(normalized, "review_deferred", "reviewTrigger");
        return {
            action,
            ...base,
            targetReviewVersionId: requireString(normalized, "review_deferred", "targetReviewVersionId"),
            ...(note === undefined ? {} : { note }),
            ...(reviewTrigger === undefined ? {} : { reviewTrigger })
        };
    }
    const decisionRef = optionalString(normalized, "review_deferred", "decisionRef");
    return {
        action,
        ...base,
        outcome: requireEnumString(normalized, "review_deferred", "outcome", ["superseded", "rejected", "out_of_scope"]),
        ...(note === undefined ? {} : { note }),
        ...(decisionRef === undefined ? {} : { decisionRef })
    };
};
export const adaptRecordConstraintInput = (input) => {
    const normalized = expectInputObject("record_constraint", input);
    const scopeType = requireEnumString(normalized, "record_constraint", "scopeType", ["project", "version"]);
    const base = {
        projectId: requireString(normalized, "record_constraint", "projectId"),
        rule: requireString(normalized, "record_constraint", "rule"),
        rationale: requireString(normalized, "record_constraint", "rationale")
    };
    return scopeType === "project"
        ? { ...base, scopeType }
        : {
            ...base,
            scopeType,
            versionId: requireString(normalized, "record_constraint", "versionId")
        };
};
export const adaptRetireConstraintInput = (input) => {
    const normalized = expectInputObject("retire_constraint", input);
    return {
        projectId: requireString(normalized, "retire_constraint", "projectId"),
        constraintId: requireString(normalized, "retire_constraint", "constraintId"),
        reason: requireString(normalized, "retire_constraint", "reason"),
        note: requireString(normalized, "retire_constraint", "note")
    };
};
export const adaptCheckDocDriftInput = (input) => {
    const normalized = expectInputObject("check_doc_drift", input);
    const expectedPointers = optionalExpectedPointerArray(normalized, "check_doc_drift");
    return {
        projectId: requireString(normalized, "check_doc_drift", "projectId"),
        entryFiles: requireStringArray(normalized, "check_doc_drift", "entryFiles"),
        ...(expectedPointers === undefined ? {} : { expectedPointers })
    };
};
export const adaptListVersionsWindowInput = (input) => {
    const normalized = expectInputObject("list_versions_window", input);
    const aroundVersionId = optionalString(normalized, "list_versions_window", "aroundVersionId");
    const before = optionalInteger(normalized, "list_versions_window", "before");
    const after = optionalInteger(normalized, "list_versions_window", "after");
    return {
        projectId: requireString(normalized, "list_versions_window", "projectId"),
        ...(aroundVersionId === undefined ? {} : { aroundVersionId }),
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after })
    };
};
