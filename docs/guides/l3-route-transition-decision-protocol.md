# L3 route-transition decision protocol

Status: accepted product and architecture baseline.

L3 is RouteLedger's protocol for deciding and committing high-risk route changes. Host UX can vary,
but every path uses the same canonical chain:

1. Create one `PendingOperation` with an immutable `operationDigest`.
2. Resolve a trusted decision for that exact proposal.
3. Create a single-use `ExactAuthorization` bound to proposal, project, physical RouteLedger root,
   action, target, and operation digest.
4. Persist a separate `ApprovalArtifact` and authorization receipt.
5. Re-read live state, claim the receipt, apply one atomic mutation, and finalize it.
6. Retry only through exact replay of the same binding and identities.

## Host modes

| Host mode | Decision source | RouteLedger result |
| --- | --- | --- |
| Interactive | Trusted user decision for the current proposal | One exact authorization |
| Delegated | Host-owned standing policy evaluates the current proposal | One exact authorization |
| Preauthorized | A standing policy previously approved by the user evaluates the current proposal | One exact authorization |
| Codex native admission | Codex admits the current high-risk tool call | One exact host-admission authorization |

The labels describe how a decision is obtained, not a reusable permission. No mode authorizes a
session or time window, and no decision can widen the proposal tuple.

## Generic MCP interaction

The elicitation payload is exactly `{ "approve": boolean }`. The server rejects additional keys.
Explicit decline rejects the proposal. Cancel or malformed content creates no artifact and keeps the
proposal pending. When elicitation is unavailable, RouteLedger fails closed.

## Resume and recovery

The resumable request state is authenticated and seals the exact tuple plus the command arguments.
Resume reloads the proposal and compares every field with the live project and current physical root.
Expired, tampered, stale, or secret-rotated state does not create a second proposal or artifact.

Receipt claim and finalize are shared by all decision sources. A canonical save failure can retry
under the same owner; another concurrent owner cannot pass the claim. If canonical state was saved
before finalize failed, exact replay finishes finalization without repeating the mutation.

## Compatibility boundary

Legacy authorization records are read only by decoders and migrators. Upgrade revokes and
tombstones them, including records that looked like one-shot operation credentials. Historical
committed audit remains readable and immutable, but never becomes executable authority.
