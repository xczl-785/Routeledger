# Codex plugin installation

The marketplace descriptor and plugin distribution live at the Git repository
root:

```text
<repository root>/
├── .agents/plugins/marketplace.json
└── plugins/routeledger/
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    ├── release.json
    ├── runtime/
    └── skills/
```

The plugin starts its bundled runtime relative to the plugin root:

```text
node ./runtime/bin.js --profile codex --sqlite-read-model disabled
```

The plugin manifest may forward `CODEX_PERMISSION_PROFILE` into that STDIO
runtime when the host exposes it, but the field is diagnostic only. Codex
enforces the active task permission before a high-risk RouteLedger tool call
reaches the server; RouteLedger converts arrival of that admitted call into an
exact, single-use authorization capability.

It receives the managed workspace through MCP Roots. Installing the plugin
does not bind it to the repository that supplied it. Some Codex clients do not
send Roots/rootUri; in that case `process cwd` may be the plugin cache and is
not a project identity. Call `activate_routeledger_binding` with the host
project's absolute `workspaceRoot` (and optional in-workspace
`routeledgerRoot`) through the host's available approval workflow. The
activation is scoped to the running MCP session. On Codex, high-risk tool
admission is the authorization boundary; profile environment values and client
metadata cannot create admission. Generic MCP hosts use structured elicitation
or a trusted host standing-policy decision and fail closed when neither is available.
The canonical artifact is not authority by itself; commit also requires its
matching consumption receipt. The default in-process store requires
reauthorization after an MCP process restart; continuity requires persistent
trusted storage outside Agent write scope. The
0.7.2 candidate still requires a merged-main Desktop acceptance before its
Codex-native admission claim is released.
Activation may create or normalize only the binding
`.routeledger/config.json`; `init_project` separately creates canonical
project JSON.

Codex can keep one installed-plugin MCP process alive while the user opens a
different project task. In that case RouteLedger keeps the established binding
by default. `plan_routeledger_binding` returns an explicit session-activation
action for the new roots; after the user confirms the old-to-new switch, call
`activate_routeledger_binding` again with the exact roots and
`confirmProjectSwitch: true`. This avoids a source checkout, project config,
or Desktop restart while preserving a non-silent switch boundary.

## Git marketplace installation

The canonical repository is `xczl-785/Routeledger`. Install the published
0.3.3 plugin from the upgradeable `codex-marketplace` branch:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref codex-marketplace --json
codex plugin list --marketplace routeledger-team --available --json
codex plugin add routeledger@routeledger-team --json
codex plugin list --json
```

`codex plugin marketplace upgrade routeledger-team --json` refreshes an
installed marketplace source when a later published version is available.
For an exact 0.3.3 installation, use the immutable tag instead:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref routeledger-plugin-v0.3.3 --json
```

The tag is appropriate for reproducible rollback or verification; the branch
is appropriate for normal upgrades.

Starting with 0.3.4, `main` is the release branch. The existing
`codex-marketplace` branch remains a historical 0.3.3 anchor; future published
versions are installed from `main` or their immutable version tag.

The 0.3.3 publication passed workspace and plugin-contract CI on Ubuntu,
macOS, and Windows. An isolated anonymous Codex home also verified branch
install, enabled version, no-op upgrade, tag-based reinstall, release hashes,
Apache-2.0 distribution files, and an end-to-end JSON-only workflow without a
SQLite database.

After upgrading an installed marketplace source, start a new Codex task so the
new plugin and MCP process are loaded. The desktop application itself does not
need to be restarted.

To remove the installation:

```bash
codex plugin remove routeledger@routeledger-team --json
codex plugin marketplace remove routeledger-team --json
```

Maintainers run the repository checks before a future release:

```bash
pnpm build:codex-plugin
pnpm smoke:codex-plugin
pnpm check:codex-plugin-release
pnpm smoke:codex-git-marketplace
```

The plugin manifest records `https://github.com/xczl-785/Routeledger`. This
Git marketplace release does not publish `@routeledger/mcp` to npm.

## Runtime expectations

The installed runtime is JSON-only and has no SQLite or UI bundle. It expects
`--sqlite-read-model disabled`, writes canonical JSON through its bound MCP
root, and must not create a SQLite database. Start any write session by
calling `get_runtime_context` and checking the returned binding. If that
binding is low confidence, provide an explicit host workspace to
`activate_routeledger_binding`; do not initialize at a plugin-cache cwd.

`render_host_binding_config` and `write_host_binding_config` still require an
explicit stable, user-owned source launcher. The installed plugin cache has no
stable launcher alias, so those tools return the machine-readable
`STABLE_RUNTIME_LAUNCHER_REQUIRED` state instead of emitting a versioned cache
path into project configuration. These persistence tools are optional for an
installed-plugin user: same-session activation is the supported plugin-only
onboarding path.
