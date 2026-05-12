# AGENTS.md

This document provides a guide for AI agents working in this repository.

## Project Overview

`pi-mind` is a monorepo containing three npm packages for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent):

| Package | Published as | Description |
|---|---|---|
| [`packages/memory`](packages/memory/) | `pi-mind` | Persistent memory + self-evolution (raw / knowledge / graph layers) |
| [`packages/toolkit`](packages/toolkit/) | `pi-toolkit` | Common tools: image generation, web search, browser automation |
| [`packages/ralph`](packages/ralph/) | `pi-goals` | Ralph-style autonomous goal execution with PRD loop |

## Development Commands

```bash
npm install        # Install deps + build dist + create .pi/ symlinks
npm run build      # Build all packages
npm test           # Run all tests (vitest)
```

Per-package commands:

```bash
npm run build -w pi-mind     # Build memory package
npm run build -w pi-goals    # Build goals package
npm test -w pi-mind          # Test memory package
```

Watch mode for active development:

```bash
npx tsc -w -p packages/memory    # Watch memory package
npx tsc -w -p packages/ralph    # Watch goals package
```

## Loaded Extensions & Skills

When running `pi` in this repo, the following are auto-loaded from `.pi/`:

### Extensions

| Extension | Source | Purpose |
|---|---|---|
| `memory` | `packages/memory/dist/extensions/memory/` | Three-layer memory system (raw/knowledge/graph) |
| `subagent` | `packages/memory/dist/extensions/subagent/` | Spawn focused sub-agents for isolated tasks |
| `goals` | `packages/ralph/dist/extensions/goals/` | `/goal` command + goal management tools |
| `jimeng` | `packages/toolkit/dist/extensions/jimeng/` | Volcengine Jimeng T2I image generation |
| `web_search` | `packages/toolkit/dist/extensions/web_search/` | Web search via mmx CLI |
| `understand_image` | `packages/toolkit/dist/extensions/understand_image/` | Image understanding via mmx vision |

### Skills

| Skill | Source | Purpose |
|---|---|---|
| `daily-audit` | `packages/memory/skills/daily-audit/` | Memory hygiene audit loop |
| `wiki-lint` | `packages/memory/skills/wiki-lint/` | Schema validation & auto-fix |
| `scheduling` | `packages/memory/skills/scheduling/` | Cron job setup helper |
| `agent-browser` | `node_modules/agent-browser/skills/agent-browser/` | Browser automation |
| `prd` | `packages/ralph/skills/prd/` | Generate Product Requirements Documents |
| `ralph` | `packages/ralph/skills/ralph/` | Convert markdown PRD to prd.json format |

## Memory Structure

All memory lives in `$PI_MIND_DIR` (default `./.pi-mind/`):

```
.pi-mind/
├── raw/
│   ├── sessions/         Session transcripts
│   ├── observations/      Agent's notes during work
│   ├── compaction/       Auto-summaries
│   └── maintenance-log/   Internal ops trail
├── knowledge/            Compiled facts as *.md
│   └── *.md              (frontmatter schema required)
└── graph/                KG managed from frontmatter triples
```

Knowledge entries follow this frontmatter schema:

```yaml
---
date: 2026-05-08T10:00:00.000Z
type: project          # user | project | agent-feedback | reference | compaction
tier: L2               # L1 (always-injected) | L2 (retrieved by relevance)
tags: [auth, decision]
triples: [["alice", "owns", "auth-service"]]
---

Content here.
```

## Goals Structure

Goals state and logs live in `$PI_GOALS_DIR` (default `./.pi-goals/`):

```
.pi-goals/
├── goals.db              # SQLite: goal state machine
├── progress.txt          # Append-only learnings
├── prd.json              # Current PRD (when using --from)
├── episodic/
│   └── ralph/            # Iteration logs
│       └── iteration-001.jsonl
└── .locks/               # Concurrent write protection
```

## Key Files

| Path | Purpose |
|---|---|
| `packages/memory/lib/schema.ts` | Single source of truth for frontmatter schema |
| `packages/memory/core.ts` | Memory retrieval & injection logic |
| `packages/memory/extensions/memory/index.ts` | Extension entry point |
| `packages/memory/extensions/subagent/index.ts` | Sub-agent spawn logic |
| `packages/memory/skills/daily-audit/SKILL.md` | Daily audit skill |
| `packages/memory/skills/wiki-lint/SKILL.md` | Wiki lint skill |
| `packages/ralph/lib/schema.ts` | Goal & UserStory type definitions |
| `packages/ralph/lib/store.ts` | SQLite-backed goal persistence |
| `packages/ralph/lib/loop.ts` | Ralph-style execution loop with verification |
| `packages/ralph/lib/mutex.ts` | Reentrant file lock for concurrent writes |
| `packages/ralph/extensions/goals/index.ts` | `/goal` command & goal tools |
| `packages/ralph/skills/prd/SKILL.md` | PRD generation skill |
| `packages/ralph/skills/ralph/SKILL.md` | PRD → prd.json conversion skill |
| `packages/toolkit/extensions/jimeng/` | Image generation extension |
| `packages/toolkit/extensions/web_search/` | Web search extension |
| `packages/toolkit/extensions/understand_image/` | Image understanding extension |

## Goals Architecture

The `/goal` command implements Ralph-style autonomous execution:

```
/goal command
    │
    ├── [Execution sub-agent] ← spawn_subagent, full tools
    │         ↓ implements story
    │
    ├── [Verification sub-agent] ← spawn_subagent, restricted tools (Read/Bash only)
    │         ↓ returns { passes: bool, evidence, reasons }
    │
    └── [Update prd.json / iteration log]
              ↓
        Repeat until all pass or max iterations
```

**Key design: Verification is isolated.** A separate sub-agent with clean context checks completion against actual evidence — the execution agent cannot self-verify.

## Testing

```bash
npm test              # All tests (120+ tests, all should pass)
npm run lint:wiki     # Check knowledge/ schema health
```

## Conventions

- **Schema source**: `lib/schema.ts` is the single source of truth; all code imports from it
- **File-based coordination**: Packages communicate via shared `$PI_MIND_DIR` directories
- **Cron-driven evolution**: Self-evolution runs via OS cron, not in-process scheduler
- **Concurrent writes**: Use `withGroupLock` (proper-lockfile) + `busy_timeout = 5000`
- **Idempotent postinstall**: Re-running `npm install` is safe
- **Peer dependencies**: `pi-goals` depends on `pi-mind` as peer, not consumer

## Environment Variables

| Variable | For | Notes |
|---|---|---|
| `JIMENG_ACCESS_KEY` | jimeng extension | Volcengine access key |
| `JIMENG_SECRET_KEY` | jimeng extension | Volcengine secret key |
| `DEEPSEEK_API_KEY` | Benchmark scripts | For LongMemEval benchmark |
| `PI_GOALS_DIR` | pi-goals | Override goals directory (default: `.pi-goals/`) |