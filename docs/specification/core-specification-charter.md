# RouteLedger Core Specification charter

Status: NF1-03 accepted charter. This document governs drafting; it is not the
normative Core Specification itself.

## Purpose

Create one language-agnostic specification for RouteLedger's established core
contracts. The specification will make the current product model reviewable
without requiring readers to reconstruct it from TypeScript, MCP descriptions,
capability notes, release documents, and tests.

The specification consolidates existing behavior. It does not create product
behavior merely by describing it.

## Normative language

The final specification will use `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`,
`SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in the RFC 2119 sense.

`Implementation-defined` means that every conforming implementation must make
and document a choice, while the Core Specification deliberately permits more
than one choice. It must not be used to hide an unresolved RouteLedger product
decision.

Descriptive history, implementation notes, examples, and known gaps must be
visibly non-normative.

## Scope of version 0.1

The first specification is limited to five established contract areas:

1. The Project route root and the meanings of Version, Todo, Deferred,
   Constraint, WorkItem, and TransitionEvent.
2. Canonical JSON authority, schema compatibility, deterministic encoding,
   replacement and locking, plus SQLite's rebuildable read-model boundary.
3. Workspace/root binding, physical-path containment, one-server/one-binding,
   and exact root assertions on writes.
4. Version graph and lifecycle behavior: creation, preparation, start,
   completion, close, reopen, shutdown, forward advancement, gates, and current
   pointer invariants.
5. The L3 proposal, decision, approval artifact, exact authorization, receipt
   claim, live validation, atomic mutation, finalize, replay, and audit chain.

## Explicit non-goals

Version 0.1 will not:

- standardize the CLI, UI, plugin packaging, release workflow, or every MCP
  response field;
- promote legacy Undo into the current work model;
- define a new schema, tool, state, authorization mode, or recovery policy;
- claim conformance for implementations not exercised against the published
  contract tests;
- turn current defects into desirable requirements;
- copy Symphony entities, scheduler behavior, workspace policy, or agent-runner
  semantics into RouteLedger.

## Evidence rule

Every normative requirement must have a stable requirement ID and an evidence
row containing:

- at least one existing documentation or accepted-decision reference;
- the relevant canonical schema/format reference, or `not persisted`;
- at least one implementation symbol or module;
- at least one executable test; and
- a status of `confirmed`, `compatibility`, `gap`, or `decision required`.

A requirement without both implementation and executable-test evidence cannot
be labeled `confirmed`. It remains a marked gap until code and tests establish
the contract or an explicit product decision removes it.

When evidence disagrees, the draft must report the conflict. It must not choose
the most convenient source silently. Canonical schemas and accepted migration
decisions govern persisted compatibility; executable behavior and tests govern
the implemented runtime; an explicit later decision is required to change
either.

## Proposed document shape

The Core Specification should remain smaller than the source corpus and use
this structure:

1. Status, audience, normative language, goals, and non-goals.
2. System boundaries and authority model.
3. Core domain entities, stable identifiers, and shared invariants.
4. Canonical persistence and read-model contract.
5. Binding and physical-root contract.
6. Route graph, lifecycle state machines, gates, and algorithms.
7. L3 decision and commit protocol.
8. Failure, concurrency, recovery, and security model.
9. Conformance and validation matrix.
10. Compatibility notes and explicitly unresolved gaps.

Reference algorithms may be language-agnostic pseudocode. They explain
ordering and invariants; they do not replace the normative clauses they cite.

## Conformance profiles

Version 0.1 should define two profiles only:

- `Core conformance`: deterministic domain, persistence, binding, lifecycle,
  and L3 protocol checks required for every implementation.
- `Host integration`: checks that require an MCP host, trusted decision source,
  filesystem behavior, or process restart. These are required when the related
  host capability is shipped, but may run outside the fast unit suite.

Release-distribution identity and marketplace publication remain repository
release concerns, not Core conformance.

## Change control

- A normative edit must update its evidence row in the same review unit.
- A persisted or externally observable contract change requires the normal
  schema, compatibility, release, and RouteLedger Version decisions; editing
  the specification alone cannot authorize it.
- A refactor may update symbol locations while preserving requirement IDs and
  behavior. The evidence matrix must follow the moved symbols.
- A known defect must be recorded as a gap with its current fail-closed or
  compatibility behavior, not frozen as the intended contract.

## Influence of the reference SPEC

The workspace-level Symphony `SPEC.md` was reviewed for document governance,
not product semantics. RouteLedger adopts its useful structural conventions:

- declare normative language before requirements;
- state goals and non-goals;
- define entities and stable identifiers before workflows;
- keep failure, recovery, security, reference algorithms, validation, and
  definition-of-done sections explicit;
- distinguish core conformance, optional extensions, and real integration.

RouteLedger adds a stricter source-to-test evidence rule because this
specification is being distilled from an existing implementation rather than
used to design a new service from scratch.

## NF1-03 exit criteria

NF1-03 is complete when this charter and the initial evidence matrix are
reviewed, all five areas have at least one evidence-backed cluster, known gaps
are visible, and no unsupported normative product statement has been added.
Writing the complete normative Core Specification may then proceed as a
separate, reviewable documentation slice before production extraction.
