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

The latest published plugin release is `routeledger-plugin-v0.4.2`;
`codex-marketplace` remains the historical 0.3.3 branch anchor. `main` is
the release branch: merge each verified distribution to `main`, create the
immutable version tag on that commit, and never reuse or move an existing tag.
The `main` push validates the previous-ref SemVer/distribution replay; it does
not require a tag that has not been created yet. The subsequent version-tag CI
runs the tag-to-HEAD check.

Tag CI also runs:

```bash
pnpm attest:codex-plugin \
  --tag routeledger-plugin-v<plugin-semver> \
  --output /SAFE/OUTPUT/PATH/routeledger-plugin-attestation.json
```

The uploaded attestation is the non-self-referential binding between the
immutable tag's source commit and the runtime/full-distribution digests.
Tag CI first keeps it as a workflow artifact, then a separate job with
`contents: write` publishes the same verified JSON as a durable GitHub Release
asset. Its asset name and stable download URL must match the locator exposed by
the plugin runtime identity and `release.json`.

## Install verification

Use a clean Codex home and the canonical repository URL to add the marketplace,
install `routeledger@routeledger-team`, run an MCP initialization and binding
smoke, then remove it. The published 0.4.1 path passed branch install, upgrade,
tag-based reinstall, release-hash verification, Apache-2.0
distribution checks, and the JSON-only runtime workflow. The
repository's hermetic Git marketplace smoke covers the equivalent mechanics
without modifying a user profile. The published 0.4.2 path passed the same
branch-install, upgrade, tag-reinstall, release-hash, license, and JSON-only
runtime checks.
