import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXACT_AUTHORIZATION_SCHEMA_VERSION,
  GENERIC_EXACT_DECISION_INPUT_SCHEMA,
  type ExactAuthorization,
  type ExactAuthorizationReceipt,
  type ExactDecisionArtifactResponse
} from "../index.js";
import { classifyLegacyAuthorizationRecord } from "../application/legacy-authorization-migration.js";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "exact-authorization-v1"
);
const readJson = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8")) as T;

describe("EA0 exact-only authorization contract", () => {
  it("binds one authorization and receipt to one exact proposal", () => {
    const binding = {
      proposalId: "proposal-1",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest-1",
      actionType: "start_version" as const,
      targetId: "version-1",
      operationDigest: "operation-digest-1"
    };
    const authorization: ExactAuthorization = {
      schemaVersion: EXACT_AUTHORIZATION_SCHEMA_VERSION,
      authorizationId: "authorization-1",
      artifactId: "artifact-1",
      binding,
      source: "preauthorized",
      decisionRef: "policy-decision-1",
      issuer: "trusted-host-policy",
      audience: "routeledger-core",
      subjectId: "routeledger-user",
      policyId: "policy-1",
      policyDigest: "policy-digest-1",
      profileId: "profile-1",
      modeEpoch: 3,
      profileDigest: "profile-digest-1",
      hostKind: "generic",
      clientId: "client-1",
      createdAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-12T00:01:00.000Z"
    };
    const receipt: ExactAuthorizationReceipt = {
      authorizationId: authorization.authorizationId,
      artifactId: authorization.artifactId,
      binding,
      issuer: authorization.issuer,
      audience: authorization.audience,
      subjectId: authorization.subjectId,
      source: authorization.source,
      decisionRef: authorization.decisionRef,
      policyId: authorization.policyId,
      policyDigest: authorization.policyDigest,
      profileId: authorization.profileId,
      modeEpoch: authorization.modeEpoch,
      profileDigest: authorization.profileDigest,
      hostKind: authorization.hostKind,
      clientId: authorization.clientId,
      createdAt: authorization.createdAt,
      expiresAt: authorization.expiresAt,
      status: "authorized",
      commitClaimId: null,
      commitClaimedAt: null,
      committedAt: null,
      revokedAt: null
    };

    expect(authorization.authorizationId).not.toBe(authorization.artifactId);
    expect(receipt.binding).toEqual(authorization.binding);
    expect(authorization).not.toHaveProperty("scope");
    expect(authorization).not.toHaveProperty("decisionBudget");
    expect(authorization).not.toHaveProperty("allowedActions");
    expect(authorization).not.toHaveProperty("allowedTargetIds");
    expect(receipt).not.toHaveProperty("consumedUse");
    expect(receipt).not.toHaveProperty("sessionId");
  });

  it("does not expose session identity in the exact binding", () => {
    const bindingKeys = [
      "proposalId",
      "projectId",
      "routeledgerRootDigest",
      "actionType",
      "targetId",
      "operationDigest"
    ];
    expect(bindingKeys).not.toContain("sessionId");
  });

  it("freezes a public exact decision response without reuse vocabulary", () => {
    const response: ExactDecisionArtifactResponse = {
      artifactId: "artifact-1",
      authorizationId: "authorization-1",
      proposalId: "proposal-1",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest-1",
      actionType: "start_version",
      targetId: "version-1",
      operationDigest: "digest-1",
      source: "host_admission",
      decisionRef: "codex-tool-call-1",
      status: "approved"
    };
    expect(response).not.toHaveProperty("scope");
    expect(response).not.toHaveProperty("sessionId");
    expect(response.authorizationId).toBe("authorization-1");
    expect({
      proposalId: response.proposalId,
      projectId: response.projectId,
      routeledgerRootDigest: response.routeledgerRootDigest,
      actionType: response.actionType,
      targetId: response.targetId,
      operationDigest: response.operationDigest
    }).toEqual({
      proposalId: "proposal-1",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest-1",
      actionType: "start_version",
      targetId: "version-1",
      operationDigest: "digest-1"
    });
  });

  it("defines generic elicitation without active scope semantics", () => {
    expect(GENERIC_EXACT_DECISION_INPUT_SCHEMA.required).toEqual(["approve"]);
    expect(GENERIC_EXACT_DECISION_INPUT_SCHEMA.properties).not.toHaveProperty("scope");
    expect(JSON.stringify(GENERIC_EXACT_DECISION_INPUT_SCHEMA)).not.toContain("time_window");
    expect(JSON.stringify(GENERIC_EXACT_DECISION_INPUT_SCHEMA)).not.toContain("session");
  });

  it("forces every legacy grant, including exact one-shot, through reauthorization", () => {
    const grants = readJson<Array<{ status: string; scope: "operation" | "session" | "time_window"; operationDigest: string | null }>>("legacy-grants.json");
    expect(grants.map((grant) => classifyLegacyAuthorizationRecord({ kind: "grant", ...grant })))
      .toEqual(grants.map(() => "revoke_and_tombstone_then_reauthorize"));
  });

  it("preserves old artifacts and receipts as audit evidence but never active authority", () => {
    readJson("legacy-artifact.json");
    readJson("legacy-artifact-full-provenance.json");
    readJson("legacy-artifact-partial-profile.json");
    readJson("legacy-receipt.json");
    expect(classifyLegacyAuthorizationRecord({ kind: "approval_artifact" }))
      .toBe("retain_as_immutable_audit_evidence");
    expect(classifyLegacyAuthorizationRecord({ kind: "receipt" }))
      .toBe("retain_as_immutable_audit_evidence");
  });

  it("classifies a partial legacy profile trio as audit-only, never trusted authority", () => {
    const partial = readJson<Record<string, unknown>>("legacy-artifact-partial-profile.json");
    expect(partial).toHaveProperty("profileId");
    expect(partial).not.toHaveProperty("modeEpoch");
    expect(classifyLegacyAuthorizationRecord({ kind: "approval_artifact" }))
      .toBe("retain_as_immutable_audit_evidence");
  });

  it("migrates host policy configuration without carrying active authority", () => {
    readJson("legacy-host-state.json");
    expect(classifyLegacyAuthorizationRecord({ kind: "host_state" }))
      .toBe("migrate_policy_configuration_without_authority");
  });

  it("pins a readable legacy SQLite fixture for EA2 migration tests", () => {
    const sql = fs.readFileSync(path.join(fixtureRoot, "legacy-sqlite.sql"), "utf8");
    expect(sql).toContain("scope TEXT NOT NULL");
    expect(sql).toContain("'operation'");
    expect(sql).toContain("'session'");
    expect(sql).toContain("'time_window'");
  });
});
