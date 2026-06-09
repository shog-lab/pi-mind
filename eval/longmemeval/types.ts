/**
 * Core types for the eval harness.
 *
 * Two scoring paths exist for the QA track:
 *   1. Internal judge (scoring/longmemeval-judge.ts): a verbatim port of
 *      LongMemEval's `get_anscheck_prompt`. Use `--judge` to enable.
 *      Fast, model-flexible (any model the test response can use), but
 *      NOT LongMemEval-citable — internal iteration only.
 *   2. Official evaluator wrapper (scoring/official.ts): spawns the
 *      upstream `src/evaluation/evaluate_qa.py` as a subprocess.
 *      Source of truth for QA accuracy. Use `--score-official` to
 *      enable. Requires the LongMemEval repo cloned locally.
 *
 * The pipeline here is:
 *   Dataset → Driver → HypothesisFile → (optional) Judge → RunOutput
 *                                                 ↓ (optional) score-official
 *                                                 official-score.json
 *
 * Retrieval track (--track retrieval) is separate: Dataset →
 * RetrievalOnlyDriver → topFilePaths + retrievedSessionIds → metrics.
 * No pi spawn, no model cost. Measures memory's recall, not QA accuracy.
 */

import type { PiTokens } from "@shog-lab/pi-utils";

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
  /**
   * Structured retrieval data, populated by the RetrievalOnlyDriver.
   * Lets the same harness infrastructure (one RunOutput per run) carry
   * both QA responses and retrieval metrics.
   */
  retrieval?: import("./drivers/retrieval.js").RetrievalResult;
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
  /**
   * "qa" (default; pi-session driver) or "retrieval" (RetrievalOnlyDriver).
   * Determines which writers should run.
   */
  track?: "qa" | "retrieval";
  results: EvalResult[];
}

/** Aggregated retrieval-only output. */
export interface RetrievalRunOutput {
  datasetName: string;
  driverName: string;
  startedAt: string;
  finishedAt: string;
  totalQuestions: number;
  abstentionCount: number;
  scoredQuestionCount: number;     // totalQuestions - abstentionCount
  recallAny: Record<number, number>; // K -> recall@k (0..1), only over scored questions
  ndcg: Record<number, number>;
  perCategory: Record<string, {
    count: number;
    scoredCount: number;
    recallAny: Record<number, number>;
    ndcg: Record<number, number>;
  }>;
  results: Array<{
    questionId: string;
    category?: string;
    isAbstention: boolean;
    /** Real audit fields: top retrieved file paths, scores, source method. */
    topFilePaths: string[];
    topScores: number[];
    topSources: string[];
    /** Mapping from each topFilePath to its sessionId (from seed frontmatter). */
    fileToSessionId: Record<string, string>;
    /** Retrieved sessionIds in retrieval order (dedup'd, best first). */
    retrievedSessionIds: string[];
    /** Per-K sessionIds (subset of retrievedSessionIds). */
    topKSessions: Record<number, string[]>;
    /** Ground truth for the question. Empty for abstention. */
    answerSessionIds: string[];
    durationMs: number;
    error?: string;
  }>;
}

/**
 * Per-run reproducibility metadata. Always written to <out>/manifest.json
 * so a future reader can replay a run end-to-end.
 */
export interface RunManifest {
  timestamp: string;          // ISO, generated at run end
  gitSha: string;             // HEAD; "unknown" if not a git checkout
  workspaceName: string;      // "@shog-lab/pi-mind-eval"
  workspaceVersion: string;   // from package.json
  nodeVersion: string;
  track: "qa" | "retrieval";
  dataset: string;            // e.g. "longmemeval-oracle"
  split: string;              // "oracle" | "s" | "m"
  limit?: number;
  category?: string;
  concurrency: number;
  driver: string;
  judgeModel: string | null;
  officialScoreModel: string | null;
  command: string[];          // argv tail
}
