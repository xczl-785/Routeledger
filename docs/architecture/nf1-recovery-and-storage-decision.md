# NF1 recovery and storage-boundary decision

Status: accepted for NF1 planning on 2026-08-13.

This decision separates recovery-policy work from the non-functional refactor.
It does not authorize a production behavior, schema, or storage-contract change.

## Decision summary

1. Keep the local authority state-file lease design as the current contract.
   Its lock identity, heartbeat, live-process check, stale-owner reclamation,
   revision check, and fail-closed ownership checks already cover the intended
   stale-lock lifecycle. The independently shipped Windows `EPERM` retry fixes
   a host race without changing that policy.
2. Do not change persisted `commitOwners` during NF1. A process crash can leave
   a random owner that permanently blocks a safe replay, but deleting the field
   or automatically ignoring it would weaken cross-process exclusion. Recovery
   needs a separately authorized, security-sensitive functional Version.
3. Defer the proposed NF1 storage-boundary extraction. The canonical storage
   head revision prevents stale aggregate writes; it neither creates nor
   recovers exact-authorization commit ownership. Replacing its hidden snapshot
   metadata now would add refactor risk without resolving the recovery gap.

## Evidence and current ordering

The outer commit wrapper in
`packages/core/src/application/routeledger-service.ts` acquires ownership under
the pending-operation ID with a newly generated UUID, runs the commit, and
releases the owner in `finally`. `ExactAuthorizationStoreState` persists this
plain `authorizationId -> ownerId` map without a lease, timestamp, fencing
token, or recovery record.

Inside the owned commit, the durable protocol is ordered as follows:

1. derive a stable claim ID from the approval artifact, pending operation, and
   operation digest;
2. claim the exact-authorization receipt;
3. apply the route transition and save the canonical project aggregate;
4. finalize the exact-authorization receipt;
5. return through the outer wrapper and release the random commit owner.

The stable receipt claim is intentionally replayable. The random persisted
owner is not: after restart, a new call has a different UUID and cannot acquire
the abandoned entry.

## Crash-window analysis

| Crash point | Durable state | Intended replay path | Current blocker |
| --- | --- | --- | --- |
| Before receipt claim | Approval remains usable. | Re-enter the ordinary commit path. | Abandoned random owner rejects the call first. |
| After claim, before canonical save | Receipt is `commit_claimed` with the stable claim ID. | Reuse the same claim and finish the commit. | Abandoned random owner rejects the call first. |
| After canonical save, before receipt finalize | Route mutation is committed; receipt still needs recovery. | Detect the committed operation and finalize with the same claim ID. | Abandoned random owner rejects the replay first. |
| After receipt finalize, before owner release | Canonical mutation and receipt are complete. | Return the idempotent committed result. | Abandoned random owner still rejects the replay first. |

Normal exceptions do not leak ownership because `finally` releases it. The gap
is specifically process death or equivalent interruption that prevents the
release transaction.

## Rejected shortcuts

- Stop persisting `commitOwners`: this removes cross-instance exclusion around
  the full claim/mutate/save/finalize sequence.
- Delete every owner on startup: another live process may still own the commit.
- Use the stable receipt claim ID as the owner ID: concurrent duplicate calls
  would present the same identity and both be admitted.
- Treat the canonical storage revision as the owner: it detects a stale final
  save but does not serialize the surrounding trusted-authorization protocol.

## Requirements for separate functional work

The future recovery Version must define and test a commit-coordination record,
not merely rename the current map. Its acceptance criteria are:

- distinguish concurrent live owners from an abandoned owner;
- define identity, lease/liveness, renewal, expiry, and takeover rules;
- preserve fail-closed behavior when ownership or authority state is unclear;
- prevent a former owner from committing or releasing a replacement owner's
  lock, using a fencing or equivalent ownership proof;
- preserve the stable receipt claim and committed-operation replay semantics;
- cover each crash window above, process restart, concurrent duplicate calls,
  lease expiry with a live owner, takeover, and storage-revision conflict;
- explicitly decide migration of existing authority state and its schema/
  release impact.

This work must not share a commit or review unit with a `RouteLedgerService`,
MCP registry, or storage-boundary extraction.

## NF1 consequence

NF1 may document and characterize the existing behavior, including the current
fail-closed `WRITE_IN_PROGRESS` result. It must not encode the abandoned-owner
behavior as a desirable long-term contract. Storage-boundary work remains
deferred until the recovery Version has an approved design or demonstrates a
concrete need for that extraction.
