/**
 * Tests for spawn-pi.
 *
 * Two layers:
 *   1. extractTokensFromStream — pure function, fed canned event streams.
 *   2. spawnPi end-to-end — drives a fake pi binary (a shell script that emits
 *      canned JSON events) so we exercise child_process + stream parsing
 *      without depending on a real pi installation or paying for API calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTokensFromStream, spawnPi } from "./spawn-pi.js";

// --- extractTokensFromStream ---

describe("extractTokensFromStream", () => {
  it("returns null on empty input", () => {
    expect(extractTokensFromStream("")).toBeNull();
  });

  it("returns null when no agent_end event present", () => {
    const stream = '{"type":"session"}\n{"type":"agent_start"}\n';
    expect(extractTokensFromStream(stream)).toBeNull();
  });

  it("returns null when agent_end has no assistant message with usage", () => {
    const stream = '{"type":"agent_end","messages":[{"role":"user","content":"hi"}]}';
    expect(extractTokensFromStream(stream)).toBeNull();
  });

  it("extracts usage from a single agent_end event", () => {
    const event = {
      type: "agent_end",
      messages: [
        { role: "assistant", usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 300, totalTokens: 650, cost: { total: 0.001 } } },
      ],
    };
    expect(extractTokensFromStream(JSON.stringify(event))).toEqual({
      input: 100, output: 50, cacheRead: 200, cacheWrite: 300, totalTokens: 650, costUsd: 0.001,
    });
  });

  it("uses the LAST agent_end's last assistant usage when multiple events present", () => {
    const e1 = { type: "agent_end", messages: [{ role: "assistant", usage: { totalTokens: 100 } }] };
    const e2 = { type: "agent_end", messages: [{ role: "assistant", usage: { totalTokens: 200 } }] };
    const stream = JSON.stringify(e1) + "\n" + JSON.stringify(e2);
    expect(extractTokensFromStream(stream)?.totalTokens).toBe(200);
  });

  it("ignores malformed JSON lines without crashing", () => {
    const valid = { type: "agent_end", messages: [{ role: "assistant", usage: { totalTokens: 50 } }] };
    const stream = "garbage line {not json\n" + JSON.stringify(valid) + "\nmore garbage";
    expect(extractTokensFromStream(stream)?.totalTokens).toBe(50);
  });

  it("zero-fills missing usage fields", () => {
    const event = { type: "agent_end", messages: [{ role: "assistant", usage: {} }] };
    expect(extractTokensFromStream(JSON.stringify(event))).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0,
    });
  });
});

// --- spawnPi (fake-pi backend) ---

const FAKE_PI_OK = `#!/usr/bin/env bash
echo '{"type":"session","id":"test"}'
echo '{"type":"agent_start"}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" World"}}'
echo '{"type":"agent_end","messages":[{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.0001}}}]}'
`;

const FAKE_PI_NONZERO = `#!/usr/bin/env bash
echo '{"type":"session","id":"x"}'
exit 42
`;

const FAKE_PI_HANG = `#!/usr/bin/env bash
sleep 10
`;

describe("spawnPi (fake-pi)", () => {
  let tmp: string;
  let originalPiBin: string | undefined;

  function installFakePi(content: string): string {
    const path = join(tmp, "fake-pi");
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-utils-spawn-"));
    originalPiBin = process.env.PI_BIN;
  });

  afterEach(() => {
    if (originalPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = originalPiBin;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("calls onStdout with text_delta deltas only (not raw JSON events)", async () => {
    process.env.PI_BIN = installFakePi(FAKE_PI_OK);

    const chunks: string[] = [];
    const result = await spawnPi({ cwd: tmp, args: ["test"], onStdout: (t) => chunks.push(t), timeoutMs: 5000 });

    expect(result.code).toBe(0);
    const text = chunks.join("");
    expect(text).toBe("Hello World");
    expect(text).not.toContain("{");
    expect(text).not.toContain("agent_start");
  });

  it("extracts tokens from agent_end (pipe mode)", async () => {
    process.env.PI_BIN = installFakePi(FAKE_PI_OK);
    const result = await spawnPi({ cwd: tmp, args: ["test"], timeoutMs: 5000 });
    expect(result.tokens).toEqual({
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costUsd: 0.0001,
    });
  });

  it("writes raw JSON to stdoutFile and extracts tokens from it", async () => {
    process.env.PI_BIN = installFakePi(FAKE_PI_OK);
    const logFile = join(tmp, "out.log");

    const result = await spawnPi({ cwd: tmp, args: ["test"], stdoutFile: logFile, timeoutMs: 5000 });

    expect(result.tokens?.totalTokens).toBe(15);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain('"type":"agent_end"');
    expect(log).toContain('"text_delta"');
  });

  it("propagates non-zero exit code, tokens undefined when no agent_end emitted", async () => {
    process.env.PI_BIN = installFakePi(FAKE_PI_NONZERO);
    const result = await spawnPi({ cwd: tmp, args: ["test"], timeoutMs: 5000 });
    expect(result.code).toBe(42);
    expect(result.tokens).toBeUndefined();
  });

  it("kills the child on timeout and reports killed=true", async () => {
    process.env.PI_BIN = installFakePi(FAKE_PI_HANG);
    const result = await spawnPi({ cwd: tmp, args: ["test"], timeoutMs: 200 });
    expect(result.killed).toBe(true);
  });

  it("injects --mode json into args when caller didn't supply --mode", async () => {
    // Fake pi that reports its own argv so we can inspect what was passed.
    const argDumper = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${join(tmp, "argv")}"
`;
    process.env.PI_BIN = installFakePi(argDumper);
    await spawnPi({ cwd: tmp, args: ["-p", "hello"], timeoutMs: 5000 });
    const argv = readFileSync(join(tmp, "argv"), "utf-8").split("\n").filter(Boolean);
    expect(argv).toEqual(["--mode", "json", "-p", "hello"]);
  });

  it("does NOT re-inject --mode json when caller already specified --mode", async () => {
    const argDumper = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${join(tmp, "argv")}"
`;
    process.env.PI_BIN = installFakePi(argDumper);
    await spawnPi({ cwd: tmp, args: ["-p", "--mode", "text", "hello"], timeoutMs: 5000 });
    const argv = readFileSync(join(tmp, "argv"), "utf-8").split("\n").filter(Boolean);
    expect(argv.filter((a) => a === "--mode").length).toBe(1);
    expect(argv).toContain("text");
    expect(argv).not.toContain("json");
  });
});
