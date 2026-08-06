# Release policy

Releases are deliberate repository events, not the result of a successful
local build. A release candidate must have a rebuilt plugin distribution,
passing smoke and quality checks, a SemVer-consistent `release.json`, and a
reviewed change set.

The current `0.3.1` plugin is a release candidate. It has no release tag or
release branch, so passing candidate checks is not a published release.

RouteLedger source and plugin distribution are licensed under
[Apache License 2.0](../LICENSE). This policy does not change the licenses of
third-party dependencies.

Plugin distribution bytes require a plugin SemVer increase. A normal release
tag is `routeledger-plugin-v<version>` and must point at the released commit.
Use `pnpm check:codex-plugin-release --previous-ref <ref>` before release and
`--require-tag-ref` after the tag is present. The canonical repository is
`xczl-785/Routeledger`; do not represent a release-candidate run or a local
marketplace install as a published release.

See [the plugin release guide](guides/plugin-release.md) for commands and
verification scope.
