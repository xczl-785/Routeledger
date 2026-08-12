# L3 exact authorization: host authority broker

Status: active architecture and integration guide.

RouteLedger authorizes one concrete `PendingOperation` at a time. The trusted binding is:

`proposalId + projectId + routeledgerRootDigest + actionType + targetId + operationDigest`.

An authorization has one `authorizationId`, creates one separate `artifactId`, and can be consumed
once. It never represents a session, time window, list of actions, list of targets, or reusable
capability. `expiresAt` only bounds the validity of that one credential.

## Modes

- `interactive`: the host asks the user about the current proposal.
- `delegated`: a host-owned standing policy evaluates the current proposal and, when allowed,
  creates a new exact authorization.
- `preauthorized`: the user-facing name is retained, but it is also a standing-policy mode. It
  does not install reusable authority; every proposal receives an independent decision.

The host broker owns profile installation and standing-policy changes. Agent-controlled project
files and client-reported identity are never authority. A profile binds project, physical root,
subject, host, trusted client, policy digest, and `modeEpoch`. Profile or policy rotation atomically
invalidates uncommitted authorization from the previous epoch.

## Runtime chain

```text
PendingOperation
  -> trusted host or standing-policy decision for that proposal
  -> ExactAuthorization
  -> ApprovalArtifact
  -> exact receipt and commit claim
  -> live gate and digest validation
  -> atomic canonical mutation
  -> finalize or exact replay
```

Decline rejects the proposal. Cancel, malformed input, expired state, a changed live binding, or an
untrusted response creates no artifact and leaves the proposal pending where recovery is possible.
An outer host tool-admission prompt cannot substitute for RouteLedger's inner exact decision.

## Public integration surface

`BoundLocalL3Authority` exposes an `ExactAuthorizationStore` and, for standing-policy modes, an
authority with `requestExactDecision`. `configureStandingPolicy` changes policy configuration; it
does not mint future credentials. Policy rules may use `decisionBudget` to bound evaluations, and
profiles use `maxAuthorizationTtlSeconds` to bound one credential's validity.

Legacy state is decoder/migrator input only. Upgrade revokes and tombstones every historical active
record and requires a new exact decision. Historical committed audit remains readable, but cannot be
promoted back into executable authority.

## Acceptance checks

- Exact binding mismatches fail closed before an artifact is created.
- Each proposal gets a distinct authorization, including under a standing policy.
- Concurrent consumption produces at most one artifact and one canonical mutation.
- Restart/resume verifies the sealed tuple against live project and physical-root state.
- Public schemas, CLI output, package builds, and plugin payload contain no reusable-authority API.
