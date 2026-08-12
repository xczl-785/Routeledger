# Release policy

Releases are deliberate repository events, not the result of a successful
local build. A release requires a rebuilt plugin distribution, passing smoke
and quality checks, a SemVer-consistent `release.json`, a reviewed change set,
and its immutable `routeledger-plugin-v<version>` tag.

`routeledger@routeledger-team` version 0.6.0 is the latest published Git
marketplace release, fixed by `routeledger-plugin-v0.6.0`. Version 0.7.2 is the
current Desktop-test candidate and supersedes 0.7.1 after the correctly loaded
0.7.1 runtime still lacked usable L3 host admission on Windows. It remains a
candidate until its verified `main` commit receives
`routeledger-plugin-v0.7.2`.
`main` is the release branch;
`codex-marketplace` remains only the historical 0.3.3 branch anchor. This is a
Codex plugin release path only;
`@routeledger/mcp` remains unpublished to npm.

RouteLedger source and plugin distribution are licensed under
[Apache License 2.0](../../LICENSE). This policy does not change the licenses of
third-party dependencies.

Changed plugin distribution bytes require a plugin SemVer increase whenever
the previous candidate may have reached a Desktop installation or live MCP
process, even if no immutable tag exists yet. The previous-ref guard therefore
rejects changed same-version bytes unconditionally. This keeps cache paths,
runtime identity, diagnostics, and test reports unambiguous. A normal release
is merged to `main`; tag
`routeledger-plugin-v<version>` must point at that released `main` commit.
Use `pnpm check:codex-plugin-release --previous-ref <ref>` before release and
`--require-tag-ref` after the tag is present. The canonical repository is
`xczl-785/Routeledger`. Future release work must not represent a local build
or a fixture-only marketplace run as a published release; it must also pass
tag CI and a clean-home Git marketplace lifecycle verification.

The committed runtime identity cannot safely embed the future merge commit or
a digest covering itself. It therefore reports plugin SemVer, expected release
tag, and a content-addressed runtime payload digest. Immutable tag CI runs
`pnpm attest:codex-plugin` and uploads an external JSON attestation that binds
the tag's real source commit to the runtime and complete plugin distribution
digests stored in `release.json`. Starting with 0.4.3, tag CI also publishes
that proof as a durable GitHub Release asset at the stable URL reported by the
runtime identity; the Actions artifact remains secondary CI evidence.
This attestation is an unsigned checksum manifest, not a separate
cryptographic-signature layer. Trust remains anchored in the canonical Git
repository, its immutable version tag, the GitHub Actions release run, and the
published SHA-256 bindings. RouteLedger does not require GPG signing,
Sigstore, Cosign, or SLSA provenance for the current plugin distribution.

`main` being the release branch means it is the source of the released commit;
it does not mean every `main` push already has a tag. Pull-request and `main`
CI run the previous-ref SemVer/distribution replay guard. After the verified
commit is on `main`, create the immutable version tag; the tag-triggered CI is
the stage that runs `--require-tag-ref`.

See [the plugin release guide](plugin-release.md) for commands and
verification scope.

See [Distribution and tag conventions](distribution-and-tags.md) for
per-artifact versioning and tag namespaces.
