const objectSchema = (properties, required = []) => ({
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required })
});
const stringSchema = { type: "string" };
const nullableStringSchema = {
    anyOf: [{ type: "string" }, { type: "null" }]
};
export const actorOutputSchema = objectSchema({
    id: stringSchema,
    type: { type: "string", enum: ["user", "agent", "system"] },
    displayName: stringSchema
}, ["id", "type"]);
export const idempotencyOutputSchema = objectSchema({
    protected: { type: "boolean", const: true },
    receiptId: stringSchema,
    replayed: { type: "boolean" },
    resultScope: { type: "string", const: "original_commit" },
    originalCommittedAt: stringSchema,
    currentStateRefreshed: { type: "boolean" },
    recommendedNextAction: objectSchema({
        type: { type: "string", const: "refresh_current_context" },
        tool: { type: "string", const: "get_current_context" },
        toolInput: objectSchema({ projectId: stringSchema }, ["projectId"])
    }, ["type", "tool", "toolInput"])
}, [
    "protected",
    "receiptId",
    "replayed",
    "resultScope",
    "originalCommittedAt",
    "currentStateRefreshed"
]);
export const todoOutputSchema = objectSchema({
    id: stringSchema,
    projectId: stringSchema,
    workItemId: stringSchema,
    versionId: stringSchema,
    title: stringSchema,
    description: stringSchema,
    status: { type: "string", enum: ["wait", "running", "closed", "converted"] },
    sourceType: { type: "string", enum: ["manual", "conversion", "residual_audit"] },
    sourceId: nullableStringSchema,
    createdBy: actorOutputSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    closedAt: nullableStringSchema,
    closeReason: nullableStringSchema,
    closeNote: nullableStringSchema
}, [
    "id",
    "projectId",
    "workItemId",
    "versionId",
    "title",
    "description",
    "status",
    "sourceType",
    "sourceId",
    "createdBy",
    "createdAt",
    "updatedAt",
    "closedAt",
    "closeReason",
    "closeNote"
]);
export const todoSummaryOutputSchema = objectSchema(Object.fromEntries(Object.entries(todoOutputSchema.properties).filter(([key]) => key !== "workItemId")), todoOutputSchema.required.filter((key) => key !== "workItemId"));
export const workItemOutputSchema = objectSchema({
    id: stringSchema,
    projectId: stringSchema,
    title: stringSchema,
    type: {
        type: "string",
        enum: ["feature", "bug", "risk", "open_question", "debt", "decision", "other"]
    },
    status: { type: "string", enum: ["active", "closed"] },
    originVersionId: stringSchema,
    activeRecordType: {
        anyOf: [
            { type: "string", enum: ["todo", "undo", "deferred"] },
            { type: "null" }
        ]
    },
    activeRecordId: nullableStringSchema,
    createdBy: actorOutputSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    closedAt: nullableStringSchema,
    summary: stringSchema
}, [
    "id",
    "projectId",
    "title",
    "type",
    "status",
    "originVersionId",
    "activeRecordType",
    "activeRecordId",
    "createdBy",
    "createdAt",
    "updatedAt",
    "closedAt",
    "summary"
]);
export const transitionEventOutputSchema = objectSchema({
    id: stringSchema,
    projectId: stringSchema,
    operationId: stringSchema,
    operationSeq: { type: "integer" },
    targetType: {
        type: "string",
        enum: [
            "project",
            "version",
            "work_item",
            "todo",
            "undo",
            "deferred_item",
            "constraint",
            "asset",
            "pending_operation",
            "approval_artifact"
        ]
    },
    targetId: stringSchema,
    eventType: stringSchema,
    fromState: nullableStringSchema,
    toState: nullableStringSchema,
    note: nullableStringSchema,
    actorId: stringSchema,
    actorType: { type: "string", enum: ["user", "agent", "system"] },
    actorDisplayName: nullableStringSchema,
    createdAt: stringSchema,
    metadata: { type: "object", additionalProperties: true }
}, [
    "id",
    "projectId",
    "operationId",
    "operationSeq",
    "targetType",
    "targetId",
    "eventType",
    "fromState",
    "toState",
    "note",
    "actorId",
    "actorType",
    "actorDisplayName",
    "createdAt",
    "metadata"
]);
export const deferredSummaryOutputSchema = objectSchema({
    id: stringSchema,
    projectId: stringSchema,
    targetReviewVersionId: stringSchema,
    title: stringSchema,
    description: stringSchema,
    status: { type: "string", enum: ["pending", "activated", "resolved"] },
    reason: stringSchema,
    reviewTrigger: nullableStringSchema,
    resolutionOutcome: {
        anyOf: [
            {
                type: "string",
                enum: ["activated", "superseded", "rejected", "out_of_scope"]
            },
            { type: "null" }
        ]
    },
    resolutionReason: nullableStringSchema,
    resolutionNote: nullableStringSchema,
    decisionRef: nullableStringSchema,
    activatedTodoId: nullableStringSchema,
    createdBy: actorOutputSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    reviewedAt: nullableStringSchema
}, [
    "id",
    "projectId",
    "targetReviewVersionId",
    "title",
    "description",
    "status",
    "reason",
    "reviewTrigger",
    "resolutionOutcome",
    "resolutionReason",
    "resolutionNote",
    "decisionRef",
    "activatedTodoId",
    "createdBy",
    "createdAt",
    "updatedAt",
    "reviewedAt"
]);
export const constraintSummaryOutputSchema = objectSchema({
    id: stringSchema,
    projectId: stringSchema,
    rule: stringSchema,
    rationale: stringSchema,
    scope: {
        oneOf: [
            objectSchema({ type: { type: "string", const: "project" } }, ["type"]),
            objectSchema({ type: { type: "string", const: "version" }, versionId: stringSchema }, ["type", "versionId"])
        ]
    },
    status: { type: "string", enum: ["active", "retired"] },
    createdBy: actorOutputSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    retiredAt: nullableStringSchema,
    retireReason: nullableStringSchema,
    retireNote: nullableStringSchema
}, [
    "id",
    "projectId",
    "rule",
    "rationale",
    "scope",
    "status",
    "createdBy",
    "createdAt",
    "updatedAt",
    "retiredAt",
    "retireReason",
    "retireNote"
]);
const toolErrorOutputSchema = objectSchema({
    code: stringSchema,
    message: stringSchema,
    details: { type: "object", additionalProperties: true }
}, ["code", "message"]);
export const toolOutputSchema = (dataSchema) => objectSchema({
    ok: { type: "boolean" },
    data: dataSchema,
    error: toolErrorOutputSchema,
    meta: { type: "object", additionalProperties: true }
}, ["ok"]);
