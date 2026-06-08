# @shog-lab/pi-mind-eval

LongMemEval benchmark harness for the pi-mind memory system. Used for horizontal comparison (memory implementations side-by-side) and vertical comparison (memory variants over time).

**This is a project-level private workspace, not a published package.** It lives at `eval/longmemeval/` rather than under `packages/`, so the eval layer is structurally separate from the published packages.

## Status

This harness produces both responses and TS-side LongMemEval-style judging. The TS judge in `scoring/longmemeval-judge.ts` ports LongMemEval's official `get_anscheck_prompt` verbatim (last synced 2026-05-14) — for cross-system comparability, run all systems through the same judge model.

A second scoring path is to use LongMemEval's official Python evaluator (`src/evaluation/evaluate_qa.py`) on the `hypothesis.jsonl` we produce — the JSONL contract is the official format, so no adapter is needed. See "Scoring" below.

## Pipeline

```
Dataset → Driver → HypothesisFile → [out-of-process: LongMemEval evaluator]
```

- **Dataset** yields `EvalQuestion { history, question, groundTruth }` lazily
- **Driver** runs one question; pi-session driver isolates each in a tmpdir with its own `.pi-mind`
- **Hypothesis file** (`hypothesis.jsonl`) is the contract handoff to LongMemEval's evaluator

## What's here

- `datasets/longmemeval.ts` — downloads + parses the upstream JSON; emits EvalQuestions
- `datasets/longmemeval-download.ts` — HF download with size validation and cache
- `drivers/pi-session.ts` — spawns pi, seeds memory via knowledge files, captures response. Auto-resolves the compiled memory extension by walking up to the repo root and into `packages/core/dist/extensions/memory/index.js`.
- `runner.ts` — orchestration, concurrency
- `report.ts` — writes hypothesis.jsonl + run-output.json
- `scoring/longmemeval-judge.ts` — TS port of LongMemEval's official `get_anscheck_prompt` (verbatim). Use `--judge` to enable; without it, scoring is done later by LongMemEval's Python evaluator.
- `cli.ts` — CLI entry

## Run

The harness runs as a private workspace. Build the memory extension first
(`npm run build --workspace=@shog-lab/pi-mind-core`), then:

```bash
# from monorepo root
npm run eval:longmemeval -- --split oracle --limit 5 --out /tmp/eval-run

# or from the eval workspace
cd eval/longmemeval && npm run eval -- --split oracle --limit 5 --out /tmp/eval-run

# with TS judge
npm run eval:longmemeval -- --split oracle --limit 5 --out /tmp/eval-run --judge

# with a specific judge model
npm run eval:longmemeval -- --split oracle --limit 5 --out /tmp/eval-run --judge --judge-model openai/gpt-4o-mini
```

Outputs:
- `/tmp/eval-run/hypothesis.jsonl` — feed to LongMemEval's official Python evaluator
- `/tmp/eval-run/run-output.json` — full run output (tokens, errors, durations, scores if `--judge`)

## Scoring (out-of-process)

```bash
# 1. Clone LongMemEval
git clone https://github.com/xiaowu0162/LongMemEval ~/LongMemEval

# 2. Install eval deps in a Python venv
cd ~/LongMemEval && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt

# 3. Run their evaluator on our hypothesis file
python3 src/evaluation/evaluate_qa.py gpt-4o \
        /tmp/eval-run/hypothesis.jsonl \
        ~/.cache/pi-mind-eval/longmemeval/longmemeval_oracle.json
```

Their evaluator supports `gpt-4o`, `gpt-4o-mini`, or local `llama-3.1-70b-instruct`
(via local OpenAI-compatible server). Choice of judge affects comparability —
see LongMemEval docs for details.
