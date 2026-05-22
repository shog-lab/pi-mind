/**
 * Tests for MemoryCore.buildContext — the hybrid retrieval entry point
 * shared by the before_agent_start hook and the recall_memory tool.
 *
 * These tests only exercise the FTS5-fallback path (we don't have a running
 * Ollama in CI for embeddings). The skipL1 option is the main contract here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const { MemoryCore, serializeFrontmatter } = (await import(
  '../extensions/memory/core.js'
)) as typeof import('../extensions/memory/core.js');

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

function createCore() {
  return new MemoryCore({
    groupDir: tmpDir,
    dbPath: path.join(tmpDir, '.pi-mind-index.db'),
    freshDb: true,
  });
}

function writeKnowledge(name: string, body: string, meta: Record<string, string | string[]>) {
  const fullMeta = { date: '2026-05-01T00:00:00Z', tier: 'L2', ...meta };
  const raw = serializeFrontmatter(fullMeta as any, body);
  const fp = path.join(tmpDir, 'knowledge', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, raw);
  return fp;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mind-buildctx-test-'));
  fs.mkdirSync(path.join(tmpDir, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
  mc = createCore();
});

afterEach(() => {
  try { mc.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('buildContext', () => {
  it('returns empty string when nothing in the store', async () => {
    await mc.syncIndex();
    const ctx = await mc.buildContext('anything');
    expect(ctx).toBe('');
  });

  it('includes <critical-memory> by default for L1 entries', async () => {
    writeKnowledge('pref.md', 'User prefers ripgrep over grep', { type: 'user', tier: 'L1' });
    await mc.syncIndex();
    const ctx = await mc.buildContext('ripgrep');
    expect(ctx).toContain('<critical-memory>');
    expect(ctx).toContain('ripgrep');
  });

  it('omits <critical-memory> when skipL1=true', async () => {
    writeKnowledge('pref.md', 'User prefers ripgrep over grep', { type: 'user', tier: 'L1' });
    await mc.syncIndex();
    const ctx = await mc.buildContext('ripgrep', { skipL1: true });
    expect(ctx).not.toContain('<critical-memory>');
    // The L1 entry should still be dedup'd out of L2 results (it's already in agent context).
    // With only one entry and skipL1, the function returns "" since nothing else qualifies.
    expect(ctx).toBe('');
  });

  it('returns L2 long-term-memory hits via FTS5 fallback when vector is unavailable', async () => {
    writeKnowledge('rust.md', 'Rust ownership prevents use-after-free at compile time.', { type: 'reference' });
    await mc.syncIndex();
    const ctx = await mc.buildContext('ownership');
    // No Ollama in tests → vector returns []; FTS5 picks up the keyword.
    expect(ctx).toContain('Rust ownership');
  });

  it('surfaces a linked page when the parent is retrieved (FTS5-only path)', async () => {
    // To deterministically exercise the [[link]] expansion path we disable
    // the vector pipeline by pointing the embed URL at an unreachable port.
    // Without this, vector search may semantically match the child page too
    // and dedup it out of the linked-pages block — a correct outcome but
    // one that hides the [[link]] mechanism from this specific assertion.
    const offlineMc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, '.pi-mind-index-offline.db'),
      freshDb: true,
      ollamaUrl: 'http://127.0.0.1:1', // unreachable
    });
    writeKnowledge('parent.md', 'This builds on [[child-fact]] and supersedes nothing.', { type: 'reference' });
    writeKnowledge('child-fact.md', 'Child fact body.', { type: 'reference' });
    await offlineMc.syncIndex();
    const ctx = await offlineMc.buildContext('builds on');
    expect(ctx).toContain('builds on');           // parent via FTS5
    expect(ctx).toContain('<linked-pages>');      // [[link]] expansion section
    expect(ctx).toContain('child-fact');          // slug header
    expect(ctx).toContain('Child fact body');     // body
    offlineMc.close();
  });

  it('emits <knowledge-graph> block when query mentions a KG entity', async () => {
    writeKnowledge('alice-owns.md', 'Alice owns the auth-service.', {
      type: 'project',
      triples: '[["alice", "owns", "auth-service"]]',
    });
    await mc.syncIndex();
    const ctx = await mc.buildContext('who is alice');
    expect(ctx).toContain('<knowledge-graph>');
    expect(ctx).toContain('alice');
    expect(ctx).toContain('owns');
    expect(ctx).toContain('auth-service');
  });
});
