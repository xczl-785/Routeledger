import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileL3AuthorizationPolicyUsageStore } from "../l3-authorization-policy-usage.js";

describe("L3 authorization policy usage", () => {
  it("persists and atomically exhausts a rule budget across store instances", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-policy-usage-"));
    const input = {
      policyDigest: "digest-1",
      ruleId: "rule-1",
      maxUses: 2,
      expiresAt: "2026-08-11T00:00:00.000Z",
      now: "2026-08-10T00:00:00.000Z"
    };
    try {
      expect(new FileL3AuthorizationPolicyUsageStore(root).consume(input)).toEqual({ ok: true, use: 1 });
      expect(new FileL3AuthorizationPolicyUsageStore(root).consume(input)).toEqual({ ok: true, use: 2 });
      expect(new FileL3AuthorizationPolicyUsageStore(root).consume(input)).toEqual({
        ok: false,
        code: "POLICY_USE_BUDGET_EXHAUSTED"
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
