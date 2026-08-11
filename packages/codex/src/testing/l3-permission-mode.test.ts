import { describe, expect, it } from "vitest";

import { resolveCodexL3PermissionMode } from "../index.js";

describe("Codex L3 permission mode provider", () => {
  it.each([
    [":read-only", "interactive"],
    [":workspace", "delegated"],
    [":danger-full-access", "preauthorized"]
  ] as const)("maps Codex profile %s to %s", (profile, mode) => {
    expect(resolveCodexL3PermissionMode({ CODEX_PERMISSION_PROFILE: profile })).toEqual({
      status: "resolved",
      mode,
      source: "codex_permission_profile",
      codexPermissionProfile: profile,
      fallbackUsed: false
    });
  });

  it("uses only an explicit plugin fallback when Codex context is absent", () => {
    expect(resolveCodexL3PermissionMode({ ROUTELEDGER_CODEX_L3_MODE: "delegated" })).toEqual({
      status: "resolved",
      mode: "delegated",
      source: "plugin_config",
      codexPermissionProfile: null,
      fallbackUsed: true
    });
  });

  it("fails closed for missing or unknown context without a valid fallback", () => {
    expect(resolveCodexL3PermissionMode({})).toMatchObject({
      status: "unavailable",
      code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE"
    });
    expect(resolveCodexL3PermissionMode({ CODEX_PERMISSION_PROFILE: ":future" })).toMatchObject({
      status: "unavailable",
      code: "CODEX_PERMISSION_PROFILE_UNKNOWN",
      codexPermissionProfile: ":future"
    });
    expect(resolveCodexL3PermissionMode({ ROUTELEDGER_CODEX_L3_MODE: "full" })).toMatchObject({
      status: "unavailable",
      code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE"
    });
  });
});
