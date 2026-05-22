/**
 * Mutex — reentrant file-based lock using proper-lockfile.
 * Shared between goals extension and loop for concurrent write safety.
 *
 * Note: this module used to compute a module-level LOCK_DIR using `__dirname`,
 * which is undefined in ESM (the package is "type": "module"), so importing
 * mutex.ts crashed with ReferenceError unless $PI_GOALS_DIR was set to
 * short-circuit the `||`. Moved the lock-dir computation inside the
 * function, keyed off the caller's groupDir, which is both ESM-safe and
 * better-located (locks live with the data they protect, not in the package).
 */

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { lock } from "proper-lockfile";

interface LockEntry {
  count: number;
  release?: () => Promise<void>;
}

const _locks = new Map<string, LockEntry>();

export async function withGroupLock<T>(groupDir: string, fn: () => Promise<T>): Promise<T> {
  // $PI_GOALS_DIR override remains for tests / CI that want a shared lock dir;
  // otherwise locks live next to the goal data they protect.
  const lockDir = join(process.env.PI_GOALS_DIR || groupDir, ".locks");
  mkdirSync(lockDir, { recursive: true });
  const lockFile = join(lockDir, `goals-${basename(groupDir)}.lock`);

  const entry = _locks.get(lockFile) ?? { count: 0 };
  if (entry.count === 0) {
    const release = await lock(lockFile, {
      retries: { retries: 20, minTimeout: 100, maxTimeout: 1000 },
      realpath: false,
    });
    entry.release = release;
  }
  entry.count++;
  _locks.set(lockFile, entry);

  try {
    return await fn();
  } finally {
    entry.count--;
    if (entry.count === 0 && entry.release) {
      _locks.delete(lockFile);
      await entry.release();
    }
  }
}
