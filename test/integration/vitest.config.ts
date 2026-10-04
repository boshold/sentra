import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      "@bosdev/sentra-core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["packages/*/src/**"],
      exclude: ["packages/cli/src/cli.ts"],
    },
  },
});
