/**
 * Tests for the cron extension's pure helpers (parsing, building, validation).
 *
 * The actual crontab read/write helpers shell out and are not unit-tested here —
 * see integration tests for end-to-end install/list/remove flow.
 */

import { describe, it, expect } from "vitest";

const lib =
  (await import("../../extensions/cron/lib.js")) as typeof import("../../extensions/cron/lib.js");

describe("buildLine", () => {
  it("composes cron + command + description with marker", () => {
    const line = lib.buildLine("0 22 * * *", 'cd /repo && pi -p "x"', "daily-audit");
    expect(line).toBe('0 22 * * * cd /repo && pi -p "x" # pi-mind: daily-audit');
  });

  it("trims surrounding whitespace from each field", () => {
    const line = lib.buildLine("  0 22 * * *  ", "  cmd  ", "  desc  ");
    expect(line).toBe("0 22 * * * cmd # pi-mind: desc");
  });

  it("collapses internal whitespace in description", () => {
    const line = lib.buildLine("0 22 * * *", "cmd", "my\n\nlong  description");
    expect(line).toBe("0 22 * * * cmd # pi-mind: my long description");
  });
});

describe("parseEntries", () => {
  it("returns [] for empty crontab", () => {
    expect(lib.parseEntries("")).toEqual([]);
  });

  it("ignores user lines without the pi-mind marker", () => {
    const content = `0 0 * * * /usr/bin/backup
30 8 * * 1 /usr/bin/weekly`;
    expect(lib.parseEntries(content)).toEqual([]);
  });

  it("extracts cron / command / description from a marked line", () => {
    const content = '0 22 * * * cd /repo && pi -p "x" # pi-mind: daily-audit';
    const entries = lib.parseEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].cron).toBe("0 22 * * *");
    expect(entries[0].command).toBe('cd /repo && pi -p "x"');
    expect(entries[0].description).toBe("daily-audit");
  });

  it("preserves multi-word commands", () => {
    const content = '0 9 * * 1 cd /a && cmd1 | cmd2 >> log 2>&1 # pi-mind: chain';
    const entries = lib.parseEntries(content);
    expect(entries[0].command).toBe("cd /a && cmd1 | cmd2 >> log 2>&1");
  });

  it("handles multiple marked entries mixed with user lines", () => {
    const content = `# user comment
0 0 * * * user-job
0 22 * * * cmd1 # pi-mind: audit
0 2 * * * cmd2 # pi-mind: lint
30 8 * * 1 user-weekly`;
    const entries = lib.parseEntries(content);
    expect(entries.map((e) => e.description)).toEqual(["audit", "lint"]);
  });

  it("skips malformed marked lines (fewer than 5 cron fields)", () => {
    const content = "broken # pi-mind: x";
    expect(lib.parseEntries(content)).toEqual([]);
  });
});

describe("isPiMindEntry", () => {
  it("detects the marker", () => {
    expect(lib.isPiMindEntry("0 0 * * * cmd # pi-mind: x")).toBe(true);
  });

  it("returns false for unmarked lines", () => {
    expect(lib.isPiMindEntry("0 0 * * * cmd")).toBe(false);
    expect(lib.isPiMindEntry("# user comment")).toBe(false);
  });
});

describe("isValidCronExpression", () => {
  it("accepts standard 5-field expressions", () => {
    expect(lib.isValidCronExpression("0 22 * * *")).toBe(true);
    expect(lib.isValidCronExpression("*/15 * * * *")).toBe(true);
    expect(lib.isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(lib.isValidCronExpression("0,30 * * * *")).toBe(true);
  });

  it("rejects expressions with wrong field count", () => {
    expect(lib.isValidCronExpression("0 22 * *")).toBe(false);
    expect(lib.isValidCronExpression("0 22 * * * *")).toBe(false);
    expect(lib.isValidCronExpression("")).toBe(false);
  });

  it("rejects expressions with disallowed characters", () => {
    expect(lib.isValidCronExpression("0 22 * * a")).toBe(false);
    expect(lib.isValidCronExpression("0 22 * * @")).toBe(false);
  });
});
