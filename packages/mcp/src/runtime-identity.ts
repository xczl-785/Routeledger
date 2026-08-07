/**
 * Identifies the bytes that are executing the MCP server.  This is deliberately
 * separate from the RouteLedger project/version state and from the plugin
 * distribution checksum: a generated identity file cannot safely contain a
 * hash of a file set which includes itself.
 */
export type RouteLedgerRuntimeProfile = "full" | "json-only";
export type RouteLedgerRuntimeArtifactKind = "source" | "package" | "plugin";
export type RuntimeSourceTreeState = "clean" | "dirty" | "unavailable";

export interface RuntimeIdentity {
  runtimePackageVersion: string;
  runtimeProfile: RouteLedgerRuntimeProfile;
  artifactKind: RouteLedgerRuntimeArtifactKind;
  pluginVersion: string | null;
  sourceTreeState: RuntimeSourceTreeState;
  buildCommit: string | null;
  /**
   * Reserved for an externally supplied immutable artifact digest. It is null
   * for local/source and self-describing artifacts rather than being invented.
   */
  artifactDigest: string | null;
  /**
   * SHA-256 of runtime files excluding this generated identity module. This
   * stays stable when the digest itself is injected into this module.
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
  sourceTreeState: "unavailable",
  buildCommit: null,
  artifactDigest: null,
  runtimePayloadDigest: null
});
