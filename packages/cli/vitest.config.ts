import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@bosdev/sentra-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "cli",
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
