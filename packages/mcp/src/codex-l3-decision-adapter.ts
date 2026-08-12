import { randomUUID } from "node:crypto";

import {
  assertDecisionResolutionMatchesRequest,
  validateL3AuthorizationGrant,
  type DecisionResolution,
  type ExactProposalDecisionRequest,
  type ExactAuthorizationStore,
  type L3AuthorizationGrant,
  type L3AuthorizationGrantContext,
  type L3AuthorizationGrantStore,
  type L3DecisionAdapter
} from "@routeledger/core";

export interface CodexL3DecisionAdapterOptions {
  readonly authorizationContext: Readonly<L3AuthorizationGrantContext>;
  readonly grantStore: L3AuthorizationGrantStore;
  readonly exactStore: ExactAuthorizationStore;
  readonly sessionId: string;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export type CodexL3DecisionResolution = Extract<DecisionResolution, { status: "resolved" }>;

/**
 * Converts admission of a high-risk RouteLedger tool call by Codex into one
 * exact, single-use capability. Codex owns whether the call is prompted,
 * reviewed, or automatically admitted; RouteLedger owns proposal binding,
 * receipt creation, live validation, and atomic commit after admission.
 */
export class CodexL3DecisionAdapter implements L3DecisionAdapter {
  readonly id = "codex-native-tool-admission";

  private readonly nextId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: CodexL3DecisionAdapterOptions) {
    this.nextId = options.nextId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(request: ExactProposalDecisionRequest): Promise<CodexL3DecisionResolution> {
    const now = this.now();
    const grant: L3AuthorizationGrant = {
      id: this.nextId(),
      issuer: "codex-native-tool-admission",
      subjectId: this.options.authorizationContext.subjectId,
      audience: this.options.authorizationContext.audience,
      projectId: request.projectId,
      routeledgerRootDigest: this.options.authorizationContext.routeledgerRootDigest,
      allowedActions: [request.actionType],
      allowedTargetIds: [request.targetId],
      operationDigest: request.operationDigest,
      scope: "operation",
      source: "host_admission",
      policyId: null,
      policyDigest: null,
      decisionId: `codex-tool-call-${this.nextId()}`,
      hostKind: "codex",
      clientId: this.options.authorizationContext.clientId ?? null,
      sessionId: this.options.sessionId,
      nonce: this.nextId(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
      uses: 0,
      status: "active",
      revokedAt: null
    };
    const failure = validateL3AuthorizationGrant(grant, this.options.authorizationContext);
    if (failure !== null) {
      throw new Error(`Codex host-admission grant is invalid: ${failure}`);
    }
    await this.options.exactStore.issue({
      schemaVersion: 2,
      authorizationId: grant.id,
      binding: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        routeledgerRootDigest: grant.routeledgerRootDigest,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest
      },
      source: grant.source,
      decisionRef: grant.decisionId,
      issuer: grant.issuer,
      audience: grant.audience,
      subjectId: grant.subjectId,
      policyId: grant.policyId,
      policyDigest: grant.policyDigest,
      profileId: null,
      modeEpoch: null,
      profileDigest: null,
      hostKind: grant.hostKind,
      clientId: grant.clientId,
      sessionId: null,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt
    });
    const resolution: CodexL3DecisionResolution = {
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
    };
    assertDecisionResolutionMatchesRequest(request, resolution);
    return resolution;
  }
}
