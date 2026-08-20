# Agent-host integration

RouteLedger is an MCP stdio control plane. One running server binds one
managed RouteLedger root inside one workspace; it is not a runtime project
switcher.

## Binding model

Use explicit placeholder paths:

```text
workspaceRoot   = /ABS/PATH/TO/WORKSPACE
routeledgerRoot = /ABS/PATH/TO/WORKSPACE/RELATIVE/PATH/TO/MANAGED_PROJECT
runtime source  = /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
```

`routeledgerRoot` must be inside `workspaceRoot`. The single-root case is
valid when both paths are the same. The managed project's
`.routeledger/config.json` resolves `dataRoot`; canonical data is stored at
`<dataRoot>/.routeledger/`. The runtime source directory and process `cwd`
never select the managed project.

For source mode, adapt the repository example in
`examples/config/codex.config.toml`:

```bash
pnpm --filter @routeledger/mcp exec tsx src/bin.ts \
  --workspace-root /ABS/PATH/TO/WORKSPACE \
  --routeledger-root /ABS/PATH/TO/WORKSPACE/RELATIVE/PATH/TO/MANAGED_PROJECT \
  --profile codex
```

The process must run with `cwd` set to
`/ABS/PATH/TO/ROUTELEDGER_REPO_ROOT`. Other MCP hosts can use the same stdio
arguments and select an appropriate supported profile.

## First use and existing data

Call `get_runtime_context` before planning or writing. It returns the active
binding, storage mode, and `contentLocale` state. When the project locale is
unresolved, the agent must ask the user to choose a concrete locale before
calling `init_project`; the protocol does not infer that choice from the agent
or host language. Initialization
requires an explicit BCP 47 `contentLocale`; missing, `null`, and `auto` are
not accepted. With no `firstVersion`, initialization creates a Project logical
root with an empty route and `currentVersionId: null`; when the user has already
selected the first real node, pass its title, description, and explicit
`initialTodos` in `firstVersion`. New projects still persist
`initialVersionId: null`: that field is a legacy canonical pointer retained for
older projects, while the Project itself is the route root and
`currentVersionId` identifies the selected node. Initialization also reports
whether a common human entry document points to `.routeledger/project.json`.
Missing coverage is non-blocking and includes a locale-matched suggested
snippet; RouteLedger does not create or rewrite the entry document. For an
existing canonical data set, read it before writing. When JSON and SQLite
disagree, stop on `JSON_SQLITE_CONFLICT`; do not delete either store to force
a result.

An older project without `settings.content_locale` decodes as unresolved
`null`. It remains readable, but project writes are blocked until
`set_project_content_locale` records a user-confirmed concrete value. Agent-facing
MCP messages, tool names, object keys, enums, and error codes use one canonical
English protocol. The persisted `contentLocale` remains the language contract
for generated project content and user-facing consumers. This includes candidate
Todo titles and reasons returned by document-drift checks; their surrounding
diagnostics, coverage limitations, and summaries remain canonical English.

Canonical JSON is the MCP runtime authority. SQLite is a rebuildable read
model when enabled. The JSON-only plugin runtime disables that read model and
does not create a database. A newly initialized JSON-only project uses hashed
operation envelopes by default. Existing loose-audit projects remain in their
current physical layout until an explicit `json compact-audit` migration.

## Multiple projects

Run one entry per managed project, for example `routeledger_project_a` and
`routeledger_project_b`. Entries can share the same source checkout or
installed runtime, but they are separate processes and bindings. Do not use a
single entry to alternate roots between calls.

## Safety

Read-only inspection may be automated according to host policy. Keep normal
writes prompted, and require the strongest available confirmation for
`execute_admitted_proposal` and `commit_l3_operation`. After a dedicated
lifecycle or structure proposal is persisted, hosts should prefer
`execute_route_change(operation="execute_admitted_proposal")`; it resumes by
`pendingOperationId` and performs exact authorization plus commit inside one
admitted call. The explicit approve/reject/commit operations remain available
for fine-grained host workflows. The server independently checks binding preflight,
`expectedRouteLedgerRoot`, canonical storage rules, and approval artifacts;
host approval UI does not replace those checks. `approve_l3_operation` also
requires either MCP structured elicitation, Codex native admission, or an
atomic proposal decision from a host-managed standing policy.
Project files are never authorization authority. The host-managed exact store
must retain the authorization receipt across service reconstruction;
canonical approval JSON alone cannot authorize commit. If approval must survive
an MCP process restart, inject a persistent trusted store or integrity-proof
implementation outside Agent write scope. Use
`recommend_l3_authorization_policy` only to produce a conservative candidate
for review and installation in host-managed storage outside Agent write scope.

### MCP 2025 and 2026 decision interaction

RouteLedger supports both interaction eras without changing the core proposal,
artifact, commit, or receipt semantics:

- MCP `2025-11-25` keeps the stateful structured `elicitation/create` request;
- MCP `2026-07-28` supports `server/discover`, per-request protocol metadata,
  and native multi round-trip `input_required` results;
- a 2026 retry must echo the exact `requestState` and provide the matching
  `inputResponses`; the retry remains bound to the original tool arguments and
  pending proposal;
- 2026 L3 execution requires an explicit host secret of at least 32 characters
  in `ROUTELEDGER_MCP_REQUEST_STATE_SECRET`. RouteLedger uses it only to protect
  opaque request state across retries and process restarts. Do not put the
  secret in project files or Agent-writable configuration;
- missing configuration, expired state, modified state, changed arguments, or
  response-only retries fail before authorization is consumed.

For a host without an interaction UI, configure a delegated or preauthorized
standing policy explicitly. Each evaluation creates a new authorization for the
current proposal. RouteLedger never infers Codex modes in
the generic MCP adapter and never treats client identity metadata, natural
language, or project files as authorization authority.

## Local trusted L3 authority

The V1 local authority is opt-in. It is enabled only when the host starts the
MCP server with an absolute project-external config path:

```bash
node /ABS/PATH/TO/@routeledger/mcp/bin.js \
  --workspace-root /ABS/PATH/TO/WORKSPACE \
  --routeledger-root /ABS/PATH/TO/WORKSPACE/PROJECT \
  --profile generic \
  --approver-id local-user \
  --l3-authority-config /ABS/HOST-MANAGED/PATH/routeledger-authority.json
```

`ROUTELEDGER_MCP_L3_AUTHORITY_CONFIG` is the equivalent environment setting.
When this option is present, both roots must be explicit. The config and its
state file must be absolute regular files outside both roots; symlinks,
group/world-writable config or state files, binding mismatches, malformed
state, and project-local paths fail closed.

The host-side config schema is:

```json
{
  "schemaVersion": 1,
  "authorityId": "local-routeledger-authority",
  "statePath": "/ABS/HOST-MANAGED/PATH/routeledger-authority.state.json",
  "authorizationTtlSeconds": 300,
  "trustedClientId": "optional-host-issued-client-id",
  "policy": {
    "schemaVersion": 1,
    "policyId": "policy-id-from-reviewed-candidate",
    "mode": "delegated",
    "binding": {
      "projectId": "exact-project-id",
      "routeledgerRootDigest": "exact-digest-from-the-candidate",
      "subjectId": "local-user",
      "hostKind": "generic",
      "clientId": "optional-host-issued-client-id"
    },
    "defaultEffect": "prompt",
    "rules": [],
    "alwaysPrompt": []
  }
}
```

Do not hand-author the policy body. Ask RouteLedger for
`recommend_l3_authorization_policy`, review its structured candidate and risk
checklist, then let a trusted host integration call the exported
`installLocalL3AuthorityConfig` API with the chosen external config/state
paths. That API is intentionally not an MCP tool. Candidate generation cannot
install authority, and project files cannot point the runtime to an authority.

The state file atomically persists standing-policy decision budgets, exact
authorizations, receipts, claim state, expiry, and revocation. MCP restart can
recover only the original proposal's exact authorization. A second proposal
cannot reuse it even when action and target are identical. Rotating the profile
or policy atomically invalidates outstanding authorization from the previous
epoch. If canonical save fails after authorization, retry reconstructs the
same approval artifact from the receipt without creating another credential.

The state transaction lock is a host-side lease with a heartbeat, OS-process
liveness check, owner-specific `lockId` release, and a pre-write revision
check. An old or paused writer therefore cannot reclaim, overwrite, or release
a newer owner's lock merely because a fixed wall-clock interval elapsed.

This is a local OS-permission trust boundary, not protection against an Agent
that already has unrestricted access to the host user's entire filesystem and
processes. Under that stronger access level, no ordinary local config file can
separate the Agent from the user.
