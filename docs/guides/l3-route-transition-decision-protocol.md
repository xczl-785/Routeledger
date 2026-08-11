# L3 route-transition decision protocol

Status: accepted product and architecture baseline for the post-0.6.0 L3 route.

This document defines what L3 is, what permission modes control, and where host-specific
behavior belongs. It supersedes the earlier product interpretation that treated L3 mainly as
proof of a physical user approval. Existing 0.6.0 authorization code remains the implementation
baseline until it is migrated behind the interfaces described here.

## 1. Product definition

L3 is RouteLedger's **route-transition decision protocol**.

Every L3 route change must still pass through one complete internal decision pipeline:

1. create an exact proposal;
2. resolve who or what may decide it;
3. produce a decision artifact bound to that proposal;
4. revalidate the live project state at commit time;
5. commit atomically;
6. retain a receipt and audit evidence.

Permission modes do not switch this protocol on or off. They only decide **how the decision is
resolved** and therefore how much interaction the user experiences.

Higher permission means fewer human and tool round trips. It does not mean fewer RouteLedger
state transitions, weaker proposal binding, missing receipts, or unaudited writes.

## 2. The three interaction modes

| User-facing mode | Decision source | User experience | Internal result |
| --- | --- | --- | --- |
| Request approval | Current user decision through the host | Stop on each unmatched L3 proposal | Exact one-shot decision artifact, then commit |
| Approve for me | Deterministic RouteLedger policy delegated by the user or host | Matching operations continue automatically; unmatched operations stop | Policy evaluation produces the same exact one-shot decision artifact, then commit |
| Full access | Finite project/session capability established by the host | Matching operations normally finish in one external call | Capability consumption produces the same exact one-shot decision artifact, then commit |

“Full access” is a low-friction execution mode, not a bypass. Its scope must remain finite and
identifiable: at least project/root, subject or host binding, allowed actions, validity window or
session, and consumption rules.

## 3. One external call, complete internal flow

A host or Agent may invoke one high-level operation and receive the final result without seeing
the intermediate proposal and decision calls. RouteLedger must still execute all internal steps.

```text
external operation request
        |
        v
exact proposal -> decision resolution -> decision artifact -> live validation -> atomic commit
                         |                                           |
                         +-------------- audit/receipt --------------+
```

This is the main way to reduce L3 friction: collapse protocol round trips at the adapter boundary,
not remove the protocol's internal invariants.

## 4. Trust boundary

RouteLedger accepts an authenticated, configured Agent host as a decision source. The Agent host
is responsible for enforcing its own conversation permission mode and deciding whether it may
call a RouteLedger operation. RouteLedger is responsible for the correctness and auditability of
the route transition after the call reaches it.

Consequences:

- RouteLedger does not need a universal proof that a physical user clicked every approval.
- A Codex adapter may translate Codex's effective conversation behavior into a RouteLedger
  decision mode when Codex exposes that information.
- If Codex does not expose the current mode, its adapter may still provide host-configured
  behavior and use native tool approval as the interactive boundary.
- A generic MCP connection uses its own configured adapter and capabilities; it is not assumed to
  be Codex and does not inherit Codex-specific concepts.
- Unauthenticated or unconfigured callers are not automatically trusted merely because they can
  form an MCP request.

This trust model deliberately avoids asking RouteLedger to duplicate the whole sandbox and
approval system of every Agent platform.

## 5. Core and adapter responsibilities

The core owns behavior that must be identical for Codex, generic MCP, a future GUI, or another
Agent host:

- exact proposal identity and digest;
- deterministic decision state transitions;
- decision-artifact binding and one-shot consumption;
- live gate and state validation;
- idempotency, replay behavior, atomic commit, receipt, and audit.

Adapters own host-specific mechanics:

- discovering or receiving the host's effective interaction mode;
- presenting host-native approval interaction;
- translating a trusted host decision or configuration into a core decision request;
- choosing whether an external call returns `input_required`, `denied`, or a completed commit;
- representing host identity and capability provenance.

Codex and generic MCP are sibling adapters. Neither defines the core model.

## 6. Canonical state machine

The canonical logical states are:

```text
proposed
  -> decision_required
      -> decision_resolved
      -> rejected
  -> decision_resolved
      -> committing
          -> committed
          -> stale
          -> failed
```

Automatic modes may move from `proposed` through `decision_resolved` to `committed` inside one
request. Those transitions still exist and must remain observable through the receipt or audit
record.

Definitions:

- `proposed`: the exact route mutation and its starting state are recorded.
- `decision_required`: no matching delegated policy or finite capability resolved the proposal.
- `decision_resolved`: an allow decision is bound to the exact proposal.
- `rejected`: a user, policy, or host explicitly denied the proposal.
- `committing`: the decision is being consumed and live state is being rechecked.
- `committed`: the mutation and receipt were persisted atomically.
- `stale`: live state no longer matches the proposal; a new proposal is required.
- `failed`: an operational failure occurred without a successful commit; retry semantics must be
  explicit and idempotent.

The current persisted `approvalArtifact` name may remain during compatibility work. New APIs
should prefer `decisionArtifact`; the semantic change does not require an immediate data rewrite.

## 7. Adapter contract direction

The initial adapter contract should resolve one proposal into one of three outcomes:

```ts
type DecisionResolution =
  | { status: "resolved"; decision: ExactDecision }
  | { status: "input_required"; request: DecisionRequest }
  | { status: "denied"; reason: string };
```

The orchestration layer consumes that result and advances the core state machine. Adapters never
commit mutations directly and never manufacture a broader scope than the proposal they received.

Initial adapters:

1. `CodexDecisionAdapter`: maps available Codex host behavior/configuration into interactive,
   delegated, or finite full-access resolution.
2. `McpDecisionAdapter`: uses protocol interaction when available and otherwise follows explicit
   server/host configuration.
3. Compatibility adapters for the existing local broker/profile and one-shot grant paths while
   they are migrated rather than discarded.

## 8. What remains strict

Reducing friction does not justify removing the mechanisms that make route changes reliable. The
following remain mandatory:

- exact operation and starting-state digest;
- commit-time live validation;
- atomic write and receipt;
- single-use or explicitly budgeted decision consumption;
- idempotent retry and replay isolation;
- project/root binding;
- audit visibility for automatic decisions.

The following are no longer universal product requirements and should be reevaluated per adapter:

- proof of a physical click;
- a separate user-visible RouteLedger profile identifier;
- requiring every host to expose the same three-mode configuration API;
- treating a missing host gesture-attestation field as a reason the whole product cannot proceed.

## 9. Migration sequence

1. Introduce the decision state and adapter interfaces without changing stored data.
2. Wrap current interactive, delegated-policy, preauthorized, and replay paths as compatibility
   adapters.
3. Add a one-call orchestration path that still emits the existing proposal, artifact, commit,
   receipt, and audit records.
4. Implement Codex and generic MCP adapters independently.
5. Project the effective mode and remaining capability in user-facing status; hide internal
   profile bookkeeping by default.
6. Only after compatibility tests pass, simplify obsolete proof and profile ceremony.

## 10. Acceptance principles

- The same operation produces equivalent committed RouteLedger data in all three modes.
- Switching modes changes interruption behavior, not mutation semantics.
- Automatic decisions remain distinguishable by source in audit data.
- A stale proposal cannot commit in any mode.
- Duplicate delivery cannot double-commit or double-consume a capability.
- Codex-specific configuration is absent from the core domain.
- Generic MCP works without pretending to know Codex's conversation mode.

