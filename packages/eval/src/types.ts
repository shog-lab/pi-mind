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

import type { PiTokens } from "pi-mind/dist/lib/spawn-pi.js";

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

/** Per-question output — the agent's response and execution stats. No scoring. */
export interface EvalResult {
  questionId: string;
  response: string;
  tokens?: PiTokens;
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** Driver: runs one question against a real (or fake) memory backend. */
export interface Driver {
  name: string;
  run(question: EvalQuestion): Promise<{ response: string; tokens?: PiTokens; durationMs: number }>;
  /** Optional teardown for stateful drivers (e.g. cleanup tmpdirs). */
  close?(): Promise<void>;
}

/** Aggregated run output — responses + run stats. */
export interface RunOutput {
  datasetName: string;
  driverName: string;
  startedAt: string;
  finishedAt: string;
  totalQuestions: number;
  meanTokens?: number;
  meanCostUsd?: number;
  results: EvalResult[];
}
