# cap-codex-plugin-package

## Quick Read

The canonical Git repository is `xczl-785/Routeledger`. Its root contains the
marketplace descriptor and the single generated `routeledger` plugin
distribution. `routeledger@routeledger-team` version `0.3.1` is published
through the Git marketplace: `main`, the canonical remote's
`codex-marketplace` branch, and the immutable `routeledger-plugin-v0.3.1` tag
aligned at the release point. The tag and marketplace branch remain the fixed
release anchor; `main` may later advance through protected non-distribution
changes. When `plugins/**` remains byte-identical to the tag, that later main
still carries the same 0.3.1 distribution baseline. The
published path is covered by tag CI on Ubuntu, macOS, and Windows plus an
isolated anonymous Codex marketplace installation workflow.

## Current Rules

1. `.agents/plugins/marketplace.json` is the marketplace source of truth and
   lists `./plugins/routeledger` as its only RouteLedger plugin source.
2. `plugins/routeledger/` is a distribution tree. `pnpm build:codex-plugin`
   builds `packages/mcp/dist-plugin-runtime/`, validates its closure, copies it
   into `plugins/routeledger/runtime/`, and recalculates `release.json`.
3. The manifest repository is
   `https://github.com/xczl-785/Routeledger`. It is part of the plugin
   distribution bytes and therefore subject to the SemVer/release-metadata
   contract.
4. The bundled runtime is JSON-only: it starts with `--profile codex
   --sqlite-read-model disabled`, contains neither `sqlite/` nor `ui/`, and
   does not declare `better-sqlite3`.
5. Plugin binding comes from MCP Roots and the managed project's
   `.routeledger/config.json`; the plugin directory and process `cwd` do not
   select a managed project.
6. Any distribution-byte change relative to a Git baseline requires a SemVer
   increase. `release.json` must be regenerated to match the new distribution
   bytes before a release is tagged.
   Non-distribution changes may advance `main` without changing the published
   plugin baseline only while `plugins/**` remains byte-identical to its tag.
7. `pnpm check:codex-plugin-release --previous-ref <ref>` rejects a version
   regression and rejects changed distribution bytes under the same released
   version. `--require-tag-ref` additionally requires
   `routeledger-plugin-v<version>` to resolve to `HEAD`.
8. Git marketplace publication is distinct from npm publication. The plugin
   carries a generated JSON-only runtime, but this capability does not publish
   `@routeledger/mcp` to an npm registry.

## Impact Surface

- `.agents/plugins/marketplace.json` defines marketplace discovery.
- `plugins/routeledger/.codex-plugin/plugin.json` defines plugin identity,
  version, and canonical repository URL.
- `scripts/build-codex-plugin.mjs` synchronizes the generated runtime and
  release metadata.
- `scripts/check-codex-plugin-release.mjs` verifies hashes, version replay,
  and optional tag binding.
- `scripts/smoke-codex-plugin.mjs` and
  `scripts/smoke-codex-git-marketplace.mjs` verify the bundled and Git
  marketplace paths without changing a user profile.

## Uncertainties

GitHub Actions currently emits a Node 20 deprecation warning. It is a release
automation maintenance constraint, not evidence of a failed plugin release;
the workflow runtime should be migrated before that platform warning becomes a
hard failure. Future releases must rebuild a new SemVer distribution, pass the
previous-ref and tag-to-HEAD gates, obtain tag CI, and repeat clean-home Git
marketplace installation/reinstallation verification. npm publication of
`@routeledger/mcp` remains outside this capability.

## Verification

Run `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`,
`pnpm check:codex-plugin-release`, and
`pnpm smoke:codex-git-marketplace`. See
[the installation guide](../guides/codex-plugin-installation.md) and
[the release guide](../guides/plugin-release.md) for operator instructions.
The Git smoke creates branch and tag data only inside a temporary fixture
repository; it validates installation mechanics and does not replace the
published canonical tag as release evidence.
