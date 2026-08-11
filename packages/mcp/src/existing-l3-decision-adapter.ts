import { randomUUID } from "node:crypto";

import {
  ApplicationError,
  assertDecisionResolutionMatchesRequest,
  type DecisionResolution,
  type ExactDecision,
  type ExactProposalDecisionRequest,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationGrant,
  type L3AuthorizationGrantContext,
  type L3AuthorizationGrantStore,
  type L3AuthorizationProfileV2,
  type L3AuthorizationScope,
  type L3DecisionAdapter,
  type PendingOperation,
  validateL3AuthorizationGrant
} from "@routeledger/core";

import type {
  RouteLedgerMcpAuthorizationInteraction,
  RouteLedgerMcpDelegatedAuthorizationAuthority
} from "./index.js";
import {
  isMcpDecisionInputRequiredError,
  toL3DecisionInputRequest
} from "./mcp-decision-input.js";

export type ExistingL3DecisionResolution =
  | Exclude<DecisionResolution, { status: "denied" }>
  | {
      readonly status: "denied";
      readonly code: "AUTHORIZATION_POLICY_DENIED" | "AUTHORIZATION_GRANT_REJECTED";
      readonly reason: string;
      readonly details: Record<string, unknown>;
    };

export interface ExistingL3DecisionAdapterOptions {
  readonly proposal: Readonly<PendingOperation>;
  readonly authorizationContext: Readonly<L3AuthorizationGrantContext>;
  readonly grantStore: L3AuthorizationGrantStore;
  readonly interaction: RouteLedgerMcpAuthorizationInteraction;
  readonly sessionId: string;
  readonly hostProfile: string;
  readonly trustedClientId?: string;
  readonly profile?: L3AuthorizationProfileV2;
  readonly delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
  readonly getEvaluationContext: () => Promise<L3AuthorizationEvaluationContext>;
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

const resolvedDecision = (
  request: ExactProposalDecisionRequest,
  grant: Readonly<L3AuthorizationGrant>
): ExistingL3DecisionResolution => ({
  status: "resolved",
  decision: {
    proposalId: request.proposalId,
    projectId: request.projectId,
    actionType: request.actionType,
    targetId: request.targetId,
    operationDigest: request.operationDigest,
    source: grant.source,
    decisionRef: grant.decisionId,
    authorizationGrantId: grant.id
  }
});

const exactRequestMatchesProposal = (
  request: ExactProposalDecisionRequest,
  proposal: Readonly<PendingOperation>
): boolean =>
  request.proposalId === proposal.id &&
  request.projectId === proposal.projectId &&
  request.actionType === proposal.actionType &&
  request.targetId === proposal.targetId &&
  request.operationDigest === proposal.digest.value &&
  request.proposalCreatedAt === proposal.createdAt;

export class ExistingL3DecisionAdapter implements L3DecisionAdapter {
  readonly id = "routeledger-existing-l3-compatibility";

  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(private readonly options: ExistingL3DecisionAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? randomUUID;
  }

  async resolve(
    request: ExactProposalDecisionRequest
  ): Promise<ExistingL3DecisionResolution> {
    if (this.options.profile?.status === "disabled") {
      throw new ApplicationError(
        "AUTHORIZATION_PROFILE_DISABLED",
        "The bound L3 authorization profile is disabled",
        {
          profileId: this.options.profile.profileId,
          modeEpoch: this.options.profile.modeEpoch
        }
      );
    }
    if (!exactRequestMatchesProposal(request, this.options.proposal)) {
      throw new ApplicationError(
        "AUTHORIZATION_GRANT_REJECTED",
        "The decision adapter request does not match the exact L3 proposal",
        { pendingOperationId: this.options.proposal.id, reason: "PROPOSAL_REQUEST_MISMATCH" }
      );
    }

    const resolution = await this.resolveExistingPath(request);
    assertDecisionResolutionMatchesRequest(request, resolution);
    return resolution;
  }

  private async resolveExistingPath(
    request: ExactProposalDecisionRequest
  ): Promise<ExistingL3DecisionResolution> {
    const consumedReplay = await this.options.grantStore.findConsumedAuthorization(
      this.options.authorizationContext,
      this.options.proposal.id
    );
    if (consumedReplay !== null) {
      return resolvedDecision(request, consumedReplay.grant);
    }

    const reusableGrant =
      this.options.profile === undefined || this.options.profile.mode === "preauthorized"
        ? await this.options.grantStore.findMatching(this.options.authorizationContext)
        : null;
    if (
      reusableGrant !== null &&
      (this.options.profile === undefined
        ? reusableGrant.source === "preauthorized" ||
          (reusableGrant.source === "user_interaction" && reusableGrant.scope === "session")
        : reusableGrant.source === "preauthorized")
    ) {
      return resolvedDecision(request, reusableGrant);
    }

    if (this.options.profile?.mode === "preauthorized") {
      throw new ApplicationError(
        "PREAUTHORIZATION_GRANT_REQUIRED",
        "The active preauthorized profile has no matching finite grant",
        {
          profileId: this.options.profile.profileId,
          modeEpoch: this.options.profile.modeEpoch,
          pendingOperationId: this.options.proposal.id
        }
      );
    }

    const delegated = await this.resolveDelegated(request);
    if (delegated !== null) return delegated;
    return this.resolveInteraction(request);
  }

  private async resolveDelegated(
    request: ExactProposalDecisionRequest
  ): Promise<ExistingL3DecisionResolution | null> {
    const delegatedAuthority =
      this.options.profile === undefined || this.options.profile.mode === "delegated"
        ? this.options.delegatedAuthority
        : undefined;
    if (delegatedAuthority === undefined) return null;

    if (delegatedAuthority.authorityHandle.trim().length === 0) {
      throw new ApplicationError(
        "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        "The host-managed delegated authority has no opaque startup handle",
        { pendingOperationId: this.options.proposal.id }
      );
    }

    let authorityResult;
    try {
      authorityResult = await delegatedAuthority.requestGrant({
        authorityHandle: delegatedAuthority.authorityHandle,
        proposal: this.options.proposal,
        context: await this.options.getEvaluationContext()
      });
    } catch (error) {
      throw new ApplicationError(
        "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        "The host-managed delegated authority could not make an atomic decision",
        {
          authorityHandle: delegatedAuthority.authorityHandle,
          pendingOperationId: this.options.proposal.id,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
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
    if (authorityResult.effect !== "allow") return null;

    const grant = authorityResult.grant;
    const grantFailure = validateL3AuthorizationGrant(grant, this.options.authorizationContext);
    if (
      grantFailure !== null ||
      grant.source !== "delegated_policy" ||
      grant.scope !== "operation" ||
      grant.maxUses !== 1 ||
      grant.operationDigest !== this.options.proposal.digest.value ||
      !grant.policyId ||
      !grant.policyDigest
    ) {
      throw new ApplicationError(
        "AUTHORIZATION_GRANT_REJECTED",
        "The host-managed delegated authority returned an invalid one-shot grant",
        {
          authorityHandle: delegatedAuthority.authorityHandle,
          reason: grantFailure ?? "DELEGATED_GRANT_SHAPE_INVALID"
        }
      );
    }
    await this.options.grantStore.issue(grant);
    return resolvedDecision(request, grant);
  }

  private async resolveInteraction(
    request: ExactProposalDecisionRequest
  ): Promise<ExistingL3DecisionResolution> {
    let decision;
    try {
      decision = await this.options.interaction.requestAuthorization({
        message: [
          "RouteLedger requests authorization for one L3 route operation.",
          `Action: ${this.options.proposal.actionType}.`,
          `Target: ${this.options.proposal.targetId}.`,
          `Operation digest: ${this.options.proposal.digest.value}.`,
          this.options.profile === undefined
            ? "Choose operation for one exact proposal or session for the same action and target in this MCP session."
            : "This V3 interaction authorizes only this exact operation."
        ].join(" "),
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve this RouteLedger operation" },
            scope: {
              type: "string",
              title: "Authorization scope",
              enum: this.options.profile === undefined ? ["operation", "session"] : ["operation"]
            }
          },
          required: ["approve", "scope"]
        }
      });
    } catch (error) {
      if (isMcpDecisionInputRequiredError(error)) {
        return {
          status: "input_required",
          request: toL3DecisionInputRequest(request, error)
        };
      }
      throw new ApplicationError(
        "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        "The MCP client could not provide a trusted L3 authorization interaction",
        {
          pendingOperationId: this.options.proposal.id,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }

    if (decision.action !== "accept" || decision.content?.approve !== true) {
      const cancelled = decision.action === "cancel";
      return {
        status: "denied",
        code: "AUTHORIZATION_GRANT_REJECTED",
        reason: cancelled
          ? "L3 authorization was cancelled by the host user"
          : "L3 authorization was declined by the host user",
        details: {
          pendingOperationId: this.options.proposal.id,
          reason: cancelled ? "HOST_CANCELLED" : "HOST_DECLINED"
        }
      };
    }
    if (
      this.options.profile !== undefined &&
      (decision.trustedDecision?.kind !== "trusted_host_user" ||
        decision.trustedDecision.hostKind !== this.options.hostProfile ||
        decision.trustedDecision.decisionId.trim().length === 0)
    ) {
      throw new ApplicationError(
        "TRUSTED_HOST_USER_DECISION_REQUIRED",
        "V3 interactive authorization requires verifiable trusted-host user provenance",
        {
          profileId: this.options.profile.profileId,
          modeEpoch: this.options.profile.modeEpoch,
          pendingOperationId: this.options.proposal.id
        }
      );
    }

    const scope: L3AuthorizationScope =
      this.options.profile === undefined && decision.content.scope === "session"
        ? "session"
        : "operation";
    const now = this.now();
    const grant: L3AuthorizationGrant = {
      id: this.nextId(),
      issuer: `mcp-interaction:${this.options.hostProfile}`,
      subjectId: this.options.authorizationContext.subjectId,
      audience: "routeledger-core",
      projectId: this.options.proposal.projectId,
      routeledgerRootDigest: this.options.authorizationContext.routeledgerRootDigest,
      ...(this.options.profile === undefined
        ? {}
        : {
            profileId: this.options.profile.profileId,
            modeEpoch: this.options.profile.modeEpoch,
            profileDigest: this.options.profile.profileDigest
          }),
      allowedActions: [this.options.proposal.actionType],
      allowedTargetIds: [this.options.proposal.targetId],
      operationDigest: scope === "operation" ? this.options.proposal.digest.value : null,
      scope,
      source: "user_interaction",
      policyId: null,
      policyDigest: null,
      decisionId:
        this.options.profile === undefined
          ? `decision-${this.nextId()}`
          : decision.trustedDecision!.decisionId,
      hostKind: this.options.hostProfile,
      clientId: this.options.trustedClientId ?? null,
      sessionId: this.options.sessionId,
      nonce: this.nextId(),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() +
          Math.min(
            scope === "session" ? 8 * 60 * 60 * 1000 : 60 * 60 * 1000,
            (this.options.profile?.limits.maxGrantTtlSeconds ?? 8 * 60 * 60) * 1000
          )
      ).toISOString(),
      maxUses: scope === "session" ? 16 : 1,
      uses: 0,
      status: "active",
      revokedAt: null
    };
    await this.options.grantStore.issue(grant);
    return resolvedDecision(request, grant);
  }
}

export const requireResolvedExistingL3Decision = (
  resolution: ExistingL3DecisionResolution
): ExactDecision => {
  if (resolution.status === "denied") {
    throw new ApplicationError(resolution.code, resolution.reason, resolution.details);
  }
  if (resolution.status !== "resolved") {
    throw new ApplicationError(
      "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
      "The existing authorization adapter did not resolve the exact L3 proposal",
      { status: resolution.status }
    );
  }
  return resolution.decision;
};
