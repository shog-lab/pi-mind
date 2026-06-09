/**
 * Official LongMemEval QA scoring wrapper.
 *
 * Thin shell around LongMemEval's official Python evaluator
 * (`src/evaluation/evaluate_qa.py`). We do NOT re-implement the
 * prompts or the methodology here — the official evaluator is the
 * source of truth for QA accuracy.
 *
 * Usage:
 *   await runOfficialScoring({
 *     runDir: "/tmp/pi-mind-eval-smoke",   // must contain hypothesis.jsonl
 *     officialRepoPath: "~/LongMemEval",   // git clone of upstream
 *     split: "oracle",
 *     judgeModel: "gpt-4o-mini",
 *   })
 *
 * Behavior:
 *   - Spawns `python3 src/evaluation/evaluate_qa.py <model> <hypo> <split-json>`
 *   - Captures stdout/stderr
 *   - Parses the "Accuracy:" / per-category lines from stdout into a
 *     structured OfficialScore object
 *   - Copies the upstream `hypothesis.jsonl.eval-results-<model>` file
 *     into the run dir as `official-eval-results.json` so the full
 *     per-question output is auditable later
 *
 * Failure modes (graceful — returns an OfficialScore with null overall
 * and the raw stderr/stdout so the caller can decide what to do):
 *   - Official repo not found → exit early with `overall: null`
 *   - python3 not on PATH → same
 *   - hypothesis.jsonl missing → same
 *   - Split JSON missing → same
 *   - Python evaluator exits non-zero → overall null, raw output captured
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getCachedPath } from "../datasets/longmemeval-download.js";
import type { LongMemEvalSplit } from "../datasets/longmemeval-download.js";
import type { OfficialScore } from "../report.js";

export interface OfficialScoringOptions {
  /** Run directory; must contain hypothesis.jsonl. */
  runDir: string;
  /** Path to the cloned LongMemEval repo. Default: $LONGMEMEVAL_HOME or ~/LongMemEval. */
  officialRepoPath?: string;
  /** Which split the hypothesis corresponds to. Determines which split JSON to feed the official evaluator. */
  split: LongMemEvalSplit;
  /** Override the cache dir where the official evaluator reads the split JSON. Default: ~/.cache/pi-mind-eval/longmemeval/. */
  splitCacheDir?: string;
  /** Judge model name (passed verbatim to evaluate_qa.py). */
  judgeModel: string;
  /** Optional path to a python binary. Default: "python3" on PATH. */
  pythonBin?: string;
}

const DEFAULT_OFFICIAL_REPO = join(homedir(), "LongMemEval");
export function runOfficialScoring(opts: OfficialScoringOptions): OfficialScore {
  const repoPath = resolve(opts.officialRepoPath ?? process.env.LONGMEMEVAL_HOME ?? DEFAULT_OFFICIAL_REPO);
  const python = opts.pythonBin ?? "python3";
  const evaluator = join(repoPath, "src", "evaluation", "evaluate_qa.py");
  const hypothesisPath = join(opts.runDir, "hypothesis.jsonl");
  // getCachedPath() is the single source of truth for the split → filename
  // mapping (longmemeval_oracle.json / longmemeval_s_cleaned.json /
  // longmemeval_m_cleaned.json). It honors LONGMEMEVAL_CACHE_DIR too.
  const splitJsonPath = opts.splitCacheDir
    ? resolve(opts.splitCacheDir, basename(getCachedPath(opts.split)))
    : getCachedPath(opts.split);
  // Graceful pre-checks
  const reasons: string[] = [];
  if (!existsSync(hypothesisPath)) reasons.push(`hypothesis.jsonl not found at ${hypothesisPath}`);
  if (!existsSync(evaluator)) reasons.push(`official evaluator not found at ${evaluator} (clone LongMemEval to ${repoPath})`);
  if (!existsSync(splitJsonPath)) reasons.push(`split JSON not found at ${splitJsonPath} (run the eval once to cache it, or set LONGMEMEVAL_CACHE_DIR)`);
  if (reasons.length > 0) {
    const score: OfficialScore = {
      model: opts.judgeModel,
      overall: null,
      perCategory: {},
      rawStdout: "",
      stderr: reasons.join("\n"),
      evalResultsFile: null,
    };
    // Still write a sibling official-score.json so the file's existence
    // signals the wrapper ran and the reasons are auditable.
    writeOfficialScoreJson(opts.runDir, {
      model: opts.judgeModel,
      overall: null,
      perCategory: {},
      evalResultsFile: null,
      capturedAt: new Date().toISOString(),
      exitOk: false,
      rawStdoutTail: "",
      stderrTail: reasons.join("\n"),
    });
    return score;
  }

  // Run the official evaluator. cwd=repo so `from src.evaluation.evaluate_qa`
  // resolves the way the upstream expects.
  const result = spawnSync(python, [evaluator, opts.judgeModel, hypothesisPath, splitJsonPath], {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: 60 * 60 * 1000, // 1 hour; the official evaluator is chatty
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitOk = result.status === 0;

  // The official evaluator writes the per-question results to
  // `<hypothesis_path>.eval-results-<model>` (NOT `.eval-results-<model>`
  // next to it). Copy that into <run>/official-eval-results.json so
  // downstream tooling can find the raw output by a stable name.
  let evalResultsFile: string | null = null;
  const upstreamResult = `${hypothesisPath}.eval-results-${opts.judgeModel}`;
  if (existsSync(upstreamResult)) {
    const dest = join(opts.runDir, "official-eval-results.json");
    try {
      copyFileSync(upstreamResult, dest);
      evalResultsFile = dest;
    } catch { /* non-fatal */ }
  }

  const parsed = exitOk ? parseOfficialStdout(stdout) : { overall: null, perCategory: {} };

  // Also write a sibling parsed JSON for downstream tooling.
  const summary = {
    model: opts.judgeModel,
    overall: parsed.overall,
    perCategory: parsed.perCategory,
    evalResultsFile,
    capturedAt: new Date().toISOString(),
    exitOk,
    rawStdoutTail: stdout.slice(-2_000),
    stderrTail: stderr.slice(-2_000),
  };
  writeOfficialScoreJson(opts.runDir, summary);

  return {
    model: opts.judgeModel,
    overall: parsed.overall,
    perCategory: parsed.perCategory,
    rawStdout: stdout,
    stderr,
    evalResultsFile,
  };
}

/** Last path component, platform-agnostic (avoids `node:path` import bloat). */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** Write a sibling official-score.json from the parsed + captured data. */
function writeOfficialScoreJson(runDir: string, summary: {
  model: string;
  overall: number | null;
  perCategory: Record<string, number>;
  evalResultsFile: string | null;
  capturedAt: string;
  exitOk: boolean;
  rawStdoutTail: string;
  stderrTail: string;
}): void {
  const summaryPath = join(runDir, "official-score.json");
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  } catch { /* non-fatal */ }
}

/** Write the raw result file. Exposed for tests that don't want to spawn Python. */
export function findOfficialResultFile(hypothesisPath: string, model: string): string {
  return `${hypothesisPath}.eval-results-${model}`;
}

/**
 * Parse the official LongMemEval evaluator's stdout.
 *
 * Observed formats (LongMemEval main, last synced 2026-06-09):
 *   "Accuracy: 0.612"
 *   "Overall accuracy: 0.612"
 *   "\ttemporal-reasoning: 0.25 (2)"   ← tab-indented, trailing count
 *   "single-session-user: 0.5 (1)"     ← unindented, trailing count
 *
 * Earlier pass required lines to END with the float, which dropped
 * per-category lines with a trailing `(<count>)`. Relaxed to allow
 * trailing content after the float.
 */
export function parseOfficialStdout(stdout: string): { overall: number | null; perCategory: Record<string, number> } {
  const perCategory: Record<string, number> = {};
  let overall: number | null = null;

  // Overall: "Accuracy: 0.612" or "Overall accuracy: 0.612" anywhere on a line.
  // Match the FIRST one (so per-category "X: 0.612" lines that happen to
  // be labeled "accuracy" don't accidentally override).
  const overallRe = /(?:^|\n)\s*(?:overall\s+)?accuracy\s*[:=]\s*([0-9.]+)/i;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(overallRe);
    if (m) { overall = Number(m[1]); break; }
  }

  // Per-category: a line whose first non-whitespace token is a category
  // (lowercase letters / digits / underscore) followed by ": <float>",
  // allowing optional trailing content (count, units, etc.).
  const catRe = /^\s*([a-z][a-z0-9_-]*)\s*[:=]\s*([0-9.]+)/i;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(catRe);
    if (!m) continue;
    const cat = m[1].toLowerCase();
    if (cat === "accuracy" || cat === "overall" || cat === "total") continue;
    // First occurrence wins; later lines for the same category are
    // ignored (defensive: the upstream occasionally prints both a
    // raw float and a "X (N)" version on separate lines).
    if (cat in perCategory) continue;
    perCategory[cat] = Number(m[2]);
  }
  return { overall, perCategory };
}
