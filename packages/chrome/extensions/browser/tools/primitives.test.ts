import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  registerClick,
  registerCurrentUrl,
  registerFill,
  registerLook,
  registerNav,
} from "./primitives.js";
import { clearMockEnv, makeMockBinary, type MockBinary } from "./__test-helpers__/mock-binary.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: true;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTool(register: (pi: any) => void): CapturedTool {
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

describe("co-pilot primitives", () => {
  let bin: MockBinary;
  let logDir: string;
  let logPath: string;

  beforeAll(() => {
    bin = makeMockBinary();
    logDir = mkdtempSync(join(tmpdir(), "pi-chrome-prim-"));
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
      return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  it("look calls `snapshot -i` by default", async () => {
    process.env.MOCK_SNAPSHOT_TEXT = '- heading "Title" [ref=e1]\n';
    const tool = makeTool(registerLook);

    const res = await tool.execute("1", {});
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.snapshot).toContain("[ref=e1]");
    expect(readCalls()[0]).toEqual(["snapshot", "-i"]);
  });

  it("look respects interactive=false and selector", async () => {
    process.env.MOCK_SNAPSHOT_TEXT = "- root\n";
    const tool = makeTool(registerLook);

    await tool.execute("1", { interactive: false, selector: "#main" });
    expect(readCalls()[0]).toEqual(["snapshot", "-s", "#main"]);
  });

  it("current_url returns trimmed stdout from `get url`", async () => {
    process.env.MOCK_GET_URL = "https://app.example/dashboard";
    const tool = makeTool(registerCurrentUrl);

    const res = await tool.execute("1", {});
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.url).toBe("https://app.example/dashboard");
    expect(readCalls()[0]).toEqual(["get", "url"]);
  });

  it("nav calls `open <url>` and reports passed", async () => {
    const tool = makeTool(registerNav);

    const res = await tool.execute("1", { url: "https://example.com/x" });
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.url).toBe("https://example.com/x");
    expect(readCalls()[0]).toEqual(["open", "https://example.com/x"]);
  });

  it("click forwards the ref verbatim", async () => {
    const tool = makeTool(registerClick);

    const res = await tool.execute("1", { ref: "@e7" });
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(readCalls()[0]).toEqual(["click", "@e7"]);
  });

  it("click fails with isError when CLI exits non-zero", async () => {
    process.env.MOCK_CLICK_EXIT = "1";
    const tool = makeTool(registerClick);

    const res = await tool.execute("1", { ref: "@e99" });
    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.passed).toBe(false);
    expect(data.exitCode).toBe(1);
  });

  it("fill passes ref + value to CLI", async () => {
    const tool = makeTool(registerFill);

    const res = await tool.execute("1", { ref: "@e3", value: "user@example.com" });
    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.passed).toBe(true);
    expect(data.ref).toBe("@e3");
    expect(data.value).toBe("user@example.com");
    expect(readCalls()[0]).toEqual(["fill", "@e3", "user@example.com"]);
  });
});
