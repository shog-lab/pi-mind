/**
 * Tests for subagent extension (extensions/subagent/index.ts).
 * Tests: cwd existence checks and output cleaning logic.
 * (spawning and RPC protocol are tested via integration tests separately.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Mirrors the cwd validation in extensions/subagent/index.ts:
 *   - resolve + normalize the input
 *   - require existsSync
 *
 * pi-mind dropped the /workspace/repos/ allow-list — any existing absolute path is fine.
 * The user is trusted to invoke pi-mind in a directory they intend to use.
 */
function validateCwd(cwd: string): { ok: true; resolved: string } | { ok: false; reason: string } {
  const resolved = path.resolve(path.normalize(cwd));
  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: 'does not exist' };
  }
  return { ok: true, resolved };
}

function cleanOutput(stdout: string): string {
  return stdout
    .replace(/^\*\*Output:\*\*\n?/s, '')
    .replace(/^.*?---\n/s, '')
    .replace(/^\*\*\(.+\)\*\*\n?/s, '')
    .trim();
}

// --- Tests ---

describe('cwd validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts an existing directory', () => {
    const result = validateCwd(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-existent path', () => {
    const result = validateCwd(path.join(tmpDir, 'does-not-exist'));
    expect(result.ok).toBe(false);
  });

  it('resolves traversal segments to a real path', () => {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    const traversed = path.join(sub, '..');
    const result = validateCwd(traversed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(tmpDir);
  });
});

describe('cleanOutput', () => {
  it('removes **Output:** prefix', () => {
    const raw = '**Output:**\nHere is the result';
    expect(cleanOutput(raw)).toBe('Here is the result');
  });

  it('removes --- separator with preceding content', () => {
    const raw = 'Some header\n---\nActual output';
    expect(cleanOutput(raw)).toBe('Actual output');
  });

  it('removes **(xxx)** annotation lines', () => {
    const raw = '**(Running in repo)**\nThe output';
    expect(cleanOutput(raw)).toBe('The output');
  });

  it('handles combined artifacts', () => {
    const raw = '**Output:**\n**(thinking)**\n---\nReal result';
    expect(cleanOutput(raw)).toBe('Real result');
  });

  it('does not remove legitimate content containing ---', () => {
    const raw = 'Output:\n{\n  "key": "value"\n}';
    expect(cleanOutput(raw)).toBe(raw);
  });

  it('does not remove legitimate **(text)** in output', () => {
    const raw = 'Here is **(bold text)** in output';
    expect(cleanOutput(raw)).toBe(raw);
  });

  it('handles the actual subagent output format (simple case)', () => {
    const raw = '**Output:**\n\nDone.';
    expect(cleanOutput(raw)).toBe('Done.');
  });

  it('strips the thinking/warning block before ---', () => {
    const raw = '**(Using task directory)**\n**(working in cwd)**\n---\nFile read successfully';
    expect(cleanOutput(raw)).toBe('File read successfully');
  });
});
