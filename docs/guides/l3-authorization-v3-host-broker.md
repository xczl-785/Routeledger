# L3 authorization V3: host authority broker

Status: implementation contract for the 0.6.0 candidate. This document does not claim that the
Codex Desktop host integration is complete.

## Product boundary

V3 provides three mutually exclusive local authorization modes for one OS user and one bound
RouteLedger project:

- `interactive`: every exact L3 operation requires a trusted host decision.
- `delegated`: a deterministic policy may authorize a matching exact operation; deny rules win and
  unmatched or `alwaysPrompt` operations require a trusted host decision.
- `preauthorized`: only a finite, previously issued grant may authorize the operation. A miss is a
  deny unless the user explicitly starts a separate one-time interactive ceremony.

V3 does not include remote authority, organization or multi-user identity, OAuth, cross-device
synchronization, wildcard targets, unlimited expiry, unlimited use budgets, or Mission Control
writes.

## Threat boundary

Project files, Agent messages, tool arguments, `confirm`, `decisionRef`, MCP App DOM events, and
client-reported names are untrusted inputs. They may request or display an authorization change,
but they cannot install a profile, change a mode, widen a scope, issue a grant, or revoke a grant.

The only authorization writer is a host-owned broker whose registry is injected at process
startup and stored outside both the workspace and the RouteLedger root. A workspace-write Agent
must not be able to write the registry. This boundary does not claim to resist a process that has
arbitrary write access as the same OS user.

For Codex, an explicit generated MCP config may pass `--l3-authority-registry` and
`--l3-trusted-client-id`. The bundled plugin also discovers an already initialized registry at
`$CODEX_HOME/routeledger/l3-authority-v2` (or `~/.codex/routeledger/l3-authority-v2`) only when its
trusted `registry-v2.json` marker already exists. MCP startup never creates or installs an
authority profile. A missing registry or missing bound profile remains neutral and fail-closed.

```text
Agent or MCP App
  -> candidate/request
  -> trusted host interaction + host authority broker
  -> opaque exact grant
  -> host-owned consumption receipt
  -> canonical approval artifact
  -> commit-time live revalidation
```

The canonical approval artifact is an audit projection. It is never sufficient for commit without
the matching host-owned receipt.

## Profile and invalidation contract

Each persistent profile is bound to the canonical project and host identity:

```text
projectId + workspaceRootDigest + routeledgerRootDigest
+ subjectId + hostKind + trustedClientId
```

The binding key is a SHA-256 digest of canonical JSON. Filesystem digests use canonical realpaths,
not the caller's path spelling. A session identifier constrains a grant but is not part of the
persistent binding key.

Three counters have separate meanings:

- `authorityRevision`: every broker state mutation; used for transaction ordering.
- `profileRevision`: optimistic concurrency for profile edits.
- `modeEpoch`: authorization invalidation generation. A mode, binding, policy, or effective limit
  change increments it and invalidates older uncommitted authorization.

Every grant and receipt carries `profileId`, `modeEpoch`, and `profileDigest`. A grant is rejected
when any of those values differs from the active profile.

## Grant scope contract

- `operation`: one action, one target, exact operation digest, `maxUses=1`.
- `session`: exact session identifier, explicit actions and targets, finite TTL and use budget.
- `time_window`: no session identifier, explicit actions and targets, finite TTL and use budget.
- `turn`: retained only for compatibility and is not issued by V3.

Interactive and delegated decisions issue only exact one-use operation grants. Session and
time-window grants may be issued only by the broker's trusted-host interaction adapter after it
renders the canonical action, target, TTL, use budget, and session binding. Empty targets,
wildcards, infinite TTL, and infinite use budgets are invalid.

## Rebinding and concurrency

The broker resolves a separate bound authority after the MCP session has a verified project/root
binding. A rebind constructs the new authority completely before swapping registries. Failure keeps
the previous registry active and never carries the previous project's grants into the new project.

Profile edits use compare-and-swap. Budget consumption, receipt creation, mode rotation, revoke,
and commit claims share one broker transaction boundary. Revoke and commit compete for one
linearization point:

- revoke first: the authorized but uncommitted receipt becomes revoked and commit fails;
- commit claim first: revoke reports that commit is already claimed and the commit may finish.

Committed history remains immutable.

## V1 adoption

The 0.5.1 delegated configuration is never widened or migrated automatically. Its explicit
`--l3-authority-config` compatibility path remains separate from the V2 registry, and startup
rejects using both paths together. Explicit V1-to-V2 adoption is deferred until a trusted host
ceremony can preserve policy usage and receipt provenance without widening access. Until then,
users may keep the V1 path or install a newly reviewed V2 profile; no implicit conversion occurs.

## Codex G0 result

Codex app-server 0.147.0 supports normal Agent turns, structured MCP elicitation, and a thread/turn
`approvalsReviewer` setting. The elicitation response contains action, content, and optional client
metadata, but no stable reviewer identity or user-gesture attestation.

The protocol evidence is the official [Codex App Server approval and elicitation contract](https://learn.chatgpt.com/docs/app-server#approvals),
which specifies `accept`/`decline`/`cancel` plus `serverRequest/resolved`, and the official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), which
defines `auto_review` as a reviewer subagent for eligible outer approval prompts. The absence of a
per-elicitation user attestation is an inference from that published wire contract and the live G0
probe, not a claim that future Codex hosts cannot add one.

Therefore a headless client that replies `accept` proves the JSON-RPC and form wire only. It does
not prove a physical user click. `auto_review` must never be treated as RouteLedger user authority.
Until Codex exposes a trusted host adapter or verifiable user-decision provenance, the plugin may
ship status, recommendation, request, and protocol-smoke surfaces, but must not claim that an MCP
App or bare elicitation response is the authority writer.

`scripts/smoke-codex-app-server-normal-turn.mjs` is the authenticated local release probe. It
starts a real thread and turn, auto-resolves only the outer app-tool prompt, records the final
`mcpToolCall`, and can prove that a bare inner elicitation acceptance is rejected. The required
environment is:

```text
ROUTELEDGER_CODEX_NORMAL_TURN_CWD=<isolated bound workspace>
ROUTELEDGER_CODEX_NORMAL_TURN_PROMPT=<one exact RouteLedger tool request>
ROUTELEDGER_CODEX_NORMAL_TURN_TOOL=<expected tool name>
ROUTELEDGER_CODEX_NORMAL_TURN_INNER=none|bare_accept_rejected|cancel
```

This automated probe is not the Desktop user-interaction gate. That gate requires the exact
candidate installed in Codex Desktop, a native prompt showing the canonical project/action/target
and operation digest, an actual user click, the resulting host decision ID, the exact runtime
payload digest, and the matching RouteLedger receipt. Until Codex supplies that decision
provenance to the broker adapter, the expected Desktop verdict is `BLOCKED_BY_HOST_CAPABILITY`, not
a synthetic pass.

## Acceptance gates

1. Profile digest, mode epoch, binding, and grant-scope negative tests.
2. Registry path ownership, permissions, symlink, and workspace-containment tests.
3. Project A to B rebind isolation and multi-process budget/CAS tests.
4. Revoke-versus-commit, crash recovery, and exact replay tests.
5. V1/V2 mutual exclusion, no-auto-migration, and supported downgrade fail-closed tests; explicit
   adoption remains a later host-ceremony slice.
6. Normal Agent turn tests for all modes, including proof that outer tool approval alone is
   insufficient and that `auto_review` does not answer inner authorization.
7. A separate Codex Desktop user-interaction gate for real rendering and user decision evidence.
8. Full test, typecheck, lint, package/plugin/marketplace/host smoke, previous-tag release check,
   clean runtime identity, and independent read-only security audit.
