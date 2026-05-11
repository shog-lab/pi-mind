#!/usr/bin/env node
/**
 * pi-mind postinstall: wire the package into the host repo's .pi/ tree.
 *
 * Creates symlinks (so npm update keeps the agent in sync):
 *   .pi/extensions/<name>  →  node_modules/pi-mind/dist/extensions/<name>
 *   .pi/skills/<name>      →  node_modules/pi-mind/skills/<name>
 *
 * Creates fresh directories for the three memory layers (only if missing):
 *   .pi-mind/episodic/, .pi-mind/knowledge/, .pi-mind/graph/
 *
 * Idempotent. User-customized files are never overwritten.
 *
 * Disable with PI_MIND_SKIP_INIT=1 (e.g. CI environments).
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_MIND_SKIP_INIT === "1") {
  console.log("[pi-mind] init skipped (PI_MIND_SKIP_INIT=1)");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), "..");

/**
 * Locate the host project root.
 *
 * Preferred: $INIT_CWD (set by npm to the directory where npm was invoked).
 * This is the only reliable signal when npm symlinks the package (file:
 * installs, npm link, workspaces) — walking up from PKG_ROOT lands in the
 * source tree, not the host repo.
 *
 * Fallback: walk up from PKG_ROOT looking for a node_modules ancestor.
 *   This works for normal published-package installs where pkg lives at
 *   <host>/node_modules/<pkg>/ on disk.
 *
 * If neither yields a different directory than PKG_ROOT itself, we assume
 * dev mode (npm install inside the package's own repo) and skip.
 */
function findHostRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) !== PKG_ROOT) {
    return resolve(initCwd);
  }
  let dir = resolve(PKG_ROOT);
  while (dir !== "/" && dir !== ".") {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (parent.endsWith("/node_modules")) {
      return dirname(parent);
    }
    dir = parent;
  }
  return null;
}

const HOST_ROOT = findHostRoot();
if (!HOST_ROOT) {
  console.log("[pi-mind] not installed in a host project (dev mode), skipping init");
  process.exit(0);
}

console.log(`[pi-mind] initializing in ${HOST_ROOT}`);

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    console.log(`[pi-mind] created ${relative(HOST_ROOT, p)}/`);
  }
}

function linkInto(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    if (!statSync(src).isDirectory()) continue;
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
        // Not a symlink (user-created dir/file): leave it alone, log a warning
        console.log(`[pi-mind] skip ${relative(HOST_ROOT, dest)} (already exists, not managed by pi-mind)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    console.log(`[pi-mind] linked ${relative(HOST_ROOT, dest)} → ${relSrc}`);
  }
}

// 1. Symlink extensions (compiled .js, lives in dist/) and skills (markdown, lives in source) into .pi/
linkInto(join(PKG_ROOT, "dist", "extensions"), join(HOST_ROOT, ".pi", "extensions"));
linkInto(join(PKG_ROOT, "skills"), join(HOST_ROOT, ".pi", "skills"));

// 2. Create memory layer directories under .pi-mind/
const PI_MIND_DIR = process.env.PI_MIND_DIR || join(HOST_ROOT, ".pi-mind");
ensureDir(join(PI_MIND_DIR, "episodic"));
ensureDir(join(PI_MIND_DIR, "knowledge"));
ensureDir(join(PI_MIND_DIR, "graph"));

console.log(`[pi-mind] ready. Run 'pi' in ${HOST_ROOT} to use the agent.`);
