/**
 * Memory forgetting — age-based real deletion across knowledge/ and raw/.
 *
 * Two entry points:
 *   bumpAndMaybeForget(piMindDir) — called from saveMemory; auto-runs forget
 *                                   every FORGET_EVERY_N_WRITES writes.
 *   forgetOldMemories(piMindDir, {dryRun}) — manual call from knowledge-lint --prune
 *                                            and from the bump path above.
 *
 * Retention policy (intentionally conservative on user/project; aggressive on
 * regenerable content):
 *   - knowledge/ type=user          → never auto-delete (durable preference)
 *   - knowledge/ type=project       → never auto-delete (durable decision)
 *   - knowledge/ type=agent-feedback → delete when frontmatter date > 60 days
 *   - knowledge/ type=reference     → delete when frontmatter date > 90 days
 *   - knowledge/ type=compaction    → covered by raw/compaction below
 *   - raw/compaction/*.md           → delete when mtime > 30 days
 *   - raw/sessions/<cwd>/*.jsonl    → delete when mtime > 14 days (the eval
 *                                     temp-dir pollution problem); empty
 *                                     subdirs are pruned afterwards
 *   - raw/maintenance-log/*.jsonl   → delete when mtime > 30 days; the
 *                                     last-audit.json / last-forget.json
 *                                     markers in this directory are preserved
 *
 * Marker file: raw/maintenance-log/last-forget.json tracks the write counter
 * and the most recent run (timestamp + deleted count) for observability.
 */

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const FORGET_EVERY_N_WRITES = 50;

/** Per-(directory, classifier) retention rules, in days. */
const RETENTION: {
  knowledgeByType: Record<string, number | null>;
  rawCompactionDays: number;
  rawSessionsDays: number;
  rawMaintenanceLogDays: number;
} = {
  knowledgeByType: {
    user: null,
    project: null,
    "agent-feedback": 60,
    reference: 90,
    compaction: null, // compaction-typed entries actually live in raw/compaction/
  },
  rawCompactionDays: 30,
  rawSessionsDays: 14,
  rawMaintenanceLogDays: 30,
};

/** Marker files (in raw/maintenance-log/) that must never be deleted as "stale logs". */
const PRESERVED_MARKER_FILES = new Set(["last-audit.json", "last-forget.json"]);

export interface ForgetResult {
  dryRun: boolean;
  deletedCount: number;
  byCategory: {
    knowledge: number;
    rawCompaction: number;
    rawSessions: number;
    rawMaintenanceLog: number;
  };
  /** Paths that were (or would be) deleted. */
  files: string[];
}

interface ForgetMarker {
  writesSinceLastForget: number;
  lastForgetAt?: string;
  lastDeletedCount?: number;
}

function markerPath(piMindDir: string): string {
  return join(piMindDir, "raw", "maintenance-log", "last-forget.json");
}

function readMarker(piMindDir: string): ForgetMarker {
  const p = markerPath(piMindDir);
  if (!existsSync(p)) return { writesSinceLastForget: 0 };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<ForgetMarker>;
    return {
      writesSinceLastForget: parsed.writesSinceLastForget ?? 0,
      lastForgetAt: parsed.lastForgetAt,
      lastDeletedCount: parsed.lastDeletedCount,
    };
  } catch {
    return { writesSinceLastForget: 0 };
  }
}

function writeMarker(piMindDir: string, marker: ForgetMarker): void {
  const p = markerPath(piMindDir);
  try {
    writeFileSync(p, JSON.stringify(marker, null, 2));
  } catch {
    // Best-effort — marker is observability, not load-bearing.
  }
}

/**
 * Increment the per-write counter and, if it crosses the threshold, run
 * forget synchronously and reset the counter. Call from saveMemory after
 * a successful write (skip on dedup hits / failures).
 *
 * Returns the ForgetResult if forget ran this call; null otherwise.
 */
export function bumpAndMaybeForget(piMindDir: string): ForgetResult | null {
  const marker = readMarker(piMindDir);
  const next = marker.writesSinceLastForget + 1;
  if (next < FORGET_EVERY_N_WRITES) {
    writeMarker(piMindDir, { ...marker, writesSinceLastForget: next });
    return null;
  }
  const result = forgetOldMemories(piMindDir, { dryRun: false });
  writeMarker(piMindDir, {
    writesSinceLastForget: 0,
    lastForgetAt: new Date().toISOString(),
    lastDeletedCount: result.deletedCount,
  });
  return result;
}

/**
 * Explicitly reset the counter without running forget. Used by knowledge-lint
 * --prune --apply so that hook-driven and manual forget don't double-fire
 * shortly after one another.
 */
export function resetForgetCounter(piMindDir: string, lastDeletedCount?: number): void {
  writeMarker(piMindDir, {
    writesSinceLastForget: 0,
    lastForgetAt: new Date().toISOString(),
    lastDeletedCount,
  });
}

/**
 * Run the forget pass. Returns a structured result. With dryRun, no files
 * are deleted — the result still lists what would have been deleted.
 */
export function forgetOldMemories(
  piMindDir: string,
  opts: { dryRun?: boolean } = {},
): ForgetResult {
  const dryRun = opts.dryRun ?? false;
  const now = Date.now();
  const files: string[] = [];
  const byCategory = { knowledge: 0, rawCompaction: 0, rawSessions: 0, rawMaintenanceLog: 0 };

  // 1. knowledge/ — frontmatter date + type
  const knowledgeDir = join(piMindDir, "knowledge");
  if (existsSync(knowledgeDir)) {
    for (const file of safeReaddir(knowledgeDir)) {
      if (!file.endsWith(".md")) continue;
      const fp = join(knowledgeDir, file);
      const verdict = shouldDeleteKnowledgeFile(fp, now);
      if (verdict) {
        files.push(fp);
        byCategory.knowledge++;
      }
    }
  }

  // 2. raw/compaction/ — mtime
  const compactionDir = join(piMindDir, "raw", "compaction");
  if (existsSync(compactionDir)) {
    for (const file of safeReaddir(compactionDir)) {
      if (!file.endsWith(".md")) continue;
      const fp = join(compactionDir, file);
      if (mtimeAgeDays(fp, now) > RETENTION.rawCompactionDays) {
        files.push(fp);
        byCategory.rawCompaction++;
      }
    }
  }

  // 3. raw/sessions/ — recursive walk; delete jsonl > 14d old, then prune empty dirs
  const sessionsDir = join(piMindDir, "raw", "sessions");
  if (existsSync(sessionsDir)) {
    for (const fp of collectStaleSessionFiles(sessionsDir, now)) {
      files.push(fp);
      byCategory.rawSessions++;
    }
  }

  // 4. raw/maintenance-log/ — mtime, skipping preserved markers
  const logDir = join(piMindDir, "raw", "maintenance-log");
  if (existsSync(logDir)) {
    for (const file of safeReaddir(logDir)) {
      if (PRESERVED_MARKER_FILES.has(file)) continue;
      if (!file.endsWith(".jsonl")) continue;
      const fp = join(logDir, file);
      if (mtimeAgeDays(fp, now) > RETENTION.rawMaintenanceLogDays) {
        files.push(fp);
        byCategory.rawMaintenanceLog++;
      }
    }
  }

  if (!dryRun) {
    for (const fp of files) {
      try { unlinkSync(fp); } catch { /* file may have vanished, ignore */ }
    }
    // After session file deletion, sweep empty subdirs under raw/sessions/
    if (existsSync(sessionsDir)) pruneEmptyDirs(sessionsDir, /* keepRoot */ true);
  }

  // Record the run so daily-audit / debugging can see when forget actually
  // fired and what it did. Logged for both dry-run and apply paths.
  logForgetRun(piMindDir, { dryRun, deletedCount: files.length, byCategory });

  return { dryRun, deletedCount: files.length, byCategory, files };
}

function logForgetRun(
  piMindDir: string,
  detail: { dryRun: boolean; deletedCount: number; byCategory: ForgetResult["byCategory"] },
): void {
  const logDir = join(piMindDir, "raw", "maintenance-log");
  try {
    mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `${date}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      action: "forget-run",
      ...detail,
    };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — logging is observability, not correctness.
  }
}

// --- helpers ---

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function mtimeAgeDays(filePath: string, now: number): number {
  try {
    const st = statSync(filePath);
    return (now - st.mtimeMs) / 86400_000;
  } catch {
    return 0;
  }
}

function shouldDeleteKnowledgeFile(filePath: string, now: number): boolean {
  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return false; }
  if (!raw.startsWith("---")) return false;
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return false;
  let type: string | undefined;
  let dateStr: string | undefined;
  for (const line of raw.slice(4, endIdx).split("\n")) {
    const t = line.trim();
    if (t.startsWith("type:")) type = t.slice(5).trim();
    else if (t.startsWith("date:")) dateStr = t.slice(5).trim();
  }
  if (!type || !dateStr) return false;
  const threshold = RETENTION.knowledgeByType[type];
  if (threshold == null) return false; // protected type or unknown — don't touch
  const ageDays = (now - new Date(dateStr).getTime()) / 86400_000;
  return Number.isFinite(ageDays) && ageDays > threshold;
}

function collectStaleSessionFiles(dir: string, now: number): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const fp = join(dir, entry);
    let st;
    try { st = statSync(fp); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...collectStaleSessionFiles(fp, now));
    } else if (st.isFile() && fp.endsWith(".jsonl")) {
      if ((now - st.mtimeMs) / 86400_000 > RETENTION.rawSessionsDays) {
        out.push(fp);
      }
    }
  }
  return out;
}

function pruneEmptyDirs(dir: string, keepRoot: boolean): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const fp = join(dir, name);
    let st;
    try { st = statSync(fp); } catch { continue; }
    if (st.isDirectory()) pruneEmptyDirs(fp, /* keepRoot */ false);
  }
  if (keepRoot) return;
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* not empty or permission; skip */ }
}
