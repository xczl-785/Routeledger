const CODEX_PROFILE_MODES = {
    ":read-only": "interactive",
    ":workspace": "delegated",
    ":danger-full-access": "preauthorized"
};
const parseConfiguredMode = (value) => value === "interactive" || value === "delegated" || value === "preauthorized"
    ? value
    : null;
export const resolveCodexL3PermissionMode = (environment = process.env) => {
    const profile = environment.CODEX_PERMISSION_PROFILE?.trim() || null;
    if (profile !== null) {
        const mapped = CODEX_PROFILE_MODES[profile];
        if (mapped !== undefined) {
            return {
                status: "resolved",
                mode: mapped,
                source: "codex_permission_profile",
                codexPermissionProfile: profile,
                fallbackUsed: false
            };
        }
    }
    const fallback = parseConfiguredMode(environment.ROUTELEDGER_CODEX_L3_MODE);
    if (fallback !== null) {
        return {
            status: "resolved",
            mode: fallback,
            source: "plugin_config",
            codexPermissionProfile: profile,
            fallbackUsed: true
        };
    }
    return profile === null
        ? {
            status: "unavailable",
            code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE",
            codexPermissionProfile: null,
            reason: "Codex did not expose an effective permission profile and no plugin fallback is configured."
        }
        : {
            status: "unavailable",
            code: "CODEX_PERMISSION_PROFILE_UNKNOWN",
            codexPermissionProfile: profile,
            reason: "Codex exposed an unknown permission profile and no plugin fallback is configured."
        };
};
