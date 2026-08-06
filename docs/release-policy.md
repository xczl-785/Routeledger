# Release policy

Releases are deliberate repository events, not the result of a successful
local build. A release candidate must have a rebuilt plugin distribution,
passing smoke and quality checks, a SemVer-consistent `release.json`, and a
reviewed change set.

RouteLedger source and plugin distribution are licensed under
[Apache License 2.0](../LICENSE). This policy does not change the licenses of
third-party dependencies.

Plugin distribution bytes require a plugin SemVer increase. A normal release
tag is `routeledger-plugin-v<version>` and must point at the released commit.
Use `pnpm check:codex-plugin-release --previous-ref <ref>` before release and
`--require-tag-ref` after the tag is present. Do not represent a staging run
or a local marketplace install as a published release.

See [the plugin release guide](guides/plugin-release.md) for commands and
verification scope.
