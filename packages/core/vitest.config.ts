import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
