import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { expect } from "vitest";

import type {
  ApprovalArtifact,
  DocumentSourcePort,
  ProjectAggregateSnapshot,
  RouteLedgerService,
  StoragePort
} from "../index.js";
import {
  TEST_ACTOR
} from "./builders.js";

export class MemoryStorageAdapter implements StoragePort {
  private snapshots = new Map<string, ProjectAggregateSnapshot>();

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    const snapshot = this.snapshots.get(projectId);

    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    this.snapshots.set(snapshot.project.id, structuredClone(snapshot));
  }

  async mutate(
    projectId: string,
    updater: (snapshot: ProjectAggregateSnapshot) => ProjectAggregateSnapshot
  ): Promise<void> {
    const snapshot = this.snapshots.get(projectId);

    if (snapshot === undefined) {
      throw new Error(`missing project ${projectId}`);
    }

    this.snapshots.set(projectId, structuredClone(updater(structuredClone(snapshot))));
  }
}

export class MemoryDocumentSource implements DocumentSourcePort {
  private readonly documents = new Map<string, string>();

  private readonly readErrors = new Map<string, Error>();

  setDocument(path: string, content: string): void {
    this.readErrors.delete(path);
    this.documents.set(path, content);
  }

  setReadError(path: string, error: Error & { code?: string }): void {
    this.documents.delete(path);
    this.readErrors.set(path, error);
  }

  async readUtf8(path: string): Promise<string> {
    const injected = this.readErrors.get(path);
    if (injected !== undefined) {
      throw injected;
    }

    const content = this.documents.get(path);
    if (content !== undefined) {
      return content;
    }

    const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    throw error;
  }
}

export class FailOnSaveStorageAdapter extends MemoryStorageAdapter {
  private failNextSave = false;

  failOnce(): void {
    this.failNextSave = true;
  }

  override async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }

    await super.saveProjectAggregate(snapshot);
  }
}

export class LossyPendingOperationStorageAdapter extends MemoryStorageAdapter {
  override async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    const lossySnapshot = structuredClone(snapshot);

    for (const operation of lossySnapshot.pendingOperations) {
      delete operation.payload.fromVersionId;
      delete operation.payload.setAsCurrent;
    }

    await super.saveProjectAggregate(lossySnapshot);
  }
}

export class MissingPendingOperationStorageAdapter extends MemoryStorageAdapter {
  override async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    const lossySnapshot = structuredClone(snapshot);

    if (lossySnapshot.pendingOperations.length > 0) {
      lossySnapshot.pendingOperations = [];
    }

    await super.saveProjectAggregate(lossySnapshot);
  }
}

export const createTempProjectRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-core-"));

export const cleanupProjectRoot = (projectRoot: string): void => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
};

export const stableTestStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableTestStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableTestStringify(entry)}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

export const legacyStartDigestValue = (
  digestPayload: ApprovalArtifact["digest"]["payload"]
): string => {
  const legacyPayload = structuredClone(digestPayload);
  const gateSnapshot = legacyPayload.gateSnapshot as {
    kind?: string;
  };

  if (gateSnapshot.kind !== "start") {
    throw new Error("expected start gate digest");
  }

  const legacyGate = gateSnapshot as unknown as Record<
    string,
    unknown
  >;
  delete legacyGate.dueDeferredIds;
  delete legacyGate.blockedConstraintIds;

  return crypto
    .createHash("sha256")
    .update(stableTestStringify(legacyPayload))
    .digest("hex");
};

export const createPreparedProject = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter
) => {
  const created = await service.initProject({
    contentLocale: "en",
    name: "RouteLedger",
    firstVersion: {
      title: "Initial Version",
      description: "Project bootstrap version",
      initialTodos: []
    },
    actor: TEST_ACTOR
  });
  await service.prepareVersion({
    projectId: created.project.id,
    versionId: created.firstVersion!.id,
    actor: TEST_ACTOR
  });
  const snapshot = await storage.loadProjectAggregate(created.project.id);

  return {
    created,
    projectId: created.project.id,
    versionId: created.firstVersion!.id,
    snapshot: snapshot!
  };
};

export const createApprovedArtifact = async (
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

export const startPreparedVersion = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string
) => {
  const proposal = await service.proposeL3Operation({
    projectId,
    actionType: "start_version",
    targetId: versionId,
    reason: "start current version",
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.id);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.id,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

export const closeVersionThroughL3 = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string,
  residualAudit = [
    {
      kind: "debt" as const,
      summary: "none",
      destination: "close" as const
    }
  ]
) => {
  const proposal = await service.closeVersionWorkflow({
    projectId,
    versionId,
    mode: "propose",
    residualAudit,
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.pendingOperationId!);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.pendingOperationId!,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

export const completeCurrentVersion = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter,
  setupWhileRunning?: (input: { projectId: string; versionId: string }) => Promise<void>
) => {
  const prepared = await createPreparedProject(service, storage);
  await startPreparedVersion(service, prepared.projectId, prepared.versionId);

  if (setupWhileRunning !== undefined) {
    await setupWhileRunning({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
  }

  await service.markVersionComplete({
    projectId: prepared.projectId,
    versionId: prepared.versionId,
    actor: TEST_ACTOR
  });

  return prepared;
};

export const createCommittedVersion = async (
  service: RouteLedgerService,
  projectId: string,
  title: string,
  description = ""
): Promise<string> => {
  const details = await expectConfirmationRequired(
    service.createVersion({
      projectId,
      title,
      description,
      actor: TEST_ACTOR
    })
  );
  const artifact = await createApprovedArtifact(service, projectId, details.pendingOperationId);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: details.pendingOperationId,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });

  return details.proposal.targetId;
};

export const createUnresolvedDeferredForCloseout = async (
  service: RouteLedgerService,
  storage: MemoryStorageAdapter,
  projectId: string,
  versionId: string
): Promise<string> => {
  const downstreamVersionId = await createCommittedVersion(
    service,
    projectId,
    "Deferred review destination"
  );
  const deferred = await service.deferWork({
    mode: "new",
    projectId,
    originVersionId: versionId,
    targetReviewVersionId: downstreamVersionId,
    title: "Deferred with invalidated route",
    reason: "Create a valid route before simulating persisted route drift",
    actor: TEST_ACTOR
  });

  await storage.mutate(projectId, (snapshot) => ({
    ...snapshot,
    deferredItems: snapshot.deferredItems.map((item) =>
      item.id === deferred.deferred.id
        ? {
            ...item,
            targetReviewVersionId: versionId
          }
        : item
    )
  }));

  return deferred.deferred.id;
};

export const setCurrentVersionForTest = async (
  service: RouteLedgerService,
  projectId: string,
  versionId: string
): Promise<void> => {
  const proposal = await service.transitionVersion({
    projectId,
    versionId,
    mode: "propose",
    actor: TEST_ACTOR
  });
  const artifact = await createApprovedArtifact(service, projectId, proposal.pendingOperationId!);

  await service.commitL3Operation({
    projectId,
    pendingOperationId: proposal.pendingOperationId!,
    approvalArtifactId: artifact.id,
    actor: TEST_ACTOR
  });
};

export const expectConfirmationRequired = async (
  promise: Promise<unknown>
): Promise<{
  pendingOperationId: string;
  proposal: {
    id: string;
    targetId: string;
    actionType: string;
    payload: Record<string, unknown>;
  };
}> => {
  try {
    await promise;
    throw new Error("expected CONFIRMATION_REQUIRED");
  } catch (error) {
    expect(error).toMatchObject({
      code: "CONFIRMATION_REQUIRED"
    });

    const details = (error as {
      details: {
        pendingOperationId: string;
        proposal: {
          id: string;
          targetId: string;
          actionType: string;
          payload: Record<string, unknown>;
        };
      };
    }).details;

    return details;
  }
};
