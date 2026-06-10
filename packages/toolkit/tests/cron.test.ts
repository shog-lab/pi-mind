/**
 * Tests for the cron extension.
 *
 * Strategy: import the extension default export, capture tools via a fake pi
 * ExtensionAPI stub, then invoke tool.execute() directly. Mock execSync so
 * launchctl never actually runs. Redirect PI_MIND_DIR and HOME to tmp dirs
 * so the test can't pollute the real filesystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execSync so launchctl load/unload never actually runs. Capture calls
// so tests can assert on them.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

// Set env vars BEFORE importing the extension so any module-load-time path
// resolution sees the right values. resolvePiMindDir() reads PI_MIND_DIR at
// function call time, so this is mostly for the triggerScriptPath() call
// inside the extension body.
let piMindDir: string;
let fakeHome: string;
let prevPiMind: string | undefined;
let prevHome: string | undefined;
let prevAgentName: string | undefined;
let tools: Map<string, any>;
let execSyncMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  piMindDir = mkdtempSync(join(tmpdir(), "cron-pi-mind-"));
  fakeHome = mkdtempSync(join(tmpdir(), "cron-home-"));
  prevPiMind = process.env.PI_MIND_DIR;
  prevHome = process.env.HOME;
  prevAgentName = process.env.PI_AGENT_NAME;
  process.env.PI_MIND_DIR = piMindDir;
  process.env.HOME = fakeHome;
  process.env.PI_AGENT_NAME = "alice";

  // Import fresh per-test so module-level state (if any) is reset. We import
  // the child_process mock here so we can capture the spy and assert on it.
  const cp = await import("node:child_process");
  execSyncMock = cp.execSync as unknown as ReturnType<typeof vi.fn>;
  execSyncMock.mockClear();

  const cronMod = await import("../extensions/cron/index.js");
  tools = new Map();
  const fakePi = {
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
  };
  (cronMod.default as any)(fakePi);
});

afterEach(() => {
  if (prevPiMind === undefined) delete process.env.PI_MIND_DIR;
  else process.env.PI_MIND_DIR = prevPiMind;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAgentName === undefined) delete process.env.PI_AGENT_NAME;
  else process.env.PI_AGENT_NAME = prevAgentName;
  if (piMindDir) rmSync(piMindDir, { recursive: true, force: true });
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

describe("cron extension", () => {
  it("registers 3 tools", () => {
    expect(tools.has("schedule_cron")).toBe(true);
    expect(tools.has("list_cron")).toBe(true);
    expect(tools.has("remove_cron")).toBe(true);
  });

  describe("schedule_cron", () => {
    it("returns confirmation prompt on first call (no confirm)", async () => {
      const tool = tools.get("schedule_cron");
      const result = await tool.execute(
        "tc-1",
        { cron_expr: "0 9 * * *", message: "good morning" },
        undefined,
        undefined,
        undefined,
      );
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      // Should contain the parsed time + message + a "Confirm" prompt.
      expect(text).toMatch(/every day at 09:00/);
      expect(text).toMatch(/good morning/);
      expect(text).toMatch(/Confirm/i);
      // Should NOT have called launchctl yet (gate). findNodeBin() does call
      // execSync("which node") at extension load, so we only assert that
      // launchctl specifically was not invoked.
      const calls1 = execSyncMock.mock.calls.map((c: any[]) => c[0]);
      expect(calls1.some((c: string) => String(c).includes("launchctl"))).toBe(false);
      // jobs.json should not exist yet.
      expect(existsSync(join(piMindDir, "cron", "jobs.json"))).toBe(false);
    });

    it("creates a job when confirm=true", async () => {
      const tool = tools.get("schedule_cron");
      const result = await tool.execute(
        "tc-2",
        { cron_expr: "30 14 * * 1", message: "weekly check", confirm: true },
        undefined,
        undefined,
        undefined,
      );
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toMatch(/Cron job created/);
      expect(text).toMatch(/cron-\d+-[a-z0-9]+/);

      // execSync should have been called with launchctl load
      expect(execSyncMock).toHaveBeenCalled();
      const calls = execSyncMock.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((c: string) => c.includes("launchctl load"))).toBe(true);

      // jobs.json should now contain the job
      const jobs = JSON.parse(readFileSync(join(piMindDir, "cron", "jobs.json"), "utf-8"));
      expect(jobs).toHaveLength(1);
      expect(jobs[0].cron_expr).toBe("30 14 * * 1");
      expect(jobs[0].message).toBe("weekly check");
      expect(jobs[0].target).toBe("alice");
      expect(jobs[0].plist_path).toContain("Library/LaunchAgents/com.pi-mind.cron.");

      // Plist file should exist
      expect(existsSync(jobs[0].plist_path)).toBe(true);
    });

    it("rejects unsupported cron expression (steps)", async () => {
      const tool = tools.get("schedule_cron");
      const result = await tool.execute(
        "tc-3",
        { cron_expr: "*/15 * * * *", message: "x", confirm: true },
        undefined,
        undefined,
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid cron expression/);
      const calls2 = execSyncMock.mock.calls.map((c: any[]) => c[0]);
      expect(calls2.some((c: string) => String(c).includes("launchctl"))).toBe(false);
    });

    it("rejects wrong number of fields", async () => {
      const tool = tools.get("schedule_cron");
      const result = await tool.execute(
        "tc-4",
        { cron_expr: "0 9 *", message: "x" },
        undefined,
        undefined,
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid cron expression/);
    });
  });

  describe("list_cron", () => {
    it("returns empty list when no jobs exist", async () => {
      const tool = tools.get("list_cron");
      const result = await tool.execute("tc-5", {}, undefined, undefined, undefined);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/No cron jobs registered/);
    });

    it("lists jobs after schedule_cron confirms", async () => {
      const schedule = tools.get("schedule_cron");
      const list = tools.get("list_cron");
      // Create 2 jobs
      await schedule.execute(
        "tc-6a",
        { cron_expr: "0 9 * * *", message: "morning", description: "daily 9am", confirm: true },
        undefined, undefined, undefined,
      );
      await schedule.execute(
        "tc-6b",
        { cron_expr: "0 17 * * 5", message: "friday", confirm: true },
        undefined, undefined, undefined,
      );
      const result = await list.execute("tc-6c", {}, undefined, undefined, undefined);
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("morning");
      expect(text).toContain("friday");
      expect(text).toContain("daily 9am");
      // Two job header lines ("### ✅ cron-...") and two plist path
      // references means the ID literal appears 4 times; assert exactly two
      // jobs by counting "### " headers.
      const headerCount = (text.match(/^### /gm) ?? []).length;
      expect(headerCount).toBe(2);
    });
  });

  describe("remove_cron", () => {
    it("removes a job, unloads plist, deletes from registry", async () => {
      const schedule = tools.get("schedule_cron");
      const list = tools.get("list_cron");
      const remove = tools.get("remove_cron");
      // Create
      await schedule.execute(
        "tc-7a",
        { cron_expr: "0 9 * * *", message: "x", confirm: true },
        undefined, undefined, undefined,
      );
      const jobs = JSON.parse(readFileSync(join(piMindDir, "cron", "jobs.json"), "utf-8"));
      expect(jobs).toHaveLength(1);
      const jobId = jobs[0].id;
      const plistPath = jobs[0].plist_path;
      expect(existsSync(plistPath)).toBe(true);

      execSyncMock.mockClear();

      // Remove
      const result = await remove.execute(
        "tc-7b",
        { id: jobId },
        undefined, undefined, undefined,
      );
      expect(result.isError).toBeFalsy();
      const calls = execSyncMock.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((c: string) => c.includes("launchctl unload"))).toBe(true);

      // Plist gone
      expect(existsSync(plistPath)).toBe(false);
      // jobs.json should be empty
      const jobsAfter = JSON.parse(readFileSync(join(piMindDir, "cron", "jobs.json"), "utf-8"));
      expect(jobsAfter).toHaveLength(0);
      // list_cron now empty
      const listResult = await list.execute("tc-7c", {}, undefined, undefined, undefined);
      expect(listResult.content[0].text).toMatch(/No cron jobs registered/);
    });

    it("returns error for unknown job id", async () => {
      const remove = tools.get("remove_cron");
      const result = await remove.execute(
        "tc-8",
        { id: "cron-bogus" },
        undefined, undefined, undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No cron job found/);
    });
  });
});
