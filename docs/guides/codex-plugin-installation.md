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

## Staging validation

Version `0.3.0` is a staging baseline, not a published release claim. Until
the final repository name is active, use a staging ref only for controlled
validation:

```bash
codex plugin marketplace add <STAGING_GIT_REPOSITORY_URL> --ref <STAGING_REF> --json
codex plugin list --marketplace routeledger-team --available --json
codex plugin add routeledger@routeledger-team --json
codex plugin list --json
```

To remove the staged installation:

```bash
codex plugin remove routeledger@routeledger-team --json
codex plugin marketplace remove routeledger-team --json
```

Run the repository checks before a staging install:

```bash
pnpm build:codex-plugin
pnpm smoke:codex-plugin
pnpm check:codex-plugin-release
pnpm smoke:codex-git-marketplace
```

The final canonical repository URL recorded by the plugin manifest is
`https://github.com/xczl-785/RouteLedger`. A normal release is installed from
that repository only after the final repository transition and release tag
have been completed under the release policy.

## Runtime expectations

The installed runtime is JSON-only and has no SQLite or UI bundle. It expects
`--sqlite-read-model disabled`, writes canonical JSON through its bound MCP
root, and must not create a SQLite database. Start any write session by
calling `get_runtime_context` and checking the returned binding.
