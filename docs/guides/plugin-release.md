# Plugin release guide

This guide defines the repeatable checks for a future plugin release. Passing
these checks does not by itself publish, tag, push, or install anything.

## Prepare

1. Make the intended source and documentation changes.
2. If any file in `plugins/routeledger/` changes (except the regenerated
   `release.json`), increase the plugin SemVer in
   `plugins/routeledger/.codex-plugin/plugin.json`.
3. Rebuild the generated runtime and release metadata:

   ```bash
   pnpm build:codex-plugin
   ```

4. Run the complete validation set:

   ```bash
   pnpm smoke:codex-plugin
   pnpm smoke:codex-git-marketplace
   pnpm test
   pnpm typecheck
   pnpm lint
   ```

5. Compare against the preceding release when one exists:

   ```bash
   pnpm check:codex-plugin-release --previous-ref <PREVIOUS_RELEASE_REF>
   ```

The previous-ref check rejects a changed distribution under unchanged SemVer
and rejects a version regression. `release.json` must match the manifest,
marketplace identity, and deterministic distribution hashes.

## Tag contract

For a normal release, the tag is exactly:

```text
routeledger-plugin-v<plugin-semver>
```

For each future release, create that tag on the final release commit in
`xczl-785/Routeledger` and validate it with:

```bash
pnpm check:codex-plugin-release --require-tag-ref
```

The current plugin release is `routeledger-plugin-v0.3.1`; it resolves to the
same released source as `main` and the canonical remote's
`codex-marketplace` branch. Future releases use the same tag format with their
new SemVer and must not reuse or move an existing tag.

## Install verification

Use a clean Codex home and the canonical repository URL to add the marketplace,
install `routeledger@routeledger-team`, run an MCP initialization and binding
smoke, then remove it. The released 0.3.1 path has been verified with branch
install, no-op upgrade, tag-based reinstall, release-hash verification,
Apache-2.0 distribution files, and the JSON-only runtime workflow. The
repository's hermetic Git marketplace smoke covers the equivalent mechanics
without modifying a user profile.
