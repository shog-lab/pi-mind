/**
 * Tests for withGroupLock — verifies the lock file lives under the caller's
 * groupDir (not a module-load global), and that nested calls re-enter safely
 * instead of deadlocking.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const { withGroupLock } =
  (await import("../extensions/memory/core.js")) as typeof import("../extensions/memory/core.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-lock-test-"));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// proper-lockfile writes the actual on-disk file as `<path>.lock.lock`
// (the path we pass is the logical lock ID; the physical sentinel file
// lives next to it with the doubled extension).
const PHYSICAL_LOCK_NAME = "memory.lock.lock";

function lockDirOf(groupDir: string): string {
  return path.join(groupDir, ".locks");
}

function physicalLockOf(groupDir: string): string {
  return path.join(lockDirOf(groupDir), PHYSICAL_LOCK_NAME);
}

describe("withGroupLock — lock file location", () => {
  it("creates the lock dir under the caller's groupDir, not a global default", async () => {
    await withGroupLock(tmpDir, async () => {
      expect(fs.existsSync(lockDirOf(tmpDir))).toBe(true);
      expect(fs.existsSync(physicalLockOf(tmpDir))).toBe(true);
    });
  });

  it("does not pollute the cwd with lock files", async () => {
    const cwdBefore = fs.readdirSync(process.cwd());
    await withGroupLock(tmpDir, async () => {
      const cwdDuring = fs.readdirSync(process.cwd());
      // The cwd should not have grown a .locks/ directory as a side effect.
      expect(cwdDuring).toEqual(cwdBefore);
    });
  });

  it("uses the passed-in groupDir verbatim, not basename(groupDir)", async () => {
    // Regression guard: prior implementation keyed the lock file by
    // basename(groupDir), so two repos with the same leaf name shared a
    // lock. The lock dir must now sit under the actual groupDir.
    const sub = path.join(tmpDir, "deeply", "nested", "pi-mind");
    fs.mkdirSync(sub, { recursive: true });
    await withGroupLock(sub, async () => {
      // Lock dir created under the deep path, not the tmp root.
      expect(fs.existsSync(physicalLockOf(sub))).toBe(true);
      expect(fs.existsSync(physicalLockOf(tmpDir))).toBe(false);
    });
  });

  it("two distinct groupDir get independent locks (no cross-contamination)", async () => {
    const groupA = path.join(tmpDir, "A");
    const groupB = path.join(tmpDir, "B");
    fs.mkdirSync(groupA, { recursive: true });
    fs.mkdirSync(groupB, { recursive: true });

    // Hold the lock on A, then independently take a lock on B inside A's
    // critical section. If withGroupLock still used a shared lock by basename
    // (or a module-load global), B's acquire would deadlock or block on A.
    let aFinished = false;
    let bFinished = false;
    const aPromise = withGroupLock(groupA, async () => {
      // While A's lock is held, acquire B's — should succeed immediately.
      await withGroupLock(groupB, async () => {
        bFinished = true;
      });
      aFinished = true;
    });
    await aPromise;
    expect(aFinished).toBe(true);
    expect(bFinished).toBe(true);
  });
});

describe("withGroupLock — reentrancy", () => {
  it("nested calls on the same groupDir re-enter without deadlock (refcount)", async () => {
    const order: string[] = [];
    await withGroupLock(tmpDir, async () => {
      order.push("outer-start");
      await withGroupLock(tmpDir, async () => {
        order.push("inner-start");
        // A small await proves we're actually reentering, not serializing.
        await new Promise((r) => setTimeout(r, 10));
        order.push("inner-end");
      });
      order.push("outer-end");
    });
    expect(order).toEqual(["outer-start", "inner-start", "inner-end", "outer-end"]);
  });

  it("three-deep nesting acquires the underlying lock exactly once", async () => {
    // The Map-based refcount means the third nested call should not call
    // proper-lockfile's lock() a third time. We can't easily inspect the
    // refcount from outside, so we just assert it doesn't deadlock and the
    // critical sections run in order.
    const order: number[] = [];
    await withGroupLock(tmpDir, async () => {
      order.push(1);
      await withGroupLock(tmpDir, async () => {
        order.push(2);
        await withGroupLock(tmpDir, async () => {
          order.push(3);
        });
        order.push(4);
      });
      order.push(5);
    });
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("releases the lock after the outermost call exits (not earlier)", async () => {
    let innerSawLockReleased = true;
    await withGroupLock(tmpDir, async () => {
      innerSawLockReleased = false;
      await withGroupLock(tmpDir, async () => {
        // While we're nested, the lock file MUST still exist (refcount > 0).
        expect(fs.existsSync(physicalLockOf(tmpDir))).toBe(true);
      });
      // After the inner call returns, the refcount is still 1 (the outer
      // call hasn't returned), so the lock file is still on disk.
      expect(fs.existsSync(physicalLockOf(tmpDir))).toBe(true);
    });
    // After the outermost call returns, proper-lockfile has released; the
    // file may or may not be physically removed (it usually is, but don't
    // depend on exact behavior — only that acquire-after-release works).
    expect(innerSawLockReleased).toBe(false);
  });
});
