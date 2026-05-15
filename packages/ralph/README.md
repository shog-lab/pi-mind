# @shoglab/pi-goals

**Ralph-style autonomous goal execution for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).**

`goal` tool with PRD loop, isolated self-verification, and progress tracking.

## Quickstart

```bash
# Install
npm i -D @shoglab/pi-goals

# Generate a PRD
pi -p "use prd skill and create a PRD for login feature"

# Convert to prd.json
pi -p "use ralph skill and convert tasks/prd-login.md to prd.json"

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
| `ralph` | Convert markdown PRD to `prd.json` format |

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
```

## Dependencies

Depends on `@shoglab/pi-utils` for `spawnPi` + `resolvePiMindDir`. Shares
the `.pi-mind` directory convention with `@shoglab/pi-mind-core` (episodic
logs go under `.pi-goals/episodic/`, sibling to `.pi-mind/`).

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0"
  },
  "dependencies": {
    "@shoglab/pi-utils": "*"
  }
}
```

## License

MIT