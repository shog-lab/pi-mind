/**
 * Output writers.
 *
 * - hypothesis.jsonl: LongMemEval's official format ({question_id, hypothesis}).
 *   Always written (the contract for the official Python evaluator).
 * - run-output.json: full RunOutput dump (responses, scores, tokens, errors).
 * - report.md: human-readable summary, only meaningful when --judge was on.
 * - retrieval-score.json: R@k + NDCG@k per category. Only meaningful for
 *   the retrieval-only track.
 * - retrieval-report.md: per-question top-k table for audit.
 * - manifest.json: per-run reproducibility metadata (git sha, args, model).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  RetrievalRunOutput,
  RunManifest,
  RunOutput,
} from "./types.js";

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
  lines.push(`- Track: \`${output.track ?? "qa"}\``);
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
  lines.push("> **NB:** This is the harness's internal judge score, NOT the");
  lines.push("> official LongMemEval QA accuracy. For the official number, run");
  lines.push("> `score-official` on this run directory (see README). The two");
  lines.push("> numbers can diverge; the TS judge in `scoring/longmemeval-judge.ts`");
  lines.push("> ports the official `get_anscheck_prompt` verbatim but uses a different");
  lines.push("> model by default — a deepseek judge is internal-only, not LongMemEval-citable.");
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

// =============================================================================
// Retrieval-only writers
// =============================================================================

export function writeRetrievalScoreJson(path: string, output: RetrievalRunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2));
}

export function writeRetrievalReportMd(path: string, output: RetrievalRunOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  const ks = Object.keys(output.recallAny).map(Number).sort((a, b) => a - b);
  const lines: string[] = [];
  lines.push(`# Retrieval Report: ${output.datasetName}`);
  lines.push("");
  lines.push(`- Driver: \`${output.driverName}\``);
  lines.push(`- Started: ${output.startedAt}`);
  lines.push(`- Finished: ${output.finishedAt}`);
  lines.push(`- Total questions: ${output.totalQuestions}`);
  lines.push(`- Scored (non-abstention): ${output.scoredQuestionCount}`);
  lines.push(`- Abstention (excluded from recall): ${output.abstentionCount}`);
  lines.push("");
  lines.push("> **NB:** Retrieval metric — NOT comparable to LongMemEval QA accuracy.");
  lines.push("> Tells you whether the right session came back when the question was asked,");
  lines.push("> not whether the agent's final answer was correct. For QA accuracy, run");
  lines.push("> `score-official` on the run dir.");
  lines.push("");

  lines.push("## Overall");
  lines.push("");
  const kHeaders = ks.map((k) => `@${k}`).join(" | ");
  lines.push(`| Metric | ${kHeaders} |`);
  lines.push(`|---|---|${ks.map(() => "---|").join("")}`);
  lines.push(`| RecallAny | ${ks.map((k) => `${(output.recallAny[k] * 100).toFixed(1)}%`).join(" | ")} |`);
  lines.push(`| NDCG      | ${ks.map((k) => `${(output.ndcg[k] * 100).toFixed(1)}%`).join(" | ")} |`);
  lines.push("");

  if (Object.keys(output.perCategory).length > 0) {
    lines.push("## Per category");
    lines.push("");
    lines.push(`| Category | Scored / Total | ${ks.map((k) => `R@${k}`).join(" | ")} | ${ks.map((k) => `NDCG@${k}`).join(" | ")} |`);
    lines.push(`|---|---|${ks.map(() => "---|").join("")}${ks.map(() => "---|").join("")}`);
    for (const [cat, s] of Object.entries(output.perCategory)) {
      const rLine = ks.map((k) => `${(s.recallAny[k] * 100).toFixed(1)}%`).join(" | ");
      const nLine = ks.map((k) => `${(s.ndcg[k] * 100).toFixed(1)}%`).join(" | ");
      lines.push(`| ${cat} | ${s.scoredCount} / ${s.count} | ${rLine} | ${nLine} |`);
    }
    lines.push("");
  }

  // Per-question audit table (top-10 retrieved sessionIds vs answer)
  const auditRows = output.results.filter((r) => !r.isAbstention);
  lines.push("## Per question (top retrieved vs ground truth, first 30)");
  lines.push("");
  lines.push("| Question | Category | Top retrieved (truncated) | Has answer? |");
  lines.push("|---|---|---|---|");
  for (const r of auditRows.slice(0, 30)) {
    const top = r.retrievedSessionIds.slice(0, 5).map((id) => `\`${id}\``).join(", ") || "_(none)_";
    const answerSet = new Set(r.answerSessionIds);
    const hit = r.retrievedSessionIds.slice(0, 10).some((id) => answerSet.has(id));
    lines.push(`| ${r.questionId} | ${r.category ?? "?"} | ${top} | ${hit ? "✓" : "✗"} |`);
  }
  if (auditRows.length > 30) {
    lines.push(`_…and ${auditRows.length - 30} more._`);
  }
  lines.push("");

  writeFileSync(path, lines.join("\n"));
}

// =============================================================================
// Manifest writer
// =============================================================================

/** Read the eval workspace's package.json to extract the workspaceVersion. */
function readWorkspaceVersion(): string {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Best-effort git SHA. Returns "unknown" outside a git checkout. */
function readGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildManifest(opts: {
  track: "qa" | "retrieval";
  dataset: string;
  split: string;
  limit?: number;
  category?: string;
  concurrency: number;
  driver: string;
  judgeModel: string | null;
  officialScoreModel: string | null;
  command: string[];
}): RunManifest {
  return {
    timestamp: new Date().toISOString(),
    gitSha: readGitSha(),
    workspaceName: "@shog-lab/pi-mind-eval",
    workspaceVersion: readWorkspaceVersion(),
    nodeVersion: process.version,
    ...opts,
  };
}

export function writeManifest(path: string, m: RunManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2));
}

// =============================================================================
// Official QA scoring wrapper
// =============================================================================

/**
 * Per-category accuracy extracted from the official LongMemEval Python
 * evaluator's stdout. The evaluator's output format is not strictly
 * stable; we regex-parse the lines that look like `<category>: <acc>`.
 */
export interface OfficialScore {
  model: string;
  overall: number | null;
  perCategory: Record<string, number>;
  rawStdout: string;
  stderr: string;
  /** Path the official evaluator wrote its results to (e.g. .eval-results-gpt-4o). */
  evalResultsFile: string | null;
}
