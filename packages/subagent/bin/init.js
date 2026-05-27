#!/usr/bin/env node
/**
 * pi-subagent postinstall: wire the extension into the host repo's .pi/ tree.
 *
 *   .pi/extensions/subagent → node_modules/@shog-lab/pi-subagent/dist/extensions/subagent
 *
 * Idempotent. Disable with PI_SUBAGENT_SKIP_INIT=1.
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_SUBAGENT_SKIP_INIT === "1") {
  console.log("[pi-subagent] init skipped (PI_SUBAGENT_SKIP_INIT=1)");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), "..");

function findHostRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) !== PKG_ROOT) return resolve(initCwd);

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
  console.log("[pi-subagent] not installed in a host project (dev mode), skipping init");
  process.exit(0);
}

console.log(`[pi-subagent] initializing in ${HOST_ROOT}`);

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    console.log(`[pi-subagent] created ${relative(HOST_ROOT, p)}/`);
  }
}

function linkInto(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);

  for (const name of readdirSync(destDir)) {
    const dest = join(destDir, name);
    try { readlinkSync(dest); } catch { continue; }
    if (!existsSync(dest)) {
      try {
        unlinkSync(dest);
        console.log(`[pi-subagent] removed dangling ${relative(HOST_ROOT, dest)}`);
      } catch (e) {
        console.warn(`[pi-subagent] failed to remove dangling ${relative(HOST_ROOT, dest)}: ${e instanceof Error ? e.message : String(e)}`);
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
        console.log(`[pi-subagent] skip ${relative(HOST_ROOT, dest)} (already exists, not managed by pi-subagent)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    console.log(`[pi-subagent] linked ${relative(HOST_ROOT, dest)} → ${relSrc}`);
  }
}

linkInto(join(PKG_ROOT, "dist", "extensions"), join(HOST_ROOT, ".pi", "extensions"));

console.log(`[pi-subagent] ready. spawn_subagent tool available next pi launch.`);
