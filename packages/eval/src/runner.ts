/**
 * Pipeline orchestrator — pulls Dataset → Driver → RunOutput together.
 *
 * Produces per-question responses (no scoring). Scoring is handled
 * out-of-process by LongMemEval's official Python evaluator after we export
 * the hypothesis file.
 */

import type { Dataset, Driver, EvalQuestion, EvalResult, RunOutput } from "./types.js";

export interface RunEvalOptions {
  dataset: Dataset;
  driver: Driver;
  /** Optional category filter passed to dataset.load() */
  category?: string;
  /** Cap total questions (useful for smoke runs) */
  limit?: number;
  /** Max in-flight questions. Default 1 (sequential). */
  concurrency?: number;
  /** Per-question progress callback. */
  onProgress?: (result: EvalResult, completedCount: number, total: number) => void;
}

export async function runEval(opts: RunEvalOptions): Promise<RunOutput> {
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const questions: EvalQuestion[] = [];
  for await (const q of opts.dataset.load({ category: opts.category, limit: opts.limit })) {
    questions.push(q);
  }

  const results: EvalResult[] = new Array(questions.length);
  let completedCount = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= questions.length) return;
      const question = questions[i];

      let result: EvalResult;
      try {
        const { response, tokens, durationMs } = await opts.driver.run(question);
        result = {
          questionId: question.id,
          response,
          tokens,
          durationMs,
          metadata: question.metadata,
        };
      } catch (e) {
        result = {
          questionId: question.id,
          response: "",
          durationMs: 0,
          error: e instanceof Error ? e.message : String(e),
          metadata: question.metadata,
        };
      }
      results[i] = result;
      completedCount++;
      opts.onProgress?.(result, completedCount, questions.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  await opts.driver.close?.();

  const finishedAt = new Date().toISOString();
  const withTokens = results.filter((r) => r.tokens);
  const meanTokens = withTokens.length > 0
    ? withTokens.reduce((s, r) => s + (r.tokens!.totalTokens), 0) / withTokens.length
    : undefined;
  const meanCostUsd = withTokens.length > 0
    ? withTokens.reduce((s, r) => s + (r.tokens!.costUsd), 0) / withTokens.length
    : undefined;

  return {
    datasetName: opts.dataset.name,
    driverName: opts.driver.name,
    startedAt,
    finishedAt,
    totalQuestions: results.length,
    meanTokens,
    meanCostUsd,
    results,
  };
}
