# NF1 recovery and storage-boundary decision

Status: Stage 1 protocol implemented and verified on 2026-08-21. The persisted
commit-owner recovery gap is closed. The NF1 storage-boundary refactor remains
deferred.

This decision is deliberately narrow. It applies only to the persisted L3
exact-authorization commit boundary. It does not add lease, fencing, migration,
or architecture-document requirements to ordinary writes or small refactors.

## Decision summary

1. Introduce an independent `ExactCommitCoordinator` application port. It owns
   acquire, renew, ownership assertion, and owner-checked release for one
   pending operation. `ExactAuthorizationStore` continues to own exact
   authorizations and receipt claim/finalize state.
2. Implement the local coordinator with authority state schema version 3. Each
   pending operation has one persisted lease record with owner identity,
   heartbeat/expiry timestamps, and a monotonic generation used as a fencing
   token. Release retains the last generation so a later owner cannot reuse it.
3. Permit automatic takeover only when the lease has expired and local process
   liveness is positively known to be dead. A live owner, unknown liveness,
   invalid metadata, or ambiguous clock state remains fail closed.
4. Migrate schema-v2 state automatically only when `commitOwners` is empty. A
   non-empty legacy owner has no PID, lease, or generation evidence and is
   preserved as `legacy_blocked` until explicit offline recovery reconciles the
   canonical operation and receipt state.
5. Preserve the existing durable order: stable receipt claim, canonical
   aggregate save, receipt finalize, then owner-checked release. The stable
   claim remains the replay identity; lease generation is only concurrency
   evidence and does not widen the exact authorization tuple.
6. Do not change `StoragePort`, extract its hidden aggregate revision contract,
   split `RouteLedgerService`, or refactor the MCP registry in this work. The
   service receives only the minimal coordinator integration around its
   existing commit path.

## Evidence and current ordering

The outer commit wrapper in
`packages/core/src/application/routeledger-service.ts` now acquires ownership
through `ExactCommitCoordinator` under the project/pending-operation key. The
returned opaque token carries the owner identity, lease, and monotonic fencing
generation. The service renews and asserts it before each durable commit
boundary and performs owner-checked release in `finally`.

Inside the owned commit, the durable protocol is ordered as follows:

1. derive a stable claim ID from the approval artifact, pending operation, and
   operation digest;
2. claim the exact-authorization receipt;
3. apply the route transition and save the canonical project aggregate;
4. finalize the exact-authorization receipt;
5. return through the outer wrapper and release the random commit owner.

The stable receipt claim remains intentionally replayable. Local authority
state schema version 3 persists the independent coordination record so a new
process can replace an expired owner only after that owner is definitively
dead.

## Crash-window analysis

| Crash point | Durable state | Recovery path now verified |
| --- | --- | --- |
| Before receipt claim | Approval remains usable. | Replace the dead generation, re-enter validation, and claim normally. |
| After claim, before canonical save | Receipt is `commit_claimed` with the stable claim ID. | Reuse the same stable claim and complete one canonical mutation. |
| After canonical save, before receipt finalize | Route mutation is committed; receipt still needs recovery. | Detect committed canonical state and finalize without repeating the mutation. |
| After receipt finalize, before owner release | Canonical mutation and receipt are complete. | Return the idempotent replay and owner-check release generation 2. |

Normal exceptions do not leak ownership because `finally` releases it. Process
death is recovered through the expired-lease plus definitively-dead takeover
rule; live or unknown liveness remains fail closed.

## Rejected shortcuts

- Stop persisting `commitOwners`: this removes cross-instance exclusion around
  the full claim/mutate/save/finalize sequence.
- Delete every owner on startup: another live process may still own the commit.
- Use the stable receipt claim ID as the owner ID: concurrent duplicate calls
  would present the same identity and both be admitted.
- Treat the canonical storage revision as the owner: it detects a stale final
  save but does not serialize the surrounding trusted-authorization protocol.

## Accepted Stage 1 protocol

The coordinator returns an opaque handle containing the project/pending-
operation key, owner identity, lease expiry, and generation. The local
authority adapter persists the matching schema-v3 record, and the service
renews it at durable boundaries while the L3 commit is active.

The commit path asserts the same owner and generation before receipt claim,
before canonical save, and before receipt finalize. Release succeeds only for
that same owner and generation; a stale owner cannot release a replacement.
Heartbeat failure stops the commit at the next assertion boundary.

An expired lease alone is not evidence for takeover. The local adapter may
increment the persisted generation and replace the owner only after it can also
establish that the recorded process is dead. If the recorded PID is alive, if
PID reuse cannot be excluded, or if liveness cannot be established, it returns
a fail-closed in-progress or recovery-required result. Online force unlock is
outside this protocol.

The existing stable receipt claim remains unchanged. After dead-owner takeover,
the four crash windows recover as follows:

- before claim, re-enter validation and claim normally;
- after claim but before save, reuse the same claim, revalidate, and save once;
- after save but before finalize, detect committed canonical state and finalize
  without repeating the mutation; and
- after finalize but before release, return the committed replay and release
  the replacement generation.

## Migration and compatibility

Schema-v2 state with an empty `commitOwners` map migrates atomically to schema
version 3 with no active coordination record. Existing state-file locking,
revision checks, and atomic replacement remain in use.

Schema-v2 state with any owner migrates that key to `legacy_blocked`. Startup
must not infer that it is stale. Recovery is an explicit offline operation after
old hosts are stopped; it reconciles the matching canonical pending operation,
approval artifact, and exact receipt before releasing a new generation.

Schema-v3 is exact-write only. Older binaries must reject it rather than
partially interpret or overwrite it. Canonical project JSON, the SQLite read
model, operation digests, approval artifacts, and exact-authorization schema
version 2 remain unchanged.

## Verification delivered and deferred work

Verification covers ownership generation, renewal and stale release; expired
leases with live, dead, unknown, and replaced-process identities; v2 migration;
the four crash windows in one parameterized acceptance group; concurrent
duplicate commits; canonical storage revision protection; and strict rejection
of malformed or unsupported state.

The acceptance group proves that canonical mutation and its transition events
happen at most once across all four recovery windows, while uncertain ownership
fails closed. Redesigning `StoragePort`, splitting the application facade, or
reorganizing MCP control flow remains separate non-functional work.
