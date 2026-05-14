/**
 * Output writers.
 *
 * - hypothesis.jsonl: LongMemEval's official format ({question_id, hypothesis}).
 *   Generated regardless of whether scoring ran — keeps the contract with
 *   the official Python evaluator if you ever want to cross-check.
 * - run-output.json: full RunOutput dump (responses, scores, tokens, errors).
 * - report.md: human-readable summary with per-category scores + failures.
 *   Only meaningful when scoring was enabled.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunOutput } from "./types.js";

export function writeHypothesisJsonl(path: string, output: RunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = output.results.map((r) => JSON.stringify({
    question_id: r.questionId,
    hypothesis: r.response,
  }));
  writeFileSync(path, lines.join("\n") + "\n");
}

export function writeRunOutputJson(path: string, output: RunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2));
}

export function writeMarkdownReport(path: string, output: RunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  lines.push(`# Eval Report: ${output.datasetName}`);
  lines.push("");
  lines.push(`- Driver: \`${output.driverName}\``);
  lines.push(`- Judge: \`${output.judgeModel ?? "(disabled)"}\``);
  lines.push(`- Started: ${output.startedAt}`);
  lines.push(`- Finished: ${output.finishedAt}`);
  lines.push(`- Questions: ${output.totalQuestions}`);
  if (output.meanScore !== undefined) {
    lines.push(`- **Mean score: ${(output.meanScore * 100).toFixed(1)}%**`);
  }
  if (output.meanTokens !== undefined) {
    lines.push(`- Mean test-response tokens: ${output.meanTokens.toFixed(0)}`);
  }
  if (output.meanCostUsd !== undefined) {
    lines.push(`- Mean test-response cost: $${output.meanCostUsd.toFixed(4)}`);
  }
  lines.push("");

  if (output.perCategory) {
    lines.push("## Per category");
    lines.push("");
    lines.push("| Category | Count | Mean score |");
    lines.push("|---|---|---|");
    for (const [cat, stats] of Object.entries(output.perCategory)) {
      lines.push(`| ${cat} | ${stats.count} | ${(stats.meanScore * 100).toFixed(1)}% |`);
    }
    lines.push("");
  }

  // Failures (only show top 50 to keep report readable)
  const failures = output.results.filter((r) => r.score === 0 || r.error);
  lines.push("## Failures");
  lines.push("");
  if (failures.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of failures.slice(0, 50)) {
      lines.push(`### ${f.questionId} (${(f.metadata?.category) ?? "?"})`);
      lines.push("");
      if (f.error) lines.push(`Error: \`${f.error}\``);
      if (f.judgeReply) lines.push(`Judge reply: \`${f.judgeReply.slice(0, 200)}\``);
      lines.push("");
      lines.push("```");
      lines.push(f.response.slice(0, 500));
      lines.push("```");
      lines.push("");
    }
    if (failures.length > 50) {
      lines.push(`_…and ${failures.length - 50} more._`);
    }
  }

  writeFileSync(path, lines.join("\n"));
}
