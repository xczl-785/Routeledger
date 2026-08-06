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

It receives the managed workspace through MCP Roots. Installing the plugin
does not bind it to the repository that supplied it. Some Codex clients do not
send Roots/rootUri; in that case `process cwd` may be the plugin cache and is
not a project identity. Call `activate_routeledger_binding` with the host
project's absolute `workspaceRoot` (and optional in-workspace
`routeledgerRoot`) through the host's available approval workflow. The
activation is scoped to the running MCP session. Approval metadata is a host
hint, not a prompt the MCP server can force or a substitute for binding/L3
safeguards. Activation may create or normalize only the binding
`.routeledger/config.json`; `init_project` separately creates canonical
project JSON.

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

`render_host_binding_config` and `write_host_binding_config` require an
explicit stable, user-owned source launcher. The installed plugin cache has no
stable launcher alias, so those tools return the machine-readable
`STABLE_RUNTIME_LAUNCHER_REQUIRED` state instead of emitting a versioned cache
path into project configuration.
