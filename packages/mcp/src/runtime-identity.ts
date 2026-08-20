/**
 * Identifies the bytes that are executing the MCP server.  This is deliberately
 * separate from the RouteLedger project/version state and from the plugin
 * distribution checksum: a generated identity file cannot safely contain a
 * hash of a file set which includes itself.
 */
export type RouteLedgerRuntimeProfile = "full" | "json-only";
export type RouteLedgerRuntimeArtifactKind = "source" | "package" | "plugin";
export type RuntimeSourceTreeState = "clean" | "dirty" | "unavailable";
export type RuntimeProvenanceStatus =
  | "unavailable"
  | "source_commit"
  | "external_attestation_required";

export interface RuntimeAttestationLocator {
  strategy: "git-tag-external";
  repositoryUrl: string;
  releaseTag: string;
  assetName: string;
  downloadUrl: string;
}

export interface RuntimeIdentity {
  runtimePackageVersion: string;
  runtimeProfile: RouteLedgerRuntimeProfile;
  artifactKind: RouteLedgerRuntimeArtifactKind;
  pluginVersion: string | null;
  /** Immutable release tag expected to attest this plugin payload. */
  releaseTag: string | null;
  sourceTreeState: RuntimeSourceTreeState;
  /**
   * Scoped build-input provenance. This is additive to sourceTreeState so
   * callers cannot mistake runtime build cleanliness for host-workspace Git state.
   */
  buildProvenance?: {
    scope: "runtime_build_inputs";
    sourceTreeState: RuntimeSourceTreeState;
  };
  /** How callers can bind this runtime identity to immutable source/distribution evidence. */
  provenanceStatus?: RuntimeProvenanceStatus;
  /** Stable locator for the detached proof when provenanceStatus requires attestation. */
  attestation: RuntimeAttestationLocator | null;
  /**
   * Source/package artifacts may report the clean Git HEAD that built them.
   * Plugin artifacts always use null: squash/rebase makes branch commit IDs
   * non-authoritative, so their identity is content-addressed instead.
   */
  buildCommit: string | null;
  /**
   * Reserved for an externally supplied immutable artifact digest. It is null
   * for local/source and self-describing artifacts rather than being invented.
   */
  artifactDigest: string | null;
  /**
   * SHA-256 of the actual built runtime files, excluding this generated
   * identity module. This is the authoritative identity for plugin runtime
   * payload bytes and stays stable when the digest itself is injected.
   */
  runtimePayloadDigest: string | null;
}

const SOURCE_RUNTIME_PACKAGE_VERSION = "0.0.0-package-prep";

export const resolveRuntimeIdentity = (
  runtimeProfile: RouteLedgerRuntimeProfile
): RuntimeIdentity => ({
  runtimePackageVersion: SOURCE_RUNTIME_PACKAGE_VERSION,
  runtimeProfile,
  artifactKind: "source",
  pluginVersion: null,
  releaseTag: null,
  sourceTreeState: "unavailable",
  attestation: null,
  buildCommit: null,
  artifactDigest: null,
  runtimePayloadDigest: null
});
