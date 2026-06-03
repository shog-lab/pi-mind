/**
 * Tests for MemoryCore (extensions/memory/core.ts).
 * Uses temp directories for isolated testing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const {
  MemoryCore,
  parseFrontmatter,
  serializeFrontmatter,
  extractLinks,
  estimateTokens,
} =
  (await import('../extensions/memory/core.js')) as typeof import('../extensions/memory/core.js');

// --- Helper ---

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

function createCore(opts?: { freshDb?: boolean }) {
  return new MemoryCore({
    groupDir: tmpDir,
    dbPath: path.join(tmpDir, '.pi-mind-index.db'),
    freshDb: opts?.freshDb ?? true,
  });
}

function writeWikiFile(
  name: string,
  content: string,
  meta?: Record<string, string | string[]>,
) {
  const fullMeta = { date: '2026-04-15T00:00:00Z', type: 'note', ...meta };
  const raw = serializeFrontmatter(fullMeta as any, content);
  const filePath = path.join(tmpDir, 'knowledge', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw);
  return filePath;
}

// --- Pure function tests ---

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', async () => {
    const { meta, body } = parseFrontmatter(
      '---\ndate: 2026-01-01\ntype: fact\ntags: [a, b]\n---\n\nContent',
    );
    expect(meta.date).toBe('2026-01-01');
    expect(meta.type).toBe('fact');
    expect(meta.tags).toEqual(['a', 'b']);
    expect(body).toBe('Content');
  });

  it('returns raw content when no frontmatter', async () => {
    const { meta, body } = parseFrontmatter('Just text');
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toBe('Just text');
  });

  it('handles empty frontmatter', async () => {
    const { meta, body } = parseFrontmatter('---\n---\n\nBody');
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toBe('Body');
  });
});

describe('serializeFrontmatter', () => {
  it('produces valid frontmatter string', async () => {
    const result = serializeFrontmatter(
      { date: '2026-01-01', type: 'fact', tags: ['a', 'b'] },
      'Content',
    );
    expect(result).toContain('---');
    expect(result).toContain('date: 2026-01-01');
    expect(result).toContain('tags: [a, b]');
    expect(result).toContain('Content');
  });

  it('roundtrips with parseFrontmatter', async () => {
    const original = { date: '2026-01-01', type: 'note' };
    const serialized = serializeFrontmatter(original, 'Body text');
    const { meta, body } = parseFrontmatter(serialized);
    expect(meta.date).toBe('2026-01-01');
    expect(meta.type).toBe('note');
    expect(body).toBe('Body text');
  });
});

describe('extractLinks', () => {
  it('extracts [[links]] from content', async () => {
    expect(extractLinks('See [[foo]] and [[bar]]')).toEqual(['foo', 'bar']);
  });

  it('returns empty for no links', async () => {
    expect(extractLinks('No links here')).toEqual([]);
  });

  it('handles links with spaces', async () => {
    expect(extractLinks('See [[agent memory]]')).toEqual(['agent memory']);
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 4 chars', async () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a')).toBe(1);
  });
});

// --- MemoryCore tests ---

describe('MemoryCore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mind-test-'));
    mc = createCore();
  });

  afterEach(() => {
    mc.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates wiki/ and raw/ directories', async () => {
      expect(fs.existsSync(path.join(tmpDir, 'knowledge'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'raw'))).toBe(true);
      // wiki/compaction/ is created on first saveMemory('compaction'), not by constructor
    });

    it('creates .pi-mind-index.db', async () => {
      expect(fs.existsSync(path.join(tmpDir, '.pi-mind-index.db'))).toBe(true);
    });
  });

  describe('saveMemory', () => {
    it('saves compaction to raw/compaction/', async () => {
      const fp = await mc.saveMemory({ type: 'compaction', primary: 'Summary text' });
      expect(fp).toContain('raw/compaction/');
      expect(fs.existsSync(fp!)).toBe(true);
    });

    it('saves other types to knowledge/ root', async () => {
      const fp = await mc.saveMemory({ type: 'user', primary: 'User likes dark mode' });
      expect(fp).toContain('/knowledge/');
      expect(fp).not.toContain('/compaction/');
      expect(fs.existsSync(fp!)).toBe(true);
    });

    it('writes valid frontmatter with type, tier, and tags', async () => {
      const fp = await mc.saveMemory({ type: 'project', primary: 'Findings', tier: 'L2', tags: ['ai', 'memory'] });
      const content = fs.readFileSync(fp!, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      expect(meta.type).toBe('project');
      expect(meta.tier).toBe('L2');
      expect(meta.tags).toEqual(['ai', 'memory']);
      expect(body).toBe('Findings');
    });

    it('renders context section when context is provided', async () => {
      const fp = await mc.saveMemory({
        type: 'agent-feedback',
        primary: 'User wants polling avoided',
        context: { userPrompt: 'nope, not polling', priorAgentMessage: 'I suggest polling' },
      });
      const content = fs.readFileSync(fp!, 'utf-8');
      expect(content).toContain('## Context');
      expect(content).toContain('nope, not polling');
      expect(content).toContain('I suggest polling');
    });

    it('dedupes by (type, primary) hash on the second write', async () => {
      const fp1 = await mc.saveMemory({ type: 'reference', primary: 'Rust ownership rules' });
      expect(fp1).toBeTruthy();
      const fp2 = await mc.saveMemory({ type: 'reference', primary: 'Rust ownership rules' });
      expect(fp2).toBeNull();
    });
  });

  describe('syncIndex + searchFTS5', () => {
    it('indexes and searches wiki files', async () => {
      writeWikiFile('test-search.md', 'Agent memory architecture overview');
      await mc.syncIndex();
      const results = mc.searchFTS5('memory architecture');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].entry.content).toContain('memory');
    });

    it('indexes files from raw/ too', async () => {
      const rawPath = path.join(tmpDir, 'raw', 'source.md');
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(
        rawPath,
        '---\ndate: 2026-01-01\ntype: note\n---\n\nOriginal source material',
      );
      await mc.syncIndex();
      const results = mc.searchFTS5('source material');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('removes deleted files from index', async () => {
      const fp = writeWikiFile('to-delete.md', 'xylophone zebra unique phrase');
      await mc.syncIndex();
      expect(mc.searchFTS5('xylophone zebra').length).toBeGreaterThanOrEqual(1);

      fs.unlinkSync(fp);
      await mc.syncIndex();
      expect(mc.searchFTS5('xylophone zebra').length).toBe(0);
    });

    it('filters stopwords', async () => {
      writeWikiFile('stopword-test.md', 'the quick brown fox');
      await mc.syncIndex();
      // "the" is a stopword, should still find by "quick" or "brown"
      const results = mc.searchFTS5('quick brown');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('applies type weights to scores', async () => {
      // type field = subject axis; valid subjects: user, project, agent-feedback, reference
      writeWikiFile('user.md', 'User prefers dark mode always', {
        type: 'user',
      });
      writeWikiFile('ref.md', 'Reference note about dark mode settings', {
        type: 'reference',
      });
      await mc.syncIndex();
      const results = mc.searchFTS5('dark mode');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const userResult = results.find((r) => r.entry.type === 'user');
      const refResult = results.find((r) => r.entry.type === 'reference');
      expect(userResult).toBeDefined();
      expect(refResult).toBeDefined();
      // user weight (1.5) should give higher score than reference (1.0)
      expect(userResult!.score).toBeGreaterThan(refResult!.score);
    });
  });

  describe('loadL1', () => {
    it('loads entries with tier: L1', async () => {
      writeWikiFile('fact1.md', 'User name is Alice', { type: 'fact', tier: 'L1' });
      writeWikiFile('user1.md', 'User prefers dark mode', { type: 'user', tier: 'L1' });
      writeWikiFile('note1.md', 'Random note', { type: 'note', tier: 'L2' });
      const l1 = mc.loadL1();
      expect(l1.length).toBe(2); // fact + user, both tier L1
      const types = l1.map((e) => e.type);
      expect(types).toContain('fact');
      expect(types).toContain('user');
      expect(types).not.toContain('note');
    });

    it('scans recursively (compaction/ subdirectory)', async () => {
      // compaction entries should not be L1 (tier=L2)
      await mc.saveMemory({ type: 'compaction', primary: 'A conversation summary' });
      const l1 = mc.loadL1();
      expect(l1.every((e) => e.type !== 'compaction')).toBe(true);
    });
  });

  describe('auto-heal frontmatter', () => {
    it('adds frontmatter to files without it', async () => {
      const fp = path.join(tmpDir, 'knowledge', 'no-frontmatter.md');
      fs.writeFileSync(fp, 'Just plain text, no frontmatter');
      await mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      expect(healed.startsWith('---')).toBe(true);
      const { meta } = parseFrontmatter(healed);
      expect(meta.type).toBe('note');
      expect(meta.tags).toContain('auto-healed');
    });

    it('adds missing type and tier fields', async () => {
      const fp = path.join(tmpDir, 'knowledge', 'no-type.md');
      fs.writeFileSync(
        fp,
        '---\ndate: 2026-01-01\n---\n\nContent without type',
      );
      await mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      const { meta } = parseFrontmatter(healed);
      expect(meta.type).toBe('note');
      expect(meta.tier).toBe('L2'); // non-L1 type defaults to L2
    });

    it('adds missing date field', async () => {
      const fp = path.join(tmpDir, 'knowledge', 'no-date.md');
      fs.writeFileSync(fp, '---\ntype: fact\n---\n\nContent without date');
      await mc.syncIndex();
      const healed = fs.readFileSync(fp, 'utf-8');
      const { meta } = parseFrontmatter(healed);
      expect(meta.date).toBeTruthy();
    });
  });

  describe('[[link]] resolution', () => {
    it('resolves exact slug match', async () => {
      writeWikiFile('agent-memory.md', 'About agent memory');
      await mc.syncIndex();
      const resolved = mc.resolveLink('agent-memory');
      expect(resolved).not.toBeNull();
      expect(resolved).toContain('agent-memory.md');
    });

    it('resolves linked content', async () => {
      writeWikiFile('page-a.md', 'See [[page-b]] for more');
      writeWikiFile('page-b.md', 'Linked page content here');
      await mc.syncIndex();
      const linked = mc.resolveLinkedContent('See [[page-b]] for more');
      expect(linked.length).toBe(1);
      expect(linked[0].content).toContain('Linked page content');
    });

    it('returns empty for broken links', async () => {
      await mc.syncIndex();
      expect(mc.resolveLink('nonexistent')).toBeNull();
    });
  });

  describe('generateIndex', () => {
    it('auto-generates wiki/index.md', async () => {
      writeWikiFile('foo.md', 'Foo content');
      writeWikiFile('bar.md', 'Bar content');
      await mc.syncIndex();
      const indexPath = path.join(tmpDir, 'knowledge', 'index.md');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('[[foo]]');
      expect(content).toContain('[[bar]]');
    });
  });

  describe('buildContext', () => {
    it('includes L1 memories', async () => {
      writeWikiFile('fact.md', 'User is a developer', { type: 'fact' });
      await mc.syncIndex();
      const ctx = await mc.buildContext('anything');
      expect(ctx).toContain('critical-memory');
      expect(ctx).toContain('developer');
    });

    it('includes search results', async () => {
      writeWikiFile(
        'research.md',
        'Agent memory survey findings on retrieval',
        { type: 'research' },
      );
      await mc.syncIndex();
      const ctx = await mc.buildContext('memory retrieval');
      expect(ctx).toContain('long-term-memory');
      expect(ctx).toContain('retrieval');
    });

    it('includes KG when entities match', async () => {
      mc.kg.addTriple('Alice', 'works_at', 'CompanyX');
      writeWikiFile('dummy.md', 'Placeholder');
      await mc.syncIndex();
      const ctx = await mc.buildContext('What does Alice do');
      expect(ctx).toContain('knowledge-graph');
      expect(ctx).toContain('CompanyX');
    });
  });

  describe('buildKGContext', () => {
    it('delegates to kg.buildContext', async () => {
      mc.kg.addTriple('Bob', 'likes', 'Coffee');
      const ctx = mc.buildKGContext('Tell me about Bob');
      expect(ctx).toContain('Coffee');
    });
  });

});
