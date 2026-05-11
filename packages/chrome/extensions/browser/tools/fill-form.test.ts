import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerFillForm } from "./fill-form.js";
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
  registerFillForm(pi);
  if (!captured) throw new Error("registerFillForm did not register a tool");
  return captured;
}

function parseResult(res: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("fill_form", () => {
  let bin: MockBinary;
  let logDir: string;
  let logPath: string;

  beforeAll(() => {
    bin = makeMockBinary();
    logDir = mkdtempSync(join(tmpdir(), "pi-chrome-fflog-"));
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

  it("opens, fills each field, clicks submit, waits — in order", async () => {
    const tool = makeTool();
    const res = await tool.execute("1", {
      url: "https://example.com/login",
      fields: { "@e7": "user@example.com", "@e8": "secret" },
      submit: "@e9",
      waitFor: "#welcome",
    });

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.steps.map((s: { kind: string }) => s.kind)).toEqual([
      "open", "fill", "fill", "click", "wait",
    ]);
    expect(data.failedAt).toBeUndefined();

    const calls = readCalls();
    expect(calls).toEqual([
      ["open", "https://example.com/login"],
      ["fill", "@e7", "user@example.com"],
      ["fill", "@e8", "secret"],
      ["click", "@e9"],
      ["wait", "#welcome"],
    ]);
  });

  it("stops at first failing step", async () => {
    process.env.MOCK_FILL_EXIT = "1";
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { "@e7": "x", "@e8": "y" },
      submit: "@e9",
      timeoutMs: 8000,
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.failedAt).toBe(1); // first fill (after open)
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]).toMatchObject({ kind: "open", ok: true });
    expect(data.steps[1]).toMatchObject({ kind: "fill", ok: false, exitCode: 1 });

    // 1 retry × (open + fill) = 2 attempts each, no click/wait
    const calls = readCalls();
    expect(calls.some((c) => c[0] === "click")).toBe(false);
    expect(calls.some((c) => c[0] === "wait")).toBe(false);
  }, 15000);

  it("works with no submit and no waitFor", async () => {
    const tool = makeTool();
    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { "@e1": "hello" },
    });

    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.steps.map((s: { kind: string }) => s.kind)).toEqual(["open", "fill"]);
  });

  it("fails when waitFor times out (wait command non-zero)", async () => {
    process.env.MOCK_WAIT_EXIT = "3";
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { "@e1": "hello" },
      submit: "@e2",
      waitFor: "#notgonna",
      timeoutMs: 8000,
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.steps.at(-1)).toMatchObject({ kind: "wait", ok: false, exitCode: 3 });
  }, 15000);
});
