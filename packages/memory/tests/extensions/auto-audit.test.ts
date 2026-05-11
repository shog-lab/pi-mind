/**
 * Tests for self-evolution startup hook (auto-audit).
 *
 * Pure helpers: marker read/write/threshold + notice rendering.
 * The actual `before_agent_start` integration is observed via the running pi
 * — not unit-testable without spinning up the full extension.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const aa =
  (await import("../../extensions/memory/auto-audit.js")) as typeof import("../../extensions/memory/auto-audit.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-audit-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getAuditStatus", () => {
  it("flags overdue when no marker exists", () => {
    const status = aa.getAuditStatus(tmpDir);
    expect(status.overdue).toBe(true);
    expect(status.hoursSinceLast).toBeNull();
  });

  it("flags overdue when last run was > 24h ago", () => {
    aa.markAuditDone(tmpDir);
    const fakeNow = Date.now() + 25 * 3600_000;
    const status = aa.getAuditStatus(tmpDir, fakeNow);
    expect(status.overdue).toBe(true);
    expect(status.hoursSinceLast).toBeGreaterThanOrEqual(25);
  });

  it("not overdue when last run was within 24h", () => {
    aa.markAuditDone(tmpDir);
    const fakeNow = Date.now() + 12 * 3600_000;
    const status = aa.getAuditStatus(tmpDir, fakeNow);
    expect(status.overdue).toBe(false);
  });

  it("preserves last summary across reads", () => {
    aa.markAuditDone(tmpDir, "3 lint warnings, 2 archived compactions");
    const status = aa.getAuditStatus(tmpDir);
    expect(status.lastSummary).toBe("3 lint warnings, 2 archived compactions");
  });

  it("handles corrupted marker gracefully (treats as never run)", () => {
    const markerDir = path.join(tmpDir, "episodic", "maintenance-log");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "last-audit.json"), "this is not json");
    const status = aa.getAuditStatus(tmpDir);
    expect(status.overdue).toBe(true);
    expect(status.hoursSinceLast).toBeNull();
  });
});

describe("markAuditDone", () => {
  it("creates marker file with current timestamp", () => {
    const before = Date.now();
    aa.markAuditDone(tmpDir);
    const after = Date.now();
    const status = aa.getAuditStatus(tmpDir);
    expect(status.overdue).toBe(false);
    expect(status.hoursSinceLast).toBeGreaterThanOrEqual(0);
    expect(status.hoursSinceLast).toBeLessThan((after - before + 1000) / 3600_000);
  });

  it("creates parent directory if missing", () => {
    expect(fs.existsSync(path.join(tmpDir, "episodic"))).toBe(false);
    aa.markAuditDone(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, "episodic", "maintenance-log", "last-audit.json"))).toBe(true);
  });

  it("truncates very long summary to 500 chars", () => {
    const longSummary = "a".repeat(1000);
    aa.markAuditDone(tmpDir, longSummary);
    const status = aa.getAuditStatus(tmpDir);
    expect(status.lastSummary?.length).toBe(500);
  });
});

describe("renderAuditNotice", () => {
  it("returns null when not overdue", () => {
    const notice = aa.renderAuditNotice({ overdue: false, hoursSinceLast: 5 });
    expect(notice).toBeNull();
  });

  it("renders 'never run' message when no prior audit", () => {
    const notice = aa.renderAuditNotice({ overdue: true, hoursSinceLast: null });
    expect(notice).toContain("<self-evolution>");
    expect(notice).toContain("never run");
    expect(notice).toContain("daily-audit skill");
    expect(notice).toContain("mark_daily_audit_complete");
  });

  it("renders elapsed-hours message when overdue", () => {
    const notice = aa.renderAuditNotice({ overdue: true, hoursSinceLast: 36 });
    expect(notice).toContain("36h ago");
    expect(notice).toContain("overdue");
  });

  it("includes last summary if provided", () => {
    const notice = aa.renderAuditNotice({
      overdue: true,
      hoursSinceLast: 30,
      lastSummary: "all clean, 1 stale reference",
    });
    expect(notice).toContain("all clean, 1 stale reference");
  });
});
