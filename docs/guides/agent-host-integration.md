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
binding, storage mode, and `contentLocale` state. For an empty intended
project, it proposes a concrete locale from `responseLocale`; the agent must
ask the user to confirm it before calling `init_project`. Initialization
requires an explicit BCP 47 `contentLocale`; missing, `null`, and `auto` are
not accepted. With no `firstVersion`, initialization creates a Project logical
root with an empty route and `currentVersionId: null`; when the user has already
selected the first real node, pass its title, description, and explicit
`initialTodos` in `firstVersion`. New projects still persist
`initialVersionId: null`: that field is a legacy canonical pointer retained for
older projects, while the Project itself is the route root and
`currentVersionId` identifies the selected node. For an
existing canonical data set, read it before writing. When JSON and SQLite
disagree, stop on `JSON_SQLITE_CONFLICT`; do not delete either store to force
a result.

An older project without `settings.content_locale` decodes as unresolved
`null`. It remains readable, but project writes are blocked until
`set_project_content_locale` records a user-confirmed concrete value.
`responseLocale` is request/session presentation state only: it localizes
human-readable MCP messages while tool names, object keys, enums, and error
codes remain stable English protocol values.

Canonical JSON is the MCP runtime authority. SQLite is a rebuildable read
model when enabled. The JSON-only plugin runtime disables that read model and
does not create a database.

## Multiple projects

Run one entry per managed project, for example `routeledger_project_a` and
`routeledger_project_b`. Entries can share the same source checkout or
installed runtime, but they are separate processes and bindings. Do not use a
single entry to alternate roots between calls.

## Safety

Read-only inspection may be automated according to host policy. Keep normal
writes prompted, and require the strongest available confirmation for
`commit_l3_operation`. The server independently checks binding preflight,
`expectedRouteLedgerRoot`, canonical storage rules, and approval artifacts;
host approval UI does not replace those checks. `approve_l3_operation` also
requires either MCP structured elicitation, a host-injected preauthorization
grant, or an atomic delegated decision from a host-managed authority.
Project files are never authorization authority. The host-managed grant store
must retain the exact consumption receipt across service reconstruction;
canonical approval JSON alone cannot authorize commit. If approval must survive
an MCP process restart, inject a persistent trusted store or integrity-proof
implementation outside Agent write scope. Use
`recommend_l3_authorization_policy` only to produce a conservative candidate
for review and installation in host-managed storage outside Agent write scope.

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
  "grantTtlSeconds": 300,
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

The state file atomically persists policy-use budgets, reserved and issued
grants, exact consumption receipts, expiry, exhaustion, and revocation. MCP
process reconstruction reloads that state. Rotating the installed policy
digest revokes outstanding delegated grants from the previous policy. A
trusted receipt is created in the same state transaction that consumes a
grant; if the subsequent canonical project save fails, retry reconstructs the
same approval artifact from the receipt instead of consuming a second use.

This is a local OS-permission trust boundary, not protection against an Agent
that already has unrestricted access to the host user's entire filesystem and
processes. Under that stronger access level, no ordinary local config file can
separate the Agent from the user.
