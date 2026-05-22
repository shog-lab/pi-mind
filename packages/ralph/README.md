# @shog-lab/pi-goals

**Ralph-style autonomous goal execution for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).**

`goal` tool with PRD loop, isolated self-verification, and progress tracking.

## Quickstart

```bash
# Install
npm i -D @shog-lab/pi-goals

# Generate a PRD
pi -p "use prd skill and create a PRD for login feature"

# Convert to prd.json
pi -p "use prd-compile skill and convert tasks/prd-login.md to prd.json"

# Run the goal loop
pi -p "goal --from prd.json"
```

Or without PRD (single story):

```bash
pi -p "goal 实现用户登录功能"
```

## Architecture

```
goal tool (tool call, not slash command)
    │
    ├── [Execution sub-agent] ← spawn via pi, full tools via --tools flag
    │         ↓ implements story
    │
    ├── [Verification sub-agent] ← spawn via pi, restricted tools via --tools flag
    │         ↓ returns { passes: bool, evidence, reasons }
    │
    └── [Update prd.json / iteration log]
              ↓
        Repeat until all pass or max iterations
```

**Key design: Verification is isolated.** A separate sub-agent with clean context checks completion against actual evidence — the execution agent cannot self-verify.

## Extensions

| Extension | Purpose |
|---|---|
| `goals` | `goal` / `update_goal` / `get_goal` / `list_goals` tools (tool calls, not slash commands) |

## Budget enforcement

Each iteration accumulates real token usage from pi's `--mode json` event stream
(input/output/cacheRead/cacheWrite + USD cost) into `goal.tokensUsed` and
`goal.costUsd`. If a goal has `tokenBudget` set and `tokensUsed >= tokenBudget`,
the goal transitions to `budget_limited` state and the loop halts — no further
sub-agent spawns. Use `update_goal` to raise the budget and `goal --resume` to
continue.

## Skills

| Skill | Purpose |
|---|---|
| `prd` | Generate Product Requirements Documents |
| `prd-compile` | Compile a markdown PRD into `prd.json` (was named `ralph` before 0.1.2) |
| `goals-verify` | Restricted tool allowlist for verification sub-agents (Read/Bash/Grep/Find/understand_image only) |

## Directory Structure

```
.pi-goals/
├── goals.db              # SQLite: goal state machine
├── progress.txt          # Append-only learnings
├── prd.json              # Current PRD (when using --from)
├── episodic/
│   └── ralph/            # Iteration logs
│       └── iteration-001.jsonl
└── .locks/               # Concurrent write protection

.ralph-worktrees/         # Per-goal git worktrees (one dir per goal)
├── goal-<id1>/           # Goal #1's isolated checkout on its branch
└── goal-<id2>/           # Goal #2's checkout — sibling, independent
```

## Worktree isolation

Each goal runs inside a dedicated `git worktree` rooted at
`<repo>/.ralph-worktrees/<goal-id>/`. This means:

- **Your main checkout is never touched.** Branch switching, file edits,
  and commits happen in the worktree — `git status` in your main checkout
  remains exactly as you left it.
- **Multiple goals can coexist** on different branches without conflict
  (each in its own worktree).
- **Cleanup is explicit.** When a goal finishes (completed / failed /
  iteration_limited), the worktree stays so you can inspect / merge / push
  the result. Remove it manually with:
  ```bash
  git worktree remove .ralph-worktrees/<goal-id>
  ```
- **`.pi-mind/` and `.pi-goals/` resolve to the main repo root** (via
  `git rev-parse --git-common-dir`), so memory + goal state survive
  worktree teardown.

> Add `.ralph-worktrees/` to your `.gitignore` so the per-goal worktrees
> don't show up as untracked content in your main checkout. ralph logs a
> hint the first time it creates this directory.

If `ensureWorktree` fails (branch already checked out elsewhere, path
conflict, non-git directory, …) the loop falls back to running in
`goal.cwd` directly and logs a warning. In that fallback mode you lose
the isolation guarantee but the goal can still proceed.

## Dependencies

Depends on `@shog-lab/pi-utils` for `spawnPi` + `resolvePiMindDir`. Shares
the `.pi-mind` directory convention with `@shog-lab/pi-mind-core` (episodic
logs go under `.pi-goals/episodic/`, sibling to `.pi-mind/`).

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0"
  },
  "dependencies": {
    "@shog-lab/pi-utils": "*"
  }
}
```

## License

MIT