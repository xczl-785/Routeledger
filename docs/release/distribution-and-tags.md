# Distribution forms and tag conventions

## Purpose

RouteLedger uses `main` as the single release trunk for all distribution
forms. This document defines how each form is versioned and tagged so that a
Codex plugin release and a future MCP / npm package release never collide or
block each other.

## Single release trunk

- `main` is the only release trunk. A release is a verified `main` commit with
  an immutable, form-specific tag.
- `codex-marketplace` is the historical 0.3.3 branch anchor only. It must not
  receive new commits; future versions are released from `main` or their
  immutable version tags.
- Both `main` and `codex-marketplace` are protected branches.

## Distribution forms

| Form | Artifact | Version source | Tag prefix | Release checks |
| --- | --- | --- | --- | --- |
| Codex plugin | Git marketplace distribution under `plugins/routeledger/` | Plugin SemVer in `plugins/routeledger/.codex-plugin/plugin.json` | `routeledger-plugin-v<semver>` | `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`, `pnpm check:codex-plugin-release`, `pnpm smoke:codex-git-marketplace` |
| MCP / npm package (planned) | `@routeledger/mcp` dist and local tarball | Package SemVer in `packages/mcp/package.json` (independent) | `routeledger-mcp-v<semver>` or npm dist-tag after publication | `pnpm build:mcp-package`, `pnpm smoke:mcp-package`, plus platform verification for `better-sqlite3` |

## Version independence

- The plugin SemVer and package SemVers are independent and must not be
  assumed equal. A shared-source change may require coordinated releases, but
  each release remains a separate event with its own tag and release note.
- A new distribution form must register its tag prefix in this table before
  its first release.
- Tags are immutable: never reuse, move, or delete a released tag.

## Release notes

Each distribution form keeps its own release notes under
`docs/release/release-notes/`. The current published Codex plugin release is
[0.4.1](release-notes/0.4.1.md).

The 0.4.2 regression-fix candidate is documented in
[0.4.2](release-notes/0.4.2.md); it is not published until merged and tagged.

## Current status

- Published: Codex plugin 0.4.1 (tag `routeledger-plugin-v0.4.1`).
- Historical branch anchor: Codex plugin 0.3.3 on `codex-marketplace`.
- Not published: `@routeledger/mcp` on npm. Documentation must not present it
  as installable until the first npm release exists.
