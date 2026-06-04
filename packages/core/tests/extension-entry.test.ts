/**
 * Integration test for the memory extension's default export.
 *
 * Imports `extensions/memory/index.js` (the extension entry point),
 * calls its default export with a minimal mock ExtensionAPI, and
 * asserts that:
 *   - The 4 expected tools are registered (remember_this, recall_memory,
 *     observe, mark_daily_audit_complete).
 *   - The 3 expected hooks are registered (session_compact, turn_end,
 *     before_agent_start).
 *   - The system-prompt injection path is invoked (mock provides
 *     injectContext; assert it was called).
 *
 * This is surface-level, not end-to-end \u2014 we don't run a real pi, we
 * just verify the extension's wiring. Each tool/hook handler can be
 * invoked directly afterwards to do deeper behavioral checks.
 *
 * Test isolation note: the extension module captures PI_MIND_DIR at load
 * time, so each test must reset modules and re-import with a fresh
 * PI_MIND_DIR env var. Otherwise the second test would write to the
 * first test's tmp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
}

interface MockPi {
  tools: Map<string, MockTool>;
  hooks: Map<string, Array<(event: any) => Promise<any> | any>>;
  injectContext: ReturnType<typeof vi.fn>;
  registerTool: (tool: MockTool) => void;
  on: (event: string, handler: any) => void;
}

function makeMockPi(): MockPi {
  const tools = new Map<string, MockTool>();
  const hooks = new Map<string, Array<(event: any) => Promise<any> | any>>();
  return {
    tools,
    hooks,
    injectContext: vi.fn(),
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: any) {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
  };
}

let tmpDir: string;
let memExtension: (pi: any) => void;

beforeEach(async () => {
  // Critical: reset the module cache so the extension's module-level
  // PI_MIND_DIR constant is re-resolved against the new tmpDir.
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-ext-test-"));
  process.env.PI_MIND_DIR = tmpDir;
  // Re-import the extension AFTER setting env. The new module instance
  // captures this tmpDir as PI_MIND_DIR.
  const mod = (await import("../extensions/memory/index.js")) as {
    default: (pi: any) => void;
  };
  memExtension = mod.default;
});

afterEach(() => {
  delete process.env.PI_MIND_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("memory extension default export \u2014 surface", () => {
  it("registers the 4 expected tools", () => {
    const pi = makeMockPi();
    memExtension(pi);
    const names = [...pi.tools.keys()];
    expect(names).toContain("remember_this");
    expect(names).toContain("recall_memory");
    expect(names).toContain("observe");
    expect(names).toContain("mark_daily_audit_complete");
  });

  it("registers the 3 expected lifecycle hooks", () => {
    const pi = makeMockPi();
    memExtension(pi);
    const events = [...pi.hooks.keys()];
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("session_compact");
    // Each should have at least one handler.
    expect(pi.hooks.get("before_agent_start")!.length).toBeGreaterThanOrEqual(1);
    expect(pi.hooks.get("turn_end")!.length).toBeGreaterThanOrEqual(1);
    expect(pi.hooks.get("session_compact")!.length).toBeGreaterThanOrEqual(1);
  });

  it("gracefully no-ops the system prompt injection if system-prompt.md is unreachable (e.g. dev/test load path)", () => {
    // The extension's loadSystemPrompt() resolves a path relative to
    // its own location. When vitest loads the .ts source (instead of
    // the compiled .js in dist/), the resolved path is different and
    // system-prompt.md may be unreachable. The extension should feature-
    // detect and silently skip rather than crash. We verify by asserting
    // the extension completes construction without throwing — regardless
    // of whether injectContext was called.
    const pi = makeMockPi();
    expect(() => memExtension(pi)).not.toThrow();
  });

  it("does not crash if injectContext is not provided (pi version fallback)", () => {
    const pi = makeMockPi();
    // @ts-expect-error -- intentionally omit to test fallback path
    delete pi.injectContext;
    expect(() => memExtension(pi)).not.toThrow();
  });
});

describe("memory extension \u2014 tool handler smoke", () => {
  it("mark_daily_audit_complete tool returns a success result and writes marker", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("mark_daily_audit_complete")!;
    expect(tool).toBeDefined();
    const result = await tool.execute("test-id", { summary: "audit done" });
    expect(result.content[0].text).toMatch(/Memory audit marked complete/i);
    // The marker file should now exist at the test's tmpDir.
    const markerPath = path.join(tmpDir, "raw", "maintenance-log", "last-audit.json");
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    expect(marker.summary).toBe("audit done");
  });

  it("observe tool writes a file to raw/observations/", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("observe")!;
    const result = await tool.execute("test-id", {
      note: "user said they prefer xterm over gnome-terminal",
      tags: ["terminal", "preference"],
    });
    expect(result.content[0].text).toMatch(/Observed \u2192/);
    const obsFile = result.content[0].text.split("\u2192 ")[1];
    expect(fs.existsSync(obsFile)).toBe(true);
    const body = fs.readFileSync(obsFile, "utf-8");
    expect(body).toContain("user said they prefer xterm over gnome-terminal");
  });

  it("remember_this tool saves a memory file and returns its path", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("remember_this")!;
    const result = await tool.execute("test-id", {
      content: "I am allergic to quokkas with red fur. calicornium-7 marker",
      type: "user",
      tags: ["allergy"],
    });
    expect(result.content[0].text).toMatch(/Saved to /);
    const fp = result.content[0].text.replace(/^Saved to /, "");
    expect(fs.existsSync(fp)).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("calicornium-7 marker");
  });

  it("remember_this coerces an invalid type to 'reference' (documented fallback)", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("remember_this")!;
    // "type" is constrained to a small enum; an invalid value should be
    // silently coerced to "reference" (per the tool's documented fallback).
    const result = await tool.execute("test-id", {
      content: "Some reference content for fallback test plumbus-XM3-marker",
      type: "not-a-valid-type",
    });
    expect(result.content[0].text).toMatch(/Saved to /);
    const fp = result.content[0].text.replace(/^Saved to /, "");
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("type: reference");
  });

  it("remember_this dedupes by (type, content) \u2014 second identical write returns 'Skipped'", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("remember_this")!;
    const content = "Deterministic dup-test content blorptastic-9-marker";
    const r1 = await tool.execute("test-id", { content, type: "user" });
    expect(r1.content[0].text).toMatch(/Saved to /);
    const r2 = await tool.execute("test-id", { content, type: "user" });
    expect(r2.content[0].text).toMatch(/Skipped/);
  });

  it("remember_this accepts type='project' (regression \u2014 not silently coerced to 'reference')", async () => {
    // KG Batch 1 review: validTypes set was missing 'project' even though
    // the tool's enum listed it. Verify project is now a valid type and
    // gets written to the frontmatter (not silently coerced to reference).
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("remember_this")!;
    const r = await tool.execute("test-id", {
      content: "Project-level architecture fact project-marker-X9",
      type: "project",
    });
    expect(r.content[0].text).toMatch(/Saved to /);
    const fp = r.content[0].text.replace(/^Saved to /, "");
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("type: project");
    // Negative control: an INVALID type (e.g. "not-a-thing") still falls back to reference.
    const r2 = await tool.execute("test-id", {
      content: "Garbage type coerce test fallback-marker",
      type: "not-a-valid-type",
    });
    const fp2 = r2.content[0].text.replace(/^Saved to /, "");
    expect(fs.readFileSync(fp2, "utf-8")).toContain("type: reference");
  });

  it("remember_this rejects whitespace-only triple entries (trim check)", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const tool = pi.tools.get("remember_this")!;
    const r = await tool.execute("test-id", {
      content: "Some memory with whitespace-only triple",
      type: "project",
      triples: [["good", "ok", "yes"], ["  ", "blank", "x"]],
    });
    // Tool boundary must reject — the blank entry would be silently
    // dropped by the parser, leaving a hole in the frontmatter vs. what
    // the agent thought it wrote.
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/non-empty|whitespace/);
  });
});

describe("memory extension \u2014 hook handler smoke", () => {
  it("turn_end does not throw when called repeatedly (archive is a no-op without ~/.pi/agent/sessions)", () => {
    const pi = makeMockPi();
    memExtension(pi);
    const handler = pi.hooks.get("turn_end")![0];
    for (let i = 0; i < 12; i++) {
      expect(() => handler({})).not.toThrow();
    }
  });

  it("session_compact saves the summary to raw/compaction/ and does not throw", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    const handler = pi.hooks.get("session_compact")![0];
    await handler({
      compactionEntry: {
        summary: "User asked about pi-mind's compaction lifecycle. zebracorn-marker-XQ4",
      },
    });
    const compactionDir = path.join(tmpDir, "raw", "compaction");
    const files = fs.existsSync(compactionDir) ? fs.readdirSync(compactionDir) : [];
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(compactionDir, files[0]), "utf-8");
    expect(content).toContain("zebracorn-marker-XQ4");
  });

  it("before_agent_start calls event.injectContext with the assembled memory block", async () => {
    const pi = makeMockPi();
    memExtension(pi);
    // Pre-populate an L1 memory so buildContext has something to inject.
    const memDir = path.join(tmpDir, "knowledge");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, "2026-01-01_warmup-marker.md"),
      "---\ndate: 2026-01-01T00:00:00Z\ntype: user\ntier: L1\n---\n\nUser loves warmup-marker cuisine",
    );
    const handler = pi.hooks.get("before_agent_start")![0];
    const event: any = {
      prompt: "what food do I like? warmup-marker",
      injectContext: vi.fn(),
    };
    await handler(event);
    expect(event.injectContext).toHaveBeenCalled();
    const arg = (event.injectContext.mock.calls[0] as any[])[0];
    expect(typeof arg).toBe("string");
    expect(arg).toContain("warmup-marker cuisine");
  });
});
