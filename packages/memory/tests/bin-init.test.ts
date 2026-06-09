/**
 * Regression tests for the bin/init.js postinstall wrapper.
 *
 * The blocker these tests guard against: a fresh git clone + `npm install`
 * runs the package's `postinstall` hook BEFORE `prepare`. At that point
 * the package's `dist/` directory does not exist (it would be created
 * by the prepare-triggered build). The previous version of bin/init.js
 * did a top-level `import { runInit, findHostRoot } from
 * "../dist/lib/init.js"` \u2014 that import fails in a fresh clone,
 * crashing the install with no way for PI_MIND_SKIP_INIT=1 to short-
 * circuit (because ESM `import` is hoisted and runs before any
 * top-level code).
 *
 * The fix in this batch:
 *   1. Helper moved to `bin/init-lib.js` (plain ESM, ships with the
 *      package, NOT a dist product).
 *   2. `bin/init.js` does an early PI_MIND_SKIP_INIT check BEFORE the
 *      dynamic `await import('./init-lib.js')`. Dynamic import is NOT
 *      hoisted, so the SKIP check runs first.
 *   3. If the helper is missing AND SKIP is not set, the install fails
 *      LOUDLY with a clear ERR_MODULE_NOT_FOUND \u2014 not a silent no-op.
 *
 * These tests simulate the three scenarios end-to-end by running the
 * actual bin/init.js in an isolated tmp directory via child_process.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const BIN_INIT = path.join(PKG_ROOT, "bin", "init.js");
const BIN_INIT_LIB = path.join(PKG_ROOT, "bin", "init-lib.js");

// Sanity: the files we depend on must exist in the real repo.
expect(fs.existsSync(BIN_INIT)).toBe(true);
expect(fs.existsSync(BIN_INIT_LIB)).toBe(true);

let scratch: string;

beforeEach(() => {
  // Simulated "fresh clone" \u2014 only the files we explicitly copy end up
  // in this scratch dir. No dist/, no node_modules, no init-lib.js
  // (unless a test copies it in).
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-bin-init-test-"));
});

afterEach(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

/**
 * Build a fake "package" directory tree that mirrors what an installed
 * @shog-lab/pi-memory would have on disk. By default we copy only
 * bin/init.js \u2014 the test can opt into copying init-lib.js and/or
 * dist/ structure.
 */
function setupPkg(opts: {
  copyInitLib?: boolean;
  copyDist?: boolean;
}): string {
  const pkg = path.join(scratch, "pkg");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.copyFileSync(BIN_INIT, path.join(pkg, "bin", "init.js"));

  if (opts.copyInitLib) {
    fs.copyFileSync(BIN_INIT_LIB, path.join(pkg, "bin", "init-lib.js"));
  }

  if (opts.copyDist) {
    for (const name of ["memory", "skill-evolution"]) {
      const extDir = path.join(pkg, "dist", "extensions", name);
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, "index.js"), `// ext ${name}`);
      const skillDir = path.join(pkg, "skills", name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}`);
    }
  }

  return pkg;
}

function runPostinstall(pkg: string, extraEnv: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [path.join(pkg, "bin", "init.js")], {
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ============================================================================
// Scenario 1: SKIP short-circuit works WITHOUT the helper present
// ============================================================================

describe("bin/init.js \u2014 SKIP path", () => {
  it("PI_MIND_SKIP_INIT=1 exits 0 even when init-lib.js is absent (fresh-clone scenario)", () => {
    // Worst case: fresh clone before any build, no init-lib.js, no dist.
    // SKIP short-circuit must still succeed.
    const pkg = setupPkg({ copyInitLib: false, copyDist: false });
    const r = runPostinstall(pkg, { PI_MIND_SKIP_INIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pi-mind] init skipped");
    expect(r.stdout).toContain("PI_MIND_SKIP_INIT=1");
  });

  it("PI_MIND_SKIP_INIT=1 also works when init-lib.js IS present (no change in behavior)", () => {
    const pkg = setupPkg({ copyInitLib: true, copyDist: true });
    const r = runPostinstall(pkg, { PI_MIND_SKIP_INIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pi-mind] init skipped");
  });

  it("PI_MIND_SKIP_INIT=0 (or unset) without init-lib.js fails LOUDLY, not silently", () => {
    // Without SKIP and without helper, we expect a noisy crash. This is
    // intentional: better to fail loud than to silently no-op the
    // postinstall. A real fix is "commit init-lib.js to the repo" or
    // "run npm run build first" \u2014 not a silent fallback.
    const pkg = setupPkg({ copyInitLib: false, copyDist: false });
    const r = runPostinstall(pkg, { PI_MIND_SKIP_INIT: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
});

// ============================================================================
// Scenario 2: real postinstall with helper present, no dist/
// ============================================================================

describe("bin/init.js \u2014 real postinstall", () => {
  it("with init-lib.js but no dist/extensions/ (no extensions to link), still creates .pi-mind dirs", () => {
    // Helper is present, but the package's dist/extensions/ is empty
    // (fresh clone before build). The script should still run, create
    // .pi-mind/{raw,knowledge,graph}, and not crash on the missing
    // dist/ contents.
    const pkg = setupPkg({ copyInitLib: true, copyDist: false });
    const host = path.join(scratch, "host");
    fs.mkdirSync(host, { recursive: true });
    const r = runPostinstall(pkg, {
      INIT_CWD: host,
      PI_MIND_DIR: path.join(host, ".pi-mind"),
    });
    expect(r.status).toBe(0);
    // The .pi-mind dirs are created. (No graph/ — KG lives in SQLite.)
    expect(fs.existsSync(path.join(host, ".pi-mind", "raw"))).toBe(true);
    expect(fs.existsSync(path.join(host, ".pi-mind", "knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(host, ".pi-mind", "graph"))).toBe(false);
  });

  it("with init-lib.js AND dist/extensions/, creates symlinks into host's .pi/", () => {
    // Real postinstall: helper present, package has compiled extensions.
    // Verify the .pi/extensions/ symlinks land in the host repo.
    const pkg = setupPkg({ copyInitLib: true, copyDist: true });
    const host = path.join(scratch, "host");
    fs.mkdirSync(host, { recursive: true });
    const r = runPostinstall(pkg, {
      INIT_CWD: host,
      PI_MIND_DIR: path.join(host, ".pi-mind"),
    });
    expect(r.status).toBe(0);
    // The 2 extensions and 2 skills become symlinks in host/.pi/.
    for (const name of ["memory", "skill-evolution"]) {
      const extLink = path.join(host, ".pi", "extensions", name);
      const skillLink = path.join(host, ".pi", "skills", name);
      expect(fs.lstatSync(extLink).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    }
  });

  it("uses PI_MIND_DIR override when set", () => {
    const pkg = setupPkg({ copyInitLib: true, copyDist: false });
    const host = path.join(scratch, "host");
    fs.mkdirSync(host, { recursive: true });
    const custom = path.join(scratch, "alt-memory");
    const r = runPostinstall(pkg, {
      INIT_CWD: host,
      PI_MIND_DIR: custom,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(custom, "raw"))).toBe(true);
    expect(fs.existsSync(path.join(custom, "knowledge"))).toBe(true);
    // The default .pi-mind/ in the host should NOT be created.
    expect(fs.existsSync(path.join(host, ".pi-mind"))).toBe(false);
  });

  it("prints a clear 'ready' banner after initialization", () => {
    const pkg = setupPkg({ copyInitLib: true, copyDist: false });
    const host = path.join(scratch, "host");
    fs.mkdirSync(host, { recursive: true });
    const r = runPostinstall(pkg, {
      INIT_CWD: host,
      PI_MIND_DIR: path.join(host, ".pi-mind"),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pi-mind] ready");
    expect(r.stdout).toContain("Run 'pi' in");
  });
});

// ============================================================================
// Scenario 3: idempotency \u2014 second run on already-initialized host
// ============================================================================

describe("bin/init.js \u2014 idempotent re-run", () => {
  it("running twice on the same host does not duplicate symlinks and does not throw", () => {
    const pkg = setupPkg({ copyInitLib: true, copyDist: true });
    const host = path.join(scratch, "host");
    fs.mkdirSync(host, { recursive: true });
    const env = {
      INIT_CWD: host,
      PI_MIND_DIR: path.join(host, ".pi-mind"),
    };
    const r1 = runPostinstall(pkg, env);
    const r2 = runPostinstall(pkg, env);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    // Each symlink still resolves correctly.
    for (const name of ["memory", "skill-evolution"]) {
      const extLink = path.join(host, ".pi", "extensions", name);
      const skillLink = path.join(host, ".pi", "skills", name);
      expect(fs.lstatSync(extLink).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    }
  });
});
