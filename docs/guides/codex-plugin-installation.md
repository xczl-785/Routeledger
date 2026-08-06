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
does not bind it to the repository that supplied it.

## Git marketplace installation

The canonical repository is `xczl-785/Routeledger`. Install the published
0.3.1 plugin from the upgradeable `codex-marketplace` branch:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref codex-marketplace --json
codex plugin list --marketplace routeledger-team --available --json
codex plugin add routeledger@routeledger-team --json
codex plugin list --json
```

`codex plugin marketplace upgrade routeledger-team --json` refreshes an
installed marketplace source when a later published version is available.
For an exact 0.3.1 installation, use the immutable tag instead:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref routeledger-plugin-v0.3.1 --json
```

The tag is appropriate for reproducible rollback or verification; the branch
is appropriate for normal upgrades.

The published path is verified by tag CI across the workspace and plugin
contracts on Ubuntu, macOS, and Windows. An isolated anonymous Codex home has
also verified branch install, enabled version, no-op upgrade, removal,
tag-based reinstall, release hashes, Apache-2.0 distribution files, and the
JSON-only initialization workflow without a SQLite database.

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
calling `get_runtime_context` and checking the returned binding.
