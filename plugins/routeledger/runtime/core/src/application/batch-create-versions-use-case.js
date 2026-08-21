import crypto from "node:crypto";
import { assertBatchPreviousCurrentPolicy, evaluateBatchCreateVersions } from "./batch-create-versions-planner.js";
import { ApplicationError } from "./errors.js";
import { loadRequiredProjectAggregate } from "./project-aggregate-access.js";
import { BATCH_CREATE_VERSIONS_MODES, isBatchCreateVersionsMode } from "./types.js";
const sortKeys = (value) => {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((accumulator, key) => {
            accumulator[key] = sortKeys(value[key]);
            return accumulator;
        }, {});
    }
    return value;
};
export const buildBatchSnapshotHash = (snapshot) => crypto
    .createHash("sha256")
    .update(JSON.stringify(sortKeys({
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
})))
    .digest("hex");
const assertBatchCreateVersionsMode = (mode) => {
    if (isBatchCreateVersionsMode(mode))
        return mode;
    throw new ApplicationError("BATCH_CREATE_VERSIONS_MODE_INVALID", "batch_create_versions mode 仅支持 preflight 或 propose", { receivedMode: mode ?? null, allowedModes: [...BATCH_CREATE_VERSIONS_MODES] });
};
export class BatchCreateVersionsUseCase {
    storage;
    deps;
    buildDigestPreview;
    propose;
    constructor(options) {
        this.storage = options.storage;
        this.deps = options.deps;
        this.buildDigestPreview = options.buildDigestPreview;
        this.propose = options.propose;
    }
    async execute(input) {
        const mode = assertBatchCreateVersionsMode(input.mode);
        const previousCurrentPolicy = assertBatchPreviousCurrentPolicy(input.previousCurrentPolicy);
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        const headRevision = snapshot.headRevision;
        const evaluatedAt = this.deps.clock.now();
        const evaluated = evaluateBatchCreateVersions(snapshot, {
            anchor: input.anchor,
            items: input.items,
            partialAllowed: input.partialAllowed,
            previousCurrentPolicy,
            setCurrentTo: input.setCurrentTo
        }, evaluatedAt, buildBatchSnapshotHash(snapshot));
        if (evaluated.ok === false)
            return evaluated;
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
