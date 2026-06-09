# @shog-lab/pi-mind-eval

LongMemEval benchmark harness for the pi-mind memory system. Two tracks:

- **Official QA accuracy** — spawn pi, collect responses, optionally run the
  upstream LongMemEval Python evaluator on them. Citable across systems.
- **Retrieval R@k / NDCG@k** — measure memory's recall directly, no model
  cost. Compare memory implementations apples-to-apples. MemPalace-style.

**Private top-level workspace** (`@shog-lab/pi-mind-eval`, `private: true`).
Not published.

## Tracks

| Track | What it measures | When to use |
|---|---|---|
| `--track qa` (default) | QA accuracy of the agent's final answer. Citable when scored with the official evaluator. | Cross-system comparisons (pi-mind vs others). |
| `--track retrieval` | Did memory surface the right session when the question was asked? R@5, R@10, NDCG@10 + per-category. | Fast iteration on memory variants (indexing, ingestion, prompt). |

The two tracks are intentionally separate: retrieval says "memory found the right context", QA says "the model used the context correctly". Mixing them is the most common eval-confusion bug.

## Run

Build the memory extension first, then:

```bash
# Build the memory extension once (its dist is what the eval loads)
npm run build --workspace=@shog-lab/pi-mind-core

# QA track (default). Internal judge is OPTIONAL — it's a deepseek/any-model
# port of LongMemEval's `get_anscheck_prompt` and is NOT LongMemEval-citable.
npm run eval:longmemeval -- --split oracle --limit 10 --out /tmp/eval-qa
npm run eval:longmemeval -- --split oracle --limit 10 --out /tmp/eval-qa --judge --judge-model deepseek/deepseek-chat

# Official QA scoring (requires LongMemEval repo cloned locally)
git clone https://github.com/xiaowu0162/LongMemEval ~/LongMemEval
cd ~/LongMemEval && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
npm run eval:longmemeval -- --split oracle --limit 10 --out /tmp/eval-qa --score-official --official-model gpt-4o-mini

# Retrieval track (no model cost, no pi spawn — measures memory directly)
npm run eval:longmemeval -- --track retrieval --split oracle --limit 10 --out /tmp/eval-retrieval
```

## Outputs

| File | QA track | Retrieval track | Notes |
|---|---|---|---|
| `hypothesis.jsonl` | always | — | LongMemEval official format. Feeds the official Python evaluator. |
| `run-output.json` | always | — | Full responses, tokens, errors, judge replies. |
| `report.md` | when `--judge` on | — | Per-category score table + failures (top 50). |
| `retrieval-score.json` | — | always | R@k + NDCG@k + per-category. |
| `retrieval-report.md` | — | always | Per-question top-k audit table (first 30 rows). |
| `official-score.json` | when `--score-official` on | — | Even on graceful failure, written with `overall: null` + reasons. |
| `official-eval-results.json` | when upstream wrote `.eval-results-<model>` | — | Raw per-question output from the official evaluator. |
| `manifest.json` | always | always | Reproducibility: git SHA, args, models, node version. |

## Comparability caveats

- The internal `--judge` score is a deepseek/any-model port of LongMemEval's
  `get_anscheck_prompt`. It is fast and model-flexible but **not**
  LongMemEval-citable. Use it for internal iteration only.
- The official `--score-official` wraps the upstream `evaluate_qa.py`
  verbatim. **This is the source of truth for QA accuracy** and is what
  you cite in cross-system comparisons. Requires the LongMemEval repo
  cloned locally (default path `~/LongMemEval`, override with
  `--official-repo` or `$LONGMEMEVAL_HOME`).
- Retrieval metrics are a different axis. They tell you whether
  memory's hybrid retrieval (FTS5 + vector + KG) returned the right
  session for the right question. They are **NOT comparable** to QA
  accuracy — a system can have perfect retrieval and a dumb model
  (low QA), or weak retrieval and a smart model that compensates
  (high QA). Use retrieval to optimize memory, QA to evaluate the
  end-to-end system.
- The two tracks use the **same ingestion** (the `seed.ts` helper is
  shared), so the apples-to-apples comparison is: same memory contents,
  different downstream consumption (model vs. raw retrieval).

## Retrieval metric definitions

For each non-abstention question:

- **RecallAny@k**: 1 if any `answerSessionId` appears in the top-k
  retrieved filePaths (mapped to sessionId via the seeded `session_id`
  frontmatter), else 0. Mean over all non-abstention questions.
- **NDCG@k**: standard formula, binary relevance. The relevance set
  is the `answerSessionIds`. Normalized by IDCG (best possible
  ordering truncated to k).

Abstention cases (no `answerSessionIds`) are **excluded from the
denominator**; their count is reported separately. Computing recall
against an empty set is meaningless.

## Seeded file shape

For each `haystack_sessions[i]`, the seed helper writes one
`knowledge/eval-${sessionId}.md` with:

```yaml
---
date: <ISO-normalized>
type: reference
tier: L2
tags: [eval-seed, session:<sessionId>]
session_id: <sessionId>     # explicit, parsed by the retrieval track
---
**user:** ...
**assistant:** ...
```

The `session_id` frontmatter field is what the retrieval track uses to
map a retrieved `filePath` back to its `answerSessionId`. The
`session:<id>` tag is a fallback for back-compat with hand-edited files
that might not have `session_id`.

## What this is NOT

- Not a general eval framework. No abstract Driver / Judge / Metric
  classes beyond the minimum needed for these two tracks.
- Not a Mem0 / LangMem / etc. integration. The pi-session driver
  spawns `pi`; the retrieval driver uses `MemoryCore` directly.
- Not published. The workspace is `private: true`. No npm tarball
  contains it.
