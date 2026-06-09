/**
 * Retrieval-only metrics (MemPalace-style R@k + NDCG@k).
 *
 * NB: these are RETRIEVAL metrics, not QA accuracy. They answer the
 * question "given the seeded history, did memory surface the right
 * session?" — NOT "did the agent produce the right answer?". For the
 * latter, run the official LongMemEval Python evaluator on
 * hypothesis.jsonl.
 *
 * For each non-abstention question:
 *   - RecallAny@k: 1 if ANY of `answerSessionIds` is in the top-k
 *     retrieved filePaths (mapped to sessionId via the seeded
 *     frontmatter), else 0. Mean over all scored questions.
 *   - NDCG@k: standard formula. The relevance set is the
 *     `answerSessionIds` (each has equal gain). Binary relevance
 *     (gain 1 per relevant hit at position i is 1/log2(i+1)),
 *     normalized by IDCG.
 *
 * Abstention cases (no `answerSessionIds`) are EXCLUDED from the
 * denominator; their count is reported separately. (Computing recall
 * against an empty set is meaningless.)
 *
 * The two metrics are complementary: RecallAny captures whether
 * retrieval found anything useful; NDCG captures whether it ranked
 * the useful thing high.
 */

import type { EvalResult, RetrievalRunOutput } from "./types.js";

export interface RetrievalScoreRow {
  questionId: string;
  category?: string;
  isAbstention: boolean;
  answerSessionIds: string[];
  /** Per-result file paths in retrieval order, dedup'd (best-score first). */
  topFilePaths: string[];
  /** Per-file scores, aligned with topFilePaths. */
  topScores: number[];
  /** Per-file source method, aligned with topFilePaths. */
  topSources: string[];
  /** SessionId for each entry in topFilePaths (parsed from seed frontmatter). */
  fileToSessionId: Record<string, string>;
  /** SessionIds in retrieval order, dedup'd. */
  retrievedSessionIds: string[];
  topKSessions: Record<number, string[]>;
  recallAny: Record<number, number>;
  ndcg: Record<number, number>;
  durationMs: number;
  error?: string;
}

export interface RetrievalAggregateOptions {
  ks?: number[];
  skipErrors?: boolean;
}

const DEFAULT_KS = [5, 10];

export function computeRetrievalRows(
  results: EvalResult[],
  opts: RetrievalAggregateOptions = {},
): RetrievalScoreRow[] {
  const ks = opts.ks ?? DEFAULT_KS;
  const skipErrors = opts.skipErrors ?? true;

  const rows: RetrievalScoreRow[] = [];
  for (const r of results) {
    const meta = (r.metadata ?? {}) as {
      answerSessionIds?: unknown;
      isAbstention?: unknown;
      category?: unknown;
    };
    const answerIds = Array.isArray(meta.answerSessionIds)
      ? (meta.answerSessionIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const isAbstention = answerIds.length === 0 || meta.isAbstention === true;

    // Map filePath → sessionId via the driver's map; the runner stored
    // the full RetrievalResult on the EvalResult.
    const retrieval = r.retrieval;
    if (!retrieval) continue; // not a retrieval track
    const seen = new Set<string>();
    const retrievedIdsDedup: string[] = [];
    for (const fp of retrieval.topFilePaths) {
      const sid = retrieval.fileToSessionId[fp];
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      retrievedIdsDedup.push(sid);
    }

    const topKSessions: Record<number, string[]> = {};
    const recallAny: Record<number, number> = {};
    const ndcg: Record<number, number> = {};
    for (const k of ks) {
      const topK = retrievedIdsDedup.slice(0, k);
      topKSessions[k] = topK;
      const answerSet = new Set(answerIds);
      recallAny[k] = isAbstention
        ? 0
        : topK.some((id) => answerSet.has(id)) ? 1 : 0;
      ndcg[k] = ndcgAtK(topK, new Set(answerIds), k);
    }
    rows.push({
      questionId: r.questionId,
      category: typeof meta.category === "string" ? meta.category : undefined,
      isAbstention,
      answerSessionIds: answerIds,
      topFilePaths: retrieval.topFilePaths,
      topScores: retrieval.topScores,
      topSources: retrieval.topSources,
      fileToSessionId: retrieval.fileToSessionId,
      retrievedSessionIds: retrievedIdsDedup,
      topKSessions,
      recallAny,
      ndcg,
      durationMs: r.durationMs,
      error: r.error,
    });
    if (skipErrors && r.error) {
      // Drop the last pushed row.
      rows.pop();
    }
  }
  return rows;
}

export function aggregateRows(
  rows: RetrievalScoreRow[],
  ks: number[] = DEFAULT_KS,
): {
  recallAny: Record<number, number>;
  ndcg: Record<number, number>;
  perCategory: Record<string, {
    count: number;
    scoredCount: number;
    recallAny: Record<number, number>;
    ndcg: Record<number, number>;
  }>;
  total: number;
  abstentionCount: number;
  scoredCount: number;
} {
  const scored = rows.filter((r) => !r.isAbstention && !r.error);
  const abstention = rows.filter((r) => r.isAbstention);

  const recallAny = meanOver(ks, scored.map((r) => r.recallAny));
  const ndcg = meanOver(ks, scored.map((r) => r.ndcg));

  // Per category: include abstention in `count`, only scored in `scoredCount`.
  const byCat = new Map<string, RetrievalScoreRow[]>();
  for (const r of scored) {
    const k = r.category ?? "unknown";
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(r);
  }
  const perCategory: Record<string, { count: number; scoredCount: number; recallAny: Record<number, number>; ndcg: Record<number, number> }> = {};
  for (const [cat, catRows] of byCat) {
    const abstInCat = rows.filter((r) => (r.category ?? "unknown") === cat && r.isAbstention).length;
    perCategory[cat] = {
      count: catRows.length + abstInCat,
      scoredCount: catRows.length,
      recallAny: meanOver(ks, catRows.map((r) => r.recallAny)),
      ndcg: meanOver(ks, catRows.map((r) => r.ndcg)),
    };
  }

  return { recallAny, ndcg, perCategory, total: rows.length, abstentionCount: abstention.length, scoredCount: scored.length };
}

/** Convenience: build a RetrievalRunOutput (for serialization) from rows. */
export function rowsToRetrievalOutput(
  rows: RetrievalScoreRow[],
  agg: ReturnType<typeof aggregateRows>,
  meta: { datasetName: string; driverName: string; startedAt: string; finishedAt: string },
  _ks: number[] = DEFAULT_KS,
): RetrievalRunOutput {
  return {
    datasetName: meta.datasetName,
    driverName: meta.driverName,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalQuestions: agg.total,
    abstentionCount: agg.abstentionCount,
    scoredQuestionCount: agg.scoredCount,
    recallAny: agg.recallAny,
    ndcg: agg.ndcg,
    perCategory: agg.perCategory,
    results: rows.map((r) => ({
      questionId: r.questionId,
      category: r.category,
      isAbstention: r.isAbstention,
      // Real audit fields — topFilePaths are the actual retrieved file
      // paths, topScores the per-hit score, topSources the per-hit
      // search method. The sessionIds (retrievedSessionIds) come from
      // parsing the seeded file's frontmatter.
      topFilePaths: r.topFilePaths,
      topScores: r.topScores,
      topSources: r.topSources,
      fileToSessionId: r.fileToSessionId,
      answerSessionIds: r.answerSessionIds,
      retrievedSessionIds: r.retrievedSessionIds,
      topKSessions: r.topKSessions,
      durationMs: r.durationMs,
      error: r.error,
    })),
  };
}

/** DCG@k with binary relevance, normalized by IDCG. */
function ndcgAtK(retrievedIds: string[], answerSet: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(retrievedIds.length, k); i++) {
    if (answerSet.has(retrievedIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idcgLimit = Math.min(answerSet.size, k);
  let idcg = 0;
  for (let i = 0; i < idcgLimit; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

function meanOver(ks: number[], perRow: Array<Record<number, number>>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const k of ks) {
    if (perRow.length === 0) { out[k] = 0; continue; }
    out[k] = perRow.reduce((s, r) => s + (r[k] ?? 0), 0) / perRow.length;
  }
  return out;
}
