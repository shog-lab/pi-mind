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
import { execSync, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
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

// =============================================================================
// --rebuild-kg mode
//
// Dry-run = scan-only, never touches the DB. Output must agree with what the
// apply path would actually ingest (modulo the index.md filter, which both
// runLint and rebuildKGFromFiles effectively skip because auto-generated
// index.md has no frontmatter).
// Apply   = take withGroupLock(piMindDir, ...), wipe kg_* tables, re-derive
// from knowledge/*.md, print before/after stats. KG only — FTS / vector
// indexes are not touched.
// =============================================================================

function runRebuildKg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", LINT_SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, PI_MIND_DIR: tmpDir },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function setupKnowledgeDir() {
  fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "raw"), { recursive: true });
}

describe("knowledge-lint --rebuild-kg (dry-run)", () => {
  it("counts knowledge files, files-with-triples, and triples correctly", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"], ["bob", "role", "engineer"]]\n---\n\nbody a`,
    );
    writeFile(
      "knowledge/b.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["carol", "manages", "platform"]]\n---\n\nbody b`,
    );
    writeFile(
      "knowledge/c.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [foo]\n---\n\nbody c (no triples)`,
    );

    const r = runRebuildKg(["--rebuild-kg"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pi-mind-lint --rebuild-kg \(DRY-RUN\)/);
    expect(r.stdout).toMatch(/Knowledge files:\s+3/);
    expect(r.stdout).toMatch(/Files with triples:\s+2/);
    expect(r.stdout).toMatch(/Triples that would index:\s+3/);
  });

  it("does NOT create the index DB (purely a scan)", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["x", "r", "y"]]\n---\n\nbody`,
    );
    const dbPath = path.join(tmpDir, ".pi-mind-index.db");
    expect(fs.existsSync(dbPath)).toBe(false);

    const r = runRebuildKg(["--rebuild-kg"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("excludes index.md from the knowledge-file count (matches runLint semantics)", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["x", "r", "y"]]\n---\n\nbody`,
    );
    // Auto-generated style index.md (no frontmatter). Must not be counted.
    writeFile("knowledge/index.md", `# Wiki Index\n\nAuto-generated.\n`);

    const r = runRebuildKg(["--rebuild-kg"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Knowledge files:\s+1/);
    expect(r.stdout).toMatch(/Files with triples:\s+1/);
    expect(r.stdout).toMatch(/Triples that would index:\s+1/);
  });

  it("reports a 'not found' message when the knowledge/ dir is missing", () => {
    // No setupKnowledgeDir() call — knowledge/ does not exist.
    // Dry-run is a no-op in this case: just tell the user the dir is
    // missing. Counters are not printed (the scan never ran).
    const r = runRebuildKg(["--rebuild-kg"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Knowledge directory not found/);
    expect(r.stdout).not.toMatch(/Knowledge files:/);
  });

  it("ignores files with malformed triples when counting (they contribute 0)", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/bad.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["a", "b"], "not-an-array"]\n---\n\nbody`,
    );
    writeFile(
      "knowledge/good.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["p", "q", "r"]]\n---\n\nbody`,
    );
    const r = runRebuildKg(["--rebuild-kg"]);
    expect(r.status).toBe(0);
    // 2 .md files, only 1 has valid triples, 1 triple total
    expect(r.stdout).toMatch(/Knowledge files:\s+2/);
    expect(r.stdout).toMatch(/Files with triples:\s+1/);
    expect(r.stdout).toMatch(/Triples that would index:\s+1/);
  });
});

describe("knowledge-lint --rebuild-kg --apply", () => {
  it("wipes and re-derives kg_* from knowledge/*.md, prints before/after stats", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"]]\n---\n\nbody a`,
    );
    writeFile(
      "knowledge/b.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["bob", "role", "engineer"], ["bob", "knows", "alice"]]\n---\n\nbody b`,
    );

    const r = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pi-mind-lint --rebuild-kg \(APPLY\)/);
    expect(r.stdout).toMatch(/Before: entities=0 triples=0/);
    expect(r.stdout).toMatch(/After:  entities=4 triples=3/);
    expect(r.stdout).toMatch(/Ingested: triples=3 entities=4/);

    // The index DB now exists.
    const dbPath = path.join(tmpDir, ".pi-mind-index.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("is idempotent: a second --apply run on the same files reports identical stats", () => {
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"]]\n---\n\nbody a`,
    );

    const r1 = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r1.stdout).toMatch(/After:  entities=2 triples=1/);

    // Re-run: rebuild should yield the same end state (no drift).
    const r2 = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/Before: entities=2 triples=1/);
    expect(r2.stdout).toMatch(/After:  entities=2 triples=1/);
  });

  it("wipes stale triples that no longer match a knowledge file", () => {
    // First run: creates triples for a.md.
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"]]\n---\n\nbody a`,
    );
    runRebuildKg(["--rebuild-kg", "--apply"]);

    // Mutate: rewrite a.md to a different triple (entity "alice" no longer
    // appears in any knowledge file). The rebuild must remove the stale
    // entity AND the stale triple.
    const aPath = path.join(tmpDir, "knowledge", "a.md");
    fs.writeFileSync(
      aPath,
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["platform", "uses", "postgres"]]\n---\n\nbody a\n`,
    );

    const r = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r.status).toBe(0);
    // Before: 2 entities (alice, auth-service) + 1 triple.
    // After:  2 entities (platform, postgres) + 1 triple. alice GONE.
    expect(r.stdout).toMatch(/Before: entities=2 triples=1/);
    expect(r.stdout).toMatch(/After:  entities=2 triples=1/);

    // Re-open DB and verify "alice" no longer exists.
    const db = new Database(path.join(tmpDir, ".pi-mind-index.db"), { readonly: true });
    const aliceRow = db.prepare("SELECT id FROM kg_entities WHERE id = ?").get("alice");
    expect(aliceRow).toBeUndefined();
    const tripleRows = db.prepare("SELECT subject FROM kg_triples").all() as Array<{ subject: string }>;
    expect(tripleRows.map((r) => r.subject).sort()).toEqual(["platform"]);
    db.close();
  });

  it("rebuild on an empty knowledge dir leaves the KG empty", () => {
    setupKnowledgeDir();
    const r = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Before: entities=0 triples=0/);
    expect(r.stdout).toMatch(/After:  entities=0 triples=0/);
  });

  it("ignores knowledge/index.md even when it carries a `triples:` field", () => {
    // index.md is a system file (auto-generated by syncIndex) and must
    // not contribute to the KG regardless of frontmatter content. The
    // dry-run preview must also agree — a hand-edited or stale index.md
    // with triples: must NOT make it into either count.
    setupKnowledgeDir();
    writeFile(
      "knowledge/a.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["alice", "owns", "auth-service"]]\n---\n\nbody a`,
    );
    writeFile(
      "knowledge/index.md",
      `# Wiki Index\n\nAuto-generated.\n\n---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntriples: [["SHOULD", "be", "ignored"], ["NOPE", "nope", "nada"]]\n---\n`,
    );

    // dry-run: index.md does not bump the file/triple counts.
    const dry = runRebuildKg(["--rebuild-kg"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Knowledge files:\s+1/);
    expect(dry.stdout).toMatch(/Files with triples:\s+1/);
    expect(dry.stdout).toMatch(/Triples that would index:\s+1/);

    // apply: index.md does not contribute to the KG.
    const apply = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toMatch(/After:  entities=2 triples=1/);

    const db = new Database(path.join(tmpDir, ".pi-mind-index.db"), { readonly: true });
    const shouldRow = db.prepare("SELECT id FROM kg_entities WHERE id = ?").get("SHOULD");
    expect(shouldRow).toBeUndefined();
    const nopeRow = db.prepare("SELECT id FROM kg_entities WHERE id = ?").get("NOPE");
    expect(nopeRow).toBeUndefined();
    const triples = db.prepare("SELECT subject FROM kg_triples").all() as Array<{ subject: string }>;
    expect(triples.map((r) => r.subject).sort()).toEqual(["alice"]);
    db.close();
  });

  it("does NOT filter `fooindex.md` (basename is exact, not endsWith)", () => {
    // Regression guard: a broad `endsWith("index.md")` would silently
    // drop `fooindex.md`, `myindex.md`, etc. The filter must be an
    // exact basename match. This file has a real triple and must be
    // ingested.
    setupKnowledgeDir();
    writeFile(
      "knowledge/fooindex.md",
      `---\ndate: 2026-05-01T00:00:00Z\ntype: project\ntier: L2\ntriples: [["x", "r", "y"]]\n---\n\nbody`,
    );
    const r = runRebuildKg(["--rebuild-kg", "--apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/After:  entities=2 triples=1/);

    const db = new Database(path.join(tmpDir, ".pi-mind-index.db"), { readonly: true });
    const xRow = db.prepare("SELECT id FROM kg_entities WHERE id = ?").get("x");
    expect(xRow).toBeDefined();
    db.close();
  });
});

// =============================================================================
// PI_MIND_DIR resolution (unified across all modes)
//
// Background: pre-fix, only --rebuild-kg used git-common-dir-aware
// resolvePiMindDir. Normal lint/fix/prune used the naive
// `path.join(process.cwd(), ".pi-mind")`, so running `pi-mind-lint` from a
// workspace subdir (e.g. packages/core/) would look for
// packages/core/.pi-mind instead of the main repo's .pi-mind.
//
// These tests pin the unified behavior: env PI_MIND_DIR wins, else
// resolvePiMindDir(cwd) is used, for every mode. --dir still overrides
// the lint knowledge directory (only).
// =============================================================================

/**
 * Run the lint script from a specific cwd with a controlled env.
 * `env` entries with value `undefined` are DELETED from the spawned env
 * (so the "no PI_MIND_DIR" case is testable even when the parent runner
 * happens to have PI_MIND_DIR set).
 */
function runLintIn(
  cwd: string,
  env: Record<string, string | undefined>,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const finalEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") finalEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete finalEnv[k];
    else finalEnv[k] = v;
  }
  const r = spawnSync("npx", ["tsx", LINT_SCRIPT, ...args], {
    cwd,
    env: finalEnv,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Create a throwaway git repo with one initial commit, so resolvePiMindDir works. */
function makeGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-lint-resolve-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email test@test.invalid", { cwd: repo });
  execSync("git config user.name test", { cwd: repo });
  // Need at least one commit so `git rev-parse --git-common-dir` returns
  // a usable path (some versions return empty for a brand-new repo with
  // no commits).
  fs.writeFileSync(path.join(repo, ".gitkeep"), "");
  execSync("git add .gitkeep && git commit -q -m initial", { cwd: repo });
  return repo;
}

describe("knowledge-lint \u2014 PI_MIND_DIR resolution", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeGitRepo();
  });

  afterEach(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  it("walks up to the git repo root for .pi-mind when no PI_MIND_DIR is set", { timeout: 60_000 }, () => {
    // Root has the real .pi-mind/knowledge/sentinel.md.
    // sub/ has a decoy .pi-mind/knowledge/decoy.md that the OLD code
    // would have wrongly picked up. The fix must use the root.
    fs.mkdirSync(path.join(repoDir, ".pi-mind/knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".pi-mind/knowledge/sentinel.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\nroot sentinel body\n`,
    );
    fs.mkdirSync(path.join(repoDir, "sub", ".pi-mind", "knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "sub", ".pi-mind", "knowledge", "decoy.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\ndecoy body\n`,
    );

    const r = runLintIn(
      path.join(repoDir, "sub"),
      { PI_MIND_DIR: undefined },
      [],
    );
    expect(r.status).toBe(0);
    // Lint's summary section lists files. With the fix, only sentinel.md.
    expect(r.stdout).toContain("sentinel.md");
    expect(r.stdout).not.toContain("decoy.md");
  });

  it("PI_MIND_DIR env wins over the cwd-derived resolvePiMindDir", { timeout: 60_000 }, () => {
    // Real git repo with root .pi-mind/knowledge/root-sentinel.md.
    fs.mkdirSync(path.join(repoDir, ".pi-mind/knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".pi-mind/knowledge/root-sentinel.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\nroot body\n`,
    );

    // A completely separate non-git dir used via PI_MIND_DIR. Lint must
    // use THIS, not the git repo's .pi-mind.
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-lint-env-"));
    try {
      fs.mkdirSync(path.join(envDir, "knowledge"), { recursive: true });
      fs.writeFileSync(
        path.join(envDir, "knowledge", "env-sentinel.md"),
        `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\nenv body\n`,
      );

      const r = runLintIn(
        repoDir,  // cwd would resolve to repoDir/.pi-mind if env were unset
        { PI_MIND_DIR: envDir },
        [],
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("env-sentinel.md");
      expect(r.stdout).not.toContain("root-sentinel.md");
    } finally {
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("--dir still overrides the normal lint knowledge directory", { timeout: 60_000 }, () => {
    // The resolved .pi-mind has a normal.md file.
    fs.mkdirSync(path.join(repoDir, ".pi-mind/knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".pi-mind/knowledge/normal.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\nnormal body\n`,
    );
    // --dir target has its own override.md file.
    const customDir = path.join(repoDir, "custom");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, "override.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: reference\ntier: L2\ntags: [x]\n---\n\noverride body\n`,
    );

    const r = runLintIn(
      repoDir,
      { PI_MIND_DIR: undefined },
      ["--dir", customDir],
    );
    expect(r.status).toBe(0);
    // Lint prints "Memory Lint \u2014 N files". With --dir=custom, only
    // override.md is scanned; the resolved .pi-mind/knowledge/normal.md
    // is bypassed.
    expect(r.stdout).toContain("override.md");
    expect(r.stdout).not.toContain("normal.md");
    expect(r.stdout).toMatch(/Memory Lint\s+\u2014\s+1 files/);
  });

  it("--prune is not affected by --dir (uses PI_MIND_DIR / resolvePiMindDir only)", { timeout: 60_000 }, () => {
    // PI_MIND_DIR points to root with a knowledge/ subdir; --dir points
    // elsewhere. The prune header must reference PI_MIND_DIR, not --dir.
    const pruneDir = path.join(repoDir, "prune-root");
    fs.mkdirSync(path.join(pruneDir, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(pruneDir, "raw"), { recursive: true });

    const otherDir = path.join(repoDir, "other");
    fs.mkdirSync(otherDir, { recursive: true });

    const r = runLintIn(
      repoDir,
      { PI_MIND_DIR: pruneDir },
      ["--prune", "--dir", otherDir],
    );
    expect(r.status).toBe(0);
    // Header line includes the resolved PI_MIND_DIR.
    expect(r.stdout).toMatch(new RegExp(`PI_MIND_DIR=${escapeRegex(pruneDir)}`));
    // --dir value must not appear in the PI_MIND_DIR= header (prune
    // ignores --dir entirely).
    expect(r.stdout).not.toMatch(new RegExp(`PI_MIND_DIR=${escapeRegex(otherDir)}`));
  });
});

/** Escape a path for use inside a RegExp literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
