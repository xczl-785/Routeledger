import { randomUUID } from "node:crypto";
import { ApplicationError, GENERIC_EXACT_DECISION_INPUT_SCHEMA, assertDecisionResolutionMatchesRequest, } from "../../core/src/index.js";
import { isMcpDecisionInputRequiredError, toL3DecisionInputRequest } from "./mcp-decision-input.js";
import { validateExactAuthorizationCandidate } from "./exact-authorization-candidate-validator.js";
const resolvedDecision = (request, authorization) => ({
    status: "resolved",
    decision: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest,
        source: authorization.source,
        decisionRef: authorization.decisionRef,
        authorizationId: authorization.authorizationId
    }
});
const exactRequestMatchesProposal = (request, proposal) => request.proposalId === proposal.id &&
    request.projectId === proposal.projectId &&
    request.actionType === proposal.actionType &&
    request.targetId === proposal.targetId &&
    request.operationDigest === proposal.digest.value &&
    request.proposalCreatedAt === proposal.createdAt;
export class ExistingL3DecisionAdapter {
    options;
    id = "routeledger-existing-l3-compatibility";
    now;
    nextId;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => new Date());
        this.nextId = options.nextId ?? randomUUID;
    }
    async resolve(request) {
        if (this.options.profile?.status === "disabled") {
            throw new ApplicationError("AUTHORIZATION_PROFILE_DISABLED", "The bound L3 authorization profile is disabled", {
                profileId: this.options.profile.profileId,
                modeEpoch: this.options.profile.modeEpoch
            });
        }
        if (!exactRequestMatchesProposal(request, this.options.proposal)) {
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The decision adapter request does not match the exact L3 proposal", { pendingOperationId: this.options.proposal.id, reason: "PROPOSAL_REQUEST_MISMATCH" });
        }
        const resolution = await this.resolveExistingPath(request);
        assertDecisionResolutionMatchesRequest(request, resolution);
        return resolution;
    }
    async resolveExistingPath(request) {
        const delegated = await this.resolveDelegated(request);
        if (delegated !== null)
            return delegated;
        if (this.options.profile?.mode === "preauthorized") {
            throw new ApplicationError("STANDING_POLICY_DECISION_REQUIRED", "The active standing policy did not authorize this exact proposal", {
                profileId: this.options.profile.profileId,
                modeEpoch: this.options.profile.modeEpoch,
                pendingOperationId: this.options.proposal.id
            });
        }
        return this.resolveInteraction(request);
    }
    async resolveDelegated(request) {
        const delegatedAuthority = this.options.profile === undefined ||
            this.options.profile.mode === "delegated" ||
            this.options.profile.mode === "preauthorized"
            ? this.options.delegatedAuthority
            : undefined;
        if (delegatedAuthority === undefined)
            return null;
        if (delegatedAuthority.authorityHandle.trim().length === 0) {
            throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "The host-managed delegated authority has no opaque startup handle", { pendingOperationId: this.options.proposal.id });
        }
        let authorityResult;
        try {
            authorityResult = await delegatedAuthority.requestExactDecision({
                authorityHandle: delegatedAuthority.authorityHandle,
                proposal: this.options.proposal,
                context: await this.options.getEvaluationContext()
            });
        }
        catch (error) {
            throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "The host-managed delegated authority could not make an atomic decision", {
                authorityHandle: delegatedAuthority.authorityHandle,
                pendingOperationId: this.options.proposal.id,
                cause: error instanceof Error ? error.message : String(error)
            });
        }
        if (authorityResult.effect === "deny") {
            return {
                status: "denied",
                code: "AUTHORIZATION_POLICY_DENIED",
                reason: "The host-managed delegated authority denied this operation",
                details: {
                    authorityHandle: delegatedAuthority.authorityHandle,
                    decisionCode: authorityResult.code,
                    policyId: authorityResult.policyId,
                    policyDigest: authorityResult.policyDigest,
                    matchedRuleId: authorityResult.matchedRuleId
                }
            };
        }
        if (authorityResult.effect !== "allow")
            return null;
        const authorization = authorityResult.authorization;
        const expectedSource = this.options.profile?.mode === "preauthorized"
            ? "preauthorized"
            : "delegated_policy";
        const validationFailure = validateExactAuthorizationCandidate({
            candidate: authorization,
            request,
            context: this.options.authorizationContext,
            profile: this.options.profile,
            expectedSource,
            expectedIssuer: delegatedAuthority.issuerId,
            expectedPolicyId: delegatedAuthority.policyId,
            expectedPolicyDigest: delegatedAuthority.policyDigest,
            now: this.now()
        });
        if (authorization.schemaVersion !== 2 ||
            authorization.binding.proposalId !== request.proposalId ||
            authorization.binding.projectId !== request.projectId ||
            authorization.binding.routeledgerRootDigest !==
                this.options.authorizationContext.routeledgerRootDigest ||
            authorization.binding.actionType !== request.actionType ||
            authorization.binding.targetId !== request.targetId ||
            authorization.binding.operationDigest !== request.operationDigest ||
            validationFailure !== null ||
            !authorization.policyId ||
            !authorization.policyDigest) {
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", "The host-managed delegated authority returned an invalid one-shot grant", {
                authorityHandle: delegatedAuthority.authorityHandle,
                reason: validationFailure ?? "DELEGATED_EXACT_DECISION_INVALID"
            });
        }
        await this.options.exactStore.issue(authorization);
        return resolvedDecision(request, authorization);
    }
    async resolveInteraction(request) {
        let decision;
        try {
            decision = await this.options.interaction.requestAuthorization({
                message: [
                    "RouteLedger requests authorization for one L3 route operation.",
                    `Action: ${this.options.proposal.actionType}.`,
                    `Target: ${this.options.proposal.targetId}.`,
                    `Operation digest: ${this.options.proposal.digest.value}.`,
                    this.options.profile === undefined
                        ? "Approve only this exact proposal."
                        : "This V3 interaction authorizes only this exact operation."
                ].join(" "),
                requestedSchema: GENERIC_EXACT_DECISION_INPUT_SCHEMA
            });
        }
        catch (error) {
            if (isMcpDecisionInputRequiredError(error)) {
                return {
                    status: "input_required",
                    request: toL3DecisionInputRequest(request, error)
                };
            }
            throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "The MCP client could not provide a trusted L3 authorization interaction", {
                pendingOperationId: this.options.proposal.id,
                cause: error instanceof Error ? error.message : String(error)
            });
        }
        if (decision.action === "decline") {
            return {
                status: "denied",
                code: "EXACT_AUTHORIZATION_REJECTED",
                reason: "L3 authorization was declined by the host user",
                details: {
                    pendingOperationId: this.options.proposal.id,
                    reason: "HOST_DECLINED"
                }
            };
        }
        const contentKeys = decision.content === null ? [] : Object.keys(decision.content);
        if (decision.action !== "accept" ||
            decision.content?.approve !== true ||
            contentKeys.length !== 1 ||
            contentKeys[0] !== "approve") {
            throw new ApplicationError("EXACT_AUTHORIZATION_REJECTED", decision.action === "cancel"
                ? "L3 authorization was cancelled without deciding the proposal"
                : "The host returned an invalid exact authorization response", {
                pendingOperationId: this.options.proposal.id,
                reason: decision.action === "cancel" ? "HOST_CANCELLED" : "INVALID_DECISION_RESPONSE"
            });
        }
        if (this.options.profile !== undefined &&
            (decision.trustedDecision?.kind !== "trusted_host_user" ||
                decision.trustedDecision.hostKind !== this.options.hostProfile ||
                decision.trustedDecision.decisionId.trim().length === 0)) {
            throw new ApplicationError("TRUSTED_HOST_USER_DECISION_REQUIRED", "V3 interactive authorization requires verifiable trusted-host user provenance", {
                profileId: this.options.profile.profileId,
                modeEpoch: this.options.profile.modeEpoch,
                pendingOperationId: this.options.proposal.id
            });
        }
        const now = this.now();
        const authorization = {
            schemaVersion: 2,
            authorizationId: this.nextId(),
            binding: {
                proposalId: request.proposalId,
                projectId: request.projectId,
                routeledgerRootDigest: this.options.authorizationContext.routeledgerRootDigest,
                actionType: request.actionType,
                targetId: request.targetId,
                operationDigest: request.operationDigest
            },
            issuer: `mcp-interaction:${this.options.hostProfile}`,
            subjectId: this.options.authorizationContext.subjectId,
            audience: "routeledger-core",
            source: "user_interaction",
            policyId: null,
            policyDigest: null,
            decisionRef: this.options.profile === undefined
                ? `decision-${this.nextId()}`
                : decision.trustedDecision.decisionId,
            profileId: this.options.profile?.profileId ?? null,
            modeEpoch: this.options.profile?.modeEpoch ?? null,
            profileDigest: this.options.profile?.profileDigest ?? null,
            hostKind: this.options.hostProfile,
            clientId: this.options.trustedClientId ?? null,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() +
                Math.min(60 * 60 * 1000, (this.options.profile?.limits.maxAuthorizationTtlSeconds ?? 8 * 60 * 60) * 1000)).toISOString()
        };
        await this.options.exactStore.issue(authorization);
        return resolvedDecision(request, authorization);
    }
}
export const requireResolvedExistingL3Decision = (resolution) => {
    if (resolution.status === "denied") {
        throw new ApplicationError(resolution.code, resolution.reason, resolution.details);
    }
    if (resolution.status !== "resolved") {
        throw new ApplicationError("AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE", "The existing authorization adapter did not resolve the exact L3 proposal", { status: resolution.status });
    }
    return resolution.decision;
};
