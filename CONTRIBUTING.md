# Contributing

RouteLedger is a pnpm workspace. Use Node and pnpm versions compatible with
the repository's `packageManager` declaration, then install dependencies with:

```bash
pnpm install --frozen-lockfile
```

Keep a change within its documented capability boundary. Do not add managed
project state, generated package directories, local paths, or credentials to
the repository. The root `.routeledger/` directory is local runtime state;
the canonical JSON fixture under `packages/json/src/testing/fixtures/` is the
only tracked exception.

Before proposing a change, run the focused tests plus:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

For plugin changes also run `pnpm build:codex-plugin`,
`pnpm smoke:codex-plugin`, and `pnpm smoke:codex-git-marketplace`. Distribution
byte changes require a plugin SemVer increase and regenerated `release.json`;
see `docs/guides/plugin-release.md`.

Contributions to this repository are made under the
[Apache License 2.0](LICENSE).
