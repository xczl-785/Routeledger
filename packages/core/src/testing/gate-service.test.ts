import { describe, expect, it } from "vitest";

import type { Constraint } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import { evaluateCloseGate, evaluateStartGate } from "../services/gate-service.js";
import {
  TEST_ACTOR,
  createTodoFixture,
  createUndoFixture,
  createVersionFixture
} from "./builders.js";

const createDeferredFixture = (
  overrides: Partial<DeferredItem> = {}
): DeferredItem => ({
  id: "deferred-1",
  projectId: "project-1",
  workItemId: "work-item-deferred-1",
  originVersionId: "version-1",
  targetReviewVersionId: "version-2",
  title: "Review deferred capability",
  description: "",
  status: "pending",
  reason: "Not required yet",
  reviewTrigger: null,
  resolutionOutcome: null,
  resolutionReason: null,
  resolutionNote: null,
  decisionRef: null,
  activatedTodoId: null,
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  reviewedAt: null,
  ...overrides
});

const createConstraintFixture = (
  overrides: Partial<Constraint> = {}
): Constraint => ({
  id: "constraint-1",
  projectId: "project-1",
  rule: "Do not bypass canonical validation",
  rationale: "Keep the route auditable",
  scope: { type: "project" },
  status: "active",
  createdBy: TEST_ACTOR,
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  retiredAt: null,
  retireReason: null,
  retireNote: null,
  ...overrides
});

const routedResidualAudit = [
  {
    kind: "debt" as const,
    summary: "none",
    destination: "close" as const
  }
];

const createRouteVersions = () => ({
  source: createVersionFixture({
    id: "version-source",
    projectId: "project-1",
    state: "complete",
    order: 2
  }),
  known: [
    createVersionFixture({
      id: "version-upstream",
      projectId: "project-1",
      order: 1
    }),
    createVersionFixture({
      id: "version-source",
      projectId: "project-1",
      state: "complete",
      order: 2
    }),
    createVersionFixture({
      id: "version-downstream",
      projectId: "project-1",
      order: 3
    }),
    createVersionFixture({
      id: "version-cross-project",
      projectId: "project-2",
      order: 4
    })
  ]
});

describe("gate service", () => {
  it("start gate blocks when due undo points at the target version", () => {
    const version = createVersionFixture({
      id: "version-2",
      state: "ready"
    });

    const result = evaluateStartGate({
      targetVersion: version,
      currentVersionTodos: [createTodoFixture()],
      dueUndos: [
        createUndoFixture({
          preferredResolutionVersionId: "version-2"
        })
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.openTodoIds).toEqual(["todo-1"]);
    expect(result.dueUndoIds).toEqual(["undo-1"]);
  });

  it("start gate marks self-referential due undo as a dedicated blocker", () => {
    const version = createVersionFixture({
      id: "version-2",
      state: "ready"
    });

    const result = evaluateStartGate({
      targetVersion: version,
      currentVersionTodos: [],
      dueUndos: [
        createUndoFixture({
          id: "undo-1",
          versionId: "version-2",
          preferredResolutionVersionId: "version-2",
          status: "wait"
        })
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.dueUndoIds).toEqual(["undo-1"]);
    expect(result.selfReferentialUndoIds).toEqual(["undo-1"]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OPEN_DUE_UNDOS", recordIds: ["undo-1"] }),
        expect.objectContaining({
          code: "SELF_REFERENTIAL_UNDO_BLOCKS_START",
          recordIds: ["undo-1"]
        })
      ])
    );
  });

  it("close gate requires unresolved items to be handled and residual audit destinations to be structured", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({
        state: "complete"
      }),
      todos: [createTodoFixture()],
      undos: [createUndoFixture()],
      residualAudit: [
        {
          kind: "bug",
          summary: "fix later",
          destination: null
        }
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.unresolvedTodoIds).toEqual(["todo-1"]);
    expect(result.unresolvedUndoIds).toEqual(["undo-1"]);
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "INVALID_RESIDUAL_AUDIT_DESTINATION"
    );
  });

  it("close gate distinguishes missing audit from an explicit reviewed-empty audit", () => {
    const base = {
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: []
    };

    expect(evaluateCloseGate({ ...base, residualAudit: undefined })).toMatchObject({
      allowed: false,
      blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
    });
    expect(
      evaluateCloseGate({
        ...base,
        residualAudit: { status: "reviewed", items: [] }
      })
    ).toMatchObject({ allowed: true, blockers: [] });
    expect(
      evaluateCloseGate({
        ...base,
        residualAudit: [
          { kind: "debt", summary: "legacy residual", destination: "close" }
        ]
      })
    ).toMatchObject({ allowed: true, blockers: [] });
  });

  it("start gate allows the target when all due undos are already handled", () => {
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({
        id: "version-2",
        state: "ready"
      }),
      currentVersionTodos: [],
      dueUndos: [
        createUndoFixture({
          id: "undo-1",
          preferredResolutionVersionId: "version-2",
          status: "closed"
        }),
        createUndoFixture({
          id: "undo-2",
          preferredResolutionVersionId: "version-2",
          status: "converted"
        })
      ]
    });

    expect(result.allowed).toBe(true);
    expect(result.dueUndoIds).toEqual([]);
  });

  it("close gate ignores a wait undo that was already carried forward to another version", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({
        id: "version-1",
        state: "complete"
      }),
      todos: [],
      undos: [
        createUndoFixture({
          id: "undo-1",
          versionId: "version-1",
          originVersionId: "version-1",
          preferredResolutionVersionId: "version-2",
          carriedForwardAt: "2026-06-27T00:00:00.000Z",
          carriedForwardToVersionId: "version-2",
          status: "wait"
        })
      ],
      residualAudit: [
        {
          kind: "debt",
          summary: "none",
          destination: "close"
        }
      ]
    });

    expect(result.allowed).toBe(true);
    expect(result.unresolvedUndoIds).toEqual([]);
  });

  it("start gate blocks due pending Deferred and points Agent to review_deferred", () => {
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({
        id: "version-2",
        state: "ready"
      }),
      currentVersionTodos: [],
      dueUndos: [],
      deferredItems: [
        createDeferredFixture({ id: "deferred-pending" }),
        createDeferredFixture({
          id: "deferred-activated",
          status: "activated"
        }),
        createDeferredFixture({
          id: "deferred-resolved",
          status: "resolved"
        })
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.dueDeferredIds).toEqual(["deferred-pending"]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUE_DEFERRED_REQUIRES_REVIEW",
          message: expect.stringContaining("review_deferred"),
          recordIds: ["deferred-pending"]
        })
      ])
    );
  });

  it("start gate ignores activated and resolved Deferred", () => {
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({
        id: "version-2",
        state: "ready"
      }),
      currentVersionTodos: [],
      dueUndos: [],
      deferredItems: [
        createDeferredFixture({
          id: "deferred-activated",
          status: "activated"
        }),
        createDeferredFixture({
          id: "deferred-resolved",
          status: "resolved"
        })
      ]
    });

    expect(result.allowed).toBe(true);
    expect(result.dueDeferredIds).toEqual([]);
  });

  it("close gate allows pending Deferred routed from origin to another Version", () => {
    const { source, known } = createRouteVersions();
    const result = evaluateCloseGate({
      version: source,
      todos: [],
      undos: [],
      knownVersions: known,
      deferredItems: [
        createDeferredFixture({
          originVersionId: source.id,
          targetReviewVersionId: "version-downstream"
        })
      ],
      residualAudit: routedResidualAudit
    });

    expect(result.allowed).toBe(true);
    expect(result.unresolvedDeferredIds).toEqual([]);
  });

  it("close gate blocks blank or self-referential Deferred routing and ignores terminal records", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({
        id: "version-1",
        state: "complete"
      }),
      todos: [],
      undos: [],
      deferredItems: [
        createDeferredFixture({
          id: "deferred-blank",
          targetReviewVersionId: " "
        }),
        createDeferredFixture({
          id: "deferred-self",
          targetReviewVersionId: "version-1"
        }),
        createDeferredFixture({
          id: "deferred-terminal",
          targetReviewVersionId: "version-1",
          status: "resolved"
        })
      ],
      residualAudit: routedResidualAudit
    });

    expect(result.allowed).toBe(false);
    expect(result.unresolvedDeferredIds).toEqual([
      "deferred-blank",
      "deferred-self"
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_REQUIRED",
          recordIds: ["deferred-blank"]
        }),
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_SELF",
          recordIds: ["deferred-self"]
        })
      ])
    );
  });

  it("active Constraint 自身不阻塞 start 或 close", () => {
    const constraint = createConstraintFixture();
    const startResult = evaluateStartGate({
      targetVersion: createVersionFixture({ state: "ready" }),
      currentVersionTodos: [],
      dueUndos: [],
      constraints: [constraint]
    });
    const closeResult = evaluateCloseGate({
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: [],
      constraints: [constraint],
      residualAudit: routedResidualAudit
    });

    expect(startResult.allowed).toBe(true);
    expect(startResult.blockedConstraintIds).toEqual([]);
    expect(closeResult.allowed).toBe(true);
    expect(closeResult.blockedConstraintIds).toEqual([]);
  });

  it("satisfied Constraint check 不阻塞，violated 与 evidence_missing 显式阻塞", () => {
    const constraints = [
      createConstraintFixture({ id: "constraint-satisfied" }),
      createConstraintFixture({ id: "constraint-violated" }),
      createConstraintFixture({ id: "constraint-missing" })
    ];
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({ state: "ready" }),
      currentVersionTodos: [],
      dueUndos: [],
      constraints,
      constraintChecks: [
        {
          constraintId: "constraint-satisfied",
          status: "satisfied",
          evidenceRef: "evidence:test-1"
        },
        {
          constraintId: "constraint-violated",
          status: "violated",
          evidenceRef: "evidence:failure-1"
        },
        {
          constraintId: "constraint-missing",
          status: "evidence_missing"
        }
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedConstraintIds).toEqual([
      "constraint-violated",
      "constraint-missing"
    ]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "CONSTRAINT_VIOLATED",
        "CONSTRAINT_EVIDENCE_MISSING"
      ])
    );
  });

  it("retired Constraint 的关联检查不阻塞", () => {
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({ state: "ready" }),
      currentVersionTodos: [],
      dueUndos: [],
      constraints: [
        createConstraintFixture({
          status: "retired",
          retiredAt: "2026-06-27T00:00:00.000Z",
          retireReason: "superseded",
          retireNote: "decision:1"
        })
      ],
      constraintChecks: [
        {
          constraintId: "constraint-1",
          status: "violated"
        }
      ]
    });

    expect(result.allowed).toBe(true);
    expect(result.blockedConstraintIds).toEqual([]);
  });

  it("unknown 或与目标 scope 不匹配的 Constraint check fail closed", () => {
    const result = evaluateStartGate({
      targetVersion: createVersionFixture({
        id: "version-1",
        state: "ready"
      }),
      currentVersionTodos: [],
      dueUndos: [],
      constraints: [
        createConstraintFixture({
          id: "constraint-other-version",
          scope: {
            type: "version",
            versionId: "version-9"
          }
        })
      ],
      constraintChecks: [
        {
          constraintId: "constraint-unknown",
          status: "satisfied"
        },
        {
          constraintId: "constraint-other-version",
          status: "satisfied"
        }
      ]
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedConstraintIds).toEqual([
      "constraint-unknown",
      "constraint-other-version"
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_CONSTRAINT_GATE_CHECK",
          recordIds: ["constraint-unknown"]
        }),
        expect.objectContaining({
          code: "MISMATCHED_CONSTRAINT_GATE_CHECK",
          recordIds: ["constraint-other-version"]
        })
      ])
    );
  });

  it("residual defer_work 需要目标 Version，record_constraint 不需要", () => {
    const base = {
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: []
    };
    const invalidDeferred = evaluateCloseGate({
      ...base,
      residualAudit: [
        {
          kind: "debt",
          summary: "review later",
          destination: "defer_work"
        }
      ]
    });
    const validDeferred = evaluateCloseGate({
      ...base,
      knownVersions: [
        base.version,
        createVersionFixture({
          id: "version-2",
          order: base.version.order + 1
        })
      ],
      residualAudit: [
        {
          kind: "debt",
          summary: "review later",
          destination: "defer_work",
          targetReviewVersionId: "version-2"
        }
      ]
    });
    const validConstraint = evaluateCloseGate({
      ...base,
      residualAudit: [
        {
          kind: "risk",
          summary: "do not bypass validation",
          destination: "record_constraint"
        }
      ]
    });

    expect(invalidDeferred.allowed).toBe(false);
    expect(invalidDeferred.blockers.map((blocker) => blocker.code)).toContain(
      "DEFERRED_ROUTE_TARGET_REQUIRED"
    );
    expect(validDeferred.allowed).toBe(true);
    expect(validConstraint.allowed).toBe(true);
  });

  it.each([
    {
      label: "blank",
      targetReviewVersionId: " ",
      expectedCode: "DEFERRED_ROUTE_TARGET_REQUIRED",
      allowed: false
    },
    {
      label: "self",
      targetReviewVersionId: "version-source",
      expectedCode: "DEFERRED_ROUTE_TARGET_SELF",
      allowed: false
    },
    {
      label: "unknown",
      targetReviewVersionId: "version-unknown",
      expectedCode: "DEFERRED_ROUTE_TARGET_UNKNOWN",
      allowed: false
    },
    {
      label: "cross-project",
      targetReviewVersionId: "version-cross-project",
      expectedCode: "DEFERRED_ROUTE_TARGET_CROSS_PROJECT",
      allowed: false
    },
    {
      label: "upstream",
      targetReviewVersionId: "version-upstream",
      expectedCode: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM",
      allowed: false
    },
    {
      label: "downstream",
      targetReviewVersionId: "version-downstream",
      expectedCode: null,
      allowed: true
    }
  ])(
    "existing Deferred route validates $label target",
    ({ targetReviewVersionId, expectedCode, allowed }) => {
      const { source, known } = createRouteVersions();
      const result = evaluateCloseGate({
        version: source,
        todos: [],
        undos: [],
        knownVersions: known,
        deferredItems: [
          createDeferredFixture({
            id: "deferred-route",
            originVersionId: source.id,
            targetReviewVersionId
          })
        ],
        residualAudit: routedResidualAudit
      });

      expect(result.allowed).toBe(allowed);
      expect(result.unresolvedDeferredIds).toEqual(
        allowed ? [] : ["deferred-route"]
      );

      if (expectedCode !== null) {
        expect(result.blockers.map((blocker) => blocker.code)).toContain(
          expectedCode
        );
      }
    }
  );

  it.each([
    {
      label: "blank",
      targetReviewVersionId: " ",
      expectedCode: "DEFERRED_ROUTE_TARGET_REQUIRED",
      allowed: false
    },
    {
      label: "self",
      targetReviewVersionId: "version-source",
      expectedCode: "DEFERRED_ROUTE_TARGET_SELF",
      allowed: false
    },
    {
      label: "unknown",
      targetReviewVersionId: "version-unknown",
      expectedCode: "DEFERRED_ROUTE_TARGET_UNKNOWN",
      allowed: false
    },
    {
      label: "cross-project",
      targetReviewVersionId: "version-cross-project",
      expectedCode: "DEFERRED_ROUTE_TARGET_CROSS_PROJECT",
      allowed: false
    },
    {
      label: "upstream",
      targetReviewVersionId: "version-upstream",
      expectedCode: "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM",
      allowed: false
    },
    {
      label: "downstream",
      targetReviewVersionId: "version-downstream",
      expectedCode: null,
      allowed: true
    }
  ])(
    "residual defer_work validates $label target",
    ({ targetReviewVersionId, expectedCode, allowed }) => {
      const { source, known } = createRouteVersions();
      const result = evaluateCloseGate({
        version: source,
        todos: [],
        undos: [],
        knownVersions: known,
        residualAudit: [
          {
            kind: "debt",
            summary: "review later",
            destination: "defer_work",
            targetReviewVersionId
          }
        ]
      });

      expect(result.allowed).toBe(allowed);

      if (expectedCode !== null) {
        expect(result.blockers.map((blocker) => blocker.code)).toContain(
          expectedCode
        );
      }
    }
  );

  it("knownVersions 缺失时 existing Deferred 与 residual defer_work 都 fail closed", () => {
    const { source } = createRouteVersions();
    const existingResult = evaluateCloseGate({
      version: source,
      todos: [],
      undos: [],
      deferredItems: [
        createDeferredFixture({
          originVersionId: source.id,
          targetReviewVersionId: "version-downstream"
        })
      ],
      residualAudit: routedResidualAudit
    });
    const residualResult = evaluateCloseGate({
      version: source,
      todos: [],
      undos: [],
      residualAudit: [
        {
          kind: "debt",
          summary: "review later",
          destination: "defer_work",
          targetReviewVersionId: "version-downstream"
        }
      ]
    });

    expect(existingResult.allowed).toBe(false);
    expect(residualResult.allowed).toBe(false);
    expect(existingResult.blockers.map((blocker) => blocker.code)).toContain(
      "DEFERRED_ROUTE_CONTEXT_REQUIRED"
    );
    expect(residualResult.blockers.map((blocker) => blocker.code)).toContain(
      "DEFERRED_ROUTE_CONTEXT_REQUIRED"
    );
  });

  it("close gate directly blocks violated and evidence_missing Constraint checks", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: [],
      constraints: [
        createConstraintFixture({ id: "constraint-violated" }),
        createConstraintFixture({ id: "constraint-missing" })
      ],
      constraintChecks: [
        {
          constraintId: "constraint-violated",
          status: "violated"
        },
        {
          constraintId: "constraint-missing",
          status: "evidence_missing"
        }
      ],
      residualAudit: routedResidualAudit
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedConstraintIds).toEqual([
      "constraint-violated",
      "constraint-missing"
    ]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "CONSTRAINT_VIOLATED",
        "CONSTRAINT_EVIDENCE_MISSING"
      ])
    );
  });

  it("close gate ignores retired Constraint checks", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: [],
      constraints: [
        createConstraintFixture({
          status: "retired",
          retiredAt: "2026-06-27T00:00:00.000Z",
          retireReason: "superseded",
          retireNote: "decision:1"
        })
      ],
      constraintChecks: [
        {
          constraintId: "constraint-1",
          status: "violated"
        }
      ],
      residualAudit: routedResidualAudit
    });

    expect(result.allowed).toBe(true);
    expect(result.blockedConstraintIds).toEqual([]);
  });

  it("close gate fails closed for unknown and mismatched Constraint checks", () => {
    const result = evaluateCloseGate({
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: [],
      constraints: [
        createConstraintFixture({
          id: "constraint-other-version",
          scope: {
            type: "version",
            versionId: "version-9"
          }
        })
      ],
      constraintChecks: [
        {
          constraintId: "constraint-unknown",
          status: "satisfied"
        },
        {
          constraintId: "constraint-other-version",
          status: "satisfied"
        }
      ],
      residualAudit: routedResidualAudit
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "UNKNOWN_CONSTRAINT_GATE_CHECK",
        "MISMATCHED_CONSTRAINT_GATE_CHECK"
      ])
    );
  });

  it("legacy create_undo residual destination 保持原有校验", () => {
    const base = {
      version: createVersionFixture({ state: "complete" }),
      todos: [],
      undos: []
    };
    const invalid = evaluateCloseGate({
      ...base,
      residualAudit: [
        {
          kind: "debt",
          summary: "legacy route",
          destination: "create_undo"
        }
      ]
    });
    const valid = evaluateCloseGate({
      ...base,
      residualAudit: [
        {
          kind: "debt",
          summary: "legacy route",
          destination: "create_undo",
          preferredResolutionVersionId: "version-2"
        }
      ]
    });

    expect(invalid.allowed).toBe(false);
    expect(valid.allowed).toBe(true);
  });
});
