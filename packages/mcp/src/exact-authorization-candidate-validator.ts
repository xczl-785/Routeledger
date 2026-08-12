import type {
  ExactAuthorizationCandidate,
  ExactProposalDecisionRequest,
  L3AuthorizationGrantContext,
  L3AuthorizationProfileV2
} from "@routeledger/core";

export const validateExactAuthorizationCandidate = (input: {
  candidate: Readonly<ExactAuthorizationCandidate>;
  request: Readonly<ExactProposalDecisionRequest>;
  context: Readonly<L3AuthorizationGrantContext>;
  profile?: Readonly<L3AuthorizationProfileV2>;
  expectedSource: ExactAuthorizationCandidate["source"];
  expectedIssuer: string;
  now: Date;
}): string | null => {
  const { candidate, request, context, profile, expectedSource, expectedIssuer, now } = input;
  const binding = candidate.binding;
  if (
    request.projectId !== context.projectId ||
    request.actionType !== context.actionType ||
    request.targetId !== context.targetId ||
    request.operationDigest !== context.operationDigest
  ) return "REQUEST_CONTEXT_MISMATCH";
  if (
    binding.proposalId !== request.proposalId ||
    binding.projectId !== request.projectId ||
    binding.routeledgerRootDigest !== context.routeledgerRootDigest ||
    binding.actionType !== request.actionType ||
    binding.targetId !== request.targetId ||
    binding.operationDigest !== request.operationDigest
  ) return "EXACT_BINDING_MISMATCH";
  if (
    candidate.source !== expectedSource ||
    candidate.issuer !== expectedIssuer ||
    candidate.audience !== context.audience ||
    candidate.subjectId !== context.subjectId ||
    candidate.hostKind !== context.hostKind ||
    candidate.clientId !== (context.clientId ?? null)
  ) return "TRUSTED_PROVENANCE_MISMATCH";
  if (profile === undefined) {
    if (
      candidate.profileId !== null ||
      candidate.modeEpoch !== null ||
      candidate.profileDigest !== null
    ) return "UNEXPECTED_PROFILE_PROVENANCE";
  } else if (
    candidate.profileId !== profile.profileId ||
    candidate.modeEpoch !== profile.modeEpoch ||
    candidate.profileDigest !== profile.profileDigest
  ) return "PROFILE_PROVENANCE_MISMATCH";
  const createdAt = Date.parse(candidate.createdAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    expiresAt <= createdAt
  ) return "AUTHORIZATION_TIME_INVALID";
  if (
    profile !== undefined &&
    expiresAt - createdAt > profile.limits.maxAuthorizationTtlSeconds * 1000
  ) return "AUTHORIZATION_TTL_EXCEEDED";
  return null;
};
