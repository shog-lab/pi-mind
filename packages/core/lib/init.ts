/**
 * pi-mind postinstall / host-project wiring logic.
 *
 * Extracted from bin/init.js so the postinstall script stays a thin
 * wrapper while the actual file/symlink logic is unit-testable. The
 * postinstall wrapper handles:
 *   1. process.exit(0) on PI_MIND_SKIP_INIT=1
 *   2. host-root detection (INIT_CWD + pnpm-aware walk)
 *   3. printing the "ready" banner
 *
 * Everything in this file is pure: takes explicit paths, returns a
 * structured result, no process.env reads, no side effects beyond
 * filesystem mutations. Testable in tmp dirs.
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface RunInitOptions {
  /** Where to install .pi/extensions, .pi/skills, and .pi-mind/. */
  hostRoot: string;
  /** Where the package's `dist/extensions/` and `skills/` live. */
  pkgRoot: string;
  /** Override the .pi-mind directory (default: <hostRoot>/.pi-mind). */
  piMindDir?: string;
  /** Verbose logger (default: silent). */
  log?: (line: string) => void;
  /** Warning logger (default: silent). */
  warn?: (line: string) => void;
}

export interface RunInitResult {
  /** Relative paths of symlinks created (or refreshed) under .pi/. */
  linked: string[];
  /** Relative paths of directories created under .pi-mind/. */
  dirsCreated: string[];
  /** Relative paths of dangling symlinks removed. */
  removedDangling: string[];
  /** Relative paths of pre-existing non-symlink entries we left alone. */
  skipped: string[];
}

const SILENT = (): void => {};

/**
 * Create the standard .pi/ and .pi-mind/ tree under hostRoot, and link the
 * package's compiled extensions + source skills into it.
 *
 * Idempotent: re-running on an already-initialized host is a no-op except
 * for cleaning up dangling symlinks (extension/skill removed between
 * package versions).
 *
 * Returns a structured result so callers (tests, the postinstall wrapper)
 * can surface what changed.
 */
export function runInit(opts: RunInitOptions): RunInitResult {
  const log = opts.log ?? SILENT;
  const warn = opts.warn ?? SILENT;
  const hostRoot = opts.hostRoot;
  const pkgRoot = opts.pkgRoot;
  const piMindDir = opts.piMindDir ?? join(hostRoot, ".pi-mind");

  const result: RunInitResult = {
    linked: [],
    dirsCreated: [],
    removedDangling: [],
    skipped: [],
  };

  // 1. Symlink extensions (compiled .js, lives in dist/) and skills
  //    (markdown, lives in source) into .pi/. Sweep dangling symlinks first
  //    to avoid "file exists" failures when an extension was removed.
  linkInto(
    join(pkgRoot, "dist", "extensions"),
    join(hostRoot, ".pi", "extensions"),
    hostRoot,
    result,
    log,
    warn,
  );
  linkInto(
    join(pkgRoot, "skills"),
    join(hostRoot, ".pi", "skills"),
    hostRoot,
    result,
    log,
    warn,
  );

  // 2. Create memory layer directories under .pi-mind/.
  // Note: there is no "graph/" subdirectory. The KG state lives in
  // .pi-mind/.pi-mind-index.db (kg_entities / kg_triples tables) — it
  // is a derived, rebuildable index over frontmatter `triples` fields,
  // not a separate file layer.
  for (const sub of ["raw", "knowledge"]) {
    const dir = join(piMindDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      result.dirsCreated.push(relative(hostRoot, dir));
      log(`created ${relative(hostRoot, dir)}/`);
    }
  }

  return result;
}

/**
 * Link the contents of srcDir (immediate child directories only) into destDir
 * as relative symlinks. Skips entries that already exist as non-symlinks
 * (user-owned). Replaces existing symlinks that point elsewhere. Removes
 * dangling symlinks (whose target no longer exists).
 */
function linkInto(
  srcDir: string,
  destDir: string,
  hostRoot: string,
  result: RunInitResult,
  log: (line: string) => void,
  warn: (line: string) => void,
): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });

  // First pass: sweep dangling symlinks in destDir. Only touches symlinks
  // (never user-managed directories or files).
  for (const name of readdirSync(destDir)) {
    const dest = join(destDir, name);
    let isSymlink = false;
    try {
      readlinkSync(dest);
      isSymlink = true;
    } catch {
      continue;
    }
    if (isSymlink && !existsSync(dest)) {
      try {
        unlinkSync(dest);
        result.removedDangling.push(relative(hostRoot, dest));
        log(`removed dangling ${relative(hostRoot, dest)}`);
      } catch (e) {
        warn(`failed to remove dangling ${relative(hostRoot, dest)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Second pass: link each srcDir/<name>/ → destDir/<name>.
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    let srcStat;
    try { srcStat = statSync(src); } catch { continue; }
    if (!srcStat.isDirectory()) continue;
    const dest = join(destDir, name);
    const relSrc = relative(destDir, src);

    if (existsSync(dest)) {
      // If it's already our symlink pointing to the right target, skip silently.
      try {
        const current = readlinkSync(dest);
        if (current === relSrc) continue;
        // Existing symlink to different target: replace (we own this slot)
        unlinkSync(dest);
      } catch {
        // Not a symlink (user-created dir/file): leave it alone.
        result.skipped.push(relative(hostRoot, dest));
        log(`skip ${relative(hostRoot, dest)} (already exists, not managed by pi-mind)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    result.linked.push(relative(hostRoot, dest));
    log(`linked ${relative(hostRoot, dest)} → ${relSrc}`);
  }
}

/**
 * Walks up from pkgRoot looking for a host root: the parent of a
 * node_modules that is NOT inside a pnpm virtual store. Returns null if
 * no host root is found (caller is in dev mode / pkg root itself).
 *
 * Exposed for the bin/init.js postinstall wrapper. Tests don't need this
 * because they call runInit directly with explicit hostRoot.
 */
export function findHostRoot(pkgRoot: string, initCwd?: string): string | null {
  if (initCwd) return initCwd;
  let dir = pkgRoot;
  while (dir !== "/" && dir !== ".") {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (parent.endsWith("/node_modules")) {
      const candidate = dirname(parent);
      if (candidate.includes("/node_modules/.pnpm/")) {
        dir = candidate;
        continue;
      }
      return candidate;
    }
    dir = parent;
  }
  return null;
}
