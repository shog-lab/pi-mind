/**
 * Minimal CLI: spawn pi to answer each LongMemEval question, write a
 * hypothesis file in LongMemEval's official format.
 *
 * Scoring is NOT done here. To score, hand the output to LongMemEval's
 * official Python evaluator:
 *
 *   python3 LongMemEval/src/evaluation/evaluate_qa.py gpt-4o \
 *           <out>/hypothesis.jsonl \
 *           ~/.cache/pi-mind-eval/longmemeval/longmemeval_oracle.json
 */

import { join, resolve } from "node:path";
import { LongMemEvalDataset } from "./datasets/longmemeval.js";
import type { LongMemEvalSplit } from "./datasets/longmemeval-download.js";
import { PiSessionDriver } from "./drivers/pi-session.js";
import { runEval } from "./runner.js";
import { writeHypothesisJsonl, writeRunOutputJson } from "./report.js";

interface CliArgs {
  dataset: string;
  split: LongMemEvalSplit;
  limit?: number;
  category?: string;
  out: string;
  concurrency: number;
  model?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    dataset: "longmemeval", split: "oracle", out: "./eval-out", concurrency: 1,
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
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`pi-mind eval — generates LongMemEval hypothesis files (no scoring)

Usage:
  pi-mind-eval [--split S] [--limit N] [--category C] [--out DIR] [--model M]

Options:
  --dataset NAME    Dataset to run (default: longmemeval)
  --split S         LongMemEval split: oracle (15MB), s (277MB), m (2.7GB). Default: oracle
  --limit N         Cap total questions
  --category C      Filter to a question_type
  --out DIR         Output directory (default: ./eval-out)
  --concurrency N   Max in-flight questions (default: 1)
  --model M         Override pi's default model

Output:
  <out>/hypothesis.jsonl   — feed this to LongMemEval's evaluate_qa.py for scoring
  <out>/run-output.json    — full run output with tokens, errors, durations

Scoring:
  python3 LongMemEval/src/evaluation/evaluate_qa.py gpt-4o \\
          <out>/hypothesis.jsonl \\
          ~/.cache/pi-mind-eval/longmemeval/longmemeval_oracle.json
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

  console.log(`Running ${dataset.name} via ${driver.name}, output → ${outDir}`);

  const output = await runEval({
    dataset,
    driver,
    category: args.category,
    limit: args.limit,
    concurrency: args.concurrency,
    onProgress: (r, done, total) => {
      const tag = r.error ? ` (error: ${r.error.slice(0, 80)})` : ` (${r.response.length} chars)`;
      console.log(`  [${done}/${total}] ${r.questionId}${tag}`);
    },
  });

  writeHypothesisJsonl(join(outDir, "hypothesis.jsonl"), output);
  writeRunOutputJson(join(outDir, "run-output.json"), output);

  console.log(`\nGenerated hypothesis file for ${output.totalQuestions} question(s).`);
  if (output.meanCostUsd !== undefined) {
    console.log(`Mean cost/question: $${output.meanCostUsd.toFixed(4)}`);
  }
  console.log(`\nScore via:`);
  console.log(`  python3 LongMemEval/src/evaluation/evaluate_qa.py gpt-4o \\\n          ${join(outDir, "hypothesis.jsonl")} \\\n          ~/.cache/pi-mind-eval/longmemeval/longmemeval_oracle.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
