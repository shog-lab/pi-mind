# AGENTS.md

Guide for AI agents working in this repository.

## Project Overview

`pi-mind` is a monorepo of capability packages for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

| Workspace | npm name | Status | Purpose |
|---|---|---|---|
| `packages/utils` | `@shog-lab/pi-utils` | published | Shared infra: `spawnPi`, `resolvePiMindDir`. Depended on by every other workspace. |
| `packages/core` | `@shog-lab/pi-mind-core` | published | Persistent memory + skill self-evolution. Layers: raw, knowledge, KG. |
| `packages/toolkit` | `@shog-lab/pi-toolkit` | published | Common pi extensions: web search, image understanding, MCP server bridge, sub-agent spawn. |
| `packages/ralph` | `@shog-lab/pi-goals` | published | Ralph-style autonomous goal execution with PRD loop + worktree isolation. |
| `packages/eval` | `@shog-lab/pi-eval` | **not published** (internal) | Benchmark harness (LongMemEval driver for now). |

Publishing is **manual per-package**, no CI — see [[publish-flow]] memory.

## Development Commands

```bash
npm install                          # Install + build dist + create .pi/ symlinks
npm run build                        # Build all workspaces
npm test                             # Run all tests (vitest, ~180 total)
npm run typecheck                    # Typecheck all workspaces
```

Per-workspace (use path or full scoped name):

```bash
npm run build --workspace=packages/core
npm run test --workspace=packages/ralph
npm run typecheck --workspace=packages/toolkit
```

Watch mode:

```bash
npx tsc -w -p packages/core
npx tsc -w -p packages/ralph
```

## Loaded Extensions & Skills

`npm install` symlinks all extensions / skills into `.pi/` so `pi` auto-discovers them.

### Extensions

| Extension | Source dir | Purpose |
|---|---|---|
| `memory` | `packages/core/extensions/memory/` | Persistent memory: hybrid retrieval (vector + FTS5 + KG + [[link]]), `remember_this` / `recall_memory` / `observe` / `forget_memory` tools, worth-remembering-llm auto-capture at agent_end. |
| `skill-evolution` | `packages/core/extensions/skill-evolution/` | `write_skill` tool — agent edits `.pi/skills/<name>/SKILL.md` directly with `.bak.<ts>` backups. Backs the `define-skill` / `revise-skill` skills. |
| `goals` | `packages/ralph/extensions/goals/` | `goal` / `update_goal` / `list_goals` / `get_goal` **tools** (not slash commands). Ralph loop with worktree isolation. |
| `web-search` | `packages/toolkit/extensions/web-search/` | `web_search` tool — backed by mmx CLI. |
| `understand-image` | `packages/toolkit/extensions/understand-image/` | `understand_image` tool — base64 + URL + path; auto-saves base64 attachments to temp files. mmx vision backend. |
| `mcp-bridge` | `packages/toolkit/extensions/mcp-bridge/` | Spawns MCP servers from `mcp-servers.json`, registers their tools as `<server>_<tool>`. |
| `subagent` | `packages/toolkit/extensions/subagent/` | `spawn_subagent` tool — fire-and-forget child pi via `spawnPi`. |

Tool names stay `snake_case` for LLM stability; extension dirs are `kebab-case`.

### Skills

| Skill | Source dir | Purpose |
|---|---|---|
| `daily-audit` | `packages/core/skills/daily-audit/` | Memory hygiene audit loop. |
| `knowledge-lint` | `packages/core/skills/knowledge-lint/` | Schema validation + auto-fix for knowledge entries. (Was `wiki-lint` before 0.3.0.) |
| `scheduling` | `packages/core/skills/scheduling/` | Cron setup helper. |
| `define-skill` | `packages/core/skills/define-skill/` | Compose a brand-new skill via `write_skill`. |
| `revise-skill` | `packages/core/skills/revise-skill/` | Update an existing skill via `write_skill`. |
| `agent-browser` | `node_modules/agent-browser/skills/agent-browser/` | Browser automation (external dep). |
| `prd` | `packages/ralph/skills/prd/` | Generate Product Requirements Documents. |
| `prd-compile` | `packages/ralph/skills/prd-compile/` | Compile markdown PRD → `prd.json`. (Was `ralph` before 0.1.2.) |
| `goals-verify` | `packages/ralph/skills/goals-verify/` | Restricted tool allowlist for verification sub-agents. |

## Directory Conventions

All shared state lives under three roots, all resolvable from any cwd in the repo (or any git worktree of it):

```
.pi-mind/                       # $PI_MIND_DIR — memory + skills state
├── raw/sessions/               session transcripts
├── raw/observations/           agent's notes during work
├── raw/compaction/             auto-summaries
├── raw/maintenance-log/        internal ops trail
├── knowledge/*.md              compiled facts (frontmatter-tagged)
└── graph/                      KG managed from frontmatter triples

.pi-goals/                      # $PI_GOALS_DIR — goal state machine
├── goals.db                    SQLite
├── progress.txt                append-only learnings
├── prd.json                    current PRD (when using --from)
├── episodic/ralph/             per-iteration JSONL logs
└── .locks/                     proper-lockfile coordination

.ralph-worktrees/               per-goal git worktrees (ralph 0.4.0+)
└── goal-<id>/                  isolated checkout on goal's branch
```

**Path resolution** uses `git rev-parse --git-common-dir` (see `packages/utils/src/paths.ts`) — both `.pi-mind/` and `.pi-goals/` always point to the **main repo root** even when called from a linked worktree. `$PI_MIND_DIR` / `$PI_GOALS_DIR` env vars override.

**Add `.ralph-worktrees/` to your `.gitignore`** — ralph logs a one-time hint when it first creates the directory; we don't auto-modify your `.gitignore`.

### Knowledge frontmatter schema

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

## Key Files

| Path | Purpose |
|---|---|
| `packages/utils/src/spawn-pi.ts` | Shared pi spawn — JSON event parsing, token extraction, process-group kill. |
| `packages/utils/src/paths.ts` | `resolvePiMindDir` — git-common-dir aware. |
| `packages/core/lib/schema.ts` | Knowledge frontmatter schema (single source of truth). |
| `packages/core/lib/skill-evolution.ts` | `write_skill` implementation. |
| `packages/core/lib/session-archive.ts` | Session archive with host-cwd prefix filtering. |
| `packages/core/extensions/memory/index.ts` | Memory extension entry; worth-remembering-llm, remember_this. |
| `packages/core/extensions/memory/core.ts` | Hybrid retrieval pipeline (vector + FTS5 + KG + links). |
| `packages/core/extensions/memory/knowledge-graph.ts` | KG storage + entity-fact queries. |
| `packages/ralph/extensions/goals/index.ts` | `goal` tool + sibling management tools. |
| `packages/ralph/extensions/goals/loop.ts` | Execution + verification loop; `ensureWorktree`. |
| `packages/ralph/extensions/goals/store.ts` | SQLite-backed goal persistence. |
| `packages/ralph/extensions/goals/schema.ts` | Goal / UserStory / VerificationResult types. |
| `packages/ralph/extensions/goals/mutex.ts` | Reentrant file lock. |
| `packages/toolkit/extensions/mcp-bridge/mcp-client.ts` | MCP stdio JSON-RPC client. |

## Architecture Notes

### Memory

Three layers, retrievable as a single hybrid context (Ollama `nomic-embed-text` vector + SQLite FTS5 + KG entity facts + `[[link]]` traversal). Writes split into:

- **`remember_this` tool** — agent explicitly persists a fact (preferred).
- **`worth-remembering-llm`** — auto-runs at `agent_end`, uses qwen3:4b (think:false, keep_alive=30m) to decide if the last turn produced something worth saving. Skipped if the tool already fired this turn (explicit-flag dedup).

See [[memory-write-impl-notes]] for runtime details + corner cases.

### Goals (Ralph)

```
goal tool invocation
    ↓
ensureWorktree(cwd, goalId, branchName) → <repo>/.ralph-worktrees/<id>/
    ↓
loop, each iteration:
    Execution sub-pi  ← spawned via spawnPi, --no-extensions, --tools allowlist
        cwd = worktreePath           ← user's main checkout never touched
        ↓ implements one story
    Verification sub-pi ← separate pi process, restricted allowlist
        cwd = worktreePath
        ↓ returns { passes: bool, evidence, reasons } — schema-validated
    Persist outcome, append progress, check budget/pause/iteration
```

Sub-agents run with `--no-extensions` so they **cannot** load pi-mind or any other extension — they're locked to built-in pi tools only. Verification is a separate pi process with a stricter `--tools` allowlist (no Write/Edit).

Memory + `.pi-goals/` resolve to the main repo root regardless of worktree (via git-common-dir). After a goal finishes, the worktree survives — clean up with `git worktree remove .ralph-worktrees/<id>` once reviewed.

### Subprocess discipline

**ALL** `child_process.spawn` calls in pi-mind code MUST use `detached: true` + `process.kill(-pid, signal)` to kill the whole process group. Without this, grandchildren orphan and keep inherited pipe FDs open → Node's `'close'` event never fires → callers hang.

See [[subprocess-group-kill]] memory for the full rule and the audited site list. Reference impl: `packages/utils/src/spawn-pi.ts`.

### E2E probe before publish

Unit tests pass against compiled-on-the-fly source under vitest, which silently injects `require` and other shims that DON'T exist in production ESM. Bugs that pass unit tests have broken production multiple times.

**Mandatory before any `npm publish`**: write a throwaway `.tmp-verify-<feature>.mjs` that imports from `dist/` and exercises the actual integration path — not just the primitive. Primitive-level probes (e.g. "the helper works in isolation") are **NOT sufficient**; the bug surface is in the wiring, not the leaves.

See [[e2e-before-publish]] memory.

## Conventions

- **Single source of truth for schemas** — frontmatter via `packages/core/lib/schema.ts`, goal types via `packages/ralph/extensions/goals/schema.ts`; never duplicate.
- **File-based coordination** — packages share `.pi-mind/` / `.pi-goals/`; no in-process IPC.
- **Cron-driven evolution** — scheduled maintenance runs via OS cron, not in-process timer (pi has no daemon).
- **Concurrent writes** — `withGroupLock` (proper-lockfile) for filesystem, `busy_timeout = 5000` for SQLite.
- **Idempotent postinstall** — `bin/init.js` symlink creation is safe to re-run.
- **No dual-write** — refactor in one go, rely on git revert; don't ship transition shims. See [[no-dual-write]].
- **Direct commit to main** — solo repo, no PR. See [[direct-commit-to-main]].

## Testing

```bash
npm test                                       # All workspaces (~180 tests)
npm run test --workspace=packages/core         # Memory tests
npm run test --workspace=packages/ralph        # Goals tests
node packages/core/scripts/knowledge-lint.ts   # Check knowledge/ schema health
```

## Environment Variables

| Variable | Used by | Notes |
|---|---|---|
| `PI_MIND_DIR` | pi-utils `resolvePiMindDir` | Override memory + skills root (default: walks up to main repo via `git-common-dir`, then `.pi-mind/`) |
| `PI_GOALS_DIR` | pi-goals store | Override goals root (default: sibling of `$PI_MIND_DIR`, i.e. `.pi-goals/`) |
| `PI_BIN` | pi-utils `spawnPi` | Override pi binary path (default: `"pi"` via `$PATH`) |
| `MODEL` | ralph sub-agent spawn | Model name for execution + verification sub-agents (default: `minimax-cn/MiniMax-M2.7`) |
| `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` | toolkit `web-search` + `understand-image` | mmx auth (fallback to `~/.mmx/config.json` if env unset) |
| `DEEPSEEK_API_KEY` | pi-eval LongMemEval driver | Judge model for benchmark scoring |
