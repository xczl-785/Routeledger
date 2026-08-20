# Exact-only authorization contract

Status: implemented contract. Runtime adoption completed through EA1-EA5 and
the exact-only chain is part of the published 0.8.x baseline.

## Complete target

Every L3 mutation follows one exact chain:

```text
PendingOperation
  -> trusted host or standing-policy decision for that exact proposal
  -> ExactAuthorization and distinct decision artifact
  -> single-use receipt claim
  -> commit-time live validation
  -> atomic mutation
  -> finalize or exact replay
```

`PendingOperation` and its operation digest remain canonical. Exact identity is the tuple of
proposal, project, RouteLedger-root digest, action, target, and operation digest. No adapter,
policy, profile, session, or time window may widen that tuple.

## Frozen v2 records

`ExactAuthorization` has a stable `authorizationId` distinct from `artifactId`, one exact binding,
decision source and reference, issuer/audience/subject, optional policy and profile provenance,
host/client provenance, and creation/expiry
timestamps. It has no scope, action array, target array, use budget, or matching API.

`ExactAuthorizationReceipt` repeats the same exact binding and owns the single commit-claim
lifecycle: `authorized -> commit_claimed -> committed`, with `revoked` as a fail-closed terminal
state. A finalize retry with the same exact claim is replay; another claim cannot consume it.
This lifecycle applies equally to interactive, delegated, preauthorized, and profile-less Codex
`host_admission` decisions.

The public decision-artifact response exposes exact binding and identities, but no scope or grant
reuse vocabulary. Generic elicitation asks only for the decision on the displayed exact proposal;
it must not offer operation/session/time-window choices.

## Standing policy and `preauthorized`

The user-facing name `preauthorized` remains in 0.8. It means a standing trusted policy evaluates
each proposal independently and mints a new exact decision. It does not mean an active reusable
grant. A policy allow result cannot be replayed against another proposal even when action and
target are equal.

## Compatibility and migration

Current writers do not emit `sessionId`. A legacy decoder may read it only while classifying old
audit records; it is never part of matching, authority, or receipt verification.

All legacy active grants are revoked and tombstoned, including operation-scoped one-shot grants;
the proposal must be authorized again under v2. Session, time-window, turn, multi-action,
multi-target, nullable-digest, and multi-use authority never migrates as active authority. Legacy
artifacts and receipts remain immutable audit evidence. Host state may migrate policy
configuration, but not grant IDs, budgets, sessions, expiry windows, or active authority.
Partial profile provenance is audit-only and fails closed; the profile ID, epoch, and digest are an
all-or-none trusted trio.

JSON and SQLite readers use dual-read/exact-only-write during 0.8. Old binaries must reject the new
state rather than partially interpret it. Migration is atomic, idempotent, and leaves a durable
tombstone.

## Compatibility goldens and target reds

- The 0.7.2 Codex explicit `propose -> approve -> commit` flow remains a golden behavior.
- The 0.7.2 Codex one-call `execute_l3_operation` flow remains a golden behavior.
- A dedicated lifecycle proposal can resume after process reconstruction through
  `execute_admitted_proposal(pendingOperationId)` without weakening exact authorization.
- Exact digest binding, single consumption, commit claim, live validation, atomic save, finalize,
  replay, rejection, expiry, stale-proposal handling, and audit remain mandatory.
- The v2 generic input schema in `exact-authorization-contract.ts` is the target oracle: it has no
  scope field. The legacy 0.7.2 elicitation schema is expected to remain unchanged during EA0 and
  is replaced only in EA3.

## Version ownership

- EA0 freezes this contract, fixtures, migration classification, and goldens only.
- EA1 implements the exact authorization kernel.
- EA2 implements persistence migration and legacy isolation.
- EA3 converges host adapters and external protocols.
- EA4 removes legacy vocabulary from public contracts and source surfaces.
- EA5 performs aggregate verification, independent audit, and merge preparation.

No EA Version is a separately mergeable feature release. All advance on one feature branch and
merge to `main` only after EA5 passes its independent audit.

## Compatibility matrix

| Input | Read | Migrate | New write | Authorize / replay |
| --- | --- | --- | --- | --- |
| JSON v1 artifact without provenance | audit-only | retain immutable | exact v2 only | never authority |
| JSON v1 artifact with full profile trio | audit-only | retain immutable | exact v2 only | old receipt replay only |
| JSON v1 artifact with partial profile trio | fail closed as trusted input | retain invalid audit evidence | rejected | never authority |
| SQLite through migration 0006 | read historical rows | 0007 then v2 migration | exact v2 only | legacy grants reauthorize |
| SQLite 0007 provenance JSON | read full provenance | preserve all fields | exact v2 only | legacy receipt audit/replay only |
| authority state v1 operation grant | read and classify | revoke+tombstone | no legacy grant | reauthorize |
| authority state v1 session/time-window/turn grant | read and classify | revoke+tombstone | forbidden | reauthorize |
| profile v2 interactive/delegated/preauthorized | read policy configuration | adopt config, rotate authority | exact per proposal | exact replay only |
| disabled/rotated profile | read audit state | no active authority | exact only after fresh decision | reject old authority |
| Codex explicit three-step / one-call | preserve behavior | exact internal records | exact only | exact replay |
| generic elicitation / decline / no capability | preserve fail-closed behavior | remove scope transport in EA3 | exact only | no decision means no artifact |

EA2 must add executable crash, locking, idempotence, corrupt-state, and old-binary rejection tests.
One known 0.7.2 baseline defect is deliberately not repaired in EA0: SQLite
`authorization_provenance_json` currently omits `profileId`, `modeEpoch`, and `profileDigest` on
round trip. Its target test is recorded as pending and EA2 owns the fix.
