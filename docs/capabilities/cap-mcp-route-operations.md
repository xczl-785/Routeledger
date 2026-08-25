# cap-mcp-route-operations

## Scope

This capability covers the MCP operation surface and its server-side safety
rules.

## Current rules

1. Each MCP process has one binding. Discovery and planning tools can inspect
   candidates, but do not switch a running process to a different project.
2. Non-read-only tools require a matching absolute `expectedRouteLedgerRoot`,
   including preview or `dry_run` operations on the three public
   `propose_*_change` tools and
   `execute_route_change`. Those previews remain
   write/high-risk MCP operations:
   binding preflight blocks unbound, invalid, or uninitialized operations
   before they enter a write path.
3. Current work is presented as Todo, Deferred, and Constraint. Legacy Undo
   details remain audit-only read data (`includeLegacyUndo=true`) and are not
   part of the agent tool surface; the five legacy Undo tools were removed and
   no write or recommendation surface remains.
4. Deferred work has a target review version; a due item must be reviewed
   rather than silently carried forward. Constraints remain rules, not work
   completion counts. When no downstream Version exists, the error recovery
   payload supplies a three-step dependency plan: propose a real Version,
   execute the admitted proposal, then retry the original Deferred request by
   binding `targetReviewVersionId` to the proposal's real `targetId`.
5. L3 route changes follow proposal, approval or rejection, and commit.
   Approval artifacts are minted only after a trusted exact decision from
   structured host elicitation, Codex native admission, or a host-managed
   standing policy evaluated for the current proposal. Project files are never authority: the canonical approval artifact is an audit projection, while
   `execute_route_change(operation="commit_l3_operation")` verifies an exact host-owned consumption receipt bound to the artifact ID, proposal
   digest, authorization, root, and provenance. Invalid authorization or receipts and unsupported interaction fail closed; the
   standalone CLI cannot self-approve. Commit consumes a valid approval
   artifact; `confirm=true` alone is not an approval. A retry of an already committed operation is a read-like replay
   only when the same consumed artifact still matches the operation ID,
   action, target, and digest exactly; it returns `replayed: true` without
   creating canonical events. Every mismatch fails closed.
   A persisted lifecycle or structure proposal can be resumed through
   `execute_route_change(operation="execute_admitted_proposal")`. The public
   input needs the project and pending-operation IDs, with the returned digest
   accepted as an optional stale-client assertion. RouteLedger reloads the
   canonical proposal and, only after host admission, internally authorizes and
   commits it. This reduces the normal admitted lifecycle path to proposal plus
   execution while preserving the explicit approve/reject/commit operations.
   `propose_l3_route_change` returns the same confirmation envelope as the
   dedicated Version proposal tools, including the proposal ID, digest, and
   complete execute/approve/reject actions. While a proposal is pending,
   `next_action` points directly to `execute_admitted_proposal` rather than
   sending the Agent back to reread the same proposal.
6. Route writes use the JSON-first storage boundary and therefore inherit its
   validation, locking, recovery, and conflict behavior.
7. `inspect_route_progress(operation="next_action")` follows the version lifecycle: a current `wait` version
   recommends `set_version_state(operation="prepare")`, while a current `ready` version with a passing
   start gate recommends `start_version`. Gate blockers, due Deferred work,
   pending proposals, shutdown state, and pointer drift retain higher priority.
   The projected `nextVersion` is the current Version's persisted direct sibling
   successor, not the next node in flattened tree preorder. Child Versions stay
   visible as structure but do not silently replace the legal mainline advance target.
   A running current Version with no open Todo and no blocking risk returns a
   canonical-English `decision_required` branch: create a Todo when work remains, or
   mark the Version complete only when implementation is actually complete.
8. Ordinary version close requires explicit residual-audit evidence. New MCP
   callers use `{ status: "reviewed", items: [] }` to declare a reviewed-empty
   audit; a legacy non-empty item array remains readable, while omitted,
   `null`, and legacy empty arrays remain `MISSING_RESIDUAL_AUDIT`. The same
   resolved evidence (input first, then a pending close proposal) is used by
   gates, closeout summaries/plans, guides, close proposals, and approval
   digests. A non-`close` destination is a declaration backed by an already
   materialized Todo, Deferred, or Constraint: callers must provide its
   `destinationRecordId`, and the close gate validates type, actionability, and
   downstream routing. Close commit never invents an underspecified record.
   After close, the summary restores the reviewed audit from the committed
   close proposal; while a Version is reopened, a current pending close proposal
   takes precedence over historical committed evidence.
9. Agent-facing MCP messages and protocol identifiers use canonical English.
   Coded blockers use one message catalog across current context, gate inspection,
   and legal-operation projections; next-action summaries, reasons, and choice
   conditions do not vary with project locale. Candidate Todo text and document
   templates are project content and continue to follow `contentLocale`.
   `inspect_runtime(operation="runtime")` reports an unresolved project
   `contentLocale` without inferring a value from the agent or host language;
   initialization requires user confirmation and an explicit value. `auto` is
   invalid.
10. A legacy project whose `contentLocale` is unresolved remains readable.
   All project writes except `configure_project(operation="set_content_locale")` are blocked until a
    concrete BCP 47 locale is persisted.
11. `inspect_runtime(operation="runtime").contentLocale.scope` is the stable
    machine-readable value `project_content_only`, while `effectiveScopes` reports the current
    bounded effect of `contentLocale`: the persisted project setting, the
    `agent_authored_project_content_default` language agents should use for new project content, and the
    write-integrity gate. It does
    not claim translation of user-authored or existing project content.
    MCP diagnostics, blockers, next actions, state labels, and other control-plane
    messages remain stable English. `humanReviewText` is stable review material
    for an agent to interpret or paraphrase, not localized project content.
12. Agent-facing recommended actions are projected to public task-level tools.
    Write, proposal, and high-risk action inputs include the active binding's
    `expectedRouteLedgerRoot`; when no trusted root exists, the action declares
    `requiredRuntimeBindings` instead. Admitted proposal execution also carries
    the exact operation digest.
13. The MCP runtime exposes an `interactionProfile` without persisting it into
    canonical project data. Codex, Claude Code, and Cursor default to
    `agent_only`; generic MCP defaults to `agent_with_human_review`. Under
    `agent_only`, Mission Control remains available as `advisoryAction`
    metadata, while project initialization omits human-entry-document metadata.
    Explicit document inspection and human-review profiles retain it.
14. `inspect_route_progress(operation="check_doc_drift")` compares explicit Chinese or English declarations of the
    current Version ID, title, and state. It returns every recognized,
    mismatched, and non-detected assertion under `checkedAssertions`, and its
    `coverage.level` remains `partial`; zero warnings never claims complete
    document coverage. Execution completion and document alignment are separate:
    `alignmentStatus` reports `aligned`, `drift_detected`,
    `insufficient_coverage`, or `unknown`, and `safeToTrust` is true only for
    the aligned result.
15. `configure_project(operation="initialize")` distinguishes project initialization from route selection.
    Omitting `firstVersion` creates a valid empty route with nullable current
    and legacy-initial pointers. An explicit `firstVersion` creates the first
    current `wait` node and its `initialTodos` in the same aggregate write.
    Initialization also performs a read-only check for common human entry
    documents. It reports whether one points to `.routeledger/project.json`
    and returns a locale-matched, non-blocking template when coverage is
    missing; it never creates or rewrites README, AGENTS, CONTRIBUTING, or
    `docs/index.md` automatically. The check is omitted from the returned
    `agent_only` initialization payload to keep the primary Agent route concise.
14. On an empty route, the first approved `propose_version_structure_change(operation="propose_version_creation")` commit creates the
    node and assigns it as current atomically. Batch creation requires an
    explicit `setCurrentTo`. A closed top-level tail may receive an append-only
    successor through single or batch creation without reopening or replacing
    that historical node; insertion before closed history, reordering it,
    changing its parent, and adding children beneath it remain forbidden. The
    continuation records `version.successor_appended`. For ordinary forward progress from a closed
    current Version to its ready direct successor, `propose_version_lifecycle_change(operation="propose_version_advance")`
    performs current-switch and start under one proposal, digest, approval
    artifact, operation ID, and aggregate save. A blocked gate returns
    structured blockers without creating a pending proposal.
15. Pending-operation persistence is verified before a proposal is returned for
    approval: canonical payload/gate bytes must rebuild the stored digest after
    reload. A lossy adapter fails early and the new proposal is rolled back.
    Equal-timestamp Todos created by one batch retain their explicit input
    order through their creation-event sequence.
16. The public registry exposes exactly 15 task-level tools. Multi-operation
    tools select behavior with `operation`; business fields named `action`
    remain available without colliding with dispatch. Internal capability
    registrations and persisted L3 `actionType` values do not change.
17. The public risk split is 4 read-only tools (`inspect_runtime`,
    `inspect_route_progress`, `inspect_versions`, and
    `inspect_l3_route_operations`), 10 ordinary write tools, and one high-risk tool
    (`execute_route_change`). Host binding config rendering/writing remains an
    internal/CLI installation capability rather than an Agent-facing MCP tool.
18. Every public operation accepts `detail: compact | standard | audit`.
    Omission keeps the compatibility-preserving `standard` response.
    `compact` is intended for routine Agent loops: operation-aware profiles
    shorten runtime binding and route context, summarize Todo receipts and
    events, cap long arrays, and remove operation/digest payload bodies.
    `agentSummary` and `delta` are retained where they add write or L3 value,
    but are not added to small read/empty-list responses merely to repeat IDs.
    Compact metadata reports `detailApplied`, `payloadBytes`, `hasMore`, and
    grouped or exact `omittedSections`. Executable recommended-action inputs
    are never trimmed.
    Exact proposal, target, digest, authorization, approval-artifact, replay,
    and commit identifiers remain available so an Agent can complete L3 state
    progression without requesting audit material. Representative structured
    envelopes are guarded by R0-R3 footprint tests, including the invariant
    that compact is no larger than standard. `audit` preserves the full response
    and exposes L3 host-diagnostic authorization fields. MCP 2026 explicit
    compact calls use terse text plus authoritative `structuredContent`; legacy
    and standard calls retain the compatibility JSON text mirror.

## Evidence

`packages/mcp/src/index.ts` remains the public facade and composition root.
Ordered tool registrations and handlers live in
`packages/mcp/src/capabilities/*.ts`; shared tool contracts and transport
schemas live in `packages/mcp/src/registry/*.ts` and
`packages/mcp/src/l3-authorization-contract.ts`. `binding*.ts`,
`input-adapter.ts`, `packages/core/src/application/routeledger-service.ts`,
`packages/core/src/application/version-closeout-application.ts`, and their
tests together define these guarantees. `RouteLedgerService` remains the
public application facade and retains aggregate loading/ownership validation;
the closeout collaborator is read-only orchestration behind that facade.
Response profile and footprint behavior is implemented in
`packages/mcp/src/response-detail.ts` and verified by
`response-detail.test.ts`, `response-footprint-integration.test.ts`,
`execute-l3-operation.test.ts`, and `mcp-mrtr.test.ts`.
