# @pi-mind/eval

Generates LongMemEval hypothesis files by running pi-mind against the benchmark.
**Does NOT score** — scoring is delegated to LongMemEval's official Python evaluator.

**Private workspace** — not published.

## Status

⚠️ **Scoring layer was removed and is to be rebuilt.** The previous custom
LLM judge did not match LongMemEval's official evaluation methodology (wrong
prompts, wrong abstention detection, model-tier mismatch). Numbers from the
previous version are not comparable to published baselines and were discarded.

The plan: this harness produces responses; LongMemEval's official Python
evaluator scores them. See "Scoring" below.

## Pipeline

```
Dataset → Driver → HypothesisFile → [out-of-process: LongMemEval evaluator]
```

- **Dataset** yields `EvalQuestion { history, question, groundTruth }` lazily
- **Driver** runs one question; pi-session driver isolates each in a tmpdir with its own `.pi-mind`
- **Hypothesis file** (`hypothesis.jsonl`) is the contract handoff to LongMemEval's evaluator

## What's kept (working)

- `src/datasets/longmemeval.ts` — downloads + parses the upstream JSON; emits EvalQuestions
- `src/datasets/longmemeval-download.ts` — HF download with size validation and cache
- `src/drivers/pi-session.ts` — spawns pi, seeds memory via knowledge files, captures response
- `src/runner.ts` — orchestration, concurrency
- `src/report.ts` — writes hypothesis.jsonl + run-output.json
- `src/cli.ts` — CLI entry

## What's removed (was broken)

- `src/scoring/*` — custom judge was not aligned with LongMemEval's official prompts
- `src/pipeline.test.ts` — tested the broken scorers

## Run

```bash
npm run build --workspace packages/eval
node packages/eval/dist/cli.js --split oracle --limit 5 --out /tmp/eval-run
```

Outputs:
- `/tmp/eval-run/hypothesis.jsonl` — feed to official evaluator
- `/tmp/eval-run/run-output.json` — full run output (tokens, errors, durations)

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
