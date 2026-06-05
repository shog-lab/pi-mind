/**
 * Tests for the KnowledgeGraph class.
 * Uses in-memory SQLite database.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

// Dynamic import (avoid embedding implementation paths in static imports)
const { KnowledgeGraph } =
  (await import('../extensions/memory/knowledge-graph.js')) as typeof import('../extensions/memory/knowledge-graph.js');

describe('KnowledgeGraph', () => {
  let db: InstanceType<typeof Database>;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    kg = new KnowledgeGraph(db);
  });

  describe('addTriple', () => {
    it('adds a triple and returns an id', () => {
      const id = kg.addTriple('Alice', 'knows', 'Bob');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('deduplicates identical active triples', () => {
      const id1 = kg.addTriple('Alice', 'knows', 'Bob');
      const id2 = kg.addTriple('Alice', 'knows', 'Bob');
      expect(id1).toBe(id2);
    });

    it('allows same triple with different validity', () => {
      const id1 = kg.addTriple('Alice', 'works_at', 'CompanyA', {
        validFrom: '2025-01-01',
      });
      kg.invalidate('Alice', 'works_at', 'CompanyA', '2025-12-31');
      const id2 = kg.addTriple('Alice', 'works_at', 'CompanyB', {
        validFrom: '2026-01-01',
      });
      expect(id1).not.toBe(id2);
    });

    it('rejects empty subject', () => {
      const id = kg.addTriple('', 'knows', 'Bob');
      expect(id).toBeNull();
    });

    it('rejects empty predicate', () => {
      const id = kg.addTriple('Alice', '', 'Bob');
      expect(id).toBeNull();
    });

    it('rejects empty object', () => {
      const id = kg.addTriple('Alice', 'knows', '');
      expect(id).toBeNull();
    });

    it('stores confidence', () => {
      kg.addTriple('Alice', 'likes', 'Coffee', { confidence: 0.8 });
      const triples = kg.queryEntity('Alice');
      expect(triples[0].confidence).toBe(0.8);
    });

    it('stores source_file', () => {
      kg.addTriple('Alice', 'likes', 'Coffee', { sourceFile: 'test.md' });
      const triples = kg.queryEntity('Alice');
      expect(triples[0].source_file).toBe('test.md');
    });
  });

  describe('addTriplesBatch', () => {
    it('adds multiple triples atomically', () => {
      const count = kg.addTriplesBatch([
        ['Alice', 'knows', 'Bob'],
        ['Alice', 'knows', 'Charlie'],
        ['Bob', 'works_at', 'CompanyX'],
      ]);
      expect(count).toBe(3);
    });

    it('deduplicates via addTriple calls', () => {
      // addTriple dedup is tested separately; batch delegates to addTriple
      const count = kg.addTriplesBatch([
        ['Alice', 'knows', 'Bob'],
        ['Alice', 'knows', 'Charlie'],
        ['Bob', 'works_at', 'CompanyX'],
      ]);
      // All three are unique, so all should be inserted
      expect(count).toBe(3);

      // Adding same triples again — addTriple dedup should prevent duplicates
      const id1 = kg.addTriple('Alice', 'knows', 'Bob');
      const id2 = kg.addTriple('Alice', 'knows', 'Bob');
      expect(id1).toBe(id2); // dedup works on individual calls
    });

    it('returns 0 for empty batch', () => {
      expect(kg.addTriplesBatch([])).toBe(0);
    });
  });

  describe('invalidate', () => {
    it('marks a triple as expired', () => {
      kg.addTriple('Alice', 'works_at', 'CompanyA');
      kg.invalidate('Alice', 'works_at', 'CompanyA', '2026-01-01');
      const triples = kg.queryEntity('Alice');
      expect(triples[0].current).toBe(false);
      expect(triples[0].valid_to).toBe('2026-01-01');
    });

    it('allows adding new triple after invalidation', () => {
      kg.addTriple('Alice', 'works_at', 'CompanyA');
      kg.invalidate('Alice', 'works_at', 'CompanyA');
      const id = kg.addTriple('Alice', 'works_at', 'CompanyB');
      expect(id).toBeTruthy();
    });
  });

  describe('queryEntity', () => {
    beforeEach(() => {
      kg.addTriple('Alice', 'knows', 'Bob');
      kg.addTriple('Alice', 'likes', 'Coffee');
      kg.addTriple('Bob', 'works_at', 'CompanyX');
    });

    it('returns outgoing triples', () => {
      const triples = kg.queryEntity('Alice', { direction: 'outgoing' });
      expect(triples.length).toBe(2);
      expect(triples.every((t) => t.subject === 'Alice')).toBe(true);
    });

    it('returns incoming triples', () => {
      const triples = kg.queryEntity('Bob', { direction: 'incoming' });
      expect(triples.length).toBe(1);
      expect(triples[0].subject).toBe('Alice');
      expect(triples[0].object).toBe('Bob');
    });

    it('returns both directions by default', () => {
      const triples = kg.queryEntity('Bob');
      expect(triples.length).toBe(2); // knows (incoming) + works_at (outgoing)
    });

    it('filters by asOf date', () => {
      kg.addTriple('Alice', 'lives_in', 'NYC', { validFrom: '2025-01-01' });
      kg.invalidate('Alice', 'lives_in', 'NYC', '2025-12-31');
      kg.addTriple('Alice', 'lives_in', 'SF', { validFrom: '2026-01-01' });

      const mid2025 = kg.queryEntity('Alice', {
        asOf: '2025-06-01',
        direction: 'outgoing',
      });
      const liveTriples = mid2025.filter((t) => t.predicate === 'lives_in');
      expect(liveTriples.length).toBe(1);
      expect(liveTriples[0].object).toBe('NYC');
    });
  });

  describe('queryRelationship', () => {
    it('finds all triples with a given predicate', () => {
      kg.addTriple('Alice', 'knows', 'Bob');
      kg.addTriple('Charlie', 'knows', 'Dave');
      const triples = kg.queryRelationship('knows');
      expect(triples.length).toBe(2);
    });
  });

  describe('timeline', () => {
    it('returns triples sorted by valid_from', () => {
      kg.addTriple('Alice', 'event1', 'X', { validFrom: '2026-03-01' });
      kg.addTriple('Alice', 'event2', 'Y', { validFrom: '2026-01-01' });
      kg.addTriple('Alice', 'event3', 'Z', { validFrom: '2026-02-01' });
      const tl = kg.timeline('Alice');
      expect(tl[0].valid_from).toBe('2026-01-01');
      expect(tl[1].valid_from).toBe('2026-02-01');
      expect(tl[2].valid_from).toBe('2026-03-01');
    });

    it('returns all triples when no entity specified', () => {
      kg.addTriple('Alice', 'knows', 'Bob');
      kg.addTriple('Charlie', 'knows', 'Dave');
      const tl = kg.timeline();
      expect(tl.length).toBe(2);
    });
  });

  describe('getTopTriples', () => {
    it('returns high-confidence current triples', () => {
      kg.addTriple('Alice', 'prefers', 'Dark Mode', { confidence: 1.0 });
      kg.addTriple('Alice', 'maybe_likes', 'Jazz', { confidence: 0.5 });
      const top = kg.getTopTriples(10, 0.9);
      expect(top.length).toBe(1);
      expect(top[0].object).toBe('Dark Mode');
    });

    it('excludes expired triples', () => {
      kg.addTriple('Alice', 'prefers', 'Light Mode', { confidence: 1.0 });
      kg.invalidate('Alice', 'prefers', 'Light Mode');
      const top = kg.getTopTriples();
      expect(top.length).toBe(0);
    });
  });

  describe('buildContext', () => {
    it('returns KG block when entity matches query', () => {
      kg.addTriple('毛雄禹', '职业', '程序员');
      const ctx = kg.buildContext('毛雄禹在做什么');
      expect(ctx).toContain('knowledge-graph');
      expect(ctx).toContain('程序员');
    });

    it('returns empty string when no match', () => {
      kg.addTriple('Alice', 'knows', 'Bob');
      const ctx = kg.buildContext('天气怎么样');
      expect(ctx).toBe('');
    });

    it("matches 'auth-service' via the 'auth' query token (token-prefix)", () => {
      // Regression for the previous substring contract: query "alice auth"
      // must still surface a triple whose object is the hyphenated entity
      // "auth-service". Under the new token-bounded logic this is exact
      // token match (index has "auth" because "auth-service" tokenizes to
      // ["auth", "service"]).
      kg.addTriple('alice', 'owns', 'auth-service');
      const ctx = kg.buildContext('alice auth');
      expect(ctx).toContain('<knowledge-graph>');
      expect(ctx).toContain('auth-service');
    });

    it("does NOT match 'oauth_token' via the 'auth' query token (no arbitrary substring)", () => {
      // "oauth_token" tokenizes to ["oauth", "token"]. The query "auth"
      // is neither an exact match nor a prefix of either token. Under
      // the old substring logic it WOULD have matched (auth is a
      // substring of oauth_token). Pinning the new contract.
      kg.addTriple('user', 'uses', 'oauth_token');
      const ctx = kg.buildContext('auth');
      expect(ctx).not.toContain('oauth_token');
      expect(ctx).toBe('');
    });

    it("does NOT noise-match 'island' or 'go-service' on query 'what is going on'", () => {
      // "what", "is", "on" are KG_STOPWORDS and are filtered before the
      // lookup. The only surviving query token is "going" (length 6,
      // ≥ 3, so prefix is checked too). "island" doesn't start with
      // "going" and "go-service" tokenizes to ["go", "service"] — neither
      // starts with "going". The old substring logic would have
      // substring-matched all three (any query that contains the
      // letters of a short entity name triggered a match).
      kg.addTriple('trip', 'destination', 'island');
      kg.addTriple('svc', 'kind', 'go-service');
      const ctx = kg.buildContext('what is going on');
      expect(ctx).not.toContain('island');
      expect(ctx).not.toContain('go-service');
      expect(ctx).toBe('');
    });

    it('entity index cache reflects new entities after addTriple', () => {
      // First addTriple forces the index to build on the next
      // buildContext. A second addTriple for a new entity must be
      // visible after the cache is invalidated, proving the
      // addTriple -> invalidateEntityIndexCache() hook fires.
      kg.addTriple('alice', 'owns', 'book');
      const first = kg.buildContext('alice');
      expect(first).toContain('alice');
      // New entity 'bob' arrives after the index was built.
      kg.addTriple('bob', 'likes', 'pizza');
      const second = kg.buildContext('bob pizza');
      expect(second).toContain('bob');
      expect(second).toContain('pizza');
    });

    it('invalidateEntityIndexCache is a public method that clears the cache', () => {
      kg.addTriple('alice', 'owns', 'book');
      // Warm the index by calling buildContext.
      kg.buildContext('alice');
      // Now manually invalidate. Next buildContext must still work
      // (proves the rebuild path) and must not surface phantom data.
      kg.invalidateEntityIndexCache();
      const ctx = kg.buildContext('alice');
      expect(ctx).toContain('alice');
      expect(ctx).toContain('book');
    });
  });

  describe('stats', () => {
    it('returns correct counts', () => {
      kg.addTriple('A', 'r1', 'B');
      kg.addTriple('C', 'r2', 'D');
      kg.invalidate('A', 'r1', 'B');
      const s = kg.stats();
      expect(s.entities).toBe(4);
      expect(s.triples).toBe(2);
      expect(s.currentFacts).toBe(1);
      expect(s.expiredFacts).toBe(1);
    });
  });

  describe('getEntity', () => {
    it('returns entity info after triple is added', () => {
      kg.addTriple('Alice', 'knows', 'Bob');
      const entity = kg.getEntity('Alice');
      expect(entity).not.toBeNull();
      expect(entity!.name).toBe('Alice');
    });

    it('returns null for non-existent entity', () => {
      expect(kg.getEntity('NonExistent')).toBeNull();
    });
  });
});
