/**
 * Regression tests for knowledge-lint's handling of frontmatter `triples:`.
 *
 * Background (alice's review of KG Batch 1):
 *   Before this fix, lint's naive parseFrontmatter treated any `[...]`
 *   frontmatter value as a comma-split YAML list. For `triples:
 *   [["alice", "owns", "auth-service"]]` it would split the value into
 *   string fragments, which the triples validator then rejected with
 *   "must be an array, got string" \u2014 3 errors per valid triple. This
 *   test pins the fix.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LINT_SCRIPT = path.resolve(
  __dirname,
  "../scripts/knowledge-lint.ts",
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-lint-test-"));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/** Run the lint script and return the captured output + exit code. */
function runLint(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", LINT_SCRIPT, "--dir", tmpDir], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function writeFile(name: string, content: string) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

describe("knowledge-lint \u2014 triples parsing", () => {
  it("accepts a single valid triple without error", () => {
    writeFile(
      "single.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"]]\n---\n\nbody`,
    );
    const r = runLint();
    // Lint prints a summary even on success; assert no `triples` errors.
    expect(r.stdout).not.toMatch(/triples\[/);
    expect(r.stdout).not.toMatch(/must be an array/);
  });

  it("accepts multiple valid triples without error", () => {
    writeFile(
      "multi.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "x"], ["bob", "role", "engineer"], ["alice", "manages", "x"]]\n---\n\nbody`,
    );
    const r = runLint();
    expect(r.stdout).not.toMatch(/triples\[/);
  });

  it("rejects malformed triples with a clear error", () => {
    writeFile(
      "bad.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["a", "b"], "not-an-array", ["c", "d", "e", "f"]]\n---\n\nbody`,
    );
    const r = runLint();
    // Lint script always exits 0 (it just prints errors). Look for the
    // error banner + summary line + at least one error mentioning triples.
    expect(r.stdout).toMatch(/❌ ERRORS \(\d+\)/);
    expect(r.stdout).toMatch(/Summary: \d+ errors/);
    expect(r.stdout).toMatch(/triples\[/);
    expect(r.stdout).toContain("bad.md");
  });

  it("accepts a file with no `triples` field at all (most files)", () => {
    writeFile(
      "plain.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [foo, bar]\n---\n\nbody`,
    );
    const r = runLint();
    expect(r.stdout).not.toMatch(/triples\[/);
  });

  it("rejects whitespace-only entries (consistency with tool/schema/parser)", () => {
    writeFile(
      "whitespace.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["good", "ok", "yes"], ["  ", "blank", "x"]]\n---\n\nbody`,
    );
    const r = runLint();
    // Lint always exits 0; check stderr/stdout for the error banner.
    expect(r.stdout).toMatch(/❌ ERRORS \(\d+\)/);
    expect(r.stdout).toMatch(/non-empty|whitespace/);
  });
});
