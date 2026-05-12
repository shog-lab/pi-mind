# pi-goals

**Ralph-style autonomous goal execution for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).**

`/goal` command with PRD loop, isolated self-verification, and progress tracking.

## Quickstart

```bash
# Install
npm i -D pi-goals

# Generate a PRD
pi -p "use prd skill and create a PRD for login feature"

# Convert to prd.json
pi -p "use ralph skill and convert tasks/prd-login.md to prd.json"

# Run the goal loop
pi -p "/goal --from prd.json"
```

Or without PRD (single story):

```bash
pi -p "/goal 实现用户登录功能"
```

## Architecture

```
/goal command
    │
    ├── [Execution sub-agent] ← spawn_subagent, full tools
    │         ↓ implements story
    │
    ├── [Verification sub-agent] ← spawn_subagent --restricted, checks evidence
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
| `goals` | `/goal` command + `update_goal` / `get_goal` / `list_goals` tools |

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

## Dependency

Requires `pi-mind` as peer dependency (shares `PI_MIND_DIR` conventions for episodic logging).

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "pi-mind": "^0.1.0"
  }
}
```

## License

MIT