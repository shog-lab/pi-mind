#!/usr/bin/env node
/**
 * pi-bus postinstall: wire the extension and packaged skills into the host repo's .pi/ tree.
 *
 *   .pi/extensions/bus       → node_modules/@shog-lab/pi-bus/dist/extensions/bus
 *   .pi/skills/build-personas → node_modules/@shog-lab/pi-bus/skills/build-personas
 *
 * Idempotent. Disable with PI_BUS_SKIP_INIT=1.
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_BUS_SKIP_INIT === "1") {
  console.log("[pi-bus] init skipped (PI_BUS_SKIP_INIT=1)");
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), "..");

function findHostRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) !== PKG_ROOT) return resolve(initCwd);

  // Walk up from PKG_ROOT until we hit the host's node_modules (skipping pnpm's virtual store).
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
  console.log("[pi-bus] not installed in a host project (dev mode), skipping init");
  process.exit(0);
}

console.log(`[pi-bus] initializing in ${HOST_ROOT}`);

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    console.log(`[pi-bus] created ${relative(HOST_ROOT, p)}/`);
  }
}

function linkInto(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);

  // Sweep dangling symlinks first (extension renamed/removed between versions).
  for (const name of readdirSync(destDir)) {
    const dest = join(destDir, name);
    try { readlinkSync(dest); } catch { continue; }  // not a symlink → leave it
    if (!existsSync(dest)) {
      try {
        unlinkSync(dest);
        console.log(`[pi-bus] removed dangling ${relative(HOST_ROOT, dest)}`);
      } catch (e) {
        console.warn(`[pi-bus] failed to remove dangling ${relative(HOST_ROOT, dest)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    if (!statSync(src).isDirectory()) continue;
    const dest = join(destDir, name);
    const relSrc = relative(realpathSync(destDir), realpathSync(src));

    if (existsSync(dest)) {
      try {
        const current = readlinkSync(dest);
        if (current === relSrc) continue;
        unlinkSync(dest);
      } catch {
        console.log(`[pi-bus] skip ${relative(HOST_ROOT, dest)} (already exists, not managed by pi-bus)`);
        continue;
      }
    }
    symlinkSync(relSrc, dest);
    console.log(`[pi-bus] linked ${relative(HOST_ROOT, dest)} → ${relSrc}`);
  }
}

linkInto(join(PKG_ROOT, "dist", "extensions"), join(HOST_ROOT, ".pi", "extensions"));
linkInto(join(PKG_ROOT, "skills"), join(HOST_ROOT, ".pi", "skills"));

console.log(`[pi-bus] ready. Open multiple pi terminals in ${HOST_ROOT} — they auto-join the same bus.`);
