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

## Release-candidate validation

The canonical repository is `xczl-785/Routeledger`. Version `0.3.1` is a
release candidate, not a published release: no release tag or release branch
is asserted by this guide. Use the canonical repository and an explicit
candidate ref for controlled validation:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref <CANDIDATE_REF> --json
codex plugin list --marketplace routeledger-team --available --json
codex plugin add routeledger@routeledger-team --json
codex plugin list --json
```

To remove the candidate installation:

```bash
codex plugin remove routeledger@routeledger-team --json
codex plugin marketplace remove routeledger-team --json
```

Run the repository checks before a candidate install:

```bash
pnpm build:codex-plugin
pnpm smoke:codex-plugin
pnpm check:codex-plugin-release
pnpm smoke:codex-git-marketplace
```

The plugin manifest records
`https://github.com/xczl-785/Routeledger`. A normal release becomes installable
from that repository only after the release tag gate has been completed under
the release policy.

## Runtime expectations

The installed runtime is JSON-only and has no SQLite or UI bundle. It expects
`--sqlite-read-model disabled`, writes canonical JSON through its bound MCP
root, and must not create a SQLite database. Start any write session by
calling `get_runtime_context` and checking the returned binding.
