import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
