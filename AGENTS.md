# AGENTS.md

Guide for AI agents working in this repository.

## Project Overview

`pi-mind` is a monorepo of capability packages for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

| Workspace | npm name | Status | Purpose |
|---|---|---|---|
| `packages/utils` | `@shog-lab/pi-utils` | published | Shared infra: `spawnPi`, `resolvePiMindDir`. Depended on by every other workspace. |
| `packages/core` | `@shog-lab/pi-mind-core` | published | Persistent memory + ask-first skill authoring. Layers: raw, knowledge, KG. |
| `packages/toolkit` | `@shog-lab/pi-toolkit` | published | Common pi extensions: web search, MCP server bridge. (0.3.0 removed `spawn_subagent` → pi-subagent; 0.4.0 removed `understand_image` — models have native vision now.) |
| `packages/bus` | `@shog-lab/pi-bus` | published | Inter-pi messaging primitive. 3 tools, per-repo auto-discovery, push-trigger via `pi.sendUserMessage`. |
| `packages/subagent` | `@shog-lab/pi-subagent` | published | Single `spawn_subagent` tool — fire-and-forget child pi via spawnPi. Extracted from pi-toolkit 0.3.0. |

LongMemEval benchmark harness lives at `packages/core/eval/` (was its own workspace `packages/eval/` through 2026-05-26). Internal dev tooling; not published. Run with `npm run eval --workspace=packages/core -- <args>` (the harness is run via `tsx`, NOT compiled into the package's `dist/` — `tsconfig.json` excludes `eval/**/*` from the published build).

`@shog-lab/pi-goals` (ralph) was published through 0.5.1 then **deprecated + removed from the monorepo on 2026-05-28** (see Design Principles below). Published versions remain installable from npm with a deprecation warning; pin `@shog-lab/pi-goals@0.5.1` if you depend on the old behavior.

Publishing is **manual per-package**, no CI — see [[publish-flow]] memory.

## Design Principles

These principles define **what kinds of autonomy this ecosystem will and won't support**. They emerged from auditing our own packages and noticing that several patterns — unbottlenecked autonomous loops, background curator LLMs writing prescriptive memory, agents self-modifying their own behavior — produce results we don't trust. Codifying the constraints up front lets future feature decisions be made by reference to the principles rather than re-litigated.

### 1. Behavior-changing autonomy requires inline gate

Agent actions that **require LLM judgment AND change future agent behavior** must propose-before-executing. The proposal happens in a visible turn; the actual side effect waits for explicit user approval (or surrogate approval — see principle 3).

Includes:
- Writing or updating skills (`create_skill` / `update_skill`)
- Continuing autonomous multi-step loops past iteration 1

Excludes (these may run silently):
- Reading any state (memory injection, file reads, tool calls within a turn)
- Mechanical state mutations driven by user-set policy (retention-based forget, session archive)
- User-invoked CLI commands (`pi-mind-lint --apply`, etc.)

### 2. Memory is passive

Memory is a **dumb storage + smart retrieval** layer. It has no background curator, no autonomous "is this worth remembering?" judge.

- **Writes** happen only via `remember_this` (agent explicitly calls in a visible turn) or manual file authorship.
- **Reads** are smart: hybrid retrieval, relevance ranking, L1/L2 injection at agent_start.
- **Forgets** are mechanical: retention policy you configured, not LLM-judged.
- **No `worth-remembering-llm`-style auto-capture.** If nobody decided to remember it, it wasn't worth keeping.

Why: a wrong memory entry is mostly noise (relevance-ranked retrieval filters it). A wrong skill is consistent wrong behavior. Memory tolerates errors; skills don't. So memory write can be less ceremonious — but it must still originate from a visible decision, not a background LLM.

### 3. Bus is graduated-autonomy substrate

`@shog-lab/pi-bus` is not (just) a messaging primitive. It enables **the same code to operate anywhere on a continuum**:

```
silent                  ──→   auto-approve keeper          (gives audit trail)
                                                                  ↓
                              prompted keeper (LLM judge)  (theatrical bottleneck — ok for low-stakes)
                                                                  ↓
                              human keeper (another terminal)  (real bottleneck)
                                                                  ↓
                              inline interactive (current pi)
```

Switching position on this continuum is configuration, not rewrite. A "memory keeper" or "skill reviewer" agent can sit between your work-pi and the persistent state, and the keeper can be auto-approving, LLM-judging, or human-watched — same protocol, different stance.

**Caveat**: an auto-approve keeper is **structurally identical** to a background LLM judge, just with audit trail. It's OK as a deliberate fallback, but treat "auto-approve everywhere" as a code smell. The point of graduated autonomy is to let you slide toward review when stakes rise, not to dress up silent autonomy.

### 4. Trigger chain must originate from user action

The legality of a memory write or skill change is judged by the **start of its trigger chain**, not by which agent ultimately executes it.

```
✅ Legal:  user message  →  agent decides  →  (optionally bus → other agent)  →  remember_this
❌ Illegal: agent_end hook  →  background LLM  →  silent write
❌ Illegal: cron / timer  →  ...  →  state mutation
```

A `remember_this` call routed through three agents via bus is still legal **if the chain started with a user message**. A `remember_this` triggered by an `agent_end` background hook is not, even if it goes through a "keeper" agent first — the user never invited that decision.

### How these principles map to current packages

| Package | Alignment | Note |
|---|---|---|
| `pi-utils` | ✅ Pure infra | No autonomy concerns |
| `pi-mind-core` memory (`remember_this`, retrieval, retention) | ✅ Per principle 2 | `worth-remembering-llm` removed in 0.6.0 — memory is now passive |
| `pi-mind-core` skill-evolution | ✅ Per principle 1 | `write_skill` replaced by ask-first `create_skill` + `update_skill` in 0.6.0 |
| `pi-toolkit` (web-search / mcp-bridge) | ✅ Scoped tools, no persistent autonomy | — |
| `pi-subagent` | ✅ Scoped, closed-loop spawn | — |
| `pi-bus` | ✅ The substrate enabling principle 3 | — |
| ~~`pi-goals` (ralph)~~ | 🗑️ **Removed 2026-05-28** | Autonomous orchestrated workflows are platform-level work. At the extension layer, the same workflows are better composed *visibly* via `pi-bus` (peer mesh) + `pi-subagent` (call tree) + git worktree, with the user in the loop per spawn. Same capability surface, opposite transparency posture. Last release `0.5.1` remains on npm as deprecated, pinnable as fallback. |

## Development Commands

```bash
npm install                          # Install + build dist + create .pi/ symlinks
npm run build                        # Build all workspaces
npm test                             # Run all workspace vitest suites
npm run typecheck                    # Typecheck all workspaces
```

Per-workspace (use path or full scoped name):

```bash
npm run build --workspace=packages/core
npm run test --workspace=packages/bus
npm run typecheck --workspace=packages/toolkit
```

Watch mode:

```bash
npx tsc -w -p packages/core
npx tsc -w -p packages/bus
```

## Loaded Extensions & Skills

`npm install` symlinks all extensions / skills into `.pi/` so `pi` auto-discovers them.

### Extensions

| Extension | Source dir | Purpose |
|---|---|---|
| `memory` | `packages/core/extensions/memory/` | Persistent memory: hybrid retrieval (vector + FTS5 + KG + [[link]]); tools: `remember_this` / `recall_memory` / `observe` / `mark_daily_audit_complete`. 0.6.0 removed the `worth-remembering-llm` auto-capture (memory is passive). |
| `skill-evolution` | `packages/core/extensions/skill-evolution/` | `create_skill` + `update_skill` tools — agent proposes in chat, gets explicit user approval, then writes `.pi/skills/<name>/SKILL.md` (with `.bak.<ts>` on overwrite). Backs the `define-skill` / `revise-skill` skills. (0.6.0 replaced the prior `write_skill` per Design Principles.) |
| `web-search` | `packages/toolkit/extensions/web-search/` | `web_search` tool — backed by mmx CLI. |
| `mcp-bridge` | `packages/toolkit/extensions/mcp-bridge/` | Spawns MCP servers from `mcp-servers.json`, registers their tools as `<server>_<tool>`. |
| `subagent` | `packages/subagent/extensions/subagent/` | `spawn_subagent` tool — fire-and-forget child pi via `spawnPi`. (Moved from pi-toolkit in toolkit 0.3.0.) |
| `bus` | `packages/bus/extensions/bus/` | `agent_list` / `agent_send` / `agent_inbox` — peer-to-peer messaging between pi sessions in same repo. Push-trigger via `pi.sendUserMessage(..., { deliverAs: "followUp" })`. |

Tool names stay `snake_case` for LLM stability; extension dirs are `kebab-case`.

### Skills

| Skill | Source dir | Purpose |
|---|---|---|
| `memory-audit` | `packages/core/skills/memory-audit/` | Memory hygiene audit loop. |
| `knowledge-lint` | `packages/core/skills/knowledge-lint/` | Schema validation + auto-fix for knowledge entries. (Was `wiki-lint` before 0.3.0.) |
| `scheduling` | `packages/core/skills/scheduling/` | Cron setup helper. |
| `define-skill` | `packages/core/skills/define-skill/` | Compose a brand-new skill via `create_skill` (ask-first). |
| `revise-skill` | `packages/core/skills/revise-skill/` | Update an existing skill via `update_skill` (ask-first). |
| `agent-browser` | `node_modules/agent-browser/skills/agent-browser/` | Browser automation (external dep). |

(The `prd` / `prd-compile` / `goals-verify` skills were removed with `packages/ralph/` on 2026-05-28. If you want PRD-style work, write the markdown yourself and compose `pi-bus` + `pi-subagent` + git worktree for execution with a human keeper in the loop.)

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

```

**Path resolution** uses `git rev-parse --git-common-dir` (see `packages/utils/src/paths.ts`) — `.pi-mind/` always points to the **main repo root** even when called from a linked worktree. `$PI_MIND_DIR` env var overrides.

(Pre-2026-05-28 sibling dirs `.pi-goals/` and `.ralph-worktrees/` were used by the now-removed `pi-goals` package. They're still in `.gitignore` for users with residual data, but no current package writes to them.)

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
| `packages/core/lib/skill-evolution.ts` | `create_skill` / `update_skill` implementation. |
| `packages/core/lib/session-archive.ts` | Session archive with host-cwd prefix filtering. |
| `packages/core/extensions/memory/index.ts` | Memory extension entry; lifecycle hooks (before_agent_start / turn_end / session_compact), remember_this / observe tools. |
| `packages/core/extensions/memory/core.ts` | Hybrid retrieval pipeline (vector + FTS5 + KG + links). |
| `packages/core/extensions/memory/knowledge-graph.ts` | KG storage + entity-fact queries. |
| `packages/bus/extensions/bus/index.ts` | bus extension: session registry, fs.watch inbox, 3 tools, push-trigger via `pi.sendUserMessage`. |
| `packages/subagent/extensions/subagent/index.ts` | `spawn_subagent` tool — wraps `spawnPi`. |
| `packages/toolkit/extensions/mcp-bridge/mcp-client.ts` | MCP stdio JSON-RPC client. |

## Architecture Notes

### Memory

Three layers, retrievable as a single hybrid context (Ollama `nomic-embed-text` vector + SQLite FTS5 + KG entity facts + `[[link]]` traversal). All curated writes originate from agent action in a visible turn:

- **`remember_this` / `observe` tools** — agent explicitly persists a fact or a low-bar field note.
- **`session_compact`** — pi's compaction summary is saved to `raw/compaction/` (type=compaction, L2) and indexed (`syncIndex` scans `raw/` as well as `knowledge/`), so it's retrievable on its own. No background promotion: it ages out via retention unless promoted into `knowledge/` via the `memory-audit` skill in a visible turn.

(0.6.0+ removed two background memory writers — the `agent_end` `worth-remembering-llm` detector and the `session_compact` classifier sub-agent — both lifecycle-triggered LLMs writing curated state with no user in the trigger chain, violating "Memory is passive".)

See [[memory-write-impl-notes]] for runtime details + corner cases.

### Bus

`@shog-lab/pi-bus` is the **substrate for inter-pi coordination**. Any pi started in a repo auto-joins a per-repo bus (scoped via `git rev-parse --git-common-dir`). Three tools: `agent_list` / `agent_send` / `agent_inbox`.

Push delivery: when a message lands in your inbox, the extension calls
`pi.sendUserMessage(text, { deliverAs: "followUp" })`. Recipient's agent treats it as a user turn and starts work — even when sitting idle. `followUp` mode waits until the agent is fully idle before injecting, so it never interrupts mid-stream.

This is what makes bus useful as the **graduated-autonomy substrate** (Design Principle 3): the same protocol carries human review (terminal B watched by a human), LLM keeper review (terminal B running an auto-judging agent), and silent fallback (auto-approve keeper) — same code, different stance.

File layout (per-repo): `<repo>/.pi-mind/bus/sessions/<id>/{meta.json, inbox/<msg-id>.json}`. Heartbeat every 30s; stale sessions (>90s no heartbeat) auto-filter from `agent_list`.

### Sub-agent

`@shog-lab/pi-subagent` provides `spawn_subagent` — agent passes a `cwd` + `prompt`, gets back a fresh child pi's response. Child runs with `--no-extensions` (no memory, no other extensions), giving you a clean-slate scoped task. Returns response text + token usage from the child's `agent_end` event.

Compose with `git worktree` for physical isolation, with `pi-bus` for inter-session coordination, with manual loops for what `pi-goals` used to automate (with a human in the loop per iteration — see Design Principles).

### Subprocess discipline

**ALL** `child_process.spawn` calls in pi-mind code MUST use `detached: true` + `process.kill(-pid, signal)` to kill the whole process group. Without this, grandchildren orphan and keep inherited pipe FDs open → Node's `'close'` event never fires → callers hang.

See [[subprocess-group-kill]] memory for the full rule and the audited site list. Reference impl: `packages/utils/src/spawn-pi.ts`.

### E2E probe before publish

Unit tests pass against compiled-on-the-fly source under vitest, which silently injects `require` and other shims that DON'T exist in production ESM. Bugs that pass unit tests have broken production multiple times.

**Mandatory before any `npm publish`**: write a throwaway `.tmp-verify-<feature>.mjs` that imports from `dist/` and exercises the actual integration path — not just the primitive. Primitive-level probes (e.g. "the helper works in isolation") are **NOT sufficient**; the bug surface is in the wiring, not the leaves.

See [[e2e-before-publish]] memory.

## Conventions

- **Single source of truth for schemas** — frontmatter via `packages/core/lib/schema.ts`; bus message / inbox schemas inline in `packages/bus/extensions/bus/index.ts`; never duplicate.
- **File-based coordination** — packages share `.pi-mind/` (memory + bus state); no in-process IPC.
- **Cron-driven maintenance** — scheduled maintenance runs via OS cron, not in-process timer (pi has no daemon).
- **Concurrent writes** — `withGroupLock` (proper-lockfile) for filesystem, `busy_timeout = 5000` for SQLite.
- **Idempotent postinstall** — `bin/init.js` symlink creation is safe to re-run.
- **No dual-write** — refactor in one go, rely on git revert; don't ship transition shims. See [[no-dual-write]].
- **Direct commit to main** — solo repo, no PR. See [[direct-commit-to-main]].

## Testing

```bash
npm test                                       # All workspace vitest suites
npm run test --workspace=packages/core         # Memory tests
npm run test --workspace=packages/bus          # Bus tests
node packages/core/scripts/knowledge-lint.ts   # Check knowledge/ schema health
```

## Environment Variables

| Variable | Used by | Notes |
|---|---|---|
| `PI_MIND_DIR` | pi-utils `resolvePiMindDir` | Override memory + skills root (default: walks up to main repo via `git-common-dir`, then `.pi-mind/`) |
| `PI_BIN` | pi-utils `spawnPi` | Override pi binary path (default: `"pi"` via `$PATH`) |
| `PI_AGENT_NAME` | pi-bus | Override auto-generated friendly bus name (e.g. `calm-fox-x2k`) |
| `MODEL` | pi-subagent (`spawn_subagent`) | Model for child pi (default: `minimax-cn/MiniMax-M2.7`) |
| `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` | toolkit `web-search` | mmx auth (fallback to `~/.mmx/config.json` if env unset) |
| `DEEPSEEK_API_KEY` | LongMemEval driver in `packages/core/eval/` | Judge model for benchmark scoring |
