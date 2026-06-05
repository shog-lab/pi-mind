# @shog-lab/pi-mind-core

**Give pi a mind: portable, self-maintaining memory as a drop-in [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension.**

A pi extension package that turns any repo into the home of a persistent agent. Memory survives across sessions, accumulates over time, and the agent maintains its own knowledge through a periodic memory-audit.

Inspired by [Karpathy's LLM Wiki](https://github.com/luotwo/llm-wiki) — knowledge as flat markdown the LLM curates itself.

## Why

LLM agents that lose everything between sessions can't accumulate. RAG-only setups see history as searchable chunks but don't learn from contradictions, deprecations, or refinements. pi-mind treats memory as a **two-layer system** (raw event stream + curated knowledge markdown — the SoT for the KG via the frontmatter `triples:` field) with a derived SQLite index, gives the agent tools to write/read/lint its own knowledge, and gets out of the way otherwise.

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
│   └── *.md           compiled facts, decisions, concepts (frontmatter + body) + `triples` field (KG SoT)
```

Two layers plus a derived KG index: **raw** (append-only event stream), **knowledge** (compiled markdown — also the SoT for the KG via its `triples:` frontmatter field), and the **KG index** (SQLite `kg_*` tables in `.pi-mind/.pi-mind-index.db`, rebuilt from frontmatter on every sync). There is no `graph/` directory — the KG lives in SQLite, not on disk as a separate file layer.

## Install

```bash
npm i -D @shog-lab/pi-mind-core
```

`postinstall` symlinks `extensions/memory/` and `skills/*/` into the host repo's `.pi/`, then creates the `raw/ knowledge/` directories. Idempotent — re-running `npm install` is safe.

`pi-mind` declares `@earendil-works/pi-coding-agent` as a peer dependency. Make sure `pi` is on `PATH` (typically via `npm i -g @earendil-works/pi-coding-agent`).

## Quickstart

```bash
cd ~/my-repo
npm i -D @shog-lab/pi-mind-core

pi                          # interactive: memory auto-loaded, system prompt injected
# > "记一下 I prefer pm2 over forever for process management"
# (agent calls remember_this tool → .pi-mind/knowledge/*.md, source: explicit)

pi -p "what do you know about my preferences?"
# (agent retrieves and answers via L1/L2 injection)

npx pi-mind-lint                # validate knowledge schema
npx pi-mind-lint --prune        # dry-run: show what forget would delete
npx pi-mind-lint --prune --apply  # really delete stale memories + raw artifacts
```

The forget mechanism runs automatically every 50 writes (see [Memory maintenance](#memory-maintenance)); the manual `--prune` is for emergency cleanup or audit.

Optional cron for memory-audit (no cron is required; the extension is daemon-free):

```cron
0 22 * * * cd /path/to/repo && pi -p "use memory-audit skill" >> .pi-mind/cron.log 2>&1
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
| `source` | no | `explicit` / `compaction` / `observe` (or any string) | informational — which writer produced this entry. Set by `saveMemory`; not used by retrieval. |
| `image` | no | relative path under `$PI_MIND_DIR` (e.g. `raw/images/abc.png`) | link to a stored image; rendered as `![](../<image>)` in the body. |

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

**Naming convention** (the KG index is only as good as the predicate vocabulary — fragmented relations never get joined):

- **Entity**: canonical lowercase for stable identifiers; preserve natural casing for proper nouns (`DeepSeek V4`, `--rebuild-kg`). Multi-word entities use hyphens / underscores (`auth-service`, `ml-model`).
- **Predicate**: snake_case verb phrase. `addTriple` normalizes spaces to `_` on ingest, so `uses model` and `uses_model` end up the same — write it snake_case anyway. No copula (`is`, `has`), no `related_to` (pick a direction).
- **Direction**: pick one. Never mix `owns` / `owner_of` / `owned_by` — that's relation fragmentation.

Good: `carol uses_model DeepSeek V4` · `pi-mind-core released_version 0.12.0` · `pi-mind-lint supports_flag --rebuild-kg`. Bad: `x is y` · `a has b` · `p related_to q`.

Audit the current state at any time:

```bash
npx pi-mind-lint --kg-health     # read-only: top predicates, suspicious list, orphan check
```

The `memory-audit` skill runs this on every audit. See `AGENTS.md` (KG naming convention) for the full rationale and the audit policy.

## Retrieval

Each turn, the memory extension automatically injects relevant memory into the agent's context, before any tool call:

- **L1 entries** — always injected (token budget capped, default 2000)
- **L2 entries** — FTS5 + vector search by relevance to the user's prompt, scored with type-weights (configurable in `pi-mind-config.json`) and recency boost
- **Linked pages** — `[[link]]` resolution pulls in connected entries
- **Token budget** — total injection capped (default 4000) to leave room for actual reasoning

Configure via a `pi-mind-config.json` in `$PI_MIND_DIR/` (auto-loaded). Defaults live in `extensions/memory/core.ts`.

### Vector search requires Ollama

L2 vector search is powered by the **`nomic-embed-text`** model served by a local
[Ollama](https://ollama.com) daemon (default URL `http://localhost:11434`,
configurable via `pi-mind-config.json` → `embedding.ollamaUrl`).

- **If Ollama is running with `nomic-embed-text` pulled** — vector search works; new memory
  entries are embedded as they're indexed.
- **If Ollama is down / model not pulled / network unreachable** — vector search is
  automatically **skipped** and retrieval falls back to FTS5 keyword search. A one-line
  warning is logged to the agent's stderr (`[pi-mind] embedding call failed: ...`).
  Retrieval still works; the agent just sees fewer topically-similar matches.
- **Embedding requests are timed out at 5s** to avoid blocking the turn on a hung daemon.
  On timeout the warning reads `[pi-mind] embedding timed out after 5000ms ...` and
  FTS5 fallback kicks in.

To install Ollama + the model:

```bash
# Install Ollama: see https://ollama.com/download
ollama pull nomic-embed-text
ollama serve   # if not already running as a service
```

## Memory maintenance

Three mechanisms keep memory healthy. None require a daemon — pi-mind has no background process; everything piggybacks on the natural rhythm of agent interaction.

- **`knowledge-lint`** — validates frontmatter, finds duplicates, flags stale entries. With `--fix` it auto-migrates legacy fields. With `--prune` it deletes age-expired memories + raw artifacts (`--prune --apply` to actually delete; default is dry-run).
- **`memory-audit`** — agent-executed skill: scans the maintenance log, samples LLM decisions, surfaces problems. Triggered by an "audit overdue" notice the extension injects into the agent's context at `before_agent_start`; the agent decides when to honor it.
- **Auto-forget** — `saveMemory` increments a persistent counter (`raw/maintenance-log/last-forget.json`); every 50 writes the extension runs `forgetOldMemories()` synchronously and resets. No cron needed.

Retention policy (`lib/forget.ts`):

| Target | Retention |
|---|---|
| `knowledge/` type=`user`, `project` | Never auto-deleted (durable preferences / decisions) |
| `knowledge/` type=`agent-feedback` | Frontmatter date > 60 days |
| `knowledge/` type=`reference` | Frontmatter date > 90 days |
| `raw/compaction/*.md` | mtime > 30 days |
| `raw/sessions/<cwd>/*.jsonl` | mtime > 14 days; empty cwd-dirs pruned |
| `raw/maintenance-log/*.jsonl` | mtime > 30 days (markers preserved) |

Optional cron — only if you want memory-audit to fire even without an interactive session:

```cron
0 22 * * * cd /repo && pi -p "use memory-audit skill" >> .pi-mind/cron.log 2>&1
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

`memory-audit` scans the entire `raw/` tree, so anything any package writes there gets reviewed automatically. Convention: each package writes only to its own subdirectory and uses the same frontmatter schema. See [`pi-chrome`](https://github.com/shog-lab/pi-chrome) for an example sibling package.

## Benchmarks

`eval/` ships the LongMemEval harness (datasets, pi-session driver, runner, report). Produces `hypothesis.jsonl` to feed into LongMemEval's official Python evaluator. **Internal dev tooling; NOT published** — `tsconfig.json` excludes `eval/**/*` from the build, so the harness is not in the npm tarball. Run via `tsx` directly, see [`eval/README.md`](eval/README.md) for the out-of-process scoring pipeline.

```bash
npm run eval --workspace=packages/core -- --split oracle --limit 5 --out /tmp/eval-run
```

The harness bypasses any container or daemon — it imports `MemoryCore` directly. This makes the memory module independently testable.

History: `eval/` lived in its own `packages/eval/` workspace through 2026-05-26. Folded into core on 2026-05-27 because it only ever evaluated memory and was never published — a workspace boundary wasn't earning its overhead. The git-tracked rename preserves history. The separate `scripts/verify-worth-remembering.ts` precision-checker shipped through 0.5.x — removed in 0.6.0 along with the `worth-remembering-llm` detector itself (no detector to verify).

## Architecture

```
pi process (the runtime)
  ↓ extension load
memory extension initializes:
  - reads .pi-mind/ from disk
  - syncs FTS5 + vector + KG index in .pi-mind/.pi-mind-index.db
    (KG index is rebuilt from frontmatter `triples` fields on every sync;
    frontmatter is the source of truth, the SQLite kg_* tables are a
    derived, rebuildable index)
  - registers hooks: before_agent_start / turn_end / session_compact
  - registers tools: remember_this, observe, recall_memory,
                     update_memory, mark_memory_audit_complete
    (no forget_memory tool — old memories drop via retention policy in
    lib/forget.ts, auto-run every 50 writes; for emergency manual prune
    use the CLI: `npx pi-mind-lint --prune --apply`)
  - injects system-prompt.md into agent context (via pi.injectContext)
  ↓
agent runs:
  - before_agent_start: L1 always-inject + L2 query-relevant retrieval; cache userPrompt
  - turn_end: archive sessions (filtered to this host repo only — see lib/session-archive.ts)
  - on saveMemory (from remember_this / observe): bump persistent counter;
    every 50 writes auto-run forgetOldMemories (mechanical retention policy)
  - session_compact: pi-side summary saved to raw/compaction/ + syncIndex
  ↓ pi process exit
SQLite + filesystem persist, in-memory state cleared
```

**No background memory writers in 0.6.0+** — two were removed for violating the "Memory is passive" design principle (see top-level `AGENTS.md`):
- the `agent_end` `worth-remembering-llm` detector (qwen3:4b via Ollama) that auto-captured high-signal turns; and
- the `session_compact` fire-and-forget classifier sub-agent ("B-spawn") that promoted each compaction summary into a `knowledge/` entry.

Both were lifecycle-triggered LLMs writing curated state with no user in the trigger chain. Compaction summaries are still persisted to `raw/compaction/` and remain retrievable on their own (syncIndex scans `raw/` as well as `knowledge/`, so a `type: compaction` entry is searchable at tier L2 — see `getScanDirs`). They age out via the normal retention policy unless explicitly promoted into durable `knowledge/` via the `memory-audit` skill, in a visible turn. All curated knowledge now requires explicit `remember_this` / `observe` calls (or an audit) in a visible turn.

Key implementation notes:

- **Concurrency safety**: `withGroupLock` (proper-lockfile) wraps all multi-step writes (`syncIndex`, `saveMemory`, KG mutations). Reentrant via reference counting. SQLite gets `busy_timeout = 5000` as a second wall.
- **Schema convergence (Plan C)**: `type=subject + tier=recall` two-axis design, replacing earlier overlapping `type` field that conflated both. See `lib/schema.ts:LEGACY_TYPE_MAP` for documented lossy migrations.
- **No double-source for schema**: `lib/schema.ts` is the single source; `core.ts` and `scripts/knowledge-lint.ts` both import from it.
- **Soft-trigger maintenance**: cron + skills + audit log, not exception-throwing CI gates. Agent maintains its own house.

## Status

Early. The core (memory model, schema, lint, memory-audit, forget) is in active use; APIs may evolve. Tests cover MemoryCore, KnowledgeGraph, forget mechanism, session-archive filter, and extension behavior (all passing — verify count with `npm test`).

Roadmap (no fixed dates):

- [ ] Per-pi-process saveMemory call-site validation (currently relies on TS literal types)
- [ ] Migration of long-running pi-mind users from legacy schemas (handled in lint --fix today)
- [ ] Vector embedding cache to skip re-embed on unchanged content
- [ ] Optional encryption-at-rest for sensitive knowledge entries

## License

MIT
