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

Create that tag on the final release commit in
`xczl-785/Routeledger` and validate it with:

```bash
pnpm check:codex-plugin-release --require-tag-ref
```

For the current 0.3.1 release candidate, the prospective tag is
`routeledger-plugin-v0.3.1`. It has not been created and must not be created
merely to make a candidate checkout look published.

## Install verification

Use a clean Codex home and the final repository URL to add the marketplace,
install `routeledger@routeledger-team`, run an MCP initialization and binding
smoke, then remove it. The repository's hermetic Git marketplace smoke covers
the equivalent install, upgrade, tag-based reinstall, hash, and JSON-only
runtime behavior without modifying a user profile.
