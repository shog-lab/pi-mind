/**
 * Resolve where the shared pi-mind state lives.
 *
 * Resolution order:
 *   1. $PI_MIND_DIR if set (explicit user override always wins)
 *   2. <main-repo-root>/.pi-mind, via `git rev-parse --git-common-dir`
 *      — this means worktrees share the main checkout's .pi-mind so memory
 *      survives worktree teardown.
 *   3. <cwd>/.pi-mind as fallback (not in a git repo at all)
 *
 * Why git-common-dir: it returns the path to the main .git directory regardless
 * of whether the caller is in the main checkout or a linked worktree. Its parent
 * is the main repo root. In contrast, `git rev-parse --show-toplevel` returns
 * the *worktree* root, which is what we explicitly do NOT want.
 *
 * Behavior is cached per-cwd to avoid repeated execSync; cache is keyed on cwd
 * so test setups that switch directories work correctly.
 */

import { execSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

const cache = new Map<string, string>();

export function resolvePiMindDir(cwd: string = process.cwd()): string {
  if (process.env.PI_MIND_DIR) return process.env.PI_MIND_DIR;

  const cwdKey = resolve(cwd);
  const cached = cache.get(cwdKey);
  if (cached) return cached;

  let result: string;
  try {
    const out = execSync("git rev-parse --git-common-dir", {
      cwd: cwdKey,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (out) {
      // git may return a relative path (typical "git" or ".git") in the main checkout,
      // or an absolute path when called from a linked worktree.
      const gitCommonDir = isAbsolute(out) ? out : resolve(cwdKey, out);
      const repoRoot = dirname(gitCommonDir);
      result = join(repoRoot, ".pi-mind");
    } else {
      result = join(cwdKey, ".pi-mind");
    }
  } catch {
    // Not a git repo, or git binary missing — fall back to cwd-rooted
    result = join(cwdKey, ".pi-mind");
  }

  cache.set(cwdKey, result);
  return result;
}

/** Clear the resolution cache. Test-only — production code does not need this. */
export function _resetPiMindDirCache(): void {
  cache.clear();
}
