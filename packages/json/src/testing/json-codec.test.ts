import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ApprovalArtifact,
  PendingOperation,
  ProjectAggregateSnapshot,
  StoragePort
} from "@routeledger/core";
import { RouteLedgerService } from "@routeledger/core";
import { describe, expect, it } from "vitest";

import {
  decodeProjectAggregateFromJsonDocuments,
  encodeProjectAggregateToJsonDocuments,
  type RouteLedgerJsonDocument
} from "../index.js";
import {
  createDeferredConstraintJsonSnapshot,
  createJsonCodecSnapshot,
  shuffleSnapshotCollections
} from "./builders.js";
import { TEST_ACTOR, createTestDependencies } from "../../../core/src/testing/builders.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testDir, "fixtures", "canonical");

const readFixtureDocuments = (): RouteLedgerJsonDocument[] => {
  const documents: RouteLedgerJsonDocument[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      const relativePath = path.relative(fixtureRoot, entryPath).split(path.sep).join("/");
      documents.push({
        path: relativePath,
        content: fs.readFileSync(entryPath, "utf8")
      });
    }
  };

  visit(fixtureRoot);

  return documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
};

const collectObjectKeysDeep = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectObjectKeysDeep(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      key,
      ...collectObjectKeysDeep(entry)
    ]);
  }

  return [];
};

const normalizeSnapshot = (snapshot: ProjectAggregateSnapshot): ProjectAggregateSnapshot => ({
  ...snapshot,
  versions: [...snapshot.versions].sort((left, right) => left.id.localeCompare(right.id, "en")),
  workItems: [...snapshot.workItems].sort((left, right) => left.id.localeCompare(right.id, "en")),
  todos: [...snapshot.todos].sort((left, right) => left.id.localeCompare(right.id, "en")),
  undos: [...snapshot.undos].sort((left, right) => left.id.localeCompare(right.id, "en")),
  deferredItems: [...snapshot.deferredItems].sort((left, right) =>
    left.id.localeCompare(right.id, "en")
  ),
  constraints: [...snapshot.constraints].sort((left, right) =>
    left.id.localeCompare(right.id, "en")
  ),
  assets: [...snapshot.assets].sort((left, right) => left.id.localeCompare(right.id, "en")),
  events: [...snapshot.events].sort((left, right) => left.id.localeCompare(right.id, "en")),
  pendingOperations: [...snapshot.pendingOperations].sort((left, right) =>
    left.id.localeCompare(right.id, "en")
  ),
  approvalArtifacts: [...snapshot.approvalArtifacts].sort((left, right) =>
    left.id.localeCompare(right.id, "en")
  )
});

class MemoryStorageAdapter implements StoragePort {
  private snapshots = new Map<string, ProjectAggregateSnapshot>();

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    const snapshot = this.snapshots.get(projectId);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    this.snapshots.set(snapshot.project.id, structuredClone(snapshot));
  }
}

const createApprovedArtifact = async (
  service: RouteLedgerService,
  projectId: string,
  pendingOperationId: string
): Promise<ApprovalArtifact> =>
  service.approveL3Operation({
    projectId,
    pendingOperationId,
    approver: {
      id: "user-1",
      type: "user",
      displayName: "owner"
    },
    actor: TEST_ACTOR
  });

describe("@routeledger/json canonical codec", () => {
  it("encodes a snake_case canonical document set with stable paths", () => {
    const documents = encodeProjectAggregateToJsonDocuments(
      shuffleSnapshotCollections(createJsonCodecSnapshot())
    );
    const joinedContent = documents.map((document) => document.content).join("\n");

    expect(documents).toEqual(readFixtureDocuments());
    expect(documents.map((document) => document.path)).toEqual(
      [...documents.map((document) => document.path)].sort((left, right) =>
        left.localeCompare(right, "en")
      )
    );

    for (const document of documents) {
      expect(document.content.endsWith("\n")).toBe(true);
      expect(document.content.includes("\r")).toBe(false);
      expect(document.content).not.toContain("currentVersionId");
      expect(document.content).not.toContain("createdBy");
    }

    for (const camelCaseKey of [
      "projectId",
      "actionType",
      "targetId",
      "gateSnapshot",
      "unresolvedTodoIds",
      "unresolvedUndoIds",
      "residualAudit",
      "currentVersionId",
      "siblingVersionIds"
    ]) {
      expect(joinedContent).not.toContain(`"${camelCaseKey}"`);
    }

    for (const snakeCaseKey of [
      "project_id",
      "action_type",
      "target_id",
      "gate_snapshot",
      "unresolved_todo_ids",
      "unresolved_undo_ids",
      "residual_audit",
      "current_version_id",
      "sibling_version_ids"
    ]) {
      expect(joinedContent).toContain(`"${snakeCaseKey}"`);
    }

    const eventDocument = documents.find((document) => document.path.endsWith("/event-1.json"));
    expect(eventDocument).toBeDefined();

    const eventMetadata = (
      JSON.parse(eventDocument!.content) as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    const eventMetadataKeys = collectObjectKeysDeep(eventMetadata);

    for (const camelCaseKey of [
      "actionType",
      "targetId",
      "decisionRef",
      "expiresAt",
      "pendingOperationId"
    ]) {
      expect(eventMetadataKeys).not.toContain(camelCaseKey);
    }

    for (const snakeCaseKey of [
      "action_type",
      "target_id",
      "decision_ref",
      "expires_at",
      "pending_operation_id"
    ]) {
      expect(eventMetadataKeys).toContain(snakeCaseKey);
    }
  });

  it("repeated encode is byte-stable across collection ordering", () => {
    const snapshot = createJsonCodecSnapshot();
    const left = encodeProjectAggregateToJsonDocuments(snapshot);
    const right = encodeProjectAggregateToJsonDocuments(shuffleSnapshotCollections(snapshot));

    expect(left).toEqual(right);
  });

  it("round-trips DeferredItem and Constraint documents with stable canonical paths", () => {
    const snapshot = createDeferredConstraintJsonSnapshot();
    const documents = encodeProjectAggregateToJsonDocuments(snapshot);
    const shuffledDocuments = encodeProjectAggregateToJsonDocuments(
      shuffleSnapshotCollections(snapshot)
    );

    expect(documents).toEqual(shuffledDocuments);
    expect(documents.map((document) => document.path)).toEqual(
      expect.arrayContaining([
        ".routeledger/deferred_items/de/deferred-1.json",
        ".routeledger/constraints/co/constraint-1.json"
      ])
    );

    const decoded = decodeProjectAggregateFromJsonDocuments(documents);
    expect(normalizeSnapshot(decoded)).toEqual(normalizeSnapshot(snapshot));
    expect(encodeProjectAggregateToJsonDocuments(decoded)).toEqual(documents);
  });

  it("decodes legacy canonical sets without DeferredItem or Constraint documents as empty arrays", () => {
    const decoded = decodeProjectAggregateFromJsonDocuments(readFixtureDocuments());

    expect(decoded.deferredItems).toEqual([]);
    expect(decoded.constraints).toEqual([]);
  });

  it("decodes a legacy project without content_locale as unresolved null", () => {
    const documents = encodeProjectAggregateToJsonDocuments(createJsonCodecSnapshot()).map(
      (document) => {
        if (!document.path.endsWith("/project.json")) {
          return document;
        }

        const project = JSON.parse(document.content) as {
          settings: Record<string, unknown>;
        };
        delete project.settings.content_locale;
        return { ...document, content: `${JSON.stringify(project, null, 2)}\n` };
      }
    );

    const decoded = decodeProjectAggregateFromJsonDocuments(documents);

    expect(decoded.project.settings.contentLocale).toBeNull();
  });

  it("fails closed when direct decode receives malformed DeferredItem or Constraint documents", () => {
    const documents = encodeProjectAggregateToJsonDocuments(
      createDeferredConstraintJsonSnapshot()
    );
    const malformedDeferred = documents.map((document) => {
      if (!document.path.endsWith("/deferred-1.json")) {
        return document;
      }

      const value = JSON.parse(document.content) as Record<string, unknown>;
      delete value.title;
      return {
        ...document,
        content: `${JSON.stringify(value, null, 2)}\n`
      };
    });
    expect(() =>
      decodeProjectAggregateFromJsonDocuments(malformedDeferred)
    ).toThrow(/deferred_item document/);

    const malformedConstraint = documents.map((document) => {
      if (!document.path.endsWith("/constraint-1.json")) {
        return document;
      }

      const value = JSON.parse(document.content) as Record<string, unknown>;
      value.scope = {
        type: "version"
      };
      return {
        ...document,
        content: `${JSON.stringify(value, null, 2)}\n`
      };
    });
    expect(() =>
      decodeProjectAggregateFromJsonDocuments(malformedConstraint)
    ).toThrow(/constraint document/);
  });

  it("fails closed when direct decode receives invalid DeferredItem or Constraint lifecycle state", () => {
    const baseDocuments = encodeProjectAggregateToJsonDocuments(
      createDeferredConstraintJsonSnapshot()
    );
    const mutateDocument = (
      suffix: string,
      mutate: (value: Record<string, unknown>) => void
    ): RouteLedgerJsonDocument[] =>
      baseDocuments.map((document) => {
        if (!document.path.endsWith(suffix)) {
          return document;
        }

        const value = JSON.parse(document.content) as Record<string, unknown>;
        mutate(value);
        return {
          ...document,
          content: `${JSON.stringify(value, null, 2)}\n`
        };
      });

    expect(() =>
      decodeProjectAggregateFromJsonDocuments(
        mutateDocument("/deferred-1.json", (value) => {
          value.resolution_outcome = "activated";
        })
      )
    ).toThrow(/DEFERRED_PENDING_RESOLUTION_FIELDS_INVALID/);

    expect(() =>
      decodeProjectAggregateFromJsonDocuments(
        mutateDocument("/deferred-1.json", (value) => {
          value.status = "activated";
          value.resolution_outcome = "superseded";
          value.resolution_reason = "invalid activated outcome";
          value.resolution_note = "invalid activated outcome";
          value.reviewed_at = "2026-06-27T02:00:00.000Z";
        })
      )
    ).toThrow(/DEFERRED_ACTIVATED_OUTCOME_INVALID/);

    expect(() =>
      decodeProjectAggregateFromJsonDocuments(
        mutateDocument("/deferred-1.json", (value) => {
          value.status = "resolved";
          value.resolution_outcome = "activated";
          value.resolution_reason = "invalid resolved outcome";
          value.resolution_note = "invalid resolved outcome";
          value.reviewed_at = "2026-06-27T02:00:00.000Z";
        })
      )
    ).toThrow(/DEFERRED_RESOLVED_OUTCOME_INVALID/);

    expect(() =>
      decodeProjectAggregateFromJsonDocuments(
        mutateDocument("/constraint-1.json", (value) => {
          value.retired_at = "2026-06-27T02:00:00.000Z";
          value.retire_reason = "invalid active retirement";
          value.retire_note = "invalid active retirement";
        })
      )
    ).toThrow(/CONSTRAINT_ACTIVE_RETIREMENT_FIELDS_INVALID/);

    expect(() =>
      decodeProjectAggregateFromJsonDocuments(
        mutateDocument("/constraint-1.json", (value) => {
          value.status = "retired";
        })
      )
    ).toThrow(/CONSTRAINT_RETIREMENT_FIELDS_MISSING/);
  });

  it("decode round-trips snapshot semantics including pending operations and approval artifacts", () => {
    const fixtureDocuments = readFixtureDocuments();
    const decoded = decodeProjectAggregateFromJsonDocuments(fixtureDocuments);
    const expected = createJsonCodecSnapshot();

    expect(normalizeSnapshot(decoded)).toEqual(normalizeSnapshot(expected));
    expect(decoded.pendingOperations[0]?.approvalArtifactId).toBe("approval-1");
    expect(decoded.approvalArtifacts[0]?.pendingOperationId).toBe("pending-1");
    expect(decoded.events[0]?.metadata).toMatchObject({
      approvalMetadata: {
        decisionRef: "decision://routeledger/1",
        expiresAt: "2026-06-28T01:10:00.000Z",
        pendingOperationId: "pending-1"
      },
      nested: {
        actionType: "close_version",
        targetId: "version-2",
        approvals: [
          {
            decisionRef: "decision://routeledger/1",
            pendingOperationId: "pending-1"
          }
        ]
      }
    });

    const reencoded = encodeProjectAggregateToJsonDocuments(decoded);
    expect(reencoded).toEqual(fixtureDocuments);
  });

  it("batch pending operation payload JSON roundtrip does not drop batch fields", () => {
    const snapshot = createJsonCodecSnapshot();
    const batchPendingOperation: PendingOperation = {
      ...snapshot.pendingOperations[0]!,
      id: "pending-batch-1",
      actionType: "insert_version",
      targetId: snapshot.project.id,
      digest: {
        algorithm: "sha256",
        value: "batch-digest-1",
        payload: {
          projectId: snapshot.project.id,
          actionType: "insert_version",
          targetId: snapshot.project.id,
          payload: {
            batchItems: [
              {
                clientKey: "plan-a",
                title: "Plan A",
                description: "batch item A",
                initialTodos: ["write docs"]
              }
            ],
            batchAnchor: {
              afterVersionId: "version-2",
              beforeVersionId: null,
              parentVersionId: null
            },
            batchNormalizedPlan: [
              {
                index: 0,
                clientKey: "plan-a",
                previewVersionId: "batch-preview:0:plan-a",
                title: "Plan A",
                description: "batch item A",
                parentVersionId: null,
                previousRef: "version-2",
                nextRef: null,
                initialTodos: ["write docs"]
              }
            ],
            batchResolvedAnchors: {
              parentVersionId: null,
              afterVersionId: "version-2",
              beforeVersionId: null
            },
            batchSetCurrentTo: "plan-a",
            batchPreviousCurrentPolicy: "leave_as_is",
            batchPreflightSnapshotHash: "snapshot-hash-1"
          },
          gateSnapshot: {
            kind: "none",
            allowed: true,
            blockers: []
          }
        }
      },
      payload: {
        batchItems: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: ["write docs"]
          }
        ],
        batchAnchor: {
          afterVersionId: "version-2",
          beforeVersionId: null,
          parentVersionId: null
        },
        batchNormalizedPlan: [
          {
            index: 0,
            clientKey: "plan-a",
            previewVersionId: "batch-preview:0:plan-a",
            title: "Plan A",
            description: "batch item A",
            parentVersionId: null,
            previousRef: "version-2",
            nextRef: null,
            initialTodos: ["write docs"]
          }
        ],
        batchResolvedAnchors: {
          parentVersionId: null,
          afterVersionId: "version-2",
          beforeVersionId: null
        },
        batchSetCurrentTo: "plan-a",
        batchPreviousCurrentPolicy: "leave_as_is",
        batchPreflightSnapshotHash: "snapshot-hash-1"
      }
    };
    const batchSnapshot: ProjectAggregateSnapshot = {
      ...snapshot,
      pendingOperations: [batchPendingOperation]
    };

    const encoded = encodeProjectAggregateToJsonDocuments(batchSnapshot);
    const pendingDocument = encoded.find((document) => document.path.includes("pending_operations/"));
    expect(pendingDocument?.content).toContain("\"batch_items\"");
    expect(pendingDocument?.content).toContain("\"batch_anchor\"");
    expect(pendingDocument?.content).toContain("\"batch_normalized_plan\"");
    expect(pendingDocument?.content).toContain("\"batch_resolved_anchors\"");
    expect(pendingDocument?.content).toContain("\"batch_set_current_to\"");
    expect(pendingDocument?.content).toContain("\"batch_previous_current_policy\"");
    expect(pendingDocument?.content).toContain("\"batch_preflight_snapshot_hash\"");

    const decoded = decodeProjectAggregateFromJsonDocuments(encoded);
    expect(decoded.pendingOperations[0]?.payload).toEqual(batchPendingOperation.payload);
  });

  it("pending operation payload preserves explicit null preferredResolutionVersionId values", () => {
    const snapshot = createJsonCodecSnapshot();
    const pendingOperation: PendingOperation = {
      ...snapshot.pendingOperations[0]!,
      payload: {
        residualAudit: [
          {
            kind: "open_question",
            summary: "null should survive JSON hydrate",
            destination: "close",
            preferredResolutionVersionId: null
          }
        ]
      }
    };
    const encoded = encodeProjectAggregateToJsonDocuments({
      ...snapshot,
      pendingOperations: [pendingOperation]
    });
    const decoded = decodeProjectAggregateFromJsonDocuments(encoded);

    expect(decoded.pendingOperations[0]?.payload).toEqual(pendingOperation.payload);
    expect(
      decoded.pendingOperations[0]?.payload.residualAudit?.[0]?.preferredResolutionVersionId
    ).toBeNull();
  });

  it("pending close payload roundtrips the reviewed marker for an empty audit", () => {
    const snapshot = createJsonCodecSnapshot();
    const pendingOperation: PendingOperation = {
      ...snapshot.pendingOperations[0]!,
      payload: {
        residualAudit: [],
        residualAuditReviewed: true
      }
    };
    const encoded = encodeProjectAggregateToJsonDocuments({
      ...snapshot,
      pendingOperations: [pendingOperation]
    });
    const decoded = decodeProjectAggregateFromJsonDocuments(encoded);

    expect(decoded.pendingOperations[0]?.payload).toEqual(pendingOperation.payload);
    expect(
      encoded.find((document) => document.path.includes("pending_operations/"))?.content
    ).toContain("\"residual_audit_reviewed\": true");
  });

  it("pending operation payload roundtrips Deferred and Constraint residual destinations", () => {
    const snapshot = createJsonCodecSnapshot();
    const pendingOperation: PendingOperation = {
      ...snapshot.pendingOperations[0]!,
      payload: {
        residualAudit: [
          {
            kind: "open_question",
            summary: "review this in the next product version",
            destination: "defer_work",
            targetReviewVersionId: "version-2"
          },
          {
            kind: "risk",
            summary: "preserve the stop-write boundary",
            destination: "record_constraint"
          }
        ]
      }
    };
    const encoded = encodeProjectAggregateToJsonDocuments({
      ...snapshot,
      pendingOperations: [pendingOperation]
    });
    const pendingDocument = encoded.find((document) =>
      document.path.includes("pending_operations/")
    );
    const decoded = decodeProjectAggregateFromJsonDocuments(encoded);

    expect(pendingDocument?.content).toContain("\"defer_work\"");
    expect(pendingDocument?.content).toContain("\"record_constraint\"");
    expect(pendingDocument?.content).toContain("\"target_review_version_id\"");
    expect(decoded.pendingOperations[0]?.payload).toEqual(
      pendingOperation.payload
    );
  });

  it("batch proposal survives JSON encode/decode roundtrip and can still commit", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      actor: TEST_ACTOR
    });
    const proposed = await service.batchCreateVersions({
      projectId: created.project.id,
      mode: "propose",
      anchor: {
        afterVersionId: created.initialVersion.id
      },
      items: [
        {
          clientKey: "plan-a",
          title: "Plan A",
          description: "batch item A",
          initialTodos: ["write docs"]
        },
        {
          clientKey: "plan-b",
          title: "Plan B",
          description: "batch item B",
          initialTodos: []
        }
      ],
      setCurrentTo: "plan-b",
      previousCurrentPolicy: "leave_as_is",
      actor: TEST_ACTOR
    });

    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !("pendingOperationId" in proposed)) {
      throw new Error("expected propose success");
    }

    const artifact = await createApprovedArtifact(service, created.project.id, proposed.pendingOperationId);
    const beforeRoundtrip = await storage.loadProjectAggregate(created.project.id);
    const documents = encodeProjectAggregateToJsonDocuments(beforeRoundtrip!);
    const decodedSnapshot = decodeProjectAggregateFromJsonDocuments(documents);

    await storage.saveProjectAggregate(decodedSnapshot);
    await service.commitL3Operation({
      projectId: created.project.id,
      pendingOperationId: proposed.pendingOperationId,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });

    const afterCommit = await storage.loadProjectAggregate(created.project.id);
    const versions = afterCommit?.versions.slice().sort((left, right) => left.order - right.order) ?? [];

    expect(versions.map((version) => version.title)).toEqual([
      "Initial Version",
      "Plan A",
      "Plan B"
    ]);
    expect(afterCommit?.todos.map((todo) => todo.title)).toEqual(["write docs"]);
    expect(afterCommit?.project.currentVersionId).toBe(versions[2]?.id);
    expect(afterCommit?.pendingOperations[0]?.status).toBe("committed");
    expect(afterCommit?.approvalArtifacts[0]?.status).toBe("consumed");
  });

  it("round-trips carried-forward undo fields and shutdown gate snapshots", () => {
    const snapshot = createJsonCodecSnapshot();
    snapshot.undos[0] = {
      ...snapshot.undos[0]!,
      carriedForwardAt: "2026-06-27T02:00:00.000Z",
      carriedForwardToVersionId: "version-2"
    };
    snapshot.pendingOperations[0] = {
      ...snapshot.pendingOperations[0]!,
      id: "pending-shutdown-1",
      actionType: "shutdown_version",
      status: "pending",
      reason: "forced close for emergency stop",
      gateSnapshot: {
        kind: "shutdown",
        evaluatedAt: "2026-06-27T02:05:00.000Z",
        allowed: true,
        blockers: [],
        forced: true,
        stateReason: "shutdown:emergency_stop",
        ordinaryCloseGate: {
          allowed: false,
          blockers: [
            {
              code: "OPEN_TODOS",
              message: "still open",
              recordIds: ["todo-1"]
            }
          ],
          unresolvedTodoIds: ["todo-1"],
          unresolvedUndoIds: [],
          unresolvedDeferredIds: [],
          blockedConstraintIds: []
        }
      },
      digest: {
        algorithm: "sha256",
        value: "shutdown-digest-1",
        payload: {
          projectId: snapshot.project.id,
          actionType: "shutdown_version",
          targetId: "version-2",
          payload: {
            shutdownReason: "emergency_stop"
          },
          gateSnapshot: {
            kind: "shutdown",
            allowed: true,
            blockers: [],
            forced: true,
            stateReason: "shutdown:emergency_stop",
            ordinaryCloseGate: {
              allowed: false,
              blockers: [
                {
                  code: "OPEN_TODOS",
                  message: "still open",
                  recordIds: ["todo-1"]
                }
              ],
              unresolvedTodoIds: ["todo-1"],
              unresolvedUndoIds: []
            }
          }
        }
      },
      payload: {
        shutdownReason: "emergency_stop"
      }
    };

    const encoded = encodeProjectAggregateToJsonDocuments(snapshot);
    const decoded = decodeProjectAggregateFromJsonDocuments(encoded);

    expect(decoded.undos[0]).toMatchObject({
      carriedForwardAt: "2026-06-27T02:00:00.000Z",
      carriedForwardToVersionId: "version-2"
    });
    expect(decoded.pendingOperations[0]?.gateSnapshot).toMatchObject({
      kind: "shutdown",
      forced: true,
      stateReason: "shutdown:emergency_stop",
      ordinaryCloseGate: {
        unresolvedTodoIds: ["todo-1"],
        unresolvedDeferredIds: [],
        blockedConstraintIds: []
      }
    });
    expect(
      decoded.pendingOperations[0]?.digest.payload.gateSnapshot
    ).toMatchObject({
      kind: "shutdown",
      ordinaryCloseGate: {
        unresolvedDeferredIds: [],
        blockedConstraintIds: []
      }
    });
  });

  it("defaults legacy GateSnapshot Deferred/Constraint arrays and re-encodes required fields", () => {
    const closeSnapshot = createJsonCodecSnapshot();
    const startSnapshot = createJsonCodecSnapshot();
    startSnapshot.pendingOperations[0] = {
      ...startSnapshot.pendingOperations[0]!,
      actionType: "start_version",
      gateSnapshot: {
        kind: "start",
        evaluatedAt: "2026-06-27T02:10:00.000Z",
        allowed: false,
        blockers: [],
        openTodoIds: [],
        dueUndoIds: [],
        dueDeferredIds: ["deferred-legacy"],
        missingDecisionRefs: [],
        blockedConstraintIds: ["constraint-legacy"]
      },
      digest: {
        ...startSnapshot.pendingOperations[0]!.digest,
        payload: {
          gateSnapshot: {
            kind: "start",
            dueDeferredIds: ["deferred-legacy"],
            blockedConstraintIds: ["constraint-legacy"]
          }
        }
      }
    };

    for (const snapshot of [closeSnapshot, startSnapshot]) {
      const legacyDocuments = encodeProjectAggregateToJsonDocuments(snapshot).map(
        (document) => {
          if (
            !document.path.includes("/pending_operations/") &&
            !document.path.includes("/approval_artifacts/")
          ) {
            return document;
          }

          const value = JSON.parse(document.content) as Record<string, unknown>;
          const gateSnapshot = value.gate_snapshot as
            | Record<string, unknown>
            | undefined;
          if (gateSnapshot !== undefined) {
            delete gateSnapshot.due_deferred_ids;
            delete gateSnapshot.unresolved_deferred_ids;
            delete gateSnapshot.blocked_constraint_ids;
          }

          const digest = value.digest as Record<string, unknown>;
          const payload = digest.payload as Record<string, unknown>;
          const digestGate = payload.gate_snapshot as
            | Record<string, unknown>
            | undefined;
          if (digestGate !== undefined) {
            delete digestGate.due_deferred_ids;
            delete digestGate.unresolved_deferred_ids;
            delete digestGate.blocked_constraint_ids;
          }

          return {
            ...document,
            content: `${JSON.stringify(value, null, 2)}\n`
          };
        }
      );
      const decoded =
        decodeProjectAggregateFromJsonDocuments(legacyDocuments);
      const operation = decoded.pendingOperations[0]!;

      if (operation.gateSnapshot.kind === "start") {
        expect(operation.gateSnapshot.dueDeferredIds).toEqual([]);
        expect(operation.gateSnapshot.blockedConstraintIds).toEqual([]);
      } else if (operation.gateSnapshot.kind === "close") {
        expect(operation.gateSnapshot.unresolvedDeferredIds).toEqual([]);
        expect(operation.gateSnapshot.blockedConstraintIds).toEqual([]);
      }

      expect(operation.digest.payload.gateSnapshot).toMatchObject(
        operation.gateSnapshot.kind === "start"
          ? {
              dueDeferredIds: [],
              blockedConstraintIds: []
            }
          : {
              unresolvedDeferredIds: [],
              blockedConstraintIds: []
            }
      );
      const approval = decoded.approvalArtifacts[0];
      if (approval !== undefined) {
        const approvalGate = approval.digest.payload.gateSnapshot as {
          kind?: string;
        };
        expect(approvalGate).toMatchObject(
          approvalGate.kind === "start"
            ? {
                dueDeferredIds: [],
                blockedConstraintIds: []
              }
            : {
                unresolvedDeferredIds: [],
                blockedConstraintIds: []
              }
        );
      }

      const reencoded = encodeProjectAggregateToJsonDocuments(decoded);
      const pendingDocument = reencoded.find((document) =>
        document.path.includes("/pending_operations/")
      )!;
      expect(pendingDocument.content).toContain(
        operation.gateSnapshot.kind === "start"
          ? '"due_deferred_ids": []'
          : '"unresolved_deferred_ids": []'
      );
      expect(pendingDocument.content).toContain(
        '"blocked_constraint_ids": []'
      );
    }
  });
});
