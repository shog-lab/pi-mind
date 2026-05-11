import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerTestPage } from "./test-page.js";
import { clearMockEnv, makeMockBinary, type MockBinary } from "./__test-helpers__/mock-binary.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: true;
  }>;
}

function makeTool(): CapturedTool {
  let captured: CapturedTool | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi: any = { registerTool: (o: CapturedTool) => { captured = o; } };
  registerTestPage(pi);
  if (!captured) throw new Error("registerTestPage did not register a tool");
  return captured;
}

function parseResult(res: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("test_page", () => {
  let bin: MockBinary;
  let logDir: string;
  let logPath: string;

  beforeAll(() => {
    bin = makeMockBinary();
    logDir = mkdtempSync(join(tmpdir(), "pi-chrome-tplog-"));
  });
  afterAll(() => {
    bin.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.AGENT_BROWSER_BIN = bin.path;
    logPath = join(logDir, `log-${Date.now()}-${Math.random()}.txt`);
    process.env.MOCK_LOG = logPath;
  });
  afterEach(() => clearMockEnv());

  function readCalls(): string[][] {
    try {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  it("calls open then snapshot and passes when expects all present", async () => {
    process.env.MOCK_SNAPSHOT_TEXT =
      '- heading "Example Domain" [level=1, ref=e1]\n- link "Learn more" [ref=e2]\n';
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      expects: ["Example Domain", "Learn more"],
    });

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.missing).toEqual([]);
    expect(data.exitCode).toBe(0);

    const calls = readCalls();
    expect(calls[0]).toEqual(["open", "https://example.com"]);
    expect(calls[1]).toEqual(["snapshot"]);
  });

  it("fails with missing list when expects are absent", async () => {
    process.env.MOCK_SNAPSHOT_TEXT = '- heading "Example Domain" [ref=e1]\n';
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      expects: ["Example Domain", "Nonexistent"],
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.missing).toEqual(["Nonexistent"]);
  });

  it("does not call snapshot when open fails", async () => {
    process.env.MOCK_OPEN_EXIT = "1";
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://broken.example",
      expects: ["anything"],
      timeoutMs: 8000,
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.exitCode).toBe(1);

    const calls = readCalls();
    // 3 retries × 1 open call each = 3 opens, 0 snapshots
    expect(calls.every((c) => c[0] === "open")).toBe(true);
  }, 15000);

  it("fails when snapshot exits non-zero", async () => {
    process.env.MOCK_SNAPSHOT_EXIT = "2";
    process.env.MOCK_SNAPSHOT_TEXT = "";
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      expects: ["whatever"],
      timeoutMs: 8000,
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.exitCode).toBe(2);
  }, 15000);
});
