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
 *   - Copies the upstream `.eval-results-<model>` file into the run dir
 *     so the full output is auditable later
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { OfficialScore } from "../report.js";

export interface OfficialScoringOptions {
  /** Run directory; must contain hypothesis.jsonl. */
  runDir: string;
  /** Path to the cloned LongMemEval repo. Default: $LONGMEMEVAL_HOME or ~/LongMemEval. */
  officialRepoPath?: string;
  /** Which split the hypothesis corresponds to. Determines which split JSON to feed the official evaluator. */
  split: "oracle" | "s" | "m";
  /** Override the cache dir where the official evaluator reads the split JSON. Default: ~/.cache/pi-mind-eval/longmemeval/. */
  splitCacheDir?: string;
  /** Judge model name (passed verbatim to evaluate_qa.py). */
  judgeModel: string;
  /** Optional path to a python binary. Default: "python3" on PATH. */
  pythonBin?: string;
}

const DEFAULT_OFFICIAL_REPO = join(homedir(), "LongMemEval");
const DEFAULT_SPLIT_CACHE = join(homedir(), ".cache", "pi-mind-eval", "longmemeval");

export function runOfficialScoring(opts: OfficialScoringOptions): OfficialScore {
  const repoPath = resolve(opts.officialRepoPath ?? process.env.LONGMEMEVAL_HOME ?? DEFAULT_OFFICIAL_REPO);
  const splitCache = resolve(opts.splitCacheDir ?? process.env.LONGMEMEVAL_CACHE_DIR ?? DEFAULT_SPLIT_CACHE);
  const python = opts.pythonBin ?? "python3";
  const evaluator = join(repoPath, "src", "evaluation", "evaluate_qa.py");
  const hypothesisPath = join(opts.runDir, "hypothesis.jsonl");
  const splitJsonPath = join(splitCache, `longmemeval_${opts.split}.json`);

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

  // Copy the .eval-results-<model> file the official script writes next
  // to hypothesis.jsonl into the run dir, so the full per-question output
  // is auditable later.
  let evalResultsFile: string | null = null;
  const sourceResults = join(opts.runDir, `.eval-results-${opts.judgeModel}`);
  if (existsSync(sourceResults)) {
    const dest = join(opts.runDir, "official-eval-results.json");
    try {
      copyFileSync(sourceResults, dest);
      evalResultsFile = dest;
    } catch { /* non-fatal */ }
  } else {
    // Upstream writes the file in cwd (the repo). Also try there.
    const fromRepo = join(repoPath, `.eval-results-${opts.judgeModel}`);
    if (existsSync(fromRepo)) {
      const dest = join(opts.runDir, "official-eval-results.json");
      try {
        copyFileSync(fromRepo, dest);
        evalResultsFile = dest;
      } catch { /* non-fatal */ }
    }
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

/**
 * Parse the official LongMemEval evaluator's stdout.
 *
 * The exact line shapes change across upstream versions. The most
 * stable forms we've observed:
 *   "Accuracy: 0.612"
 *   "<category_name>: 0.612"
 *   "Overall accuracy: 0.612"
 *
 * We try a few regexes and return what we find. If the upstream format
 * changes, the perCategory / overall may be null — the rawStdout /
 * stderrTail fields in `official-score.json` preserve the literal text
 * for re-parsing.
 */
function parseOfficialStdout(stdout: string): { overall: number | null; perCategory: Record<string, number> } {
  const perCategory: Record<string, number> = {};
  let overall: number | null = null;

  // Look for "Accuracy: 0.612" or "Overall accuracy: 0.612" anywhere.
  const overallRe = /(?:overall\s+)?accuracy\s*[:=]\s*([0-9.]+)/i;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(overallRe);
    if (m) overall = Number(m[1]);
  }

  // Per-category: lines that look like "<word>: <float>" (no spaces in
  // the word — LongMemEval uses underscores for multi-word categories).
  const catRe = /^([a-z0-9_-]+)\s*[:=]\s*([0-9.]+)\s*$/i;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(catRe);
    if (!m) continue;
    const cat = m[1].toLowerCase();
    if (cat === "accuracy" || cat === "overall") continue;
    perCategory[cat] = Number(m[2]);
  }
  return { overall, perCategory };
}
