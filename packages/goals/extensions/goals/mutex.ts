/**
 * Mutex — reentrant file-based lock using proper-lockfile.
 * Shared between goals extension and loop for concurrent write safety.
 */

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { lock } from "proper-lockfile";

const LOCK_DIR = join(process.env.PI_GOALS_DIR || join(__dirname, "..", ".."), ".locks");

interface LockEntry {
  count: number;
  release?: () => Promise<void>;
}

const _locks = new Map<string, LockEntry>();

export async function withGroupLock<T>(groupDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockFile = join(LOCK_DIR, `goals-${basename(groupDir)}.lock`);

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
