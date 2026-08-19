import assert from "node:assert/strict";

import { findRemovedPublicTools } from "./check-agent-tool-surface.mjs";

assert.deepEqual(
  findRemovedPublicTools('write({ params: { name: "init_project", arguments: {} } });'),
  ["init_project"]
);

assert.deepEqual(
  findRemovedPublicTools('registry.invoke("inspect_route", { operation: "next_action" });'),
  ["inspect_route"]
);

assert.deepEqual(
  findRemovedPublicTools('write({ params: { name: "propose_route_change", arguments: {} } });'),
  ["propose_route_change"]
);
