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

6. After installing the exact candidate into the active Codex home, start a
   fresh host task and require one native `get_runtime_context` call:

   ```bash
   pnpm smoke:codex-host-plugin
   ```

   This check uses an ephemeral, read-only `codex exec` task and verifies native
   MCP tool exposure, the loaded plugin version, and the runtime payload digest
   from candidate `release.json`. The separate plugin/marketplace release checks
   retain responsibility for the full distribution digest. This host check is
   intentionally not part of credential-free CI. Directly launching the bundled
   stdio runtime does not satisfy this gate because it bypasses host activation.

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

The latest published plugin release is `routeledger-plugin-v0.9.4`;
`codex-marketplace` remains the historical 0.3.3 branch anchor. `main` is the
release branch: merge each verified distribution to `main`, create the
immutable version tag on that commit, and never reuse or move an existing tag.
The `main` push validates the previous-ref SemVer/distribution replay; it does
not require a tag that has not been created yet. The subsequent version-tag CI
runs the tag-to-HEAD check.

## Merge, tag, and publish

Use a protected-branch pull request to place the reviewed release commit on
`main`. Do not bypass branch protection with a direct or forced push. After the
pull request is merged, use a clean worktree and run:

```bash
git fetch origin --tags
git switch main
git pull --ff-only origin main

export PLUGIN_VERSION=<plugin-semver>
export RELEASE_TAG="routeledger-plugin-v${PLUGIN_VERSION}"

test -z "$(git status --porcelain)"
test -z "$(git tag --list "${RELEASE_TAG}")"
pnpm check:codex-plugin-release --previous-ref <PREVIOUS_RELEASE_REF>
pnpm smoke:codex-host-plugin

git tag -a "${RELEASE_TAG}" -m "RouteLedger Codex plugin ${PLUGIN_VERSION}"
pnpm check:codex-plugin-release --require-tag-ref
git push origin "${RELEASE_TAG}"
```

The pull-request merge publishes the release commit to `origin/main`; the final
push publishes only the immutable version tag. Never use `--force`, never move
or delete a published tag, and do not retry with the same SemVer after changing
plugin distribution bytes. The tag-triggered workflow must finish successfully
and publish the GitHub Release checksum manifest before the version is described
as published.

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

Here, "attestation" means an unsigned release checksum manifest. Verification
recomputes and compares SHA-256 values under the canonical repository tag and
GitHub Release; it does not require a signing key, GPG, Sigstore, Cosign, or
SLSA. Add a separate cryptographic-signature layer only if a future external
distribution or compliance requirement explicitly needs one.

## Install verification

Use a clean Codex home and the canonical repository URL to add the marketplace,
install `routeledger@routeledger-team`, run an MCP initialization and binding
smoke, verify native host exposure with `pnpm smoke:codex-host-plugin`, then
remove it. The published 0.4.1 path passed branch install, upgrade,
tag-based reinstall, release-hash verification, Apache-2.0
distribution checks, and the JSON-only runtime workflow. The
repository's hermetic Git marketplace smoke covers the equivalent mechanics
without modifying a user profile. The published 0.4.2 path passed the same
branch-install, upgrade, tag-reinstall, release-hash, license, and JSON-only
runtime checks; 0.4.4 additionally publishes and anonymously revalidates its
durable checksum manifest. The 0.4.3 candidate was never tagged or published.
Versions 0.5.0 through 0.9.4 used the same immutable-main-tag and durable
attestation path. The latest releases add plugin-native Mission Control,
localized runtime guidance, and persistent ordinary-write idempotency.
