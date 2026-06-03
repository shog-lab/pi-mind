/**
 * CLI: spawn pi to answer LongMemEval questions, optionally judge each
 * response with the official LongMemEval methodology, write outputs.
 *
 * Outputs (in --out dir):
 *   hypothesis.jsonl  — LongMemEval official format (always written)
 *   run-output.json   — full run dump (responses, scores, tokens, errors)
 *   report.md         — human-readable summary (only useful when --judge enabled)
 */

import { join, resolve } from "node:path";
import { LongMemEvalDataset } from "./datasets/longmemeval.js";
import type { LongMemEvalSplit } from "./datasets/longmemeval-download.js";
import { PiSessionDriver } from "./drivers/pi-session.js";
import { runEval } from "./runner.js";
import { writeHypothesisJsonl, writeMarkdownReport, writeRunOutputJson } from "./report.js";

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
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    dataset: "longmemeval", split: "oracle", out: "./eval-out",
    concurrency: 1, judge: false,
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
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`pi-mind eval — runs LongMemEval against pi, optionally scores with official methodology

Usage:
  pi-mind-eval [--split S] [--limit N] [--category C] [--out DIR] [--model M] [--judge] [--judge-model M]

Options:
  --dataset NAME      Dataset to run (default: longmemeval)
  --split S           LongMemEval split: oracle (15MB), s (277MB), m (2.7GB). Default: oracle
  --limit N           Cap total questions
  --category C        Filter to a question_type
  --out DIR           Output directory (default: ./eval-out)
  --concurrency N     Max in-flight questions (default: 1)
  --model M           Override pi's default model for the test responses
  --judge             Enable LongMemEval-style judge after each response
  --judge-model M     Use a specific model for the judge (implies --judge)

Outputs:
  <out>/hypothesis.jsonl   — LongMemEval official format (always)
  <out>/run-output.json    — full run output (responses, scores, tokens)
  <out>/report.md          — human-readable summary (only useful with --judge)

Methodology:
  When --judge is on, scoring uses LongMemEval's official prompts (verbatim
  from src/evaluation/evaluate_qa.py). Judge model choice is yours; for
  cross-system comparability, run all systems through the same judge model.

  Without --judge, you can still score later via LongMemEval's Python
  evaluator on hypothesis.jsonl.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);

  if (args.dataset !== "longmemeval") {
    console.error(`unknown dataset: ${args.dataset}`);
    process.exit(2);
  }

  const dataset = new LongMemEvalDataset({ split: args.split });
  const driver = new PiSessionDriver({
    extraArgs: args.model ? ["--model", args.model] : undefined,
  });

  const judge = args.judge ? { model: args.judgeModel } : undefined;

  console.log(`Running ${dataset.name} via ${driver.name}${judge ? ` + judge=${judge.model ?? "pi-default"}` : " (no judge)"}`);
  console.log(`Output → ${outDir}`);

  const output = await runEval({
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

  writeHypothesisJsonl(join(outDir, "hypothesis.jsonl"), output);
  writeRunOutputJson(join(outDir, "run-output.json"), output);
  writeMarkdownReport(join(outDir, "report.md"), output);

  console.log(`\nDone: ${output.totalQuestions} question(s)`);
  if (output.meanScore !== undefined) {
    console.log(`Mean score: ${(output.meanScore * 100).toFixed(1)}%`);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
