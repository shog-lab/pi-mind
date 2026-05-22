/**
 * Tests for lib/skill-evolution.ts — writeSkill validates names, lays out
 * the file on disk under .pi/skills/<name>/SKILL.md, and backs up any
 * pre-existing live version to a same-dir timestamped .bak.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const { writeSkill } = (await import('../lib/skill-evolution.js')) as typeof import('../lib/skill-evolution.js');

let tmpDir: string;
function hostRoot() { return tmpDir; }

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mind-skill-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('writeSkill name validation', () => {
  it('rejects empty / uppercase / underscored / leading-digit names', () => {
    const cases = ['', 'Foo', 'foo_bar', '2skill', 'foo bar', 'foo/bar', 'a'.repeat(65)];
    for (const name of cases) {
      const r = writeSkill({ name, description: 'd', body: 'b', hostRoot: hostRoot() });
      expect(r.ok, `expected reject for ${JSON.stringify(name)}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid-name');
    }
  });

  it('accepts kebab-case names starting with a letter', () => {
    const cases = ['foo', 'foo-bar', 'a', 'foo-bar-baz-2', 'a'.repeat(64)];
    for (const name of cases) {
      const r = writeSkill({ name, description: 'd', body: 'b', hostRoot: hostRoot() });
      expect(r.ok, `expected accept for ${JSON.stringify(name)}`).toBe(true);
    }
  });
});

describe('writeSkill file output', () => {
  it('creates .pi/skills/<name>/SKILL.md with valid frontmatter + body', () => {
    const r = writeSkill({
      name: 'deploy-staging',
      description: 'Push the current branch to the staging environment.',
      body: '# Deploy Staging\n\nSteps...',
      hostRoot: hostRoot(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = path.join(tmpDir, '.pi', 'skills', 'deploy-staging', 'SKILL.md');
    expect(r.path).toBe(expected);
    const content = fs.readFileSync(expected, 'utf-8');
    expect(content).toContain('name: deploy-staging');
    expect(content).toContain('description: "Push the current branch to the staging environment."');
    expect(content).toContain('# Deploy Staging');
    // Trailing newline normalized
    expect(content.endsWith('\n')).toBe(true);
  });

  it('JSON-escapes a description containing quotes / colons', () => {
    const r = writeSkill({
      name: 'x',
      description: 'has: colon, comma, and "quotes"',
      body: 'b',
      hostRoot: hostRoot(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = fs.readFileSync(r.path, 'utf-8');
    // JSON.stringify produces "has: colon, comma, and \"quotes\""
    expect(content).toContain('"has: colon, comma, and \\"quotes\\""');
  });
});

describe('writeSkill backup on overwrite', () => {
  it('writes a .bak when the live file already exists', () => {
    const first = writeSkill({ name: 'foo', description: 'v1', body: 'body v1', hostRoot: hostRoot() });
    expect(first.ok).toBe(true);

    // tick the clock so the bak filename is deterministic
    const later = new Date('2026-05-21T10:00:00.000Z');
    const second = writeSkill({ name: 'foo', description: 'v2', body: 'body v2', hostRoot: hostRoot(), now: later });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.backedUpTo).toBeTruthy();
    expect(second.backedUpTo!.endsWith('SKILL.md.bak.2026-05-21T10-00-00-000Z')).toBe(true);
    // bak holds v1
    expect(fs.readFileSync(second.backedUpTo!, 'utf-8')).toContain('body v1');
    // live holds v2
    expect(fs.readFileSync(second.path, 'utf-8')).toContain('body v2');
  });

  it('omits backedUpTo when nothing existed before', () => {
    const r = writeSkill({ name: 'fresh', description: 'd', body: 'b', hostRoot: hostRoot() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backedUpTo).toBeUndefined();
  });
});

describe('writeSkill package-conflict guard', () => {
  it('refuses to overwrite when .pi/skills/<name> is a symlink', () => {
    // Stage: simulate an installed-package skill by making the target a symlink
    const symlinkSrc = path.join(tmpDir, 'pkg-skill-source');
    fs.mkdirSync(symlinkSrc, { recursive: true });
    fs.writeFileSync(path.join(symlinkSrc, 'SKILL.md'), '---\nname: pkg-skill\ndescription: from package\n---\nbody');
    const skillsDir = path.join(tmpDir, '.pi', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(symlinkSrc, path.join(skillsDir, 'pkg-skill'));

    const r = writeSkill({ name: 'pkg-skill', description: 'agent override', body: 'agent body', hostRoot: hostRoot() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('package-conflict');
    // Symlinked file is intact
    expect(fs.readFileSync(path.join(symlinkSrc, 'SKILL.md'), 'utf-8')).toContain('from package');
  });
});
