import crypto from "node:crypto";

import type { Actor } from "../domain/actor.js";
import { getProjectAggregateHeadRevision, type ProjectAggregateSnapshot, type StoragePort } from "../ports/storage-port.js";
import type { DomainDependencies } from "../services/operation.js";

import {
  assertBatchPreviousCurrentPolicy,
  evaluateBatchCreateVersions,
  type BatchCreateVersionsFailure,
  type BatchCreateVersionsNormalizedPlan,
  type BatchCreateVersionsPreview
} from "./batch-create-versions-planner.js";
import { ApplicationError } from "./errors.js";
import { loadRequiredProjectAggregate } from "./project-aggregate-access.js";
import { BATCH_CREATE_VERSIONS_MODES, isBatchCreateVersionsMode } from "./types.js";
import type {
  BatchCreateVersionsAnchor,
  BatchCreateVersionsItemInput,
  BatchCreateVersionsMode,
  BatchCreateVersionsNotice,
  BatchCreateVersionsResolvedAnchors,
  BatchPreviousCurrentPolicy,
  L3ActionType,
  OperationDigest,
  PendingOperationPayload
} from "./types.js";

export interface BatchCreateVersionsInput {
  projectId: string;
  mode: BatchCreateVersionsMode;
  partialAllowed?: boolean;
  anchor?: BatchCreateVersionsAnchor;
  items: BatchCreateVersionsItemInput[];
  setCurrentTo?: string;
  previousCurrentPolicy?: BatchPreviousCurrentPolicy;
  reason?: string;
  actor: Actor;
}

export interface BatchCreateVersionsPreflightSuccess {
  ok: true;
  headRevision: string | null;
  normalizedPlan: BatchCreateVersionsNormalizedPlan;
  resolvedAnchors: BatchCreateVersionsResolvedAnchors;
  preview: BatchCreateVersionsPreview;
  risks: BatchCreateVersionsNotice[];
  blockers: BatchCreateVersionsNotice[];
  digestPreview: OperationDigest;
}

export type BatchCreateVersionsPreflightResult =
  | BatchCreateVersionsPreflightSuccess
  | BatchCreateVersionsFailure;

export interface BatchCreateVersionsProposeSuccess {
  ok: true;
  headRevision: string | null;
  pendingOperationId: string;
  operationDigest: OperationDigest;
  normalizedPlan: BatchCreateVersionsNormalizedPlan;
  preview: BatchCreateVersionsPreview;
  humanReviewText: string;
}

export type BatchCreateVersionsResult =
  | BatchCreateVersionsPreflightResult
  | BatchCreateVersionsProposeSuccess;

type BatchCreateVersionsStorage = Pick<StoragePort, "loadProjectAggregate">;

type BatchDigestPreviewBuilder = (input: {
  snapshot: ProjectAggregateSnapshot;
  payload: PendingOperationPayload;
  evaluatedAt: string;
}) => OperationDigest;

type BatchProposal = {
  id: string;
  actionType: L3ActionType;
  targetId: string;
  digest: OperationDigest;
};

type BatchProposalPort = (input: {
  projectId: string;
  actionType: "insert_version";
  targetId: string;
  reason: string;
  payload: PendingOperationPayload;
  actor: Actor;
}) => Promise<BatchProposal>;

export interface BatchCreateVersionsExecutor {
  execute(input: BatchCreateVersionsInput): Promise<BatchCreateVersionsResult>;
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }
  return value;
};

export const buildBatchSnapshotHash = (snapshot: ProjectAggregateSnapshot): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        sortKeys({
          projectId: snapshot.project.id,
          currentVersionId: snapshot.project.currentVersionId,
          versions: snapshot.versions
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((version) => ({
              id: version.id,
              state: version.state,
              parentVersionId: version.parentVersionId,
              previousVersionId: version.previousVersionId,
              nextVersionId: version.nextVersionId,
              order: version.order,
              isCurrent: version.isCurrent
            }))
        })
      )
    )
    .digest("hex");

const assertBatchCreateVersionsMode = (mode: unknown): BatchCreateVersionsMode => {
  if (isBatchCreateVersionsMode(mode)) return mode;
  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_MODE_INVALID",
    "batch_create_versions mode 仅支持 preflight 或 propose",
    { receivedMode: mode ?? null, allowedModes: [...BATCH_CREATE_VERSIONS_MODES] }
  );
};

export class BatchCreateVersionsUseCase implements BatchCreateVersionsExecutor {
  private readonly storage: BatchCreateVersionsStorage;
  private readonly deps: Pick<DomainDependencies, "clock">;
  private readonly buildDigestPreview: BatchDigestPreviewBuilder;
  private readonly propose: BatchProposalPort;

  constructor(options: {
    storage: BatchCreateVersionsStorage;
    deps: Pick<DomainDependencies, "clock">;
    buildDigestPreview: BatchDigestPreviewBuilder;
    propose: BatchProposalPort;
  }) {
    this.storage = options.storage;
    this.deps = options.deps;
    this.buildDigestPreview = options.buildDigestPreview;
    this.propose = options.propose;
  }

  async execute(input: BatchCreateVersionsInput): Promise<BatchCreateVersionsResult> {
    const mode = assertBatchCreateVersionsMode(input.mode);
    const previousCurrentPolicy = assertBatchPreviousCurrentPolicy(input.previousCurrentPolicy);
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const headRevision = getProjectAggregateHeadRevision(snapshot) ?? null;
    const evaluatedAt = this.deps.clock.now();
    const evaluated = evaluateBatchCreateVersions(
      snapshot,
      {
        anchor: input.anchor,
        items: input.items,
        partialAllowed: input.partialAllowed,
        previousCurrentPolicy,
        setCurrentTo: input.setCurrentTo
      },
      evaluatedAt,
      buildBatchSnapshotHash(snapshot)
    );

    if (evaluated.ok === false) return evaluated;

    const digestPreview = this.buildDigestPreview({
      snapshot,
      payload: evaluated.payload,
      evaluatedAt
    });

    if (mode === "preflight") {
      return {
        ok: true,
        headRevision,
        normalizedPlan: evaluated.normalizedPlan,
        resolvedAnchors: evaluated.resolvedAnchors,
        preview: evaluated.preview,
        risks: evaluated.risks,
        blockers: evaluated.blockers,
        digestPreview
      };
    }

    if (evaluated.blockers.length > 0) {
      return {
        ok: false,
        code: "BATCH_VERSION_PLAN_BLOCKED",
        headRevision,
        summary: {
          requestedCount: input.items.length,
          validCount: input.items.length,
          invalidCount: 0
        },
        issues: [],
        risks: evaluated.risks,
        blockers: evaluated.blockers,
        normalizedPlan: evaluated.normalizedPlan,
        resolvedAnchors: evaluated.resolvedAnchors,
        preview: evaluated.preview,
        digestPreview
      };
    }

    const proposal = await this.propose({
      projectId: input.projectId,
      actionType: "insert_version",
      targetId: input.projectId,
      reason: input.reason ?? `batch create ${input.items.length} versions requested`,
      payload: evaluated.payload,
      actor: input.actor
    });

    return {
      ok: true,
      headRevision,
      pendingOperationId: proposal.id,
      operationDigest: proposal.digest,
      normalizedPlan: evaluated.normalizedPlan,
      preview: evaluated.preview,
      humanReviewText: [
        `RouteLedger batch proposal ${proposal.id}`,
        "action: batch_create_versions",
        `carrierAction: ${proposal.actionType}`,
        `target: ${proposal.targetId}`,
        `digest: ${proposal.digest.value}`,
        `items: ${evaluated.normalizedPlan.items.length}`,
        "blockers: none"
      ].join("\n")
    };
  }
}
