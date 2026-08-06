# cap-codex-plugin-package

## Scope

This capability covers the repository-root Codex marketplace, the generated
JSON-only plugin runtime, release metadata, and local or hermetic Git
marketplace verification. It does not assert that a remote release exists.

## Current rules

1. `.agents/plugins/marketplace.json` is the marketplace source of truth and
   lists `./plugins/routeledger` as its only RouteLedger plugin source.
2. `plugins/routeledger/` is a distribution tree. `pnpm build:codex-plugin`
   builds `packages/mcp/dist-plugin-runtime/`, validates its closure, copies it
   into `plugins/routeledger/runtime/`, then recalculates `release.json`.
3. The bundled runtime is JSON-only: it starts with `--profile codex
   --sqlite-read-model disabled`, contains neither `sqlite/` nor `ui/`, and
   does not declare `better-sqlite3`.
4. Plugin binding comes from MCP Roots and the managed project's
   `.routeledger/config.json`; the plugin directory and process `cwd` do not
   select a managed project.
5. A distribution-byte change requires a SemVer increase. `release.json`
   hashes all plugin files except itself, preventing self-reference.
6. `pnpm check:codex-plugin-release --previous-ref <ref>` rejects a version
   regression and rejects changed distribution bytes under the same version.
   `--require-tag-ref` additionally requires `routeledger-plugin-v<version>`
   to resolve to `HEAD`.

## Verification

Run `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`,
`pnpm check:codex-plugin-release`, and
`pnpm smoke:codex-git-marketplace`. The Git smoke creates only temporary
fixture repositories and proves install, upgrade, tag-based reinstall, hash
verification, and JSON-only runtime startup.

See [the installation guide](../guides/codex-plugin-installation.md) and
[the release guide](../guides/plugin-release.md) for operator instructions.
