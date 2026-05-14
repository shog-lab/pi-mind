/**
 * Core types for the eval harness.
 *
 * NOTE: scoring is intentionally NOT part of this codebase anymore.
 * The previous custom judge was wrong (didn't match LongMemEval's official
 * evaluator). The plan is to:
 *   1. Use this harness to spawn pi and collect responses
 *   2. Export responses as a hypothesis file in LongMemEval's expected format
 *   3. Feed that file into LongMemEval's official Python evaluator
 *      (src/evaluation/evaluate_qa.py) for scoring
 *
 * So the pipeline here is: Dataset → Driver → HypothesisFile.
 * Scoring happens out-of-process via the official evaluator.
 */

import type { PiTokens } from "pi-utils";

/** One conversation turn used to seed memory before the test question. */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp — used by datasets that test temporal reasoning. */
  timestamp?: string;
  /** Logical session id — datasets with multi-session memory use this. */
  sessionId?: string;
}

/** A single eval item: history to preload, then ask the question. */
export interface EvalQuestion {
  id: string;
  /** Conversation history to load into memory before posing the question. */
  history: HistoryMessage[];
  /** The test question itself. */
  question: string;
  /** Ground truth — kept on the question for record-keeping only; NOT used for scoring here. */
  groundTruth: string;
  /** Free-form metadata (e.g. LongMemEval category like "temporal-reasoning"). */
  metadata?: Record<string, unknown>;
}

/** Dataset adapter — yields questions lazily so multi-GB datasets don't blow up memory. */
export interface Dataset {
  name: string;
  load(opts?: { category?: string; limit?: number }): AsyncIterable<EvalQuestion>;
}

/** Per-question output — the agent's response, optional judge score, and execution stats. */
export interface EvalResult {
  questionId: string;
  response: string;
  tokens?: PiTokens;
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
  /** LongMemEval judge score (0/1, NaN if judge call failed). Undefined when scoring is disabled. */
  score?: number;
  /** Raw judge reply for debugging — kept so borderline cases can be re-audited. */
  judgeReply?: string;
  /** Tokens spent by the judge call (separate from test response tokens). */
  judgeTokens?: PiTokens;
}

/** Driver: runs one question against a real (or fake) memory backend. */
export interface Driver {
  name: string;
  run(question: EvalQuestion): Promise<{ response: string; tokens?: PiTokens; durationMs: number }>;
  /** Optional teardown for stateful drivers (e.g. cleanup tmpdirs). */
  close?(): Promise<void>;
}

/** Aggregated run output — responses + optional scoring + run stats. */
export interface RunOutput {
  datasetName: string;
  driverName: string;
  /** Judge model name if scoring was enabled; null otherwise. */
  judgeModel: string | null;
  startedAt: string;
  finishedAt: string;
  totalQuestions: number;
  meanTokens?: number;
  meanCostUsd?: number;
  /** Mean LongMemEval judge score across all questions with finite scores. Undefined if no scoring. */
  meanScore?: number;
  /** Per question_type breakdown of mean score + count. */
  perCategory?: Record<string, { count: number; meanScore: number }>;
  results: EvalResult[];
}
