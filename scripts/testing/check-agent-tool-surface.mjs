/* global console */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const agentFacingFiles = [
  "scripts/smoke-codex-git-marketplace.mjs",
  "scripts/smoke-codex-host-plugin.mjs",
  "scripts/testing/setup-codex-l3-normal-turn-fixture.ts",
  "scripts/testing/codex-app-server-jsonl-client.test.mjs",
  "examples/config/codex.config.toml"
];
const removedPublicTools = [
  "create_undo", "reassign_undo", "carry_forward_undo", "resolve_undo_as_downstream_input", "close_undo",
  "get_runtime_context", "get_l3_authorization_status", "recommend_l3_authorization_profile",
  "discover_routeledger_roots", "plan_routeledger_binding", "activate_routeledger_binding",
  "render_host_binding_config", "write_host_binding_config", "open_mission_control",
  "get_mission_control_status", "stop_mission_control", "init_project", "set_project_content_locale",
  "get_current_context", "next_action", "check_doc_drift", "summarize_version_closeout",
  "plan_version_closeout", "list_versions_window", "list_versions", "check_start_gate",
  "check_close_gate", "get_version_structure", "get_version_transition_guide",
  "recommend_l3_authorization_policy", "list_l3_proposals", "get_l3_proposal",
  "preflight_or_propose_version_batch", "preview_or_propose_version_transition",
  "batch_create_versions", "transition_version", "propose_version_advance", "advance_to_version",
  "preview_or_propose_version_close", "close_version",
  "create_todo", "close_todo", "defer_work",
  "review_deferred", "record_constraint", "retire_constraint", "prepare_version",
  "mark_version_complete", "propose_version_creation", "propose_version_insertion",
  "create_version", "insert_version", "propose_child_version_creation", "create_child_version",
  "propose_version_reorder", "reorder_versions", "propose_l3_operation",
  "preview_or_propose_forced_version_shutdown", "shutdown_version", "execute_l3_operation",
  "approve_l3_operation", "commit_l3_operation", "reject_l3_operation"
];
export const findRemovedPublicTools = (source) => {
  const residuals = [];
  for (const tool of removedPublicTools) {
    const publicUse = new RegExp(
      `(?:\\.invoke\\(\\s*["']${tool}["']|(?:tool|name)\\s*[:=]\\s*["']${tool}["']|tools\\.${tool}\\b)`,
      "u"
    );
    if (publicUse.test(source)) residuals.push(tool);
  }
  return residuals;
};

const residuals = [];
for (const relativePath of agentFacingFiles) {
  const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  for (const tool of findRemovedPublicTools(source)) residuals.push(`${relativePath}: ${tool}`);
}
if (residuals.length > 0) throw new Error(`Removed public tool names remain in Agent-facing files:\n${residuals.join("\n")}`);
console.log("Agent-facing tool surface contains no removed public tool names.");
