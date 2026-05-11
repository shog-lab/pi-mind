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
