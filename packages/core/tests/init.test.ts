/**
 * Tests for lib/init.ts \u2014 the importable init helper used by bin/init.js.
 *
 * Scope: runInit() with explicit hostRoot / pkgRoot. The bin/init.js wrapper
 * adds process.env handling + host-root detection; that's trivial and not
 * worth its own test (test the real behavior here).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { runInit, findHostRoot } =
  (await import("../lib/init.js")) as typeof import("../lib/init.js");

let hostRoot: string;
let pkgRoot: string;
const log: string[] = [];
const warn: string[] = [];

beforeEach(() => {
  hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-init-host-"));
  pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-init-pkg-"));
  log.length = 0;
  warn.length = 0;

  // Set up a fake "installed" package: dist/extensions/<name>/ and
  // skills/<name>/ directories. Each gets a sentinel file so we can
  // verify the symlink resolves to a real path.
  for (const name of ["memory", "skill-evolution"]) {
    const extDir = path.join(pkgRoot, "dist", "extensions", name);
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.js"), `// ext ${name}`);
    fs.writeFileSync(path.join(extDir, "package.json"), `{"name":"${name}"}`);

    const skillDir = path.join(pkgRoot, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}`);
  }
});

afterEach(() => {
  try { fs.rmSync(hostRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(pkgRoot, { recursive: true, force: true }); } catch {}
});

function callInit() {
  return runInit({
    hostRoot,
    pkgRoot,
    log: (l) => log.push(l),
    warn: (w) => warn.push(w),
  });
}

// --- happy path ---

describe("runInit \u2014 fresh install", () => {
  it("creates .pi/extensions/ symlinks to dist/extensions/<name>", () => {
    callInit();
    for (const name of ["memory", "skill-evolution"]) {
      const link = path.join(hostRoot, ".pi", "extensions", name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      // Following the symlink must reach a real file (sentinel).
      const target = path.join(link, "index.js");
      expect(fs.readFileSync(target, "utf-8")).toBe(`// ext ${name}`);
    }
  });

  it("creates .pi/skills/ symlinks to skills/<name>", () => {
    callInit();
    for (const name of ["memory", "skill-evolution"]) {
      const link = path.join(hostRoot, ".pi", "skills", name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      const target = path.join(link, "SKILL.md");
      expect(fs.readFileSync(target, "utf-8")).toBe(`# ${name}`);
    }
  });

  it("creates .pi-mind/{raw,knowledge} directories (no graph/ — KG lives in SQLite)", () => {
    const result = callInit();
    for (const sub of ["raw", "knowledge"]) {
      const dir = path.join(hostRoot, ".pi-mind", sub);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    // KG state is in SQLite (.pi-mind-index.db), not in a graph/ subdir.
    expect(fs.existsSync(path.join(hostRoot, ".pi-mind", "graph"))).toBe(false);
    expect(result.dirsCreated.sort()).toEqual([
      ".pi-mind/knowledge",
      ".pi-mind/raw",
    ]);
  });

  it("reports the created links in the result", () => {
    const result = callInit();
    expect(result.linked).toContain(".pi/extensions/memory");
    expect(result.linked).toContain(".pi/extensions/skill-evolution");
    expect(result.linked).toContain(".pi/skills/memory");
    expect(result.linked).toContain(".pi/skills/skill-evolution");
  });
});

// --- idempotency ---

describe("runInit \u2014 idempotent re-runs", () => {
  it("running twice does not throw, does not duplicate, and reports no new links on second run", () => {
    const r1 = callInit();
    const r2 = callInit();
    // Second run: every link already points to the right target, so no
    // new linked entries, no dirs created, no dangle removal.
    expect(r2.linked).toEqual([]);
    expect(r2.dirsCreated).toEqual([]);
    expect(r2.removedDangling).toEqual([]);
    // First run actually created the four symlinks.
    expect(r1.linked.length).toBe(4);
  });

  it("a third run after package changes (new extension) only links the new one", () => {
    callInit();
    // Add a new extension to the "package".
    const newExt = path.join(pkgRoot, "dist", "extensions", "new-tool");
    fs.mkdirSync(newExt, { recursive: true });
    fs.writeFileSync(path.join(newExt, "index.js"), "// new");
    const r3 = callInit();
    expect(r3.linked).toEqual([".pi/extensions/new-tool"]);
  });
});

// --- dangling symlink sweep ---

describe("runInit \u2014 dangling symlink sweep", () => {
  it("removes a dangling symlink (points to non-existent target)", () => {
    callInit(); // first run creates real symlinks
    // Manually break one: delete the target dir.
    fs.rmSync(path.join(pkgRoot, "dist", "extensions", "skill-evolution"), { recursive: true });
    const r2 = callInit();
    // The broken symlink in .pi/extensions/skill-evolution should have been swept.
    expect(r2.removedDangling).toContain(".pi/extensions/skill-evolution");
    expect(fs.existsSync(path.join(hostRoot, ".pi", "extensions", "skill-evolution"))).toBe(false);
  });

  it("does NOT touch a valid (existing) symlink \u2014 re-run finds it and skips", () => {
    callInit();
    // Second run with no changes \u2014 the valid symlink must still be there.
    callInit();
    const link = path.join(hostRoot, ".pi", "extensions", "memory");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // And still resolves to the real sentinel file.
    expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe("// ext memory");
  });

  it("sweeps a user-introduced dangling symlink unrelated to package contents", () => {
    callInit();
    // User (or stale state) created a dangling .pi/skills/ghost symlink.
    const ghost = path.join(hostRoot, ".pi", "skills", "ghost-skill");
    fs.symlinkSync("../../somewhere/that/does/not/exist", ghost);
    const r2 = callInit();
    expect(r2.removedDangling).toContain(".pi/skills/ghost-skill");
    expect(fs.existsSync(ghost)).toBe(false);
  });
});

// --- user-owned files left alone ---

describe("runInit \u2014 user-owned files", () => {
  it("does not overwrite a real (non-symlink) directory in .pi/extensions/ (user-managed slot)", () => {
    // The "user owns this slot" case: user-created .pi/extensions/my-thing
    // as a real dir. Init should leave it alone (it doesn't appear in srcDir
    // so init never iterates it).
    const userDir = path.join(hostRoot, ".pi", "extensions", "my-thing");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "user-file.txt"), "user content");
    callInit();
    expect(fs.statSync(userDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(userDir, "user-file.txt"), "utf-8")).toBe("user content");
  });

  it("does not overwrite a real (non-symlink) file in .pi/skills/ (user-managed slot)", () => {
    const userFile = path.join(hostRoot, ".pi", "skills", "user-skill");
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, "# user skill");
    callInit();
    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.readFileSync(userFile, "utf-8")).toBe("# user skill");
  });

  it("does NOT overwrite a real (non-symlink) dir for a slot that DOES exist in src (reports as skipped)", () => {
    // Pretend `memory` extension in src has a real-dir in dest (user overrode it).
    const userMem = path.join(hostRoot, ".pi", "extensions", "memory");
    fs.mkdirSync(userMem, { recursive: true });
    fs.writeFileSync(path.join(userMem, "user-overrode.js"), "user wins");
    const r = callInit();
    // Init sees the slot is occupied by a non-symlink, logs as skipped.
    expect(r.skipped).toContain(".pi/extensions/memory");
    expect(fs.readFileSync(path.join(userMem, "user-overrode.js"), "utf-8")).toBe("user wins");
  });

  it("replaces a symlink that points to the WRONG target (we own the slot)", () => {
    callInit(); // creates correct symlink
    // Manually repoint the symlink to a wrong target.
    const link = path.join(hostRoot, ".pi", "extensions", "memory");
    fs.unlinkSync(link);
    fs.symlinkSync("/some/other/place", link);
    const r = callInit();
    // It gets re-pointed to the correct target.
    const newTarget = fs.readlinkSync(link);
    expect(newTarget).not.toBe("/some/other/place");
    // And resolves to the real file again.
    expect(fs.readFileSync(path.join(link, "index.js"), "utf-8")).toBe("// ext memory");
    expect(r.linked).toContain(".pi/extensions/memory");
  });
});

// --- custom piMindDir ---

describe("runInit \u2014 custom piMindDir", () => {
  it("respects piMindDir override", () => {
    const custom = path.join(hostRoot, "alt", "memory");
    const r = runInit({
      hostRoot,
      pkgRoot,
      piMindDir: custom,
      log: (l) => log.push(l),
      warn: (w) => warn.push(w),
    });
    expect(fs.existsSync(path.join(custom, "raw"))).toBe(true);
    expect(fs.existsSync(path.join(custom, "knowledge"))).toBe(true);
    // No graph/ — KG state is in SQLite.
    expect(fs.existsSync(path.join(custom, "graph"))).toBe(false);
    // The default .pi-mind/ should NOT have been created.
    expect(fs.existsSync(path.join(hostRoot, ".pi-mind"))).toBe(false);
    expect(r.dirsCreated).not.toContain("alt/memory/graph");
  });
});

// --- findHostRoot ---

describe("findHostRoot", () => {
  it("returns initCwd when provided", () => {
    expect(findHostRoot(pkgRoot, "/some/host")).toBe("/some/host");
  });

  it("returns null when no initCwd and walk-up finds no host root", () => {
    // A path with no node_modules ancestor in its lineage → walk terminates
    // at the filesystem root with no host found.
    expect(findHostRoot("/nonexistent/deep/pkg", undefined)).toBeNull();
  });

  it("walks up to find node_modules parent unless inside pnpm virtual store", () => {
    // Set up a fake tree: /fake/host/node_modules/pkg/foo
    // findHostRoot("/fake/host/node_modules/pkg/foo") should return "/fake/host"
    // (since /fake/host/node_modules is not inside /node_modules/.pnpm/).
    const fakePkg = path.join(hostRoot, "node_modules", "fake-pkg", "foo");
    fs.mkdirSync(fakePkg, { recursive: true });
    const result = findHostRoot(fakePkg);
    expect(result).toBe(hostRoot);
  });
});
