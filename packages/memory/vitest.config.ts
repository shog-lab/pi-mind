import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // Tests mutate process.env and reset ESM modules to isolate extension
    // module-level state; forks avoid cross-file state bleed in Vitest's
    // default worker pool.
    pool: "forks",
  },
});
