/**
 * Output writers.
 *
 * Primary output: a hypothesis file in LongMemEval's expected format
 * (jsonl, one entry per question with `question_id` and `hypothesis`).
 * That file is what gets fed into LongMemEval's official Python evaluator
 * (`src/evaluation/evaluate_qa.py`) for scoring.
 *
 * Secondary outputs: raw JSON dump of full RunOutput for debugging /
 * post-hoc analysis (token usage, errors, etc).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunOutput } from "./types.js";

/**
 * Write a LongMemEval hypothesis file (jsonl). Each line:
 *   {"question_id": "...", "hypothesis": "<model response>"}
 *
 * Questions that errored out (no response captured) are STILL emitted with
 * empty hypothesis — the official evaluator will judge them as failures.
 * This keeps the file aligned with the reference data row-for-row.
 */
export function writeHypothesisJsonl(path: string, output: RunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = output.results.map((r) => JSON.stringify({
    question_id: r.questionId,
    hypothesis: r.response,
  }));
  writeFileSync(path, lines.join("\n") + "\n");
}

/** Write the full RunOutput as JSON — useful for debugging, token accounting, error inspection. */
export function writeRunOutputJson(path: string, output: RunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2));
}
