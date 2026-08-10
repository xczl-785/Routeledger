# cap-codex-plugin-package

## Quick Read

The canonical Git repository is `xczl-785/Routeledger`. Its root contains the
marketplace descriptor and the single generated `routeledger` plugin
distribution. The current Git marketplace release is 0.4.4, fixed by immutable
tag `routeledger-plugin-v0.4.4`. It includes canonical approval round-trip
fixes, explicit external-attestation provenance status, the stable attestation
locator, and durable GitHub Release publication without changing the
detached-proof model.
`main` is the release branch.
`codex-marketplace` remains only the historical 0.3.3 branch anchor.

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
   does not declare `better-sqlite3`. Its runtime profile omits source-only
   Mission Control tools from discovery and invocation; the full/source MCP
   profile continues to expose them.
5. Plugin binding comes from MCP Roots and the managed project's
   `.routeledger/config.json`; the plugin directory and process `cwd` do not
   select a managed project. When a host sends no Roots/rootUri, the prompted,
   session-scoped `activate_routeledger_binding` tool requires the host's
   absolute workspace root and refuses a silent high-confidence project switch.
   Cache cwd is never a discovery or initialization target. That approved
   activation may create/normalize binding `config.json`, never canonical
   project JSON; `init_project` creates project state. Plugin prompts and the
   operator Skill direct an unbound agent to use the host's current absolute
   workspace root, activate the session, and verify the rebound context.
6. Any distribution-byte change relative to a Git baseline requires a SemVer
   increase. `main` is the release branch, and `release.json` must be
   regenerated to match the new distribution bytes before a release is tagged.
7. `pnpm check:codex-plugin-release --previous-ref <ref>` rejects a version
   regression and rejects changed distribution bytes under the same released
   version. `--require-tag-ref` additionally requires
   `routeledger-plugin-v<version>` to resolve to `HEAD`. The previous immutable
   tag, not a mutable release branch, is the comparison baseline. Pull-request
   and `main` CI run the previous-ref replay guard; only immutable version-tag
   CI runs the tag-to-HEAD guard after the tag exists.
8. Plugin provenance is content-addressed: `runtimePayloadDigest`,
   `runtimeSha256`, and `pluginDistributionSha256` must match the generated
   bytes. `sourceTreeState` reports whether build inputs were clean, while
   plugin `buildCommit` is always `null` because linear-history squash/rebase
   makes a branch commit ID non-stable. The bundled runtime reports the plugin
   SemVer as `runtimePackageVersion` plus its expected immutable `releaseTag`,
   and reports `provenanceStatus=external_attestation_required` so callers do
   not mistake intentionally external commit/distribution evidence for missing
   or invented inline identity.
   Tag CI generates and uploads an external attestation that binds that tag's
   real source commit to the runtime payload, runtime tree, and full plugin
   distribution digests; this avoids embedding a self-referential digest or a
   pre-merge commit. The runtime exposes the expected GitHub Release asset URL,
   and tag CI publishes the verified proof there after all platform contract
   jobs pass. This proof is an unsigned SHA-256 release manifest; the current
   contract deliberately adds no GPG, Sigstore, Cosign, or SLSA requirement.
   Standalone MCP package artifacts may
   still report the clean build HEAD for local diagnostics. The distribution
   and bundled runtime accept directories and regular files only; current-tree
   symlinks/special files and previous-ref non-blob or non-regular Git modes
   fail closed before hashing.
9. Git marketplace publication is distinct from npm publication. The plugin
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
- `scripts/create-codex-plugin-attestation.mjs` emits the external tag, source
  commit, and artifact-digest binding after the immutable tag exists.
- `scripts/smoke-codex-plugin.mjs` and
  `scripts/smoke-codex-git-marketplace.mjs` verify the bundled and Git
  marketplace paths without changing a user profile.
- `scripts/smoke-codex-host-plugin.mjs` starts one fresh, ephemeral Codex task
  against the installed candidate and fails unless the host natively calls
  `get_runtime_context` on the expected plugin version. It is a credentialed
  pre-release gate, not a credential-free CI check.

## Uncertainties

GitHub Actions currently emits a Node 20 deprecation warning. It is a release
automation maintenance constraint, not evidence of a failed plugin release;
the workflow runtime should be migrated before that platform warning becomes a
hard failure. Future releases from `main` must rebuild a new SemVer
distribution, pass the previous-tag and tag-to-HEAD gates, obtain tag CI, and repeat clean-home Git
marketplace installation/reinstallation verification. npm publication of
`@routeledger/mcp` remains outside this capability.

Physical-path containment resolves existing symlinks, junctions, and reparse
points at preflight time and fails closed when that resolution is unavailable.
That is not a complete defence against an attacker swapping a link after
preflight; state-writing entrypoints re-check their bound root assertion, but
future hardening should make create/open operations descriptor-anchored where
the host threat model requires TOCTOU resistance.

Host approval metadata and MCP tool annotations are advisory host hints; the
server cannot use them to guarantee that Codex displays an independent human
confirmation UI for `activate_routeledger_binding`. If mandatory confirmation
becomes a product requirement, implement it as an MCP `elicitation/create`
flow whose proposal fixes the workspace root, RouteLedger root, risks, and
digest before activation. Unsupported elicitation, cancellation, timeout, or
any response other than explicit acceptance must fail closed. Because this
would make activation unavailable to older hosts, it requires separate
Desktop/CLI interoperability evidence and a separately scoped compatibility
release, rather than being folded into the current advisory behavior.

## Verification

Run `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`,
`pnpm check:codex-plugin-release`, and
`pnpm smoke:codex-git-marketplace`. After installing the exact candidate into
the active Codex home, also run `pnpm smoke:codex-host-plugin`; a direct stdio
runtime smoke does not replace this native host check. See
[the installation guide](../guides/codex-plugin-installation.md) and
[the release guide](../release/plugin-release.md) for operator instructions.
The Git smoke creates branch and tag data only inside a temporary fixture
repository; it validates installation mechanics and does not replace the
published canonical tag as release evidence.
