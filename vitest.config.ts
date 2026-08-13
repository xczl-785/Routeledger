import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    // Canonical JSON workflow tests are filesystem-heavy on Windows. Capping
    // file workers prevents unrelated suites from pushing valid operations
    // past the per-test timeout while preserving parallel execution.
    maxWorkers: 4,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/testing/**",
        "packages/*/src/bin.ts",
        "packages/*/src/**/index.ts"
      ]
    }
  }
});
