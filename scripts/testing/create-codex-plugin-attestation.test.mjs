import assert from "node:assert/strict";

import { buildCodexPluginAttestation } from "../create-codex-plugin-attestation.mjs";

const version = "0.4.2";
const releaseTag = `routeledger-plugin-v${version}`;
const sourceCommit = "a".repeat(40);
const manifest = { name: "routeledger", version };
const release = {
  plugin: { name: "routeledger", version },
  runtimeIdentity: {
    runtimePackageVersion: version,
    runtimeProfile: "json-only",
    provenanceStatus: "external_attestation_required",
    runtimePayloadDigest: "b".repeat(64),
    releaseTag
  },
  attestation: { releaseTag },
  content: {
    algorithm: "sha256",
    pluginDistributionSha256: "c".repeat(64),
    runtimeSha256: "d".repeat(64)
  }
};

assert.deepEqual(
  buildCodexPluginAttestation({ manifest, release, releaseTag, sourceCommit }),
  {
    schemaVersion: 1,
    subject: { pluginName: "routeledger", pluginVersion: version, releaseTag, sourceCommit },
    runtimeIdentity: {
      runtimePackageVersion: version,
      runtimeProfile: "json-only",
      provenanceStatus: "external_attestation_required",
      runtimePayloadDigest: "b".repeat(64)
    },
    artifacts: {
      algorithm: "sha256",
      pluginDistributionSha256: "c".repeat(64),
      runtimeSha256: "d".repeat(64)
    }
  }
);

assert.throws(
  () => buildCodexPluginAttestation({ manifest, release, releaseTag: "routeledger-plugin-v0.4.0", sourceCommit }),
  /release tag must be/
);
