# L3 exact decision protocol roadmap

Status: implementation route through exact-only public cleanup; release work remains separate.

## Target

Every Codex, generic MCP, CLI, delegated, and preauthorized entry produces at most one exact
authorization for one pending proposal. The shared binding is proposal, project, physical
RouteLedger root, action, target, and operation digest. Receipt claim/finalize, live validation,
atomic mutation, and exact replay are common to every source.

## Completed implementation waves

| Wave | Observable result |
| --- | --- |
| Contract | Exact identity, artifact, receipt, migration classification, and negative oracles frozen |
| Core | Single-use exact store and unified authorize/claim/finalize/replay kernel |
| Persistence | Dual-read legacy migration and exact-only writes across host state, JSON, and SQLite |
| Protocol | Codex, generic MCP, CLI, delegated, and preauthorized modes decide each proposal independently |
| Public cleanup | Public schemas, APIs, output, docs, and build payload expose only the exact model |

## Release boundary

Cross-platform installation, packaged-host acceptance, merge to `main`, immutable tag creation, and
publication are release activities. They are not implied by a green implementation branch. The
release gate must rebuild package and plugin payloads from the selected commit, run real host
smokes, verify payload identity/digests, then follow the protected-main and immutable-tag process.

## Durable invariants

- `PendingOperation` and `operationDigest` remain canonical.
- Authorization identity and approval artifact identity remain separate.
- Standing policy is evaluated per proposal and never creates reusable authority.
- Explicit decline rejects; cancel or invalid response creates no artifact.
- Resume authenticates and rechecks the complete live tuple.
- Legacy records remain decoder/migrator or immutable audit input only.
