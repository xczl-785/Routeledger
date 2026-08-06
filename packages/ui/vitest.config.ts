import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/ui/src/**/*.test.tsx"]
  }
});
