import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryExactAuthorizationStore,
  RouteLedgerService
} from "../../../core/src/index.js";
import {
  createTestDependencies,
  createUndoFixture,
  createVersionFixture,
  createWorkItemFixture
} from "../../../core/src/testing/builders.js";
import {
  acquireRouteLedgerJsonWriteLock,
  getRouteLedgerJsonWriteLockInfo
} from "../../../json/src/index.js";
import { SQLiteStorageAdapter } from "../../../sqlite/src/index.js";
import { JsonFirstStorageAdapter } from "../json-first-storage.js";

const createTempProjectRoot = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-json-first-storage-"));

const cleanupProjectRoot = (projectRoot: string): void => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
};

const sortKeysForDigest = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysForDigest);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortKeysForDigest(
          (value as Record<string, unknown>)[key]
        );
        return result;
      }, {});
  }

  return value;
};

const buildLegacyStartDigest = (payload: Record<string, unknown>): string => {
  const legacyPayload = structuredClone(payload);
  const gateSnapshot = legacyPayload.gateSnapshot as Record<string, unknown>;
  delete gateSnapshot.dueDeferredIds;
  delete gateSnapshot.blockedConstraintIds;

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortKeysForDigest(legacyPayload)))
    .digest("hex");
};

const findCanonicalDocument = (
  projectRoot: string,
  collection: string,
  id: string
): string => {
  const collectionRoot = path.join(projectRoot, ".routeledger", collection);
  const stack = [collectionRoot];

  while (stack.length > 0) {
    const current = stack.pop()!;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
      } else if (entry.name === `${id}.json`) {
        return candidate;
      }
    }
  }

  throw new Error(`missing canonical document ${collection}/${id}`);
};

const rewriteAsLegacyStartDigest = (
  documentPath: string,
  digestValue: string
): void => {
  const document = JSON.parse(fs.readFileSync(documentPath, "utf8")) as Record<
    string,
    unknown
  >;
  const gateSnapshot = document.gate_snapshot as
    | Record<string, unknown>
    | undefined;
  delete gateSnapshot?.due_deferred_ids;
  delete gateSnapshot?.blocked_constraint_ids;
  const digest = document.digest as Record<string, unknown>;
  digest.value = digestValue;
  const payload = digest.payload as Record<string, unknown>;
  const digestGate = payload.gate_snapshot as Record<string, unknown>;
  delete digestGate.due_deferred_ids;
  delete digestGate.blocked_constraint_ids;
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
};

const forgeAuthorizationProvenance = (documentPath: string): void => {
  const document = JSON.parse(fs.readFileSync(documentPath, "utf8")) as Record<
    string,
    unknown
  >;
  document.authorization_grant_id = "forged-grant";
  document.approval_source = "delegated_policy";
  document.policy_id = "forged-policy";
  document.policy_digest = "sha256:forged-policy";
  document.host_kind = "codex";
  document.client_id = null;
  document.session_id = null;
  document.decision_ref = "forged-decision";
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
};

const writePreD2aSchemaManifest = (projectRoot: string): void => {
  const schemaPath = path.join(
    projectRoot,
    ".routeledger",
    "schema",
    "routeledger.schema.json"
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    documents: Array<{ kind: string }>;
  };
  schema.documents = schema.documents.filter(
    (document) =>
      document.kind !== "deferred_item" && document.kind !== "constraint"
  );
  fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
};

const createJsonFirstService = (
  workspaceRoot: string,
  routeledgerRoot: string = workspaceRoot,
  deps = createTestDependencies()
) => {
  const storage = new JsonFirstStorageAdapter({
    workspaceRoot,
    routeledgerRoot
  });
  const service = new RouteLedgerService({
    storage,
    deps
  });

  return {
    storage,
    service
  };
};

describe("JsonFirstStorageAdapter", () => {
  it("rejects forged trusted provenance added to a true legacy canonical JSON artifact", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);
    let sqliteStorage: SQLiteStorageAdapter | null = null;

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "Legacy digest",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      await service.prepareVersion({
        projectId: created.project.id,
        versionId: created.firstVersion!.id,
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      const proposal = await service.proposeL3Operation({
        projectId: created.project.id,
        actionType: "start_version",
        targetId: created.firstVersion!.id,
        reason: "legacy JSON compatibility",
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      const approval = await service.approveL3Operation({
        projectId: created.project.id,
        pendingOperationId: proposal.id,
        approver: {
          id: "owner-1",
          type: "user"
        },
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      const legacyDigest = buildLegacyStartDigest(
        proposal.digest.payload as Record<string, unknown>
      );
      expect(legacyDigest).not.toBe(proposal.digest.value);

      rewriteAsLegacyStartDigest(
        findCanonicalDocument(
          projectRoot,
          "pending_operations",
          proposal.id
        ),
        legacyDigest
      );
      forgeAuthorizationProvenance(
        findCanonicalDocument(projectRoot, "approval_artifacts", approval.id)
      );
      rewriteAsLegacyStartDigest(
        findCanonicalDocument(
          projectRoot,
          "approval_artifacts",
          approval.id
        ),
        legacyDigest
      );

      sqliteStorage = new SQLiteStorageAdapter({ projectRoot });
      const pendingRow = sqliteStorage.db
        .prepare<
          [string],
          { gate_snapshot_json: string; digest_json: string }
        >(
          "SELECT gate_snapshot_json, digest_json FROM pending_operations WHERE id = ?"
        )
        .get(proposal.id);
      const pendingGateSnapshot = JSON.parse(
        pendingRow!.gate_snapshot_json
      ) as Record<string, unknown>;
      delete pendingGateSnapshot.dueDeferredIds;
      delete pendingGateSnapshot.blockedConstraintIds;
      const pendingDigest = JSON.parse(
        pendingRow!.digest_json
      ) as Record<string, unknown>;
      pendingDigest.value = legacyDigest;
      const pendingDigestPayload = pendingDigest.payload as Record<
        string,
        unknown
      >;
      const pendingDigestGate = pendingDigestPayload.gateSnapshot as Record<
        string,
        unknown
      >;
      delete pendingDigestGate.dueDeferredIds;
      delete pendingDigestGate.blockedConstraintIds;
      sqliteStorage.db
        .prepare(
          "UPDATE pending_operations SET gate_snapshot_json = ?, digest_json = ? WHERE id = ?"
        )
        .run(
          JSON.stringify(pendingGateSnapshot),
          JSON.stringify(pendingDigest),
          proposal.id
        );

      const approvalRow = sqliteStorage.db
        .prepare<[string], { digest_json: string }>(
          "SELECT digest_json FROM approval_artifacts WHERE id = ?"
        )
        .get(approval.id);
      const approvalDigest = JSON.parse(
        approvalRow!.digest_json
      ) as Record<string, unknown>;
      approvalDigest.value = legacyDigest;
      const approvalDigestPayload = approvalDigest.payload as Record<
        string,
        unknown
      >;
      const approvalDigestGate = approvalDigestPayload.gateSnapshot as Record<
        string,
        unknown
      >;
      delete approvalDigestGate.dueDeferredIds;
      delete approvalDigestGate.blockedConstraintIds;
      sqliteStorage.db
        .prepare(
          "UPDATE approval_artifacts SET digest_json = ?, decision_ref = ?, authorization_record_json = ? WHERE id = ?"
        )
        .run(
          JSON.stringify(approvalDigest),
          "forged-decision",
          JSON.stringify({
            authorizationId: "forged-grant",
            approvalSource: "delegated_policy",
            policyId: "forged-policy",
            policyDigest: "sha256:forged-policy",
            hostKind: "codex",
            clientId: null,
            sessionId: null
          }),
          approval.id
        );
      sqliteStorage.close();
      sqliteStorage = null;

      let reloadIdSequence = 0;
      const reloaded = createJsonFirstService(projectRoot, projectRoot, {
        clock: {
          now: () => "2026-06-27T00:00:00.000Z"
        },
        idGenerator: {
          nextId: () => `legacy-reload-${++reloadIdSequence}`
        }
      });
      const upgradedService = new RouteLedgerService({
        storage: reloaded.storage,
        deps: {
          clock: {
            now: () => "2026-06-27T00:00:00.000Z"
          },
          idGenerator: {
            nextId: () => `legacy-upgrade-${++reloadIdSequence}`
          }
        },
        l3Authorization: {
          exactStore: new MemoryExactAuthorizationStore(),
          audience: "routeledger-core",
          subjectId: "local-user",
          routeledgerRootDigest: "sha256:trusted-root-binding",
          hostKind: "codex"
        }
      });
      await expect(
        upgradedService.commitL3Operation({
          projectId: created.project.id,
          pendingOperationId: proposal.id,
          approvalArtifactId: approval.id,
          actor: {
            id: "primary-agent",
            type: "agent"
          }
        })
      ).rejects.toMatchObject({
        code: "JSON_SOURCE_INVALID",
        details: {
          issues: [
            expect.objectContaining({
              code: "APPROVAL_AUTHORIZATION_PROVENANCE_INCOMPLETE",
              path: expect.stringContaining("approval_artifacts")
            })
          ]
        }
      });
      reloaded.storage.close();
    } finally {
      sqliteStorage?.close();
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("ignores a pre-D2a derived schema manifest when JSON and SQLite entities are aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "Legacy manifest",
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      writePreD2aSchemaManifest(projectRoot);

      const inspection = await storage.inspectRuntimeBinding();
      expect(inspection.storageMode).toBe("json+sqlite");
      expect(inspection.conflict).toBeNull();

      await expect(
        storage.loadProjectAggregate(created.project.id)
      ).resolves.toMatchObject({
        project: {
          id: created.project.id
        }
      });

      const sqliteStorage = new SQLiteStorageAdapter({ projectRoot });

      try {
        sqliteStorage.db
          .prepare(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?"
          )
          .run(
            "Different entity data",
            "2026-07-02T00:00:00.000Z",
            created.project.id
          );

        const conflictingInspection = await storage.inspectRuntimeBinding();
        expect(conflictingInspection.storageMode).toBe("conflict");
        expect(conflictingInspection.conflict).toMatchObject({
          details: {
            differingDocumentPaths: [".routeledger/project.json"]
          }
        });
      } finally {
        sqliteStorage.close();
      }
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("rebuilds SQLite from JSON with a pre-D2a manifest and succeeds again on the second read", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "Legacy JSON only",
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      writePreD2aSchemaManifest(projectRoot);
      fs.rmSync(path.join(projectRoot, ".routeledger", "db"), {
        recursive: true,
        force: true
      });

      const first = await storage.loadProjectAggregate(created.project.id);
      const second = await storage.loadProjectAggregate(created.project.id);

      expect(first?.project.id).toBe(created.project.id);
      expect(second?.project.id).toBe(created.project.id);
      expect(
        fs.existsSync(
          path.join(
            projectRoot,
            ".routeledger",
            "db",
            "routeledger.sqlite3"
          )
        )
      ).toBe(true);
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("syncs DeferredItem and Constraint JSON to SQLite and uses their timestamps for freshness", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);
    const sqliteStorage = new SQLiteStorageAdapter({
      projectRoot
    });

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });
      const snapshot = await storage.loadProjectAggregate(created.project.id);
      expect(snapshot).not.toBeNull();

      snapshot!.workItems.push({
        id: "work-item-deferred-1",
        projectId: created.project.id,
        title: "Persist Deferred",
        type: "other",
        status: "active",
        originVersionId: created.firstVersion!.id,
        activeRecordType: "deferred",
        activeRecordId: "deferred-1",
        createdBy: created.project.createdBy,
        createdAt: "2026-06-27T01:00:00.000Z",
        updatedAt: "2026-06-27T01:00:00.000Z",
        closedAt: null,
        summary: "Persist Deferred"
      });
      snapshot!.deferredItems.push({
        id: "deferred-1",
        projectId: created.project.id,
        workItemId: "work-item-deferred-1",
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: created.firstVersion!.id,
        title: "Persist Deferred",
        description: "",
        status: "pending",
        reason: "review later",
        reviewTrigger: null,
        resolutionOutcome: null,
        resolutionReason: null,
        resolutionNote: null,
        decisionRef: null,
        activatedTodoId: null,
        createdBy: created.project.createdBy,
        createdAt: "2026-06-27T01:00:00.000Z",
        updatedAt: "2026-06-27T01:00:00.000Z",
        reviewedAt: null
      });
      snapshot!.constraints.push({
        id: "constraint-1",
        projectId: created.project.id,
        rule: "Canonical constraint",
        rationale: "freshness test",
        scope: {
          type: "project"
        },
        status: "active",
        createdBy: created.project.createdBy,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        retiredAt: null,
        retireReason: null,
        retireNote: null
      });

      await storage.saveProjectAggregate(snapshot!);
      expect(
        fs.existsSync(
          path.join(projectRoot, ".routeledger", "deferred_items", "de", "deferred-1.json")
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(projectRoot, ".routeledger", "constraints", "co", "constraint-1.json")
        )
      ).toBe(true);

      sqliteStorage.db
        .prepare(
          "UPDATE constraints SET rule = ?, updated_at = ? WHERE id = ?"
        )
        .run("Stale SQLite constraint", "2026-06-28T00:00:00.000Z", "constraint-1");

      const loaded = await storage.loadProjectAggregate(created.project.id);
      expect(loaded?.deferredItems[0]?.id).toBe("deferred-1");
      expect(loaded?.constraints[0]?.rule).toBe("Canonical constraint");
      expect(
        (
          sqliteStorage.db
            .prepare("SELECT rule FROM constraints WHERE id = ?")
            .get("constraint-1") as { rule: string }
        ).rule
      ).toBe("Canonical constraint");
    } finally {
      storage.close();
      sqliteStorage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("reloads Deferred/Constraint application commands from canonical JSON and SQLite", async () => {
    const projectRoot = createTempProjectRoot();
    const runtime = createJsonFirstService(projectRoot);
    let reloaded: ReturnType<typeof createJsonFirstService> | null = null;

    try {
      const created = await runtime.service.initProject({
      contentLocale: "en",
        name: "JSON-first application commands",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent"
        }
      });
      const snapshot = await runtime.storage.loadProjectAggregate(
        created.project.id
      );
      expect(snapshot).not.toBeNull();
      const reviewVersion = createVersionFixture({
        id: "json-first-review-version",
        projectId: created.project.id,
        title: "JSON-first review version",
        state: "wait",
        order: 2,
        previousVersionId: created.firstVersion!.id,
        nextVersionId: null,
        isCurrent: false
      });
      snapshot!.versions = [
        {
          ...snapshot!.versions[0]!,
          nextVersionId: reviewVersion.id
        },
        reviewVersion
      ];
      await runtime.storage.saveProjectAggregate(snapshot!);

      const deferred = await runtime.service.deferWork({
        mode: "new",
        projectId: created.project.id,
        originVersionId: created.firstVersion!.id,
        targetReviewVersionId: reviewVersion.id,
        title: "JSON-first deferred command",
        reason: "Review downstream",
        actor: created.project.createdBy
      });
      const constraint = await runtime.service.recordConstraint({
        projectId: created.project.id,
        rule: "JSON-first constraint command",
        rationale: "Exercise the application storage boundary",
        scope: {
          type: "version",
          versionId: reviewVersion.id
        },
        actor: created.project.createdBy
      });
      await runtime.service.retireConstraint({
        projectId: created.project.id,
        constraintId: constraint.constraint.id,
        reason: "Constraint superseded",
        note: "Retired before reload",
        actor: created.project.createdBy
      });
      const activated = await runtime.service.reviewDeferred({
        action: "activate",
        projectId: created.project.id,
        deferredId: deferred.deferred.id,
        targetVersionId: reviewVersion.id,
        reason: "Activate before reload",
        actor: created.project.createdBy
      });
      if (activated.action !== "activate") {
        throw new Error("expected activate review result");
      }

      reloaded = createJsonFirstService(projectRoot, projectRoot, {
        clock: {
          now: () => "2026-06-27T00:00:00.000Z"
        },
        idGenerator: {
          nextId: () => "json-first-reload-unused"
        }
      });
      const loaded = await reloaded.storage.loadProjectAggregate(
        created.project.id
      );

      expect(loaded?.deferredItems).toContainEqual(activated.deferred);
      expect(loaded?.todos).toContainEqual(activated.todo);
      expect(loaded?.workItems).toContainEqual(activated.workItem);
      expect(
        loaded?.constraints.find(
          (item) => item.id === constraint.constraint.id
        )
      ).toMatchObject({
        status: "retired",
        retireReason: "Constraint superseded",
        retireNote: "Retired before reload"
      });
      expect(
        fs.existsSync(
          findCanonicalDocument(
            projectRoot,
            "deferred_items",
            deferred.deferred.id
          )
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          findCanonicalDocument(
            projectRoot,
            "constraints",
            constraint.constraint.id
          )
        )
      ).toBe(true);
    } finally {
      reloaded?.storage.close();
      runtime.storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("returns STALE_SNAPSHOT instead of overwriting a newer canonical head", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);
    const competitorStorage = new JsonFirstStorageAdapter({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });

      const staleSnapshot = await storage.loadProjectAggregate(created.project.id);
      const freshSnapshot = await competitorStorage.loadProjectAggregate(created.project.id);

      expect(staleSnapshot).not.toBeNull();
      expect(freshSnapshot).not.toBeNull();

      freshSnapshot!.project.name = "Updated By Competitor";
      await competitorStorage.saveProjectAggregate(freshSnapshot!);

      staleSnapshot!.project.description = "stale overwrite attempt";

      await expect(storage.saveProjectAggregate(staleSnapshot!)).rejects.toMatchObject({
        code: "STALE_SNAPSHOT",
        details: {
          routeledgerRoot: path.resolve(projectRoot),
          projectId: created.project.id
        }
      });
    } finally {
      storage.close();
      competitorStorage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("returns STALE_SNAPSHOT and preserves an externally edited schema manifest", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });
      const staleSnapshot = await storage.loadProjectAggregate(created.project.id);
      expect(staleSnapshot).not.toBeNull();

      const schemaPath = path.join(
        projectRoot,
        ".routeledger",
        "schema",
        "routeledger.schema.json"
      );
      const externalSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<
        string,
        unknown
      >;
      externalSchema.external_marker = "edited outside RouteLedger";
      const externalSchemaContent = `${JSON.stringify(externalSchema, null, 2)}\n`;
      fs.writeFileSync(schemaPath, externalSchemaContent, "utf8");

      staleSnapshot!.project.description = "must not overwrite external schema";
      await expect(storage.saveProjectAggregate(staleSnapshot!)).rejects.toMatchObject({
        code: "STALE_SNAPSHOT"
      });
      expect(fs.readFileSync(schemaPath, "utf8")).toBe(externalSchemaContent);
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("stores canonical JSON, SQLite, and write locks under routeledgerRoot when workspaceRoot differs", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const { storage, service } = createJsonFirstService(workspaceRoot, routeledgerRoot);

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "Split Root",
        actor: {
          id: "split-root-agent",
          type: "agent",
          displayName: "split-root-agent"
        }
      });

      const inspection = await storage.inspectRuntimeBinding();
      expect(inspection).toMatchObject({
        workspaceRoot,
        routeledgerRoot,
        dataRoot: routeledgerRoot,
        routeledgerDir: path.join(routeledgerRoot, ".routeledger"),
        jsonProjectPath: path.join(routeledgerRoot, ".routeledger", "project.json"),
        sqliteDbPath: path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3"),
        storageMode: "json+sqlite",
        activeProject: {
          id: created.project.id,
          source: "canonical_json"
        }
      });
      expect(fs.existsSync(path.join(routeledgerRoot, ".routeledger", "project.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3"))
      ).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(false);

      const writeLock = await acquireRouteLedgerJsonWriteLock(routeledgerRoot, {
        ownerId: "split-root-writer",
        retryAfterMs: 175,
        staleAfterMs: 12_000
      });

      try {
        const busyInspection = await storage.inspectRuntimeBinding();
        expect(busyInspection.writeLock).toMatchObject({
          projectRoot: routeledgerRoot,
          lockPath: path.join(routeledgerRoot, ".routeledger", ".write-lock"),
          ownerId: "split-root-writer",
          retryAfterMs: 175,
          staleAfterMs: 12_000
        });

        await expect(storage.loadProjectAggregate(created.project.id)).rejects.toMatchObject({
          code: "WRITE_IN_PROGRESS",
          details: {
            routeledgerRoot
          }
        });
      } finally {
        await writeLock.release();
      }
    } finally {
      storage.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("returns WRITE_IN_PROGRESS for reads and writes while another writer lock is active", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });

      const snapshot = await storage.loadProjectAggregate(created.project.id);
      expect(snapshot).not.toBeNull();

      const writeLock = await acquireRouteLedgerJsonWriteLock(projectRoot, {
        ownerId: "competing-writer",
        retryAfterMs: 400,
        staleAfterMs: 30_000
      });

      try {
        await expect(storage.loadProjectAggregate(created.project.id)).rejects.toMatchObject({
          code: "WRITE_IN_PROGRESS",
          details: {
            routeledgerRoot: path.resolve(projectRoot),
            retryAfterMs: 400,
            staleAfterMs: 30_000
          }
        });

        snapshot!.project.description = "write during lock";

        await expect(storage.saveProjectAggregate(snapshot!)).rejects.toMatchObject({
          code: "WRITE_IN_PROGRESS",
          details: {
            routeledgerRoot: path.resolve(projectRoot),
            retryAfterMs: 400,
            staleAfterMs: 30_000
          }
        });
      } finally {
        await writeLock.release();
      }
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("recovers a stale writer lock so later reads and writes do not stay permanently busy", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });
      const writeLock = await acquireRouteLedgerJsonWriteLock(projectRoot, {
        ownerId: "stale-writer",
        retryAfterMs: 150,
        staleAfterMs: 5
      });

      const metadataPath = path.join(writeLock.lockPath, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        updatedAt: string;
      };
      metadata.updatedAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const recoveredSnapshot = await storage.loadProjectAggregate(created.project.id);
      expect(recoveredSnapshot).not.toBeNull();
      expect(await getRouteLedgerJsonWriteLockInfo(projectRoot)).toBeNull();

      recoveredSnapshot!.project.description = "post-stale-lock write";
      await expect(storage.saveProjectAggregate(recoveredSnapshot!)).resolves.toBeUndefined();
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("recovers a stale corrupt lock metadata so a later write can continue", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);

    try {
      const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });
      const writeLock = await acquireRouteLedgerJsonWriteLock(projectRoot, {
        ownerId: "corrupt-writer",
        retryAfterMs: 150,
        staleAfterMs: 5
      });

      fs.writeFileSync(path.join(writeLock.lockPath, "metadata.json"), "{bad-json", "utf8");
      fs.utimesSync(
        writeLock.lockPath,
        new Date("2000-01-01T00:00:00.000Z"),
        new Date("2000-01-01T00:00:00.000Z")
      );

      const recoveredSnapshot = await storage.loadProjectAggregate(created.project.id);
      expect(recoveredSnapshot).not.toBeNull();
      expect(await getRouteLedgerJsonWriteLockInfo(projectRoot)).toBeNull();

      recoveredSnapshot!.project.description = "post-corrupt-lock write";
      await expect(storage.saveProjectAggregate(recoveredSnapshot!)).resolves.toBeUndefined();
    } finally {
      storage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("treats missing SQLite carry-forward undo fields as a JSON/SQLite conflict instead of aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);
    const sqliteStorage = new SQLiteStorageAdapter({
      projectRoot
    });

    try {
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });

      const snapshot = await storage.loadProjectAggregate(created.project.id);
      expect(snapshot).not.toBeNull();

      snapshot!.project.updatedAt = "2026-06-27T01:00:00.000Z";
      snapshot!.versions = [
        {
          ...snapshot!.versions[0]!,
          nextVersionId: "version-2",
          updatedAt: "2026-06-27T01:00:00.000Z"
        },
        createVersionFixture({
          id: "version-2",
          projectId: created.project.id,
          title: "Downstream",
          previousVersionId: created.firstVersion!.id,
          order: 2,
          createdAt: "2026-06-27T01:00:00.000Z",
          updatedAt: "2026-06-27T01:00:00.000Z"
        })
      ];
      snapshot!.workItems.push(
        createWorkItemFixture({
          id: "work-item-undo-1",
          projectId: created.project.id,
          originVersionId: created.firstVersion!.id,
          activeRecordType: "undo",
          activeRecordId: "undo-1",
          summary: "Carry-forwarded undo"
        })
      );
      snapshot!.undos.push(
        createUndoFixture({
          id: "undo-1",
          projectId: created.project.id,
          workItemId: "work-item-undo-1",
          versionId: created.firstVersion!.id,
          originVersionId: created.firstVersion!.id,
          preferredResolutionVersionId: "version-2",
          title: "Carry-forwarded undo",
          carriedForwardAt: "2026-06-27T01:00:00.000Z",
          carriedForwardToVersionId: "version-2"
        })
      );

      await storage.saveProjectAggregate(snapshot!);

      sqliteStorage.db
        .prepare(
          `UPDATE undos
           SET carried_forward_at = NULL,
               carried_forward_to_version_id = NULL
           WHERE id = ?`
        )
        .run("undo-1");

      const runtimeBinding = await storage.inspectRuntimeBinding();

      expect(runtimeBinding.storageMode).toBe("conflict");
      expect(runtimeBinding.conflict).toMatchObject({
        details: {
          canonicalProjectId: created.project.id,
          sqliteProjectId: created.project.id,
          differingDocumentPaths: [".routeledger/undos/un/undo-1.json"]
        }
      });

      await expect(storage.loadProjectAggregate(created.project.id)).rejects.toMatchObject({
        code: "JSON_SQLITE_CONFLICT",
        details: {
          differingDocumentPaths: [".routeledger/undos/un/undo-1.json"]
        }
      });
    } finally {
      storage.close();
      sqliteStorage.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("does not rebuild SQLite from stale JSON when a child row is newer than project.updated_at", async () => {
    const projectRoot = createTempProjectRoot();
    const { storage, service } = createJsonFirstService(projectRoot);
    const sqliteStorage = new SQLiteStorageAdapter({
      projectRoot
    });

    try {
      const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: {
          id: "primary-agent",
          type: "agent",
          displayName: "primary-agent"
        }
      });

      const snapshot = await storage.loadProjectAggregate(created.project.id);
      expect(snapshot).not.toBeNull();

      snapshot!.project.updatedAt = "2026-06-27T01:00:00.000Z";
      snapshot!.versions = [
        {
          ...snapshot!.versions[0]!,
          nextVersionId: "version-2",
          updatedAt: "2026-06-27T01:00:00.000Z"
        },
        createVersionFixture({
          id: "version-2",
          projectId: created.project.id,
          title: "Downstream",
          previousVersionId: created.firstVersion!.id,
          order: 2,
          createdAt: "2026-06-27T01:00:00.000Z",
          updatedAt: "2026-06-27T01:00:00.000Z"
        })
      ];
      snapshot!.workItems.push(
        createWorkItemFixture({
          id: "work-item-undo-1",
          projectId: created.project.id,
          originVersionId: created.firstVersion!.id,
          activeRecordType: "undo",
          activeRecordId: "undo-1",
          summary: "Carry-forwarded undo"
        })
      );
      snapshot!.undos.push(
        createUndoFixture({
          id: "undo-1",
          projectId: created.project.id,
          workItemId: "work-item-undo-1",
          versionId: created.firstVersion!.id,
          originVersionId: created.firstVersion!.id,
          preferredResolutionVersionId: "version-2",
          title: "Carry-forwarded undo",
          updatedAt: "2026-06-27T01:00:00.000Z"
        })
      );

      await storage.saveProjectAggregate(snapshot!);

      sqliteStorage.db
        .prepare(
          `UPDATE undos
           SET title = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run("SQLite newer undo", "2026-06-27T02:00:00.000Z", "undo-1");

      await expect(storage.loadProjectAggregate(created.project.id)).rejects.toMatchObject({
        code: "JSON_SQLITE_CONFLICT",
        details: {
          differingDocumentPaths: [".routeledger/undos/un/undo-1.json"]
        }
      });

      const sqliteUndoRow = sqliteStorage.db
        .prepare<[], { title: string; updated_at: string }>(
          "SELECT title, updated_at FROM undos WHERE id = 'undo-1'"
        )
        .get();

      expect(sqliteUndoRow).toMatchObject({
        title: "SQLite newer undo",
        updated_at: "2026-06-27T02:00:00.000Z"
      });
    } finally {
      storage.close();
      sqliteStorage.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
