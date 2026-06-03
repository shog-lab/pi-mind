/**
 * Pipeline orchestrator — Dataset → Driver → (optional) Judge → RunOutput.
 *
 * If a judge is provided, each response is scored using LongMemEval's official
 * methodology (see scoring/longmemeval-judge.ts). Without a judge, the runner
 * just collects responses; scoring can be done later from the saved hypothesis
 * file.
 */

import type { Dataset, Driver, EvalQuestion, EvalResult, RunOutput } from "./types.js";
import type { JudgeOptions } from "./scoring/longmemeval-judge.js";
import { judgeQuestion } from "./scoring/longmemeval-judge.js";

export interface RunEvalOptions {
  dataset: Dataset;
  driver: Driver;
  /** Optional category filter passed to dataset.load() */
  category?: string;
  /** Cap total questions (useful for smoke runs) */
  limit?: number;
  /** Max in-flight questions. Default 1 (sequential). */
  concurrency?: number;
  /** If set, run LongMemEval-style judge after each response. */
  judge?: JudgeOptions;
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

        if (opts.judge) {
          try {
            const j = await judgeQuestion(question, response, opts.judge);
            result.score = j.score;
            result.judgeReply = j.rawReply;
            result.judgeTokens = j.tokens;
          } catch (e) {
            // Judge failure shouldn't kill the whole question — record NaN.
            result.score = NaN;
            result.judgeReply = `judge error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
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

  // Aggregate token + cost across both test responses and judge calls
  const withTokens = results.filter((r) => r.tokens);
  const meanTokens = withTokens.length > 0
    ? withTokens.reduce((s, r) => s + r.tokens!.totalTokens, 0) / withTokens.length
    : undefined;
  const meanCostUsd = withTokens.length > 0
    ? withTokens.reduce((s, r) => s + r.tokens!.costUsd, 0) / withTokens.length
    : undefined;

  // Score aggregation (only if judge was enabled)
  let meanScore: number | undefined;
  let perCategory: Record<string, { count: number; meanScore: number }> | undefined;
  if (opts.judge) {
    const finite = results.filter((r) => Number.isFinite(r.score));
    meanScore = finite.length > 0
      ? finite.reduce((s, r) => s + (r.score!), 0) / finite.length
      : 0;

    const buckets = new Map<string, { sum: number; count: number }>();
    for (const r of finite) {
      const cat = String((r.metadata?.category) ?? "unknown");
      const b = buckets.get(cat) ?? { sum: 0, count: 0 };
      b.sum += r.score!;
      b.count++;
      buckets.set(cat, b);
    }
    perCategory = Object.fromEntries(
      [...buckets].map(([k, v]) => [k, { count: v.count, meanScore: v.sum / v.count }]),
    );
  }

  return {
    datasetName: opts.dataset.name,
    driverName: opts.driver.name,
    judgeModel: opts.judge?.model ?? (opts.judge ? "pi-default" : null),
    startedAt,
    finishedAt,
    totalQuestions: results.length,
    meanTokens,
    meanCostUsd,
    meanScore,
    perCategory,
    results,
  };
}
