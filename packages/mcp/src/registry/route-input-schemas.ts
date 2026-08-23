const stringSchema = (description: string): Record<string, unknown> => ({
  type: "string",
  description
});

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {})
});

const residualAuditItemSchema = objectSchema(
  {
    kind: {
      type: "string",
      enum: ["bug", "risk", "open_question", "debt"],
      description: "Residual item kind."
    },
    summary: stringSchema("Human-readable residual summary."),
    destination: {
      anyOf: [
        {
          type: "string",
          enum: ["close", "create_todo", "defer_work", "record_constraint"]
        },
        { type: "null" }
      ],
      description: "How the residual item should be handled."
    },
    targetReviewVersionId: {
      anyOf: [
        stringSchema(
          "Required downstream review version when destination is defer_work."
        ),
        { type: "null" }
      ]
    },
    destinationRecordId: {
      anyOf: [
        stringSchema(
          "Required existing Todo, Deferred, or Constraint ID when destination is create_todo, defer_work, or record_constraint. The close commit validates the record but does not create it."
        ),
        { type: "null" }
      ]
    }
  },
  ["kind", "summary", "destination"]
);

const residualAuditArraySchema: Record<string, unknown> = {
  type: "array",
  description:
    "Legacy residual-audit input. Only non-empty arrays assert review; use the reviewed declaration for an explicit empty audit.",
  items: residualAuditItemSchema
};

const reviewedResidualAuditSchema: Record<string, unknown> = objectSchema(
  {
    status: { type: "string", enum: ["reviewed"] },
    items: residualAuditArraySchema
  },
  ["status", "items"]
);

export const residualAuditInputSchema: Record<string, unknown> = {
  anyOf: [reviewedResidualAuditSchema, residualAuditArraySchema, { type: "null" }]
};
