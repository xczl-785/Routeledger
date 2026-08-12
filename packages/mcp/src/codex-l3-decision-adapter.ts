import { randomUUID } from "node:crypto";

import {
  assertDecisionResolutionMatchesRequest,
  type DecisionResolution,
  type ExactAuthorizationCandidate,
  type ExactProposalDecisionRequest,
  type ExactAuthorizationStore,
  type L3AuthorizationGrantContext,
  type L3DecisionAdapter
} from "@routeledger/core";
import { validateExactAuthorizationCandidate } from "./exact-authorization-candidate-validator.js";

export interface CodexL3DecisionAdapterOptions {
  readonly authorizationContext: Readonly<L3AuthorizationGrantContext>;
  readonly exactStore: ExactAuthorizationStore;
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
    const authorizationId = this.nextId();
    const decisionRef = `codex-tool-call-${this.nextId()}`;
    const candidate: ExactAuthorizationCandidate = {
      schemaVersion: 2 as const,
      authorizationId,
      binding: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        routeledgerRootDigest: this.options.authorizationContext.routeledgerRootDigest,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest
      },
      issuer: "codex-native-tool-admission",
      subjectId: this.options.authorizationContext.subjectId,
      audience: this.options.authorizationContext.audience,
      source: "host_admission",
      policyId: null,
      policyDigest: null,
      decisionRef,
      profileId: null,
      modeEpoch: null,
      profileDigest: null,
      hostKind: "codex",
      clientId: this.options.authorizationContext.clientId ?? null,
      sessionId: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    };
    const validationFailure = validateExactAuthorizationCandidate({
      candidate,
      request,
      context: this.options.authorizationContext,
      expectedSource: "host_admission",
      expectedIssuer: "codex-native-tool-admission",
      now
    });
    if (validationFailure !== null) {
      throw new Error(`Codex exact host admission is invalid: ${validationFailure}`);
    }
    await this.options.exactStore.issue(candidate);
    const resolution: CodexL3DecisionResolution = {
      status: "resolved",
      decision: {
        proposalId: request.proposalId,
        projectId: request.projectId,
        actionType: request.actionType,
        targetId: request.targetId,
        operationDigest: request.operationDigest,
        source: candidate.source,
        decisionRef,
        authorizationGrantId: authorizationId
      }
    };
    assertDecisionResolutionMatchesRequest(request, resolution);
    return resolution;
  }
}
