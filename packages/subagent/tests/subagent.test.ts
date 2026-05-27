/**
 * Tests for the subagent extension.
 *
 * Strategy: invoke the extension's factory with a mock ExtensionAPI that
 * captures the registered tool. Then exercise the tool's execute() handler
 * directly. spawnPi is exercised against a fake pi binary (PI_BIN override)
 * so we don't actually drive a real LLM call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentExtension from "../extensions/subagent/index.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: { cwd: string; prompt: string; timeout?: number }) => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function makeFakePi(content: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "subagent-pi-"));
  const path = join(tmp, "fake-pi");
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

const FAKE_PI_HELLO = `#!/usr/bin/env bash
echo '{"type":"session","id":"x"}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"sub-agent here"}}'
echo '{"type":"agent_end","messages":[{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0.0001}}}]}'
`;

function captureRegisteredTool(): { tool: RegisteredTool | null; pi: { registerTool: (t: RegisteredTool) => void } } {
  let captured: RegisteredTool | null = null;
  const pi = {
    registerTool: (t: RegisteredTool) => { captured = t; },
  };
  return {
    get tool() { return captured; },
    pi,
  } as { tool: RegisteredTool | null; pi: { registerTool: (t: RegisteredTool) => void } };
}

describe("subagent extension", () => {
  let originalPiBin: string | undefined;

  beforeEach(() => {
    originalPiBin = process.env.PI_BIN;
  });

  afterEach(() => {
    if (originalPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = originalPiBin;
  });

  it("registers a tool named spawn_subagent with parameters schema", () => {
    const cap = captureRegisteredTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subagentExtension(cap.pi as any);
    expect(cap.tool).not.toBeNull();
    expect(cap.tool!.name).toBe("spawn_subagent");
    expect(cap.tool!.label).toBe("Spawn Sub-Agent");
    // parameters is a TypeBox schema — should be a non-null object
    expect(typeof cap.tool!.parameters).toBe("object");
  });

  it("returns isError when cwd does not exist", async () => {
    const cap = captureRegisteredTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subagentExtension(cap.pi as any);
    const result = await cap.tool!.execute("call-1", {
      cwd: "/nonexistent/path/that/should/never/exist",
      prompt: "anything",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not exist/);
  });

  it("invokes pi successfully and returns its text + token details", async () => {
    process.env.PI_BIN = makeFakePi(FAKE_PI_HELLO);
    const cap = captureRegisteredTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subagentExtension(cap.pi as any);

    const tmpCwd = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
    try {
      const result = await cap.tool!.execute("call-2", {
        cwd: tmpCwd,
        prompt: "test task",
        timeout: 5,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("sub-agent here");
      // Tokens captured by spawnPi from agent_end event
      expect(result.details.tokens).toBeDefined();
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("returns timeout error when pi runs past the requested deadline", async () => {
    process.env.PI_BIN = makeFakePi(`#!/usr/bin/env bash\nsleep 10\n`);
    const cap = captureRegisteredTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subagentExtension(cap.pi as any);

    const tmpCwd = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
    try {
      // timeout=1s; fake pi sleeps 10s → must be killed by spawnPi's timeout path
      const result = await cap.tool!.execute("call-3", {
        cwd: tmpCwd,
        prompt: "will hang",
        timeout: 1,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/timed out/);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  }, 15_000);
});
