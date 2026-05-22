#!/usr/bin/env node
/**
 * pi-toolkit postinstall: symlink extensions into the host repo's .pi/.
 *
 * Mirrors pi-mind's init.js — uses $INIT_CWD to locate host root (works for
 * symlinked / file: / workspace installs), then creates symlinks for each
 * subdirectory under extensions/.
 *
 * Disable with PI_TOOLKIT_SKIP_INIT=1.
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

if (process.env.PI_TOOLKIT_SKIP_INIT === "1") {
  console.log("[pi-toolkit] init skipped (PI_TOOLKIT_SKIP_INIT=1)");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), "..");

function findHostRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) !== PKG_ROOT) {
    return resolve(initCwd);
  }
  // Fallback: walk up from PKG_ROOT until we land on a node_modules whose parent
  // is NOT inside a pnpm cache. pnpm nests packages under
  // node_modules/.pnpm/<pkg>@<ver>/node_modules/... so the first ancestor
  // node_modules we hit is inside .pnpm — skip past it to find the real host root.
  let dir = resolve(PKG_ROOT);
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

const HOST_ROOT = findHostRoot();
if (!HOST_ROOT) {
  console.log("[pi-toolkit] not installed in a host project (dev mode), skipping init");
  process.exit(0);
}

console.log(`[pi-toolkit] initializing in ${HOST_ROOT}`);

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function linkInto(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);

  // First pass: sweep dangling symlinks in destDir. Catches the case where
  // an extension was renamed or removed between package versions — the old
  // symlink still exists but points at nothing. Only touches symlinks (not
  // user-managed directories or files).
  for (const name of readdirSync(destDir)) {
    const dest = join(destDir, name);
    try {
      readlinkSync(dest); // throws if dest is not a symlink
    } catch {
      continue; // not a symlink — leave alone
    }
    if (!existsSync(dest)) {
      // existsSync returns false for dangling symlinks
      try {
        unlinkSync(dest);
        console.log(`[pi-toolkit] removed dangling ${relative(HOST_ROOT, dest)}`);
      } catch (e) {
        // Don't silently absorb a failed unlink — the dangling link will be
        // re-encountered next install and the user gets to fix the underlying
        // permission/fs issue once instead of debugging "why is this symlink
        // still here".
        console.warn(`[pi-toolkit] failed to remove dangling ${relative(HOST_ROOT, dest)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    if (!statSync(src).isDirectory()) continue;
    const dest = join(destDir, name);
    const relSrc = relative(destDir, src);

    if (existsSync(dest)) {
      try {
        const current = readlinkSync(dest);
        if (current === relSrc) continue;
        unlinkSync(dest);
      } catch {
        console.log(`[pi-toolkit] skip ${relative(HOST_ROOT, dest)} (already exists, not managed by pi-toolkit)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    console.log(`[pi-toolkit] linked ${relative(HOST_ROOT, dest)} → ${relSrc}`);
  }
}

// Extensions are TypeScript-compiled — symlink to dist/extensions where pi
// loads from .js (no .ts source siblings to confuse it).
linkInto(join(PKG_ROOT, "dist", "extensions"), join(HOST_ROOT, ".pi", "extensions"));

// agent-browser ships its own SKILL.md describing the CLI to the agent.
// Symlink upstream (so `npm update agent-browser` auto-refreshes the skill)
// instead of vendoring our own copy.
try {
  const abPkg = require.resolve("agent-browser/package.json");
  const abSkillsDir = join(dirname(abPkg), "skills");
  if (existsSync(abSkillsDir)) {
    linkInto(abSkillsDir, join(HOST_ROOT, ".pi", "skills"));
  }
} catch {
  // agent-browser isn't installed — shouldn't happen since it's a dependency,
  // but don't break postinstall over it.
}

console.log(`[pi-toolkit] ready.`);
