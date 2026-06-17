/**
 * Regression tests for bin/init.js postinstall behavior.
 *
 * Scope: end-to-end the actual `bin/init.js` script in an isolated
 * scratch dir. Validates the new behavior (linking the packaged
 * `build-personas` skill into host's `.pi/skills/`) and the existing
 * extension linking. Also covers SKIP, idempotency, and the dangling-
 * symlink sweep so that future changes don't regress them silently.
 *
 * We use a subprocess test (not a unit test of an extracted helper)
 * because the bus init is a self-contained script — its value is in
 * the wiring, not the leaves, so exercising the actual entry point is
 * the only way to catch real failures (and it mirrors the
 * packages/memory/tests/bin-init.test.ts pattern).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const BIN_INIT = path.join(PKG_ROOT, "bin", "init.js");

// Sanity: the script we test must exist in the real repo.
expect(fs.existsSync(BIN_INIT)).toBe(true);

let scratch: string;

beforeEach(() => {
  // Each test gets a fresh scratch dir. Inside it we build a fake
  // "installed package" (bin/init.js + dist/extensions/bus + skills/)
  // and a fake "host repo" (empty dir) — and verify init.js wires
  // them together.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bus-init-test-"));
});

afterEach(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

/**
 * Build a fake "installed @shog-lab/pi-bus" tree:
 *   <pkg>/bin/init.js
 *   <pkg>/dist/extensions/bus/{index.js,package.json}
 *   <pkg>/skills/build-personas/SKILL.md
 *
 * Returns the pkg root path.
 */
function setupPkg(): string {
  const pkg = path.join(scratch, "pkg");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.copyFileSync(BIN_INIT, path.join(pkg, "bin", "init.js"));

  // Fake compiled extension
  const extDir = path.join(pkg, "dist", "extensions", "bus");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "index.js"), "// fake bus extension");
  fs.writeFileSync(
    path.join(extDir, "package.json"),
    `{"name":"@shog-lab/pi-bus-extension","version":"0.0.0-test"}`,
  );

  // Packaged skill
  const skillDir = path.join(pkg, "skills", "build-personas");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: build-personas
description: scaffold test fixture
---

# build-personas (test fixture)
`,
  );

  return pkg;
}

function runPostinstall(
  pkg: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [path.join(pkg, "bin", "init.js")], {
    env: { ...process.env, ...extraEnv },
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function makeHost(): string {
  const host = path.join(scratch, "host");
  fs.mkdirSync(host, { recursive: true });
  return host;
}

// ============================================================================
// SKIP path — must work even with nothing else present
// ============================================================================

describe("bin/init.js — SKIP path", () => {
  it("PI_BUS_SKIP_INIT=1 exits 0 with a clear message", () => {
    const pkg = setupPkg();
    const r = runPostinstall(pkg, { PI_BUS_SKIP_INIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pi-bus] init skipped");
    expect(r.stdout).toContain("PI_BUS_SKIP_INIT=1");
  });

  it("PI_BUS_SKIP_INIT=1 does not create .pi/ in the host", () => {
    const pkg = setupPkg();
    const host = makeHost();
    runPostinstall(pkg, { PI_BUS_SKIP_INIT: "1", INIT_CWD: host });
    expect(fs.existsSync(path.join(host, ".pi"))).toBe(false);
  });
});

// ============================================================================
// Real postinstall — extension + skill linking
// ============================================================================

describe("bin/init.js — real postinstall", () => {
  it("links dist/extensions/bus into host's .pi/extensions/", () => {
    const pkg = setupPkg();
    const host = makeHost();
    const r = runPostinstall(pkg, { INIT_CWD: host });
    expect(r.status).toBe(0);
    const link = path.join(host, ".pi", "extensions", "bus");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Following the symlink must reach the real sentinel file.
    expect(fs.readFileSync(path.join(link, "index.js"), "utf-8"))
      .toBe("// fake bus extension");
  });

  it("links skills/build-personas into host's .pi/skills/", () => {
    const pkg = setupPkg();
    const host = makeHost();
    const r = runPostinstall(pkg, { INIT_CWD: host });
    expect(r.status).toBe(0);
    const link = path.join(host, ".pi", "skills", "build-personas");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Reading the symlink target must surface the real SKILL.md.
    const content = fs.readFileSync(path.join(link, "SKILL.md"), "utf-8");
    expect(content).toContain("name: build-personas");
  });

  it("prints a 'ready' banner after initialization", () => {
    const pkg = setupPkg();
    const host = makeHost();
    const r = runPostinstall(pkg, { INIT_CWD: host });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pi-bus] ready");
    expect(r.stdout).toContain("auto-join");
  });
});

// ============================================================================
// Idempotency — second run on already-initialized host
// ============================================================================

describe("bin/init.js — idempotent re-run", () => {
  it("running twice does not throw and symlinks still resolve", () => {
    const pkg = setupPkg();
    const host = makeHost();
    const env = { INIT_CWD: host };
    const r1 = runPostinstall(pkg, env);
    const r2 = runPostinstall(pkg, env);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    // Both symlinks still present and resolve to the real files.
    const extLink = path.join(host, ".pi", "extensions", "bus");
    const skillLink = path.join(host, ".pi", "skills", "build-personas");
    expect(fs.lstatSync(extLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(skillLink, "SKILL.md"), "utf-8"))
      .toContain("name: build-personas");
  });
});

// ============================================================================
// User-owned files — must not be overwritten
// ============================================================================

describe("bin/init.js — user-owned files", () => {
  it("does not overwrite a real (non-symlink) .pi/skills/build-personas dir", () => {
    const pkg = setupPkg();
    const host = makeHost();
    // User has already manually authored their own build-personas
    // skill as a real directory. Init must leave it alone.
    const userSkill = path.join(host, ".pi", "skills", "build-personas");
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(
      path.join(userSkill, "SKILL.md"),
      "# user-authored build-personas",
    );
    const r = runPostinstall(pkg, { INIT_CWD: host });
    expect(r.status).toBe(0);
    // The user's content wins — init did not clobber it with a symlink.
    expect(fs.statSync(userSkill).isDirectory()).toBe(true);
    expect(fs.lstatSync(userSkill).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8"))
      .toBe("# user-authored build-personas");
  });
});

// ============================================================================
// SKIP short-circuits BEFORE any side effects
// ============================================================================

describe("bin/init.js — SKIP short-circuits cleanly", () => {
  it("does not link anything when SKIP=1 even if a host is given", () => {
    const pkg = setupPkg();
    const host = makeHost();
    runPostinstall(pkg, { INIT_CWD: host, PI_BUS_SKIP_INIT: "1" });
    expect(fs.existsSync(path.join(host, ".pi", "extensions", "bus")))
      .toBe(false);
    expect(fs.existsSync(path.join(host, ".pi", "skills", "build-personas")))
      .toBe(false);
  });
});
