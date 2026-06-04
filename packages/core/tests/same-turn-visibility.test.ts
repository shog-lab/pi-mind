/**
 * Regression: after a saveMemory call, the just-written entry must be
 * immediately visible to the FTS5 search path WITHOUT requiring a second
 * syncIndex call.
 *
 * Prior to the first batch, searchFTS5 was sync and called
 * `this.syncIndex()` (async) without `await` — so a write-then-search
 * sequence in the same turn could miss the new entry. First batch fixed
 * searchFTS5 to await syncIndex. This test pins that behavior so the
 * fix can't silently regress.
 *
 * Vector path is covered in hybrid-merge.test.ts (which uses a real
 * mock Ollama). This file focuses on the FTS5 side, which has been
 * the source of the previous bug.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { MemoryCore, serializeFrontmatter } =
  (await import("../extensions/memory/core.js")) as typeof import("../extensions/memory/core.js");

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-sameterm-test-"));
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

describe("same-turn save → search visibility", () => {
  it("a just-saved reference is findable via searchFTS5 with no extra sync", async () => {
    const fp = await mc.saveMemory({
      type: "reference",
      primary: "Unique phrase xylophone-cathedral-quokka-pangolin",
    });
    expect(fp).toBeTruthy();

    // NO await mc.syncIndex() here. If searchFTS5 doesn't internally await
    // syncIndex, this is a race that used to flake (the FTS5 query would
    // run on a stale index and return []).
    const results = await mc.searchFTS5("xylophone-cathedral-quokka-pangolin");
    expect(results.length).toBe(1);
    expect(results[0].entry.filePath).toBe(fp);
  });

  it("a just-saved user memory shows up in buildContext same-turn", async () => {
    await mc.saveMemory({
      type: "user",
      primary: "I always eat breakfast at 3am quokka-zebra-mango",
      tier: "L2",
    });

    // No explicit syncIndex between save and buildContext.
    const ctx = await mc.buildContext("quokka-zebra-mango breakfast");
    expect(ctx).toContain("<long-term-memory>");
    expect(ctx).toContain("quokka-zebra-mango");
  });

  it("multiple saves in the same turn are all findable in one search call", async () => {
    await mc.saveMemory({ type: "reference", primary: "alpha token grapefruit" });
    await mc.saveMemory({ type: "reference", primary: "beta token grapefruit" });
    await mc.saveMemory({ type: "reference", primary: "gamma token grapefruit" });

    // No explicit syncIndex. The async syncIndex inside searchFTS5 must
    // pick up all three writes.
    const results = await mc.searchFTS5("grapefruit");
    const bodies = results.map((r) => r.entry.content).sort();
    expect(results.length).toBe(3);
    expect(bodies[0]).toContain("alpha");
    expect(bodies[1]).toContain("beta");
    expect(bodies[2]).toContain("gamma");
  });

  it("a compaction-typed save is findable in raw/compaction/ via FTS5 same-turn", async () => {
    // compaction entries are written to raw/compaction/ (not knowledge/).
    // The merge should still surface them.
    const fp = await mc.saveMemory({
      type: "compaction",
      primary: "Conversation summary mentioning plumbus-trombone-glorp",
    });
    expect(fp).toContain("compaction");

    const results = await mc.searchFTS5("plumbus-trombone-glorp");
    expect(results.length).toBe(1);
    expect(results[0].entry.content).toContain("plumbus-trombone-glorp");
  });

  it("a saved-then-deleted entry is no longer findable (regression: same sync path used for removal)", async () => {
    const fp = await mc.saveMemory({
      type: "reference",
      primary: "ephemeral entry snickerdoodle-ostrich",
    });
    // Confirm it's there.
    expect((await mc.searchFTS5("snickerdoodle-ostrich")).length).toBe(1);
    // Delete the file and let syncIndex evict it. No explicit await.
    fs.unlinkSync(fp!);
    const after = await mc.searchFTS5("snickerdoodle-ostrich");
    expect(after.length).toBe(0);
  });
});
