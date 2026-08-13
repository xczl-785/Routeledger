import type {
  ExactAuthorizationCandidate,
  L3AuthorizationEvaluationContext,
  PendingOperation
} from "@routeledger/core";

export interface RouteLedgerMcpDelegatedAuthorizationRequest {
  authorityHandle: string;
  proposal: Readonly<PendingOperation>;
  context: Readonly<L3AuthorizationEvaluationContext>;
}

export type RouteLedgerMcpDelegatedAuthorizationResult =
  | { effect: "allow"; authorization: ExactAuthorizationCandidate }
  | {
      effect: "prompt" | "deny";
      code: string;
      policyId?: string;
      policyDigest?: string;
      matchedRuleId?: string;
    };

export interface RouteLedgerMcpDelegatedAuthorizationAuthority {
  /** Opaque host-owned handle. Policy evaluation and budget consumption must be atomic. */
  authorityHandle: string;
  /** Trusted issuer identity injected with the host authority. */
  issuerId: string;
  /** Trusted standing-policy identity; candidate provenance must match it exactly. */
  policyId: string;
  policyDigest: string;
  requestExactDecision(
    request: RouteLedgerMcpDelegatedAuthorizationRequest
  ): Promise<RouteLedgerMcpDelegatedAuthorizationResult>;
}

export interface RouteLedgerMcpAuthorizationRequest {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface RouteLedgerMcpAuthorizationDecision {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
  /** Present only when a trusted host adapter attests an exact user decision. */
  trustedDecision?: {
    kind: "trusted_host_user";
    hostKind: string;
    decisionId: string;
  };
}

export interface RouteLedgerMcpAuthorizationInteraction {
  requestAuthorization(
    request: RouteLedgerMcpAuthorizationRequest
  ): Promise<RouteLedgerMcpAuthorizationDecision>;
}
