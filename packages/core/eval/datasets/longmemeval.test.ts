/**
 * LongMemEval adapter tests — exercise the schema mapping against real data
 * if the oracle file is already cached. Skipped if not (no network in CI).
 *
 * To populate the cache locally: `npm run eval -- --split oracle --limit 1`
 * Or set $LONGMEMEVAL_CACHE_DIR to a directory containing the JSON.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LongMemEvalDataset } from "./longmemeval.js";
import { getCachedPath } from "./longmemeval-download.js";

const cached = existsSync(getCachedPath("oracle"));
const maybeIt = cached ? it : it.skip;

describe("LongMemEvalDataset (oracle, cache-only)", () => {
  maybeIt("loads the oracle split and yields well-formed EvalQuestions", async () => {
    const ds = new LongMemEvalDataset({ split: "oracle" });
    const sample: Awaited<ReturnType<typeof firstN>> = await firstN(ds, 5);

    expect(sample).toHaveLength(5);
    for (const q of sample) {
      expect(q.id).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(q.question).toBeTypeOf("string");
      expect(q.question.length).toBeGreaterThan(0);
      expect(q.groundTruth).toBeTypeOf("string");
      expect(Array.isArray(q.history)).toBe(true);
      expect(q.history.length).toBeGreaterThan(0);
      // Every history message has both sessionId and timestamp
      for (const msg of q.history) {
        expect(msg.role === "user" || msg.role === "assistant").toBe(true);
        expect(msg.sessionId).toBeTypeOf("string");
        expect(msg.timestamp).toBeTypeOf("string");
      }
      expect(q.metadata?.category).toBeTypeOf("string");
    }
  });

  maybeIt("category filter restricts results", async () => {
    const ds = new LongMemEvalDataset({ split: "oracle" });
    const sample = await firstN(ds, 10, { category: "temporal-reasoning" });
    expect(sample.length).toBeGreaterThan(0);
    for (const q of sample) {
      expect(q.metadata?.category).toBe("temporal-reasoning");
    }
  });

  maybeIt("oracle has 500 entries total", async () => {
    const ds = new LongMemEvalDataset({ split: "oracle" });
    let count = 0;
    for await (const _ of ds.load()) count++;
    expect(count).toBe(500);
  });
});

async function firstN(ds: LongMemEvalDataset, n: number, opts?: { category?: string }) {
  const out = [];
  for await (const q of ds.load({ category: opts?.category, limit: n })) {
    out.push(q);
  }
  return out;
}
