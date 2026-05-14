/**
 * Tests for resolvePiMindDir.
 *
 * Uses real git repos / worktrees in tmpdirs (no mocking) because this code's
 * whole job is interpreting `git rev-parse --git-common-dir` correctly across
 * main checkout / linked worktree / non-git scenarios. Mocking git would just
 * test the mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPiMindDirCache, resolvePiMindDir } from "./paths.js";

let tmpRoot: string;
let savedEnv: string | undefined;

function makeRepo(name: string): string {
  const repo = join(tmpRoot, name);
  mkdirSync(repo);
  // Quiet, deterministic repo init.
  execSync(
    "git init -q && git config user.email a@b && git config user.name x && git commit --allow-empty -qm init",
    { cwd: repo },
  );
  return repo;
}

beforeEach(() => {
  savedEnv = process.env.PI_MIND_DIR;
  delete process.env.PI_MIND_DIR;
  _resetPiMindDirCache();
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-utils-paths-")));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_MIND_DIR;
  else process.env.PI_MIND_DIR = savedEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("resolvePiMindDir", () => {
  it("respects $PI_MIND_DIR env var (highest priority)", () => {
    process.env.PI_MIND_DIR = "/explicit/override";
    expect(resolvePiMindDir()).toBe("/explicit/override");
    expect(resolvePiMindDir("/some/other/cwd")).toBe("/explicit/override");
  });

  it("falls back to <cwd>/.pi-mind when not in a git repo", () => {
    expect(resolvePiMindDir(tmpRoot)).toBe(join(tmpRoot, ".pi-mind"));
  });

  it("resolves to <repo>/.pi-mind in a main git checkout", () => {
    const repo = makeRepo("repo");
    expect(resolvePiMindDir(repo)).toBe(join(repo, ".pi-mind"));
  });

  it("resolves to <repo>/.pi-mind from a subdirectory of the main checkout", () => {
    const repo = makeRepo("repo-sub");
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolvePiMindDir(sub)).toBe(join(repo, ".pi-mind"));
  });

  it("resolves to MAIN repo's .pi-mind from inside a linked worktree (not the worktree itself)", () => {
    const repo = makeRepo("repo-wt");
    // Create branch + worktree
    execSync('git checkout -q -b feat', { cwd: repo });
    execSync('git checkout -q main 2>/dev/null || git checkout -q master', { cwd: repo, stdio: "ignore" });
    const worktreePath = join(tmpRoot, "repo-wt-feat");
    execSync(`git worktree add -q "${worktreePath}" feat`, { cwd: repo });

    const fromWorktree = resolvePiMindDir(worktreePath);
    expect(fromWorktree).toBe(join(repo, ".pi-mind"));
    expect(fromWorktree).not.toBe(join(worktreePath, ".pi-mind"));
  });

  it("caches per-cwd so repeated calls are stable", () => {
    const repo = makeRepo("repo-cache");
    const a = resolvePiMindDir(repo);
    const b = resolvePiMindDir(repo);
    expect(a).toBe(b);
    // Different cwd in same call session: separate cache key
    const sub = join(repo, "src");
    mkdirSync(sub);
    expect(resolvePiMindDir(sub)).toBe(a); // both still resolve to <repo>/.pi-mind
  });

  it("env var override takes precedence even after cache is populated for cwd", () => {
    const repo = makeRepo("repo-env");
    expect(resolvePiMindDir(repo)).toBe(join(repo, ".pi-mind"));
    process.env.PI_MIND_DIR = "/explicit";
    // Env check happens first in the function — cache only kicks in when env unset.
    expect(resolvePiMindDir(repo)).toBe("/explicit");
  });
});
