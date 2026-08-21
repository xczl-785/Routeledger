import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkPackageBoundaries } from "../check-package-boundaries.mjs";

test("reports new package-boundary violations while enforcing an exact baseline", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-package-boundaries-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const write = async (relativePath, content) => {
    const target = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  };

  await write(
    "package.json",
    `${JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2)}\n`
  );
  await write(
    "packages/a/package.json",
    `${JSON.stringify({
      name: "@fixture/a",
      type: "module",
      dependencies: { "@fixture/b": "workspace:*" }
    }, null, 2)}\n`
  );
  await write(
    "packages/a/tsconfig.json",
    `${JSON.stringify({ include: ["src/**/*.ts", "../b/src/**/*.ts"] }, null, 2)}\n`
  );
  await write("packages/a/src/cross-package.ts", 'import "../../b/src/index.js";\n');
  await write("packages/a/src/legacy-cross-package.ts", 'import "../../b/src/index.js";\n');
  await write("packages/a/src/undeclared.ts", 'import "left-pad";\n');
  await write("packages/a/src/declared.ts", 'import "@fixture/b";\n');
  await write(
    "packages/b/package.json",
    `${JSON.stringify({ name: "@fixture/b", type: "module" }, null, 2)}\n`
  );
  await write("packages/b/src/index.ts", "export const value = 1;\n");

  const initial = await checkPackageBoundaries({ repoRoot });
  assert.deepEqual(
    [...new Set(initial.violations.map((violation) => violation.rule))].sort(),
    [
      "CROSS_PACKAGE_RELATIVE_IMPORT",
      "TSCONFIG_CROSS_PACKAGE_INCLUDE",
      "UNDECLARED_BARE_DEPENDENCY"
    ]
  );
  const legacy = initial.violations.find((violation) =>
    violation.file.replaceAll("\\", "/").endsWith("packages/a/src/legacy-cross-package.ts")
  );
  assert.ok(legacy, "the legacy relative import should have a stable violation fingerprint");

  const checked = await checkPackageBoundaries({
    repoRoot,
    baselineFingerprints: [legacy.fingerprint, "stale-baseline-fingerprint"]
  });
  assert.equal(
    checked.violations.some((violation) => violation.fingerprint === legacy.fingerprint),
    false,
    "an exact legacy baseline entry should not be reported as a new violation"
  );
  assert.deepEqual(
    [...new Set(checked.violations.map((violation) => violation.rule))].sort(),
    [
      "CROSS_PACKAGE_RELATIVE_IMPORT",
      "TSCONFIG_CROSS_PACKAGE_INCLUDE",
      "UNDECLARED_BARE_DEPENDENCY"
    ]
  );
  assert.deepEqual(checked.staleBaselineFingerprints, ["stale-baseline-fingerprint"]);
});
