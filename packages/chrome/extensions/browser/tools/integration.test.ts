/**
 * Integration smoke tests against the real `agent-browser` CLI + Chrome.
 *
 * Skipped by default. Enable with:
 *
 *   RUN_INTEGRATION_TESTS=1 npm test
 *
 * Requires:
 *   - `node_modules/.bin/agent-browser` (installed via the package's deps)
 *   - a working Chrome installation that agent-browser can launch
 *   - network access to https://example.com
 *
 * These tests confirm the assumptions our mock binary encodes (CLI subcommand
 * names, snapshot JSON shape) match real behavior. If a release of
 * agent-browser changes the wire format, the unit tests stay green but these
 * will catch it.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerScrape } from "./scrape.js";
import { registerTestPage } from "./test-page.js";

const BIN = resolve("node_modules/.bin/agent-browser");
const ENABLED = process.env.RUN_INTEGRATION_TESTS === "1" && existsSync(BIN);
const integrationDescribe = ENABLED ? describe : describe.skip;

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: true;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capture(register: (pi: any) => void): CapturedTool {
  let captured: CapturedTool | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi: any = { registerTool: (o: CapturedTool) => { captured = o; } };
  register(pi);
  if (!captured) throw new Error("tool did not register");
  return captured;
}

function parseResult(res: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

integrationDescribe("integration: real agent-browser against example.com", () => {
  beforeAll(() => {
    process.env.AGENT_BROWSER_BIN = BIN;
  });
  afterAll(() => {
    try {
      execSync(`${BIN} close --all`, { stdio: "ignore", timeout: 10000 });
    } catch {
      // best-effort
    }
    delete process.env.AGENT_BROWSER_BIN;
  });

  it("test_page asserts expected substrings on example.com", async () => {
    const tool = capture(registerTestPage);
    const res = await tool.execute("1", {
      url: "https://example.com",
      expects: ["Example Domain", "Learn more"],
      timeoutMs: 60000,
    });
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.missing).toEqual([]);
  }, 90000);

  it("scrape extracts heading + link by role on example.com", async () => {
    const tool = capture(registerScrape);
    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: {
        title: { role: "heading" },
        learn: { role: "link" },
      },
      timeoutMs: 60000,
    });
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.fields.title.ref).toMatch(/^@e\d+$/);
    expect(data.fields.title.value).toBe("Example Domain");
    expect(data.fields.learn.ref).toMatch(/^@e\d+$/);
    expect(data.fields.learn.value).toBe("Learn more");
    expect(data.pages).toBe(1);
  }, 90000);
});

if (!ENABLED) {
  describe.skip("integration tests skipped", () => {
    it("set RUN_INTEGRATION_TESTS=1 to enable", () => {});
  });
}
