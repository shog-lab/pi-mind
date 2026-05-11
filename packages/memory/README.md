# pi-mind

**Give pi a mind: portable memory and self-evolution as a drop-in [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension.**

A pi extension package that turns any repo into the home of a persistent, self-improving agent. Memory survives across sessions, accumulates over time, and the agent maintains its own knowledge through a daily audit loop.

Inspired by [Karpathy's LLM Wiki](https://github.com/luotwo/llm-wiki) — knowledge as flat markdown the LLM curates itself.

## Why

LLM agents that lose everything between sessions can't accumulate. RAG-only setups see history as searchable chunks but don't learn from contradictions, deprecations, or refinements. pi-mind treats memory as a **three-layer system** with a real consolidation loop, gives the agent tools to write/read/lint its own knowledge, and gets out of the way otherwise.

## Memory model

Memory lives in `$PI_MIND_DIR` (default `./.pi-mind` in the current repo) with three peer directories:

```
.pi-mind/
├── raw/    — what happened
│   ├── sessions/      conversation transcripts
│   ├── observations/  things the agent noticed during work
│   ├── compaction/    auto-saved conversation summaries
│   └── maintenance-log/  jsonl trail of internal ops
├── knowledge/   — what's true
│   └── *.md           compiled facts, decisions, concepts (frontmatter + body)
└── graph/       — how it's connected
    └── (managed by KG module from frontmatter `triples` fields)
```

Three layers map to cognitive science: **raw** (raw events), **semantic** (compiled knowledge), **relational** (entity-relationship graph). Markdown wiki is one rendering of `knowledge/`, not memory itself — raw is real append-only logs; graph is structured triples.

## Install

```bash
npm i -D pi-mind
```

`postinstall` symlinks `extensions/memory/` and `skills/*/` into the host repo's `.pi/`, then creates the `raw/ knowledge/ graph/` directories. Idempotent — re-running `npm install` is safe.

`pi-mind` declares `@earendil-works/pi-coding-agent` as a peer dependency. Make sure `pi` is on `PATH` (typically via `npm i -g @earendil-works/pi-coding-agent`).

## Quickstart

```bash
cd ~/my-repo
npm i -D pi-mind

pi                          # interactive: memory auto-loaded, system prompt injected
# > "remember that I prefer pm2 over forever for process management"
# (agent writes to .pi-mind/knowledge/*.md)

pi -p "what do you know about my preferences?"
# (agent retrieves and answers)

npx pi-mind-lint            # check schema health of knowledge/
npx pi-mind-cron            # print recommended crontab entries
```

For the daily-audit loop, add the snippet from `npx pi-mind-cron` to your crontab. Typical:

```cron
0 22 * * * cd /path/to/repo && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1
```

## Frontmatter schema

Knowledge entries have a strict frontmatter:

```markdown
---
date: 2026-05-08T10:00:00.000Z
type: project
tier: L2
tags: [auth, decision]
triples: [["alice", "owns", "auth-service"]]
---

We chose JWT over sessions because of mobile client constraints.
```

| Field | Required | Values | Purpose |
|---|---|---|---|
| `date` | yes | ISO 8601 | sort, recency boost, staleness check |
| `type` | yes | `user` / `project` / `agent-feedback` / `reference` / `compaction` | **subject axis** — who/what is this about |
| `tier` | yes | `L1` / `L2` | **recall axis** — `L1` always-injected, `L2` retrieved by relevance |
| `tags` | no | `string[]` | free-form topic keywords (no subject/tier encoding) |
| `triples` | no | `[[subject, predicate, object], ...]` | structured KG relations |

The `type` × `tier` orthogonality is deliberate: any subject can be L1 (high-priority) or L2 (default). See [`lib/schema.ts`](lib/schema.ts) for the canonical definitions and `LEGACY_TYPE_MAP` for migration of old enums.

### Page interconnection

Use `[[page-name]]` to link knowledge entries. When pi retrieves the linker, the linked page is loaded too:

```markdown
This builds on [[agent-memory]] and supersedes [[old-design-2024]].
```

### Knowledge graph triples

When a memory involves people, schedules, or relationships, add triples. The KG module indexes them for queries like "who owns X" or "when does Y happen":

```yaml
triples: [["alice", "owns", "auth-service"], ["alice", "role", "backend-lead"]]
```

## Retrieval

Each turn, the memory extension automatically injects relevant memory into the agent's context, before any tool call:

- **L1 entries** — always injected (token budget capped, default 2000)
- **L2 entries** — FTS5 + vector search by relevance to the user's prompt, scored with type-weights (configurable in `pi-mind-config.json`) and recency boost
- **Linked pages** — `[[link]]` resolution pulls in connected entries
- **Token budget** — total injection capped (default 4000) to leave room for actual reasoning

Configure via a `pi-mind-config.json` in `$PI_MIND_DIR/` (auto-loaded). Defaults live in `extensions/memory/core.ts`.

## Self-evolution

Two cron-driven skills keep memory healthy:

- **`wiki-lint`** — validates frontmatter, finds duplicates, flags stale entries. With `--fix` it auto-migrates legacy fields.
- **`daily-audit`** — reviews recent activity, samples LLM feedback decisions for quality, archives old compactions, reports findings.

Both are designed to be triggered by **OS cron**, not by an in-process scheduler — pi-mind has no daemon.

```cron
0 22 * * * cd /repo && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1
0 02 * * * cd /repo && npx pi-mind-lint --fix     >> .pi-mind/cron.log 2>&1
```

## Composing with other pi packages

pi-mind defines the structure of `$PI_MIND_DIR/raw/` but **does not own it**. Other packages can write to their own subdirectories:

```
.pi-mind/raw/
├── sessions/         pi-mind: pi session archives
├── compaction/       pi-mind: auto summaries
├── observations/     pi-mind: agent's own notes
└── browser/          pi-chrome: browser task outcomes (if installed)
```

`daily-audit` scans the entire `raw/` tree, so anything any package writes there gets reviewed automatically. Convention: each package writes only to its own subdirectory and uses the same frontmatter schema. See [`pi-chrome`](https://github.com/shog-lab/pi-chrome) for an example sibling package.

## Benchmarks

Two scripts ship for measuring memory quality:

- **`scripts/run-longmemeval.ts`** — runs the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark against the memory system. Useful for quantitative comparisons against baseline RAG.
  ```bash
  DEEPSEEK_API_KEY=... npx tsx scripts/run-longmemeval.ts --limit 100
  ```
- **`scripts/verify-feedback.ts`** — checks the LLM feedback detector's precision/recall against a hand-curated case set. Useful before merging changes to the feedback prompt.

Both bypass any container or daemon — they import `MemoryCore` directly. This makes the memory module independently testable.

## Architecture

```
pi process (the runtime)
  ↓ extension load
memory extension initializes:
  - reads .pi-mind/ from disk
  - syncs FTS5 + vector index in .pi-mind/.pi-mind-index.db
  - registers hooks: turn_end / session_compact / before_agent_start
  - injects system-prompt.md into agent context (via pi.injectContext)
  ↓
agent runs:
  - before each prompt: L1 always-inject + L2 query-relevant retrieval
  - on session compaction: summary saved + classification spawned
  - feedback detection: regex + Ollama qwen2.5:1.5b for LLM-tier classification
  ↓ pi process exit
SQLite + filesystem persist, in-memory state cleared
```

Key implementation notes:

- **Concurrency safety**: `withGroupLock` (proper-lockfile) wraps all multi-step writes (`syncIndex`, `saveMemory`, KG mutations). Reentrant via reference counting. SQLite gets `busy_timeout = 5000` as a second wall.
- **Schema convergence (Plan C)**: `type=subject + tier=recall` two-axis design, replacing earlier overlapping `type` field that conflated both. See `lib/schema.ts:LEGACY_TYPE_MAP` for documented lossy migrations.
- **No double-source for schema**: `lib/schema.ts` is the single source; `core.ts` and `scripts/wiki-lint.ts` both import from it.
- **Soft-trigger self-evolution**: cron + skills + audit log, not exception-throwing CI gates. Agent maintains its own house.

## Status

Early. The core (memory model, schema, lint, daily-audit) is in active use; APIs may evolve. Tests cover MemoryCore (33), KnowledgeGraph (8), feedback detection, and extensions (120 total, all passing).

Roadmap (no fixed dates):

- [ ] Per-pi-process saveMemory call-site validation (currently relies on TS literal types)
- [ ] Migration of long-running pi-mind users from legacy schemas (handled in lint --fix today)
- [ ] Vector embedding cache to skip re-embed on unchanged content
- [ ] Optional encryption-at-rest for sensitive knowledge entries

## License

MIT
