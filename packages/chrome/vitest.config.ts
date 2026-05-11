import { defineConfig } from "vitest/config";

// Integration tests share a single agent-browser daemon and Chrome process.
// Run files sequentially when integration tests are enabled to avoid races
// (e.g., one test's afterAll close --all racing with another's beforeAll).
const integration = process.env.RUN_INTEGRATION_TESTS === "1";

export default defineConfig({
  test: {
    fileParallelism: !integration,
  },
});
