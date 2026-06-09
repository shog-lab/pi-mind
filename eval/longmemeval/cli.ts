/**
 * CLI: spawn pi to answer LongMemEval questions, OR run a retrieval-only
 * evaluation, optionally judge each response with the internal LongMemEval
 * methodology, then optionally score the run with the official LongMemEval
 * Python evaluator.
 *
 * Outputs (in --out dir):
 *   hypothesis.jsonl        — LongMemEval official format (always written)
 *   run-output.json         — full run dump (responses, scores, tokens, errors)
 *   report.md               — human-readable summary (only useful when --judge on, QA track)
 *   retrieval-score.json    — R@k + NDCG@k per category (retrieval track)
 *   retrieval-report.md     — per-question top-k audit table (retrieval track)
 *   official-score.json     — official LongMemEval accuracy + per-category (if --score-official)
 *   official-eval-results.json — raw upstream .eval-results-<model> (if available)
 *   manifest.json           — reproducibility metadata (git sha, args, models)
 */

import { join, resolve } from "node:path";
import { LongMemEvalDataset } from "./datasets/longmemeval.js";
import type { LongMemEvalSplit } from "./datasets/longmemeval-download.js";
import { PiSessionDriver } from "./drivers/pi-session.js";
import { RetrievalOnlyDriver } from "./drivers/retrieval.js";
import { runEval } from "./runner.js";
import { computeRetrievalRows, aggregateRows, rowsToRetrievalOutput } from "./retrieval-metrics.js";
import {
  buildManifest,
  writeHypothesisJsonl,
  writeManifest,
  writeMarkdownReport,
  writeRetrievalReportMd,
  writeRetrievalScoreJson,
  writeRunOutputJson,
} from "./report.js";
import { runOfficialScoring } from "./scoring/official.js";
import type { RunOutput } from "./types.js";

interface CliArgs {
  dataset: string;
  split: LongMemEvalSplit;
  limit?: number;
  category?: string;
  out: string;
  concurrency: number;
  model?: string;
  judge: boolean;
  judgeModel?: string;
  track: "qa" | "retrieval";
  scoreOfficial: boolean;
  officialRepo?: string;
  officialModel?: string;
  command: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    dataset: "longmemeval", split: "oracle", out: "./eval-out",
    concurrency: 1, judge: false,
    track: "qa", scoreOfficial: false,
    command: argv,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--dataset": args.dataset = next; i++; break;
      case "--split":
        if (next !== "oracle" && next !== "s" && next !== "m") {
          console.error(`--split must be one of: oracle, s, m`);
          process.exit(2);
        }
        args.split = next; i++; break;
      case "--limit": args.limit = Number(next); i++; break;
      case "--category": args.category = next; i++; break;
      case "--out": args.out = next; i++; break;
      case "--concurrency": args.concurrency = Number(next); i++; break;
      case "--model": args.model = next; i++; break;
      case "--judge": args.judge = true; break;
      case "--judge-model": args.judgeModel = next; args.judge = true; i++; break;
      case "--track":
        if (next !== "qa" && next !== "retrieval") {
          console.error(`--track must be: qa | retrieval`);
          process.exit(2);
        }
        args.track = next; i++; break;
      case "--score-official": args.scoreOfficial = true; break;
      case "--official-repo": args.officialRepo = next; i++; break;
      case "--official-model": args.officialModel = next; args.scoreOfficial = true; i++; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`pi-mind-eval — LongMemEval harness for pi-mind

Usage:
  pi-mind-eval [--track T] [--split S] [--limit N] [--category C] [--out DIR]
               [--model M] [--judge] [--judge-model M]
               [--score-official] [--official-repo PATH] [--official-model M]
               [--concurrency N]

Tracks (mutually exclusive per run):
  --track qa           (default) Spawn pi per question, write hypothesis.jsonl + run-output.json.
                       Optionally judge with the internal LongMemEval-style scorer
                       and/or score with the official LongMemEval Python evaluator.
  --track retrieval    Retrieval-only: seed memory then run memory's hybrid retrieval
                       pipeline (FTS5 + vector + KG) directly. No pi spawn, no model
                       cost. Measures R@k and NDCG@k — NOT comparable to QA accuracy.

Common:
  --dataset NAME       Dataset to run (default: longmemeval)
  --split S            LongMemEval split: oracle (15MB), s (277MB), m (2.7GB). Default: oracle
  --limit N            Cap total questions
  --category C         Filter to a question_type
  --out DIR            Output directory (default: ./eval-out)
  --concurrency N      Max in-flight questions (default: 1)

QA track only:
  --model M            Override pi's default model for the test responses
  --judge              Enable internal LongMemEval-style judge after each response
  --judge-model M      Use a specific model for the judge (implies --judge).
                       Internal judge, NOT LongMemEval-citable.
  --score-official     After the run, invoke LongMemEval's official Python evaluator
                       (src/evaluation/evaluate_qa.py) on hypothesis.jsonl and write
                       official-score.json + official-eval-results.json.
  --official-repo PATH Path to the cloned LongMemEval repo. Default: $LONGMEMEVAL_HOME
                       or ~/LongMemEval
  --official-model M   Judge model for the official evaluator (implies --score-official)

Outputs (in --out dir):
  manifest.json          always
  hypothesis.jsonl       QA track: always
  run-output.json         QA track: always
  report.md              QA track: only with --judge
  retrieval-score.json   retrieval track: always
  retrieval-report.md    retrieval track: always
  official-score.json    QA track: only with --score-official (graceful no-op if the
                         LongMemEval repo isn't cloned or the judge model key is missing)
  official-eval-results.json  Raw upstream results, if available

Comparability:
  • The internal --judge score is a deepseek/any-model port of LongMemEval's
    \`get_anscheck_prompt\`. Useful for fast iteration across memory variants.
  • --score-official is the source of truth for QA accuracy and is what you cite
    in cross-system comparisons. Requires the official LongMemEval repo locally.
  • Retrieval metrics are a different axis entirely: they measure memory's
    recall, not the agent's final answer. Useful for comparing memory
    implementations (this PR's headline use case).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);

  if (args.dataset !== "longmemeval") {
    console.error(`unknown dataset: ${args.dataset}`);
    process.exit(2);
  }

  // Retrieval track ignores --judge and --score-official (different axes).
  if (args.track === "retrieval" && (args.judge || args.scoreOfficial)) {
    console.error(`--track retrieval is incompatible with --judge / --score-official; pick one axis.`);
    process.exit(2);
  }

  const dataset = new LongMemEvalDataset({ split: args.split });
  const datasetName = dataset.name;

  let output: RunOutput;

  if (args.track === "retrieval") {
    console.log(`Running ${datasetName} via retrieval-only (no QA, no judge)`);
    console.log(`Output → ${outDir}`);
    const driver = new RetrievalOnlyDriver();
    output = await runEval({
      dataset,
      driver,
      category: args.category,
      limit: args.limit,
      concurrency: args.concurrency,
      onProgress: (r, done, total) => {
        const errTag = r.error ? ` (error: ${r.error.slice(0, 80)})` : "";
        process.stdout.write(`  [${done}/${total}] ${r.questionId}${errTag}\n`);
      },
    });
    output.track = "retrieval";
  } else {
    const driver = new PiSessionDriver({
      extraArgs: args.model ? ["--model", args.model] : undefined,
    });
    const judge = args.judge ? { model: args.judgeModel } : undefined;
    console.log(`Running ${datasetName} via ${driver.name}${judge ? ` + judge=${judge.model ?? "pi-default"}` : " (no judge)"}`);
    console.log(`Output → ${outDir}`);
    output = await runEval({
      dataset,
      driver,
      category: args.category,
      limit: args.limit,
      concurrency: args.concurrency,
      judge,
      onProgress: (r, done, total) => {
        const scoreTag = !judge
          ? ""
          : Number.isFinite(r.score)
            ? ` ${r.score === 1 ? "✓" : "✗"}`
            : " ?";
        const errTag = r.error ? ` (error: ${r.error.slice(0, 80)})` : "";
        console.log(`  [${done}/${total}] ${r.questionId}${scoreTag}${errTag}`);
      },
    });
    output.track = "qa";
  }

  // Write the per-track outputs
  if (output.track === "retrieval") {
    const rows = computeRetrievalRows(output.results);
    const agg = aggregateRows(rows);
    const retrievalOut = rowsToRetrievalOutput(rows, agg, {
      datasetName: output.datasetName,
      driverName: output.driverName,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
    });
    writeRetrievalScoreJson(join(outDir, "retrieval-score.json"), retrievalOut);
    writeRetrievalReportMd(join(outDir, "retrieval-report.md"), retrievalOut);
    console.log(`\nDone: ${output.totalQuestions} question(s) (${agg.scoredCount} scored, ${agg.abstentionCount} abstention)`);
    const ks = Object.keys(agg.recallAny).map(Number).sort((a, b) => a - b);
    for (const k of ks) {
      console.log(`  RecallAny@${k}: ${(agg.recallAny[k] * 100).toFixed(1)}%   NDCG@${k}: ${(agg.ndcg[k] * 100).toFixed(1)}%`);
    }
  } else {
    writeHypothesisJsonl(join(outDir, "hypothesis.jsonl"), output);
    writeRunOutputJson(join(outDir, "run-output.json"), output);
    writeMarkdownReport(join(outDir, "report.md"), output);
    console.log(`\nDone: ${output.totalQuestions} question(s)`);
    if (output.meanScore !== undefined) {
      console.log(`Mean internal-judge score: ${(output.meanScore * 100).toFixed(1)}%`);
      if (output.perCategory) {
        for (const [cat, s] of Object.entries(output.perCategory)) {
          console.log(`  ${cat}: ${(s.meanScore * 100).toFixed(1)}% (n=${s.count})`);
        }
      }
    }
    if (output.meanCostUsd !== undefined) {
      console.log(`Mean test-response cost: $${output.meanCostUsd.toFixed(4)}/q`);
    }
  }

  // Optional official scoring (QA track only)
  if (args.scoreOfficial) {
    const model = args.officialModel ?? "gpt-4o";
    console.log(`\nRunning official LongMemEval scoring with model=${model}...`);
    const score = runOfficialScoring({
      runDir: outDir,
      officialRepoPath: args.officialRepo,
      split: args.split,
      judgeModel: model,
    });
    if (score.overall === null) {
      console.log(`Official scoring unavailable. Reasons:`);
      for (const line of score.stderr.split("\n")) console.log(`  ${line}`);
    } else {
      console.log(`Official LongMemEval accuracy: ${(score.overall * 100).toFixed(1)}%`);
      for (const [cat, acc] of Object.entries(score.perCategory)) {
        console.log(`  ${cat}: ${(acc * 100).toFixed(1)}%`);
      }
    }
  }

  // Always write manifest last (it captures post-run state)
  const manifest = buildManifest({
    track: output.track ?? "qa",
    dataset: datasetName,
    split: args.split,
    limit: args.limit,
    category: args.category,
    concurrency: args.concurrency,
    driver: output.driverName,
    judgeModel: args.judge ? (args.judgeModel ?? "pi-default") : null,
    officialScoreModel: args.scoreOfficial ? (args.officialModel ?? "gpt-4o") : null,
    command: args.command,
  });
  writeManifest(join(outDir, "manifest.json"), manifest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
