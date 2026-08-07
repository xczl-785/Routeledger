# Release policy

Releases are deliberate repository events, not the result of a successful
local build. A release requires a rebuilt plugin distribution, passing smoke
and quality checks, a SemVer-consistent `release.json`, a reviewed change set,
and its immutable `routeledger-plugin-v<version>` tag.

`routeledger@routeledger-team` version 0.3.3 is the last published Git
marketplace release, fixed by `routeledger-plugin-v0.3.3` at commit `437a958`.
The manifest now declares the 0.3.5 patch candidate. `main` became the release
branch in 0.3.4 and remains the release branch for 0.3.5 and later;
`codex-marketplace` remains only the historical 0.3.3 branch anchor. This is a
Codex plugin release path only;
`@routeledger/mcp` remains unpublished to npm.

RouteLedger source and plugin distribution are licensed under
[Apache License 2.0](../../LICENSE). This policy does not change the licenses of
third-party dependencies.

Plugin distribution bytes require a plugin SemVer increase. A normal release
is merged to `main`; tag `routeledger-plugin-v<version>` must point at that
released `main` commit.
Use `pnpm check:codex-plugin-release --previous-ref <ref>` before release and
`--require-tag-ref` after the tag is present. The canonical repository is
`xczl-785/Routeledger`. Future release work must not represent a local build
or a fixture-only marketplace run as a published release; it must also pass
tag CI and a clean-home Git marketplace lifecycle verification.

`main` being the release branch means it is the source of the released commit;
it does not mean every `main` push already has a tag. Pull-request and `main`
CI run the previous-ref SemVer/distribution replay guard. After the verified
commit is on `main`, create the immutable version tag; the tag-triggered CI is
the stage that runs `--require-tag-ref`.

See [the plugin release guide](plugin-release.md) for commands and
verification scope.
