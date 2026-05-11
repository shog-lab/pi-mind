#!/usr/bin/env node
/**
 * pi-chrome postinstall: wire the package into the host repo's .pi/ tree.
 *
 * Creates symlinks (so npm update keeps the agent in sync):
 *   .pi/extensions/browser  →  node_modules/pi-chrome/dist/extensions/browser
 *   .pi/skills/<name>       →  node_modules/pi-chrome/skills/<name>
 *
 * Idempotent. User-customized files are never overwritten.
 *
 * Disable with PI_CHROME_SKIP_INIT=1 (e.g. CI environments).
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_CHROME_SKIP_INIT === "1") {
  console.log("[pi-chrome] init skipped (PI_CHROME_SKIP_INIT=1)");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), "..");

/**
 * Locate the host project root.
 *
 * Preferred: $INIT_CWD (set by npm to the directory where npm was invoked).
 * This is the only reliable signal when npm symlinks the package (file:
 * installs, npm link, workspaces).
 *
 * Fallback: walk up from PKG_ROOT looking for a node_modules ancestor.
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
  console.log("[pi-chrome] not installed in a host project (dev mode), skipping init");
  process.exit(0);
}

console.log(`[pi-chrome] initializing in ${HOST_ROOT}`);

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    console.log(`[pi-chrome] created ${relative(HOST_ROOT, p)}/`);
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
        console.log(`[pi-chrome] skip ${relative(HOST_ROOT, dest)} (already exists, not managed by pi-chrome)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    console.log(`[pi-chrome] linked ${relative(HOST_ROOT, dest)} → ${relSrc}`);
  }
}

// Extensions are TypeScript-compiled — symlink to dist/extensions where pi
// loads from .js (no .ts source siblings to confuse it).
// Skills are markdown — stay in source skills/.
linkInto(join(PKG_ROOT, "dist", "extensions"), join(HOST_ROOT, ".pi", "extensions"));
linkInto(join(PKG_ROOT, "skills"), join(HOST_ROOT, ".pi", "skills"));

console.log(`[pi-chrome] ready. Run 'pi' in ${HOST_ROOT} to use the browser tools.`);
