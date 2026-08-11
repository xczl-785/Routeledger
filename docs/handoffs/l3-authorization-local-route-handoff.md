# L3 local authorization route handoff

Status: continuation handoff after the published RouteLedger plugin `0.6.0`.

> Direction update: the product/trust interpretation in this historical handoff is superseded by
> [`L3 route-transition decision protocol`](../guides/l3-route-transition-decision-protocol.md).
> In particular, L3 is now defined as a route-transition decision protocol whose full internal
> flow runs in every mode; permission modes control decision automation, and physical-click proof
> is no longer a universal prerequisite. The implementation facts and deferred-work inventory in
> this handoff remain useful historical evidence.

Baseline: `main` at `1b2308e62c296febc7b3902684d6b949184a71c8`, tag
`routeledger-plugin-v0.6.0`.

Handoff branch: `docs/v3-codex-authorization-handoff`.

This is a task-level handoff, not a release approval. It records the whole local authorization
route so that V2 work remains visible while the next machine continues the V3 Codex experience.
It does not authorize merging `main`, tagging, publishing, or writing a bound project's canonical
RouteLedger JSON.

## 1. Outcome and current product truth

The intended product is a host-native authorization chooser for L3 operations, comparable in
shape to Codex's approval choices:

1. **Every time ask** — every exact operation needs a trusted user decision (`interactive`).
2. **Approve for me** — deterministic recommended rules may approve matching operations
   (`delegated`).
3. **Full access for this project** — a bounded, finite grant for the current project and session
   or time window (`preauthorized`). It is not permanent, cross-project, unlimited, remote, or
   multi-user access.

The authority must never be natural-language text, an Agent claim, a project-local file, a bare
MCP form response, or an MCP App click. A trusted host adapter must turn an authenticated user
decision into the broker's internal profile/grant state. Other local MCP hosts may later provide
the same contract through their own trusted adapter or external configuration. When no trusted
host interaction exists, the system fails closed.

Plugin `0.6.0` completed the local authorization security kernel and control plane. It did **not**
complete the native Codex three-choice product experience. In particular, the current plugin can
discover an already provisioned host-owned registry and can read or recommend authorization
state, but it cannot use a verified native Codex user gesture to install or switch the mode.

## 2. Why an internal Profile exists

The Profile mechanism did not originate as a requested user-facing object. It emerged while
closing a critical trust-boundary defect:

1. The first delegated-policy design placed authority and usage state under the project-local
   `.routeledger` directory.
2. A normal workspace-write Agent could then edit its own allow policy or reset its budget. That
   made self-authorization possible.
3. Authority moved outside the workspace and RouteLedger root into host-owned storage.
4. The broker still needed one durable record that bound project/root identity, selected mode,
   allowed scope, budget, revision, invalidation epoch, and digest. That record became the
   internal Profile.
5. Because the inspected Codex app-server wire did not provide verifiable per-elicitation user
   identity or user-gesture provenance, implementation and testing converged on pre-provisioned
   Profiles. This proved the three modes and their security properties, but shifted acceptance
   away from the original native-chooser experience.

The architecture correction is therefore not to remove the Profile from the security model. It
is to hide `profileId`, `profileDigest`, `modeEpoch`, and related broker bookkeeping from normal
users. The Codex chooser and settings surface should be the product entry; Profile remains trusted
internal state and may appear only in advanced diagnostics or audit evidence.

## 3. Recovered version chain

The route was originally split into V1, V2, and V3. A proposed V4 for remote or multi-user
authority was explicitly removed because it is not a product requirement. Different local
projects are separate authorization bindings, not separate users.

| Version | Intended result | Completed | Still open | State |
| --- | --- | --- | --- | --- |
| V1 — authorization kernel and trust boundary | Agent cannot manufacture authority; grants, budgets, receipts, replay, and commit are durable and fail closed | External host-owned config/state; persistent atomic grant/budget/receipt handling; fencing, leases, concurrency and crash recovery; exact replay isolation; no self-reported client identity as authority. Released in `0.5.1` and strengthened in `0.6.0` | Optional explicit adoption ceremony from the legacy `0.5.1` delegated config into the newer registry remains deferred. No automatic migration or widening is allowed | Complete as the operational foundation; adoption is a separately deferred compatibility item |
| V2 — MCP-native interaction and protocol compatibility | The same authorization challenge works safely across supported local MCP hosts and protocol generations | MCP 2025 structured elicitation wire; accept/decline/cancel and fail-closed behavior; Codex app-server protocol probe; outer-tool versus inner-L3 approval separation; normal-turn evidence | MCP 2026-07-28 MRTR/InputRequiredResult adapter; protocol negotiation; requestState and retry negative matrix; generic stdio MCP conformance; no-popup trusted external-config fallback; additional local-host adapters | Partially complete and intentionally deferred, **not removed** |
| V3 — Codex three-mode experience | A user selects the L3 authorization mode in trusted Codex UI; RouteLedger securely applies, displays, switches, and revokes it | Profile schema, host registry, broker, three-mode evaluation, finite grants, provenance, revoke/commit lifecycle, migration guards, normal-turn harness. Released as the `0.6.0` control-plane slice | Trusted Codex user-decision adapter; native three-choice chooser; mode settings/re-entry; user-facing view/revoke; hiding Profile internals; real Desktop acceptance | Security kernel complete; product experience incomplete |

### Why V2 was not finished earlier

V2 first depended on V1's trusted persistent state. V1 is now complete, so that dependency no
longer blocks it. V2 was then deliberately placed after the Codex path because Codex's current MCP
2025 interaction was enough to investigate and build V3, while MCP 2026 and generic-host work did
not block that investigation. This was an ordering decision, not a scope deletion.

The remaining V2 work must stay in the release route and acceptance plan. A future thread must not
declare the local multi-host goal complete merely because the Codex chooser works.

## 4. Accepted decisions and fixed boundaries

- Profile is internal trusted state, not the primary product concept.
- The user-facing choices are every-time ask, approve-for-me, and bounded current-project full
  access.
- `delegated` uses deterministic rules. Natural-language instructions never grant authority.
- The product should recommend a complete deterministic rule checklist so omission of one common
  rule does not unexpectedly stop routine work. The user may remove or tighten individual rules.
- Widening scope, changing to a more permissive mode, or increasing TTL/use budget requires a new
  trusted user decision. Tightening and emergency revoke take effect immediately through the
  trusted broker.
- `preauthorized` is finite and explicitly scoped to actions, target IDs, project/root, subject,
  trusted client, TTL, and use budget. No wildcard target, infinite TTL, infinite uses, or
  cross-project grant.
- An unmatched preauthorization denies. It may offer a separately initiated one-time interactive
  decision, but must not silently fall back to delegated authority.
- A bare Codex outer tool approval does not constitute RouteLedger L3 authorization.
- An MCP App, Agent message, `confirm`, `decisionRef`, or self-reported client name cannot install,
  switch, widen, mint, or revoke authority.
- Scope is local, single OS user, multiple projects. Remote authority, organizations, multi-user
  identity, OAuth, and cross-device synchronization remain out of scope.

## 5. Evidence boundary that must be re-admitted

The `0.6.0` G0 probe and public Codex app-server contract showed structured MCP elicitation but no
stable per-elicitation user identity or user-gesture attestation. Therefore a headless client that
returns `accept` proves only the JSON-RPC/form wire. It does not prove that a physical user clicked
a trusted Codex control. `auto_review` is a reviewer subagent and must never be treated as user
authority.

This is an evidence-based limitation of the inspected host version, not a permanent claim about
Codex. The next machine must recheck the installed Codex version, current app-server schema, and
current official documentation before selecting an implementation path.

## 6. Recommended continuing version route

The durable order preserves the earlier `V1 -> V3 -> V2` decision while ensuring V2 closes before
the integrated local-host result is released.

### V3-R1 — trusted Codex capability admission

**Todo**

- Record the installed Codex version and feature/schema output on the target machine.
- Re-run a normal Agent turn and inspect native approval/elicitation events.
- Determine whether Codex exposes a trusted, non-forgeable user decision that can bind the
  canonical project, action, target, operation digest, selected mode, TTL, and use budget.
- Prove that headless `accept`, MCP App messages, Agent arguments, and `auto_review` cannot create
  that authority.

**Constraint**

- Do not invent trust with prompt wording, client names, DOM events, or a project-local secret.
- If no suitable host capability exists, record `BLOCKED_BY_HOST_CAPABILITY` and keep the existing
  control plane fail closed.

**Acceptance**

- PASS only when a trusted Codex gesture can be cryptographically or structurally bound to the
  exact broker decision, or when an explicitly trusted host-private adapter supplies equivalent
  provenance.

### V3-R2 — native chooser and user-facing settings

**Todo**

- Present the three choices on first L3 use and provide a clear settings/re-entry path.
- Render canonical action, target, project, duration, use budget, and risk summary in trusted host
  chrome rather than Agent-authored prose.
- Install the broker Profile/grant only after the trusted decision from V3-R1.
- Provide the recommended delegated-rule checklist with safe defaults and visible fallback
  behavior.
- Show user concepts and remaining access, not Profile identifiers. Keep identifiers available in
  advanced diagnostics/audit evidence.
- Add safe mode switching, tightening, and revoke semantics; preserve existing `0.6.0` Profiles
  without widening them during migration.

**Deferred**

- Visual management UI inside an untrusted MCP App remains read/request-only unless Codex makes it
  part of a trusted authorization surface.

**Acceptance**

- A real Desktop user can select all three modes, understand their effective scope, revisit the
  selection, and revoke access. Each resulting operation carries matching broker provenance and
  survives restart without widening.

### V2-R1 — MCP 2026 protocol closeout

**Todo**

- Add the MCP 2026-07-28 MRTR / `InputRequiredResult` + `inputResponses` + `requestState` adapter.
- Negotiate MCP 2025 versus MCP 2026 while sharing one canonical authorization challenge and
  broker decision model.
- Test tampered `requestState`, duplicate delivery, disconnect, timeout, retry, and crash recovery.
- Prove retries cannot double-consume a budget or double-commit an operation.

**Constraint**

- Protocol differences are adapters only. They must not introduce a second authorization model or
  weaken the V1/V3 trust boundary.

**Acceptance**

- The same exact proposal produces equivalent safe outcomes on both protocol paths, including all
  negative and retry cases.

### V2-R2 — generic local MCP host conformance

**Todo**

- Add generic stdio MCP conformance outside Codex.
- Specify and test a no-popup fallback based on trusted external host configuration or adapter
  injection.
- Document how another local Agent platform can mount its trusted interaction adapter.
- Verify absence of UI fails closed while read-only status and proposal creation remain usable.

**Constraint**

- No authority in project files, natural-language instructions, self-reported host identity, or
  ordinary MCP tools.
- This remains local and single-user; do not expand into remote or multi-user infrastructure.

**Acceptance**

- At least one non-Codex local stdio harness proves the adapter/config contract, binding checks,
  finite grants, revoke, restart, and negative forgery cases.

### V3-R3 — integrated local-host product and release candidate

**Todo**

- Treat Codex as the first trusted-host adapter and the generic V2 contract as the extension point
  for other local Agent platforms.
- Unify user-facing status, remaining budget, pending authorization, and revoke projections.
- Run upgrade, downgrade/fail-closed, restart, concurrency, clock, crash, revoke-versus-commit, and
  exact replay matrices.

**Acceptance**

- Real Codex Desktop manual acceptance for all three choices.
- Normal Agent-turn acceptance with outer and inner approval counted separately.
- Malicious client/App/Agent negative tests.
- MCP 2025, MCP 2026, Codex, and generic stdio adapter coverage.
- Full tests, typecheck, lint, package/plugin/marketplace/MCP/host smokes, previous-tag release
  check, clean generated runtime identity, and an independent read-only security audit.
- Protected-branch PR and required CI. Merge, tag, GitHub Release, and anonymous provenance
  verification require separate explicit release authorization.

## 7. Important deferred work that must remain visible

The following items are not required to begin V3-R1, but must not disappear:

1. V2 MCP 2026 MRTR adapter and protocol negotiation.
2. V2 requestState/retry/disconnect/timeout negative matrix.
3. V2 generic local stdio host conformance and trusted no-popup fallback.
4. V1-to-new-registry explicit adoption ceremony. The legacy path may continue unchanged until a
   trusted ceremony can preserve policy usage and receipt provenance without widening authority.
5. User-facing Profile abstraction cleanup and migration of existing `0.6.0` Profiles.

Remote, multi-user, organization, OAuth, and cross-device features are excluded rather than
deferred.

## 8. Source reading order

Start from current code and Git state; this handoff is routing context, not implementation truth.

1. [`docs/guides/l3-authorization-v3-host-broker.md`](../guides/l3-authorization-v3-host-broker.md)
2. [`docs/release/release-notes/0.6.0.md`](../release/release-notes/0.6.0.md)
3. [`packages/core/src/application/l3-authorization-profile.ts`](../../packages/core/src/application/l3-authorization-profile.ts)
4. [`packages/mcp/src/local-l3-authority-broker.ts`](../../packages/mcp/src/local-l3-authority-broker.ts)
5. [`packages/mcp/src/local-l3-authority-registry.ts`](../../packages/mcp/src/local-l3-authority-registry.ts)
6. [`packages/mcp/src/local-l3-authorization.ts`](../../packages/mcp/src/local-l3-authorization.ts)
7. [`packages/mcp/src/index.ts`](../../packages/mcp/src/index.ts)
8. [`packages/mcp/src/bin.ts`](../../packages/mcp/src/bin.ts) and
   [`packages/mcp/src/stdio-server.ts`](../../packages/mcp/src/stdio-server.ts)
9. [`packages/codex/src/index.ts`](../../packages/codex/src/index.ts)
10. [`scripts/smoke-codex-app-server-normal-turn.mjs`](../../scripts/smoke-codex-app-server-normal-turn.mjs)
11. [`scripts/testing/setup-codex-l3-normal-turn-fixture.ts`](../../scripts/testing/setup-codex-l3-normal-turn-fixture.ts)

Official host references used by the previous probe:

- [Codex App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## 9. New-machine recovery

1. Fetch the repository and inspect the real Git root, `main`/upstream, working tree, tags, and
   remote branches. Do not assume this handoff branch has been merged.
2. Read this document from `origin/docs/v3-codex-authorization-handoff` if it is not yet on `main`.
3. Use published `0.6.0` as the product baseline. Verify tag
   `routeledger-plugin-v0.6.0` and release commit before testing.
4. Upgrade/install the plugin from the RouteLedger marketplace, list installed plugins, then start
   a new Codex task or restart Codex so the loaded runtime is not stale.
5. Verify `pluginVersion=0.6.0` and runtime payload digest
   `30a4fea0b4643458cd1bea2087c13c72660af9c81e3efac8e7849937925724c8` through the loaded runtime.
6. Create a feature branch from the latest `main` for V3-R1. Do not implement V3-R2 until the host
   capability admission has a defensible PASS.
7. Before any RouteLedger write, call the loaded runtime context and verify binding, project root,
   RouteLedger root, and current version. Never edit canonical RouteLedger JSON directly.

Published `0.6.0` provenance recorded at handoff:

- GitHub Release: <https://github.com/xczl-785/Routeledger/releases/tag/routeledger-plugin-v0.6.0>
- Runtime payload SHA-256: `30a4fea0b4643458cd1bea2087c13c72660af9c81e3efac8e7849937925724c8`
- Full plugin distribution SHA-256: `dc2932d4ebc119fb51a67d27cd338eaf6813c84d12caed9a09781583d11fda88`
- Runtime distribution SHA-256: `9d8d5e45a64ab6ba69b75e9d1b67e08e7fc07ac1fe04d06a9ab475451c63dd35`

## 10. Portable continuation prompt

```text
Continue RouteLedger's local L3 authorization route from
docs/handoffs/l3-authorization-local-route-handoff.md.

Act as an ordinary engineering collaborator, not release controller. Re-admit live Git, current
code, installed Codex version, app-server schema, and loaded plugin identity before making claims.
The immediate target is V3-R1 trusted Codex capability admission. Do not simulate authority with
natural language, a bare elicitation accept, MCP App DOM/click, client-reported identity, or
project-local state. If Codex lacks a verifiable trusted user-decision capability, report
BLOCKED_BY_HOST_CAPABILITY and keep the system fail closed.

Preserve the complete route: V1 foundation is operationally complete but explicit legacy adoption
is deferred; V2 is partially complete and its MCP 2026 MRTR, negotiation, negative/retry matrix,
generic stdio conformance, and local trusted-host fallback remain required after the Codex chooser
slice. V3 0.6.0 is the security control plane, not a completed three-choice user experience.

Do not expand into remote, multi-user, organizations, OAuth, or cross-device work. Do not write
canonical RouteLedger JSON directly. Use feature branch -> full regression -> independent
read-only audit -> PR/required CI. Merge, tag, and release need explicit authorization.
```

## 11. Continuation rule

This handoff is the durable continuation entry until the user explicitly requests another
handoff. Ordinary progress should update the active engineering documentation and version route;
do not create a new handoff file for every checkpoint.
