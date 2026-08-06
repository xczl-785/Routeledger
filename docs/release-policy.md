# Release policy

Releases are deliberate repository events, not the result of a successful
local build. A release requires a rebuilt plugin distribution, passing smoke
and quality checks, a SemVer-consistent `release.json`, a reviewed change set,
and its immutable `routeledger-plugin-v<version>` tag.

`routeledger@routeledger-team` version 0.3.2 is the current Git marketplace
release. At publication, `main`, the canonical remote's `codex-marketplace`
branch, and `routeledger-plugin-v0.3.2` aligned at commit `9c58e1d`. The tag
and marketplace branch remain fixed at that release commit; `main` may later
advance through protected non-distribution changes. Such a main still carries
the 0.3.2 baseline only while `plugins/**` is byte-identical to the tag. This
is a Codex plugin release only; `@routeledger/mcp` remains unpublished to npm.

RouteLedger source and plugin distribution are licensed under
[Apache License 2.0](../LICENSE). This policy does not change the licenses of
third-party dependencies.

Plugin distribution bytes require a plugin SemVer increase. A normal release
tag is `routeledger-plugin-v<version>` and must point at the released commit.
Use `pnpm check:codex-plugin-release --previous-ref <ref>` before release and
`--require-tag-ref` after the tag is present. The canonical repository is
`xczl-785/Routeledger`. Future release work must not represent a local build
or a fixture-only marketplace run as a published release; it must also pass
tag CI and a clean-home Git marketplace lifecycle verification.

See [the plugin release guide](guides/plugin-release.md) for commands and
verification scope.
