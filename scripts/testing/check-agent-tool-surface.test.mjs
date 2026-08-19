import assert from "node:assert/strict";

import { findRemovedPublicTools } from "./check-agent-tool-surface.mjs";

assert.deepEqual(
  findRemovedPublicTools('write({ params: { name: "init_project", arguments: {} } });'),
  ["init_project"]
);
