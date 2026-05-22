/**
 * Tests for lib/forget.ts — age-based deletion + persistent write counter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const {
  forgetOldMemories,
  bumpAndMaybeForget,
  resetForgetCounter,
  FORGET_EVERY_N_WRITES,
} = (await import('../lib/forget.js')) as typeof import('../lib/forget.js');

let tmpDir: string;

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

function writeKnowledge(name: string, type: string, dateIso: string, body = 'content'): string {
  const dir = path.join(tmpDir, 'knowledge');
  ensureDir(dir);
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, `---\ndate: ${dateIso}\ntype: ${type}\ntier: L2\n---\n\n${body}`);
  return fp;
}

function writeRawFile(subpath: string, ageDays: number, body = ''): string {
  const fp = path.join(tmpDir, 'raw', subpath);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, body);
  const past = (Date.now() - ageDays * 86400_000) / 1000;
  fs.utimesSync(fp, past, past);
  return fp;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mind-forget-test-'));
  ensureDir(path.join(tmpDir, 'raw', 'maintenance-log'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('forgetOldMemories', () => {
  it('protects user + project types regardless of age', () => {
    writeKnowledge('old-user.md', 'user', '2020-01-01T00:00:00Z');
    writeKnowledge('old-project.md', 'project', '2020-01-01T00:00:00Z');
    const result = forgetOldMemories(tmpDir, { dryRun: true });
    expect(result.byCategory.knowledge).toBe(0);
  });

  it('deletes reference older than 90 days', () => {
    const old = writeKnowledge('old-ref.md', 'reference', new Date(Date.now() - 100 * 86400_000).toISOString());
    const fresh = writeKnowledge('fresh-ref.md', 'reference', new Date().toISOString());
    const result = forgetOldMemories(tmpDir, { dryRun: false });
    expect(result.byCategory.knowledge).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('deletes agent-feedback older than 60 days', () => {
    const old = writeKnowledge('old-fb.md', 'agent-feedback', new Date(Date.now() - 70 * 86400_000).toISOString());
    const fresh = writeKnowledge('fresh-fb.md', 'agent-feedback', new Date(Date.now() - 50 * 86400_000).toISOString());
    forgetOldMemories(tmpDir, { dryRun: false });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('deletes raw/sessions/ jsonl older than 14 days and prunes empty subdirs', () => {
    const oldSession = writeRawFile('sessions/--Users-x--/old.jsonl', 20);
    const freshSession = writeRawFile('sessions/--Users-x--/fresh.jsonl', 5);
    const fullyStaleDir = writeRawFile('sessions/--Users-y--/stale.jsonl', 30);
    forgetOldMemories(tmpDir, { dryRun: false });
    expect(fs.existsSync(oldSession)).toBe(false);
    expect(fs.existsSync(freshSession)).toBe(true);
    expect(fs.existsSync(fullyStaleDir)).toBe(false);
    // y dir should be pruned (became empty); x dir still has fresh.jsonl
    expect(fs.existsSync(path.join(tmpDir, 'raw', 'sessions', '--Users-y--'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'raw', 'sessions', '--Users-x--'))).toBe(true);
  });

  it('deletes raw/compaction older than 30 days', () => {
    const old = writeRawFile('compaction/old.md', 40);
    const fresh = writeRawFile('compaction/fresh.md', 5);
    forgetOldMemories(tmpDir, { dryRun: false });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('preserves last-audit.json + last-forget.json in maintenance-log', () => {
    const audit = writeRawFile('maintenance-log/last-audit.json', 100, '{}');
    const forget = writeRawFile('maintenance-log/last-forget.json', 100, '{}');
    const oldLog = writeRawFile('maintenance-log/2025-01-01.jsonl', 100);
    forgetOldMemories(tmpDir, { dryRun: false });
    expect(fs.existsSync(audit)).toBe(true);
    expect(fs.existsSync(forget)).toBe(true);
    expect(fs.existsSync(oldLog)).toBe(false);
  });

  it('dryRun does not delete anything', () => {
    const old = writeRawFile('compaction/old.md', 40);
    const result = forgetOldMemories(tmpDir, { dryRun: true });
    expect(result.byCategory.rawCompaction).toBe(1);
    expect(fs.existsSync(old)).toBe(true);
  });
});

describe('bumpAndMaybeForget', () => {
  it('returns null until threshold, then runs forget and resets counter', () => {
    const old = writeRawFile('compaction/old.md', 40);
    for (let i = 1; i < FORGET_EVERY_N_WRITES; i++) {
      expect(bumpAndMaybeForget(tmpDir)).toBeNull();
    }
    expect(fs.existsSync(old)).toBe(true); // not yet
    const result = bumpAndMaybeForget(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(false);
    expect(fs.existsSync(old)).toBe(false);
    // counter reset → another bump returns null again
    expect(bumpAndMaybeForget(tmpDir)).toBeNull();
  });

  it('persists counter across calls via marker file', () => {
    bumpAndMaybeForget(tmpDir);
    bumpAndMaybeForget(tmpDir);
    const markerPath = path.join(tmpDir, 'raw', 'maintenance-log', 'last-forget.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(marker.writesSinceLastForget).toBe(2);
  });
});

describe('resetForgetCounter', () => {
  it('zeros the counter without running forget', () => {
    const old = writeRawFile('compaction/old.md', 40);
    for (let i = 0; i < 10; i++) bumpAndMaybeForget(tmpDir);
    resetForgetCounter(tmpDir, 5);
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'raw', 'maintenance-log', 'last-forget.json'), 'utf-8'),
    );
    expect(marker.writesSinceLastForget).toBe(0);
    expect(marker.lastDeletedCount).toBe(5);
    // old file is untouched (resetForgetCounter does NOT delete)
    expect(fs.existsSync(old)).toBe(true);
  });
});
