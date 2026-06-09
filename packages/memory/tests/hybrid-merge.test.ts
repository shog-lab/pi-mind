/**
 * Tests for the hybrid vector + FTS5 merge (RRF) in MemoryCore.buildContext
 * and the separate mergeHybridResults() entry point.
 *
 * The vector path is exercised via a local HTTP mock that speaks Ollama's
 * /api/embed protocol. This means the test suite never needs a real Ollama
 * install and is fully deterministic — each input string maps to a
 * deterministic 16-dim unit embedding (hash-derived), so we know in
 * advance which cosine similarities will be high.
 *
 * Test design: we seed file embeddings via `embedFile` (the mock's
 * deterministic mapping means the same file content always produces the
 * same stored vector). For queries, the mock returns a different
 * embedding so we can control which file the vector path ranks first.
 * Combined with FTS5's lexical match, this gives us a clean way to make
 * vector and FTS5 disagree and verify RRF still produces a coherent
 * merged list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { MemoryCore, serializeFrontmatter } =
  (await import("../extensions/memory/core.js")) as typeof import("../extensions/memory/core.js");

// --- Mock Ollama server ---

/**
 * Deterministic embedding: 16-dim unit vector derived from sha256(input).
 * Each axis is +/- 1/sqrt(16), so |v|=1. Different inputs → different
 * vectors; identical inputs → identical vectors. Cosine similarity
 * between two distinct hashes is roughly 0, between identical is 1.0.
 */
const DIM = 16;
function embedFor(input: string): number[] {
  const hash = createHash("sha256").update(input).digest();
  const vec = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) {
    // 0-255 -> -1 or +1 (LSB)
    vec[i] = (hash[i] & 1) === 0 ? -1 / Math.sqrt(DIM) : 1 / Math.sqrt(DIM);
  }
  return vec;
}

let mockServer: Server;
let ollamaUrl: string;
let timeoutCount = 0;
let callCount = 0;

beforeEach(async () => {
  timeoutCount = 0;
  callCount = 0;
  mockServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      callCount++;
      // Simulate Ollama timeout if the path includes "slow".
      if (req.url?.includes("slow")) {
        // Never respond — let the AbortSignal.timeout(5000) on the client
        // side trip and the test will see []. We track via callCount above.
        return;
      }
      const parsed = body ? JSON.parse(body) : { input: "" };
      const input: string = parsed.input ?? "";
      const embedding = embedFor(input);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [embedding] }));
    });
    // Safety net: if handler is still hanging when test tears down,
    // abort the response so node doesn't keep the event loop alive.
    req.on("close", () => {
      if (!res.writableEnded) {
        try { res.end(); } catch {}
      }
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const addr = mockServer.address() as AddressInfo;
  ollamaUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

// --- Helpers ---

let tmpDir: string;
function writeKnowledge(name: string, body: string, meta: Record<string, string | string[]> = {}) {
  const fullMeta = { date: "2026-05-01T00:00:00Z", tier: "L2", ...meta };
  const raw = serializeFrontmatter(fullMeta as any, body);
  const fp = path.join(tmpDir, "knowledge", name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, raw);
  return fp;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-hybrid-test-"));
  fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "raw"), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ============================================================================
// mergeHybridResults — pure function tests (no I/O, no Ollama needed)
// ============================================================================

describe("mergeHybridResults (RRF)", () => {
  let mc: InstanceType<typeof MemoryCore>;
  beforeEach(() => {
    mc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, ".pi-mind-index.db"),
      freshDb: true,
    });
  });
  afterEach(() => { try { mc.close(); } catch {} });

  it("returns empty when both inputs are empty", () => {
    expect(mc.mergeHybridResults([], [])).toEqual([]);
  });

  it("ranks a doc that BOTH lists agree on above one only one list returned", () => {
    const shared = { filePath: "/x/shared.md", date: "2026-01-01", type: "user", content: "shared" };
    const onlyVector = { filePath: "/x/vec-only.md", date: "2026-01-01", type: "user", content: "vec only" };
    const onlyFts = { filePath: "/x/fts-only.md", date: "2026-01-01", type: "user", content: "fts only" };
    const vectorResults = [
      { entry: shared, score: 0.9 },
      { entry: onlyVector, score: 0.7 },
    ];
    const ftsResults = [
      { entry: shared, score: 5.0 }, // bm25 scale — wildly different
      { entry: onlyFts, score: 2.0 },
    ];
    const merged = mc.mergeHybridResults(vectorResults, ftsResults);
    // shared has the highest RRF (in both lists, rank 0 in each).
    // onlyVector and onlyFts both have RRF = 1/62 (rank 1 in one list each);
    // tie-broken by filePath ascending → fts-only < vec-only.
    expect(merged.map((r) => r.entry.filePath)).toEqual([
      "/x/shared.md",        // in both lists → highest RRF
      "/x/fts-only.md",      // rank 1 in fts; lexically first
      "/x/vec-only.md",      // rank 1 in vector; lexically second
    ]);
  });

  it("deduplicates by filePath — a doc in both lists appears exactly once", () => {
    const doc = { filePath: "/x/dup.md", date: "2026-01-01", type: "reference", content: "x" };
    const merged = mc.mergeHybridResults(
      [{ entry: doc, score: 0.5 }, { entry: doc, score: 0.4 }], // shouldn't happen but be robust
      [{ entry: doc, score: 1.0 }],
    );
    expect(merged.length).toBe(1);
    expect(merged[0].entry.filePath).toBe("/x/dup.md");
  });

  it("uses rank-based scoring, not raw score magnitude (vector score 0.001 != fts score 1000)", () => {
    // The whole point of RRF: scores are on completely different scales.
    // The shared doc has rank 0 in vector (best) and rank 2 in fts; the
    // fts-only has rank 0 in fts. Shared should win because it has BOTH
    // signals agreeing.
    const shared = { filePath: "/x/shared.md", date: "2026-01-01", type: "user", content: "s" };
    const ftsOnly = { filePath: "/x/fts.md", date: "2026-01-01", type: "user", content: "f" };
    const vectorResults = [
      { entry: shared, score: 0.001 },  // small but rank 0
      { entry: { filePath: "/x/other.md", date: "2026-01-01", type: "user", content: "o" }, score: 0.0001 },
    ];
    const ftsResults = [
      { entry: ftsOnly, score: 9999 },  // huge but only in fts
      { entry: { filePath: "/x/yet.md", date: "2026-01-01", type: "user", content: "y" }, score: 1000 },
      { entry: shared, score: 500 },    // shared at rank 2 in fts
    ];
    const merged = mc.mergeHybridResults(vectorResults, ftsResults);
    // shared: 1/61 (vector rank 0) + 1/63 (fts rank 2) ≈ 0.01639 + 0.01587 = 0.03226
    // ftsOnly: 1/61 (fts rank 0) = 0.01639
    // shared wins.
    expect(merged[0].entry.filePath).toBe("/x/shared.md");
    expect(merged[1].entry.filePath).toBe("/x/fts.md");
  });

  it("is deterministic — same inputs always produce same order", () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({
      filePath: `/x/d${i}.md`,
      date: "2026-01-01",
      type: "user" as const,
      content: `d${i}`,
    }));
    const vectorResults = docs.slice(0, 3).map((entry, i) => ({ entry, score: 0.9 - i * 0.1 }));
    const ftsResults = docs.slice(2, 5).map((entry, i) => ({ entry, score: 5 - i }));
    const a = mc.mergeHybridResults(vectorResults, ftsResults);
    const b = mc.mergeHybridResults(vectorResults, ftsResults);
    expect(a.map((r) => r.entry.filePath)).toEqual(b.map((r) => r.entry.filePath));
  });

  it("tie-breaks by filePath ascending when RRF scores are equal", () => {
    // Two docs, each in exactly one list, same rank. RRF scores are equal.
    // filePath tiebreak picks the lexically earlier one.
    const a = { filePath: "/x/zzz.md", date: "2026-01-01", type: "user", content: "z" };
    const b = { filePath: "/x/aaa.md", date: "2026-01-01", type: "user", content: "a" };
    const merged = mc.mergeHybridResults(
      [{ entry: a, score: 0.5 }],
      [{ entry: b, score: 0.5 }],
    );
    expect(merged[0].entry.filePath).toBe("/x/aaa.md");
    expect(merged[1].entry.filePath).toBe("/x/zzz.md");
  });
});

// ============================================================================
// searchVector — exercised against a real (mock) HTTP server
// ============================================================================

describe("searchVector via mock Ollama", () => {
  let mc: InstanceType<typeof MemoryCore>;
  beforeEach(() => {
    mc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, ".pi-mind-index.db"),
      freshDb: true,
      ollamaUrl,
    });
  });
  afterEach(() => { try { mc.close(); } catch {} });

  it("calls the mock server and returns hits above the similarity threshold", async () => {
    // One file; mock returns the SAME embedding for its content (used at
    // embed-time) and for the query — cosine = 1.0, well above threshold.
    writeKnowledge("a.md", "alpha bravo charlie");
    await mc.syncIndex();
    await mc.embedFile(path.join(tmpDir, "knowledge", "a.md"), "alpha bravo charlie");
    const results = await mc.searchVector("alpha bravo charlie");
    expect(results.length).toBe(1);
    expect(results[0].entry.filePath).toContain("a.md");
    expect(callCount).toBeGreaterThan(0);
  });

  it("returns [] when the query embedding has low cosine to all stored docs", async () => {
    // File content "alpha" embeds deterministically. A query that's a
    // different text embeds differently; cosine between two random unit
    // vectors is roughly 0, below the default 0.3 threshold.
    writeKnowledge("alpha.md", "alpha");
    await mc.syncIndex();
    await mc.embedFile(path.join(tmpDir, "knowledge", "alpha.md"), "alpha");
    // Query with a content that hashes to a different vector than "alpha".
    // (The mock uses input text, not stored content, so this is a real
    // independent embedding.)
    const results = await mc.searchVector("zulu yankee xray");
    expect(results).toEqual([]);
  });

  it("degrades gracefully (returns []) when the embedding server is unreachable", async () => {
    // Use a port that nothing is listening on.
    const offlineMc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, ".pi-mind-index-offline.db"),
      freshDb: true,
      ollamaUrl: "http://127.0.0.1:1", // ECONNREFUSED fast
    });
    try {
      writeKnowledge("a.md", "alpha");
      await offlineMc.syncIndex();
      await offlineMc.embedFile(path.join(tmpDir, "knowledge", "a.md"), "alpha");
      const results = await offlineMc.searchVector("alpha");
      expect(results).toEqual([]);
    } finally {
      offlineMc.close();
    }
  });
});

// ============================================================================
// buildContext — end-to-end merge with the mock server
// ============================================================================

describe("buildContext hybrid merge (e2e via mock)", () => {
  let mc: InstanceType<typeof MemoryCore>;
  beforeEach(() => {
    mc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, ".pi-mind-index.db"),
      freshDb: true,
      ollamaUrl,
    });
  });
  afterEach(() => { try { mc.close(); } catch {} });

  it("includes <long-term-memory> with hits from BOTH vector and FTS5, deduplicated", async () => {
    // Setup: TWO files. The mock uses deterministic hash(input) as the
    // embedding, so a file's stored embedding matches what the query would
    // return ONLY if query text == file content. We pick a query that
    // matches one file via vector (exact-content match → cosine 1.0) and a
    // different file via FTS5 (shared token).
    //
    // File A content: "X123-marker alpha-token foo"  (has X123-marker, no "bravo")
    // File B content: "X123-marker bravo-token bar"  (has X123-marker and bravo)
    // Query:         "X123-marker bravo-token bar"  (= B's content; matches B via vector)
    //
    //   vector: [B] only (cosine 1.0 with B, ~0 with A — different content hash)
    //   FTS5:   [A, B] (A has "X123-marker", B has both; bm25 ranks B first but A is in)
    //   merged: B (top — both signals) + A (FTS only)
    //   We assert BOTH appear in <long-term-memory>, no duplicates.
    writeKnowledge("a-fts.md", "X123-marker alpha-token foo");
    writeKnowledge("b-vec.md", "X123-marker bravo-token bar");
    await mc.syncIndex();
    await mc.embedFile(path.join(tmpDir, "knowledge", "a-fts.md"), "X123-marker alpha-token foo");
    await mc.embedFile(path.join(tmpDir, "knowledge", "b-vec.md"), "X123-marker bravo-token bar");

    const ctx = await mc.buildContext("X123-marker bravo-token bar");
    expect(ctx).toContain("<long-term-memory>");
    const ltmBlock = ctx.match(/<long-term-memory>[\s\S]*?<\/long-term-memory>/)?.[0] ?? "";
    // Both bodies present in the merged block.
    expect(ltmBlock).toContain("alpha-token");
    expect(ltmBlock).toContain("bravo-token");
    // And rendered exactly once each.
    expect((ltmBlock.match(/alpha-token/g) ?? []).length).toBe(1);
    expect((ltmBlock.match(/bravo-token/g) ?? []).length).toBe(1);
  });

  it("boosts a file that BOTH vector and FTS5 find (RRF sum)", async () => {
    // File X: contains "memory" → FTS5 hits it; its content hashes to a
    // vector that the mock returns for the query → vector also hits it.
    // File Y: contains "memory" but its content hashes to a different
    // vector → vector cosine low.
    //
    //   vector: [X]
    //   FTS5:   [X, Y]
    //
    // X has RRF = 1/61 (vector rank 0) + 1/61 (fts rank 0) = 2/61
    // Y has RRF = 1/62 (fts rank 1)
    // So X must outrank Y.
    //
    // Use unique body substrings so we can detect ordering in the rendered block.
    writeKnowledge("x-both.md", "memory something XYZQQQ-token");
    writeKnowledge("y-fts.md", "memory other thing ZZZWWW-token");
    await mc.syncIndex();
    await mc.embedFile(path.join(tmpDir, "knowledge", "x-both.md"), "memory something XYZQQQ-token");
    await mc.embedFile(path.join(tmpDir, "knowledge", "y-fts.md"), "memory other thing ZZZWWW-token");

    const ctx = await mc.buildContext("memory something XYZQQQ-token"); // same text as x-both.md
    const ltmBlock = ctx.match(/<long-term-memory>[\s\S]*?<\/long-term-memory>/)?.[0] ?? "";
    const xPos = ltmBlock.indexOf("XYZQQQ-token");
    const yPos = ltmBlock.indexOf("ZZZWWW-token");
    expect(xPos).toBeGreaterThan(-1);
    expect(yPos).toBeGreaterThan(-1);
    expect(xPos).toBeLessThan(yPos); // x-both comes before y-fts in the merged list
  });

  it("deduplicates a doc that vector and FTS5 both return (single entry in <long-term-memory>)", async () => {
    // One file. It matches BOTH retrieval signals. The merged <long-term-memory>
    // block must render its body exactly once (RRF dedup by filePath).
    writeKnowledge("only.md", "memory alpha FRENCHUNIQUE-marker");
    await mc.syncIndex();
    await mc.embedFile(path.join(tmpDir, "knowledge", "only.md"), "memory alpha FRENCHUNIQUE-marker");
    const ctx = await mc.buildContext("memory alpha FRENCHUNIQUE-marker");
    const ltmBlock = ctx.match(/<long-term-memory>[\s\S]*?<\/long-term-memory>/)?.[0] ?? "";
    const occurrences = (ltmBlock.match(/FRENCHUNIQUE-marker/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("falls back to FTS5-only when vector is unavailable (no Ollama in CI)", async () => {
    // This is the same scenario as the legacy build-context test, but
    // exercising the new merge path. No embeddings stored, no mock for
    // vector path → searchVector returns []; FTS5 still works.
    const offlineMc = new MemoryCore({
      groupDir: tmpDir,
      dbPath: path.join(tmpDir, ".pi-mind-index-offline.db"),
      freshDb: true,
      ollamaUrl: "http://127.0.0.1:1",
    });
    try {
      writeKnowledge("rust.md", "Rust ownership prevents use-after-free at compile time.", { type: "reference" });
      await offlineMc.syncIndex();
      const ctx = await offlineMc.buildContext("ownership");
      expect(ctx).toContain("Rust ownership");
      // FTS5 result is present; merge handles the empty vector list cleanly.
      // The <long-term-memory> block renders entry.content, not the file path,
      // so we assert on the rendered body.
      const ltmBlock = ctx.match(/<long-term-memory>[\s\S]*?<\/long-term-memory>/)?.[0] ?? "";
      expect(ltmBlock).toContain("Rust ownership");
    } finally {
      offlineMc.close();
    }
  });
});
