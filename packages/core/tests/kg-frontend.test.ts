/**
 * Tests for the KG-from-frontmatter design (Batch 1):
 *   - parseTriplesFromFrontmatter is a pure function: file content in, [s,p,o][] out.
 *   - rebuildKGFromFiles wipes kg_triples + kg_entities and re-derives from
 *     each .md file's frontmatter.
 *   - remember_this with triples writes them into frontmatter; syncIndex
 *     re-derives kg_* so buildContext's KG block sees them.
 *   - Modifying a file's frontmatter triples is reflected after the next
 *     syncIndex (stale triples are cleared, not accumulated).
 *   - Deleting a file removes its triples (no orphans in kg_triples).
 *   - No `autoExtractTriples`: nothing in the body regex matters; only
 *     frontmatter `triples:` counts.
 *   - validateTriples (schema.ts) rejects malformed shapes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { MemoryCore, parseTriplesFromFrontmatter, serializeFrontmatter } =
  (await import("../extensions/memory/core.js")) as typeof import("../extensions/memory/core.js");

const { validateTriples } =
  (await import("../lib/schema.js")) as typeof import("../lib/schema.js");

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-kg-test-"));
  fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "raw"), { recursive: true });
  mc = new MemoryCore({
    groupDir: tmpDir,
    dbPath: path.join(tmpDir, ".pi-mind-index.db"),
    freshDb: true,
  });
});

afterEach(() => {
  try { mc.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeKnowledge(name: string, body: string, meta: Record<string, unknown> = {}) {
  const fullMeta = { date: "2026-05-01T00:00:00Z", tier: "L2", ...meta };
  const raw = serializeFrontmatter(fullMeta as any, body);
  const fp = path.join(tmpDir, "knowledge", name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, raw);
  return fp;
}

// =============================================================================
// Pure parser tests (parseTriplesFromFrontmatter)
// =============================================================================

describe("parseTriplesFromFrontmatter", () => {
  it("returns [] for content without a frontmatter", () => {
    expect(mc.parseTriplesFromFrontmatter("just plain text\nno yaml here")).toEqual([]);
  });

  it("returns [] for frontmatter without a triples field", () => {
    const raw = "---\ndate: 2026-01-01\ntype: user\n---\n\nBody";
    expect(mc.parseTriplesFromFrontmatter(raw)).toEqual([]);
  });

  it("parses a valid triples JSON array", () => {
    const raw = `---
date: 2026-01-01
type: project
triples: [["alice", "owns", "auth-service"], ["alice", "role", "engineer"]]
---

Body`;
    expect(mc.parseTriplesFromFrontmatter(raw)).toEqual([
      ["alice", "owns", "auth-service"],
      ["alice", "role", "engineer"],
    ]);
  });

  it("skips malformed entries (empty string, wrong arity, non-string) without throwing", () => {
    const raw = `---
triples: [["good", "one", "ok"], ["", "empty-subj", "x"], ["a"], "not-an-array", ["b", "c", "d", "e"]]
---`;
    const out = mc.parseTriplesFromFrontmatter(raw);
    expect(out).toEqual([["good", "one", "ok"]]);
  });

  it("returns [] on invalid JSON in the triples field", () => {
    const raw = `---
triples: this is not json
---`;
    expect(mc.parseTriplesFromFrontmatter(raw)).toEqual([]);
  });
});

// =============================================================================
// validateTriples (schema.ts)
// =============================================================================

describe("validateTriples (schema.ts)", () => {
  it("accepts a well-formed 3-tuple array", () => {
    const r = validateTriples([["alice", "owns", "x"]]);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts undefined (no triples is valid)", () => {
    expect(validateTriples(undefined).valid).toBe(true);
  });

  it("rejects non-array input", () => {
    expect(validateTriples("triples").valid).toBe(false);
    expect(validateTriples({ triples: [] }).valid).toBe(false);
  });

  it("rejects entries that are not 3-element arrays", () => {
    expect(validateTriples([["a", "b"]]).valid).toBe(false);
    expect(validateTriples([["a", "b", "c", "d"]]).valid).toBe(false);
    expect(validateTriples([["a", "b"]]).errors[0]).toMatch(/exactly 3 elements/);
  });

  it("rejects entries with non-string elements", () => {
    expect(validateTriples([["a", "b", 3]]).valid).toBe(false);
    expect(validateTriples([["a", null, "c"]]).valid).toBe(false);
  });

  it("rejects empty-string subject/predicate/object", () => {
    expect(validateTriples([["", "b", "c"]]).valid).toBe(false);
    expect(validateTriples([["a", "", "c"]]).valid).toBe(false);
    expect(validateTriples([["a", "b", ""]]).valid).toBe(false);
  });
});

// =============================================================================
// rebuildKGFromFiles + syncIndex integration
// =============================================================================

describe("rebuildKGFromFiles", () => {
  it("starts empty: 0 entities, 0 triples", () => {
    expect(mc.kg.stats()).toEqual({ entities: 0, triples: 0, currentFacts: 0, expiredFacts: 0 });
  });

  it("rebuilds triples from frontmatter and creates entities", async () => {
    writeKnowledge("alice.md", "Alice owns the auth service.", {
      type: "project",
      triples: '[["alice", "owns", "auth-service"]]',
    });
    writeKnowledge("bob.md", "Bob is an engineer.", {
      type: "project",
      triples: '[["bob", "role", "engineer"], ["bob", "knows", "alice"]]',
    });
    await mc.syncIndex();
    const stats = mc.kg.stats();
    expect(stats.triples).toBe(3);
    // entities: alice, auth-service, bob, engineer → 4
    expect(stats.entities).toBeGreaterThanOrEqual(3);
  });

  it("source_file is recorded on each triple (rebuild derived from .md)", async () => {
    const fp = writeKnowledge("src.md", "x", {
      type: "reference",
      triples: '[["alpha", "rel", "beta"]]',
    });
    await mc.syncIndex();
    const triples = mc.kg.queryEntity("alpha");
    expect(triples.length).toBe(1);
    expect(triples[0].source_file).toBe(fp);
  });
});

describe("KG re-derives correctly across file mutations", () => {
  it("changing a file's frontmatter triples is reflected after syncIndex (no drift)", async () => {
    const fp = writeKnowledge("mut.md", "Original.", {
      type: "project",
      triples: '[["x", "owns", "y"]]',
    });
    await mc.syncIndex();
    expect(mc.kg.queryEntity("x").some((t) => t.object === "y")).toBe(true);

    // Rewrite the file: triple now points to z, not y.
    const newRaw = serializeFrontmatter(
      { date: "2026-05-01T00:00:00Z", type: "project", tier: "L2", triples: '[["x", "owns", "z"]]' } as any,
      "Rewritten.",
    );
    fs.writeFileSync(fp, newRaw);
    await mc.syncIndex();

    const xTriples = mc.kg.queryEntity("x");
    // Stale y triple is GONE; only z remains.
    expect(xTriples.some((t) => t.object === "y")).toBe(false);
    expect(xTriples.some((t) => t.object === "z")).toBe(true);
  });

  it("deleting a file removes its triples (no orphans)", async () => {
    const fp = writeKnowledge("del.md", "to be deleted", {
      type: "project",
      triples: '[["orphan-test", "rel", "leaf"]]',
    });
    await mc.syncIndex();
    expect(mc.kg.queryEntity("orphan-test").length).toBeGreaterThan(0);
    fs.unlinkSync(fp);
    await mc.syncIndex();
    expect(mc.kg.queryEntity("orphan-test").length).toBe(0);
  });

  it("vacuum removes orphan entities (no longer referenced by any triple)", async () => {
    writeKnowledge("a.md", "x", {
      type: "reference",
      triples: '[["alpha-vac", "owns", "beta-vac"]]',
    });
    await mc.syncIndex();
    expect(mc.kg.getEntity("alpha-vac")).not.toBeNull();
    expect(mc.kg.getEntity("beta-vac")).not.toBeNull();

    // Remove the file; next sync should vacuum both entities.
    fs.unlinkSync(path.join(tmpDir, "knowledge", "a.md"));
    await mc.syncIndex();
    expect(mc.kg.getEntity("alpha-vac")).toBeNull();
    expect(mc.kg.getEntity("beta-vac")).toBeNull();
  });

  it("body content does NOT contribute to KG (no autoExtractTriples regression)", async () => {
    // Pre-0.8.0 autoExtractTriples would have created a triple for any
    // "I bought/started/owned X" pattern. Verify that body text alone
    // does NOT produce triples.
    writeKnowledge("bodyonly.md", "I bought a red quokka plushie on Tuesday.", {
      type: "user",
      // No triples field at all
    });
    await mc.syncIndex();
    expect(mc.kg.stats().triples).toBe(0);
  });
});

describe("remember_this with triples \u2014 end-to-end via buildContext", () => {
  it("saving a memory with triples makes them appear in the next sync's KG index", async () => {
    await mc.saveMemory({
      type: "project",
      primary: "Alice owns the auth service end-to-end-marker",
      triples: [["alice", "owns", "auth-service-e2e"]],
    });
    // Before sync: KG is empty (saveMemory just writes the .md file).
    expect(mc.kg.stats().triples).toBe(0);

    // After sync: triples appear.
    await mc.syncIndex();
    const aliceTriples = mc.kg.queryEntity("alice");
    expect(aliceTriples.some((t) => t.object === "auth-service-e2e")).toBe(true);
  });

  it("buildContext renders the <knowledge-graph> block when a query hits a triple entity", async () => {
    await mc.saveMemory({
      type: "project",
      primary: "Alice owns the auth service context-marker",
      triples: [["alice", "owns", "auth-service-ctx"]],
    });
    await mc.syncIndex();
    const ctx = await mc.buildContext("alice auth");
    // KG block is in the rendered context
    expect(ctx).toContain("<knowledge-graph>");
    expect(ctx).toContain("alice");
    expect(ctx).toContain("owns");
    expect(ctx).toContain("auth-service-ctx");
  });

  it("a memory without triples does NOT produce any KG entry (even if body would have triggered the old autoExtract)", async () => {
    await mc.saveMemory({
      type: "user",
      primary: "I started to think about the auth service no-triple-marker",
      // No triples.
    });
    await mc.syncIndex();
    expect(mc.kg.stats().triples).toBe(0);
  });

  it("KG triples persist across re-index (idempotent rebuild)", async () => {
    await mc.saveMemory({
      type: "project",
      primary: "Idempotent rebuild marker line",
      triples: [["idempotent-entity", "rel", "idempotent-leaf"]],
    });
    await mc.syncIndex();
    const firstStats = mc.kg.stats();
    expect(firstStats.triples).toBe(1);

    // Run syncIndex again; the wipe+rebuild should produce the same state.
    await mc.syncIndex();
    const secondStats = mc.kg.stats();
    expect(secondStats.triples).toBe(1);
    expect(secondStats.entities).toBe(firstStats.entities);
  });
});

// =============================================================================
// KG Batch 1 review fixes — regression tests for the 6 issues alice flagged
// =============================================================================

describe("KG ingest restricted to knowledgeDir (raw/compaction is NOT a KG source)", () => {
  it("a raw/compaction entry with a `triples:` field does NOT contribute to the KG", async () => {
    // Pre-0.8.0 we would have indexed raw/compaction triples too. After
    // the Batch 1 review: knowledgeDir is the sole KG source. Even if a
    // compaction file hand-declares triples in its frontmatter, those
    // must be ignored for KG purposes.
    const compDir = path.join(tmpDir, "raw", "compaction");
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(
      path.join(compDir, "compaction-with-triples.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: compaction\ntier: L2\ntriples: [["should-not-index", "from", "compaction"]]\n---\n\nConversation summary mentioning random stuff.`,
    );
    await mc.syncIndex();
    // The compaction file is indexed for FTS5/vector (currentFiles includes it),
    // but its triples must NOT enter the KG.
    expect(mc.kg.queryEntity("should-not-index").length).toBe(0);
    expect(mc.kg.queryEntity("compaction").length).toBe(0);
  });

  it("knowledgeDir triples ARE indexed even when raw/compaction is also present", async () => {
    writeKnowledge("knowledge-triple.md", "Knowledge layer only.", {
      type: "project",
      triples: '[["knowledge-only", "in", "kg"]]',
    });
    const compDir = path.join(tmpDir, "raw", "compaction");
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(
      path.join(compDir, "c.md"),
      `---\ndate: 2026-05-01T00:00:00Z\ntype: compaction\ntier: L2\ntriples: [["raw-only", "in", "compaction"]]\n---\n\nx`,
    );
    await mc.syncIndex();
    expect(mc.kg.queryEntity("knowledge-only").length).toBeGreaterThan(0);
    expect(mc.kg.queryEntity("raw-only").length).toBe(0);
  });
});

describe("saveMemory dedup includes triples in the hash", () => {
  it("same (type, primary) but DIFFERENT triples produces a distinct file (no silent loss)", async () => {
    const fp1 = await mc.saveMemory({
      type: "project",
      primary: "Same content body dedup-triple-marker",
      triples: [["a", "owns", "b"]],
    });
    expect(fp1).toBeTruthy();

    const fp2 = await mc.saveMemory({
      type: "project",
      primary: "Same content body dedup-triple-marker",
      triples: [["a", "owns", "c"]], // different object
    });
    // Must NOT be deduped — triples differ, so this is a different file.
    expect(fp2).toBeTruthy();
    expect(fp2).not.toBe(fp1);
  });

  it("same (type, primary, triples) DOES dedup (second call returns null)", async () => {
    const triples: Array<[string, string, string]> = [["a", "owns", "b"]];
    const fp1 = await mc.saveMemory({ type: "project", primary: "x dedup-same-marker", triples });
    const fp2 = await mc.saveMemory({ type: "project", primary: "x dedup-same-marker", triples });
    expect(fp1).toBeTruthy();
    expect(fp2).toBeNull();
  });

  it("triple order does not affect dedup (normalized before hashing)", async () => {
    const fp1 = await mc.saveMemory({
      type: "project",
      primary: "Order-insensitive dedup order-marker",
      triples: [["a", "owns", "b"], ["c", "rel", "d"]],
    });
    const fp2 = await mc.saveMemory({
      type: "project",
      primary: "Order-insensitive dedup order-marker",
      triples: [["c", "rel", "d"], ["a", "owns", "b"]], // reversed order
    });
    expect(fp1).toBeTruthy();
    expect(fp2).toBeNull();
  });

  it("saving with no triples vs with triples on same (type, primary) produces distinct files", async () => {
    const fp1 = await mc.saveMemory({ type: "project", primary: "no-triples-then-with marker" });
    const fp2 = await mc.saveMemory({
      type: "project",
      primary: "no-triples-then-with marker",
      triples: [["a", "b", "c"]],
    });
    expect(fp1).toBeTruthy();
    expect(fp2).toBeTruthy();
    expect(fp1).not.toBe(fp2);
  });
});

describe("triples validation uses trim() consistently (whitespace-only is rejected)", () => {
  it("parseTriplesFromFrontmatter skips whitespace-only entries", () => {
    const raw = `---
triples: [["good", "one", "ok"], ["  ", "blank", "x"], ["y", "  ", "z"], ["p", "q", "   "]]
---`;
    const out = mc.parseTriplesFromFrontmatter(raw);
    expect(out).toEqual([["good", "one", "ok"]]);
  });

  it("validateTriples rejects whitespace-only entries", () => {
    const r1 = validateTriples([["  ", "b", "c"]]);
    expect(r1.valid).toBe(false);
    const r2 = validateTriples([["a", "  ", "c"]]);
    expect(r2.valid).toBe(false);
    const r3 = validateTriples([["a", "b", "   "]]);
    expect(r3.valid).toBe(false);
  });

  it("non-whitespace, non-empty strings are accepted (consistency check)", () => {
    expect(validateTriples([["  alice  ", " owns ", " auth  "]]).valid).toBe(true);
    // Whitespace inside non-empty strings is fine — the rule is just
    // that the string isn't pure whitespace.
  });
});

describe("triples trim() at every write/ingest point", () => {
  it("parseTriplesFromFrontmatter trims leading/trailing whitespace from each tuple entry", () => {
    const raw = `---
triples: [["  alice  ", " owns ", " auth-service "], ["bob", "  role  ", "engineer"]]
---`;
    const out = mc.parseTriplesFromFrontmatter(raw);
    expect(out).toEqual([
      ["alice", "owns", "auth-service"],
      ["bob", "role", "engineer"],
    ]);
  });

  it("a knowledge file hand-edited with whitespace in triples still produces a clean KG entity", async () => {
    // Write a knowledge file directly to disk (bypassing the tool layer)
    // with leading/trailing spaces in every triple entry. After syncIndex
    // rebuilds the KG, the entity must be 'alice' (not '  alice  ').
    const fp = path.join(tmpDir, "knowledge", "whitespace-knowledge.md");
    fs.writeFileSync(
      fp,
      `---
date: 2026-05-01T00:00:00Z
type: project
tier: L2
triples: [["  alice  ", " owns ", " auth-service "]]
---

Alice owns the auth service.`,
    );
    await mc.syncIndex();
    // Entity name is clean (no spaces) — matches `buildContext('alice')`.
    const entity = mc.kg.getEntity("alice");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("alice");
    // Negative control: the untrimmed name should NOT exist as an entity.
    expect(mc.kg.getEntity("  alice  ")).toBeNull();
    // buildContext lookup: the bare query 'alice' must hit the triple.
    const ctx = await mc.buildContext("alice");
    expect(ctx).toContain("alice");
    expect(ctx).toContain("auth-service");
  });

  it("remember_this with whitespace-padded triples saves a clean-tuple file and matches 'alice' on query", async () => {
    // Path: tool layer trims input, saveMemory writes clean JSON,
    // syncIndex rebuilds, buildContext('alice') finds the triple.
    // This is the end-to-end version of the previous test.
    await mc.saveMemory({
      type: "project",
      primary: "Alice owns the auth service. trimmed-triple-marker",
      triples: [["  alice  ", " owns ", " auth-service "]],
    });
    await mc.syncIndex();
    // Entity is clean.
    expect(mc.kg.getEntity("alice")).not.toBeNull();
    expect(mc.kg.getEntity("  alice  ")).toBeNull();
    // buildContext matches.
    const ctx = await mc.buildContext("alice");
    expect(ctx).toContain("alice");
    expect(ctx).toContain("auth-service");
  });

  it("saveMemory's written frontmatter contains clean tuples (no leading/trailing spaces)", async () => {
    const fp = await mc.saveMemory({
      type: "project",
      primary: "Clean-tuple-write-marker body",
      triples: [["  alice  ", " owns ", " x "]],
    });
    const body = fs.readFileSync(fp!, "utf-8");
    // The triples field is JSON-stringified in frontmatter. After trim,
    // it should contain `"alice"`, `"owns"`, `"x"` (not the padded forms).
    expect(body).not.toMatch(/"  alice  "/);
    expect(body).not.toMatch(/" owns "/);
    expect(body).not.toMatch(/" x "/);
    // Verify the actual values present:
    expect(body).toMatch(/"alice"/);
    expect(body).toMatch(/"owns"/);
    expect(body).toMatch(/"x"/);
  });

  it("saveMemory's dedup hash treats padded and unpadded triples as the same (post-trim)", async () => {
    // Same logical triples in two saveMemory calls — one with padding,
    // one without. The hash is computed from the trimmed values, so
    // the second call must dedup to null.
    const fp1 = await mc.saveMemory({
      type: "project",
      primary: "Same body dedup-trim-marker",
      triples: [["alice", "owns", "b"]],
    });
    const fp2 = await mc.saveMemory({
      type: "project",
      primary: "Same body dedup-trim-marker",
      triples: [["  alice  ", " owns ", " b "]], // logically identical
    });
    expect(fp1).toBeTruthy();
    expect(fp2).toBeNull();
  });
});


