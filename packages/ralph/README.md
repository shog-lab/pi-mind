# @shog-lab/pi-goals

**Ralph-style autonomous goal execution for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).**

Single `goal` tool. `prd.json` is the state. Per-goal git worktree gives physical isolation. Isolated verification sub-agent that can't lie. That's it.

## Quickstart

```bash
# Install
npm i -D @shog-lab/pi-goals

# Generate a PRD
pi -p "use prd skill and create a PRD for login feature"

# Compile to prd.json
pi -p "use prd-compile skill and convert tasks/prd-login.md to prd.json"

# Run the loop
pi -p "goal --from prd.json"
```

To stop: `Ctrl+C`. To resume: re-run the same `goal --from prd.json` — the loop picks up at whichever story still has `passes: false`.

## Architecture

```
goal tool (--from prd.json)
   ↓
ensureWorktree → <repo>/.ralph-worktrees/<key>/  (git worktree on PRD's branch)
   ↓
loop until all stories pass or maxIterations:
   pick next story where passes:false
   ┌─────────────────────────────────────┐
   │ Execution sub-pi                    │  spawn via spawnPi
   │   cwd = worktree                    │  --no-extensions
   │   tools = bash, read, write, edit   │  implements ONE story
   └─────────────────────────────────────┘
   ┌─────────────────────────────────────┐
   │ Verification sub-pi                 │  separate pi process
   │   cwd = worktree                    │  --no-extensions
   │   tools = bash, read (read-only)    │  emits schema-validated JSON
   └─────────────────────────────────────┘
   if verify.passes: story.passes = true, prd.json saved
   append worktree's ralph-progress.txt
```

**Key design — verification is isolated and locked-down.** A separate sub-agent with a read-only tool allowlist checks completion against actual evidence. The execution agent has `write/edit` but `cannot` self-verify. The verification agent has `read/bash` only and cannot modify code. Its output must match `VerificationResultSchema` or the iteration counts as failed.

## State

There is no database. State lives in two files:

- `prd.json` — your PRD with `userStories[].passes` flipping `false → true` as stories pass
- `<worktree>/ralph-progress.txt` — append-only per-iteration log inside each worktree

Pause = `Ctrl+C`. Resume = re-run `goal --from prd.json`. Multi-goal management = `ls .ralph-worktrees/` and `cat prd.json`. There is no `list_goals` / `get_goal` / `update_goal` tool — you cat / ls.

## Worktree isolation

Each PRD-branch combination gets a dedicated worktree at `<repo>/.ralph-worktrees/<project-slug>-<branch>/`. Both sub-agents run inside it.

- **Your main checkout is never touched.** `git status` in your main checkout stays exactly as you left it across the entire goal.
- **Multiple goals on different branches coexist** in sibling worktrees.
- **Worktrees survive completion.** Inspect / merge / push the result yourself, then `git worktree remove .ralph-worktrees/<key>` to clean up.
- **`.pi-mind/` and `.pi-goals/` resolve to the main repo root** via `git rev-parse --git-common-dir`, so shared state survives worktree teardown.

> Add `.ralph-worktrees/` to your `.gitignore`. ralph logs a hint the first time it creates the dir.

If worktree creation fails (branch checked out elsewhere, non-git directory, path collision) the loop falls back to running in the invocation cwd and logs a warning. **You lose the isolation guarantee in fallback mode** — fix the underlying issue (release the branch, etc.) and re-run.

## Token + cost reporting

Each iteration prints real per-call usage extracted from pi's `--mode json` `agent_end` events:

```
[goals] iter 3/10 — story US-005: Add OAuth refresh
[goals]   exec  tokens: 12480 ($0.0892)
[goals]   verify tokens: 3204 ($0.0118)
```

Final result includes `totalTokens` (aggregate across all iterations). There is no `tokenBudget` enforcement — if you want to stop, `Ctrl+C` or lower `maxIterations`.

## Tool

| Tool | Args | Notes |
|---|---|---|
| `goal` | `from: string` (required) | Path to `prd.json` |
|  | `branch?: string` | Override PRD's `branchName` |
|  | `maxIterations?: number` | Default 10 |

## Skills

| Skill | Purpose |
|---|---|
| `prd` | Generate a Product Requirements Document |
| `prd-compile` | Compile a markdown PRD into `prd.json` |
| `goals-verify` | Restricted tool allowlist hint for verification sub-agents |

## Directory Structure

```
<your repo>/
├── .ralph-worktrees/                    Per-goal git worktrees
│   └── <project>-<branch>/              Isolated checkout for one goal
│       └── ralph-progress.txt           Per-worktree iteration log
├── prd.json                             Your PRD (location is up to you)
└── ...your code...
```

`.pi-mind/` and `.pi-goals/` live at the main repo root (resolved via `git rev-parse --git-common-dir`) and survive worktree creation/teardown. ralph itself writes no files outside `.ralph-worktrees/`.

## Dependencies

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0"
  },
  "dependencies": {
    "@shog-lab/pi-utils": "*",
    "@sinclair/typebox": "^0.34.0"
  }
}
```

No SQLite, no proper-lockfile, no DB drivers — those were removed in 0.5.0 as part of a deliberate simplification pass.

## What changed from 0.4.0

**BREAKING.** `pi-goals` 0.5.0 is a major simplification:

- Removed: SQLite goals.db, `iterationLogs` table
- Removed: `update_goal` / `list_goals` / `get_goal` tools
- Removed: pause/resume across pi sessions (now: ctrl+C, re-run same command)
- Removed: 7-state state machine (now: completed | halted)
- Removed: `tokenBudget` enforcement (still: per-iter token print)
- Removed: `pi-goals-config.json` loader (defaults are inline constants)
- Removed: global progress.txt (now: per-worktree only)
- Removed: PRD-less mode (`goal --objective "..."` no longer supported)
- Kept: worktree isolation (0.4.0's win)
- Kept: dual sub-pi exec/verify split with locked tool allowlists
- Kept: schema validation for PRD + verification output
- Kept: per-iter token reporting

Net effect: ~1000 LoC → ~500 LoC. State that was in a DB is now in `prd.json`. The pause-via-state-machine mechanism is replaced by "the file IS the state — re-run the command."

If you depended on any removed feature, pin to `@shog-lab/pi-goals@0.4.0`.

## License

MIT
