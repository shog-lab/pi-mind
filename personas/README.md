# Personas

`personas/` is pi-mind's repo-local operational orchestration layer: three role prompts plus tiny launchers.

## Start

Open three terminals in the repo. Start Bob and Carol first so they can receive bus messages, then Alice:

```bash
cd /Users/maoxiongyu/Code/pi-mind

./personas/bin/bob
./personas/bin/carol
./personas/bin/alice
```

That's the normal path. You should not need to remember prompt paths, model names, agent names, or tool deny-lists.

## Defaults

| Persona | Launcher | Default model | Default thinking | Notes |
|---|---|---|---|---|
| Alice | `./personas/bin/alice` | `deepseek/deepseek-v4-pro` | `high` | planner / dispatcher / reviewer / writer / memory lead |
| Bob | `./personas/bin/bob` | `minimax-cn/MiniMax-M3` | `medium` | implementer; memory/skill write tools disabled |
| Carol | `./personas/bin/carol` | `deepseek/deepseek-v4-pro` | `high` | independent reviewer; memory/skill write tools disabled |

Bob and Carol always start with these state-changing tools disabled:

```text
remember_this,observe,update_memory,mark_memory_audit_complete,create_skill,update_skill
```

## Overrides

Temporary model / thinking override:

```bash
BOB_MODEL=deepseek/deepseek-v4-pro ./personas/bin/bob
BOB_THINKING=high ./personas/bin/bob
CAROL_THINKING=medium ./personas/bin/carol
# or pass pi args directly; later --model / --thinking wins
./personas/bin/bob --model deepseek/deepseek-v4-pro --thinking high
```

Extra tool deny-list:

```bash
CAROL_EXCLUDE_TOOLS=bash ./personas/bin/carol
```

Disable skills for one run:

```bash
BOB_NO_SKILLS=1 ./personas/bin/bob
```

All extra arguments are passed through to `pi`.

## Files

```text
personas/
├── README.md
├── policy.md              # cross-persona side-effect policy
├── prompts/
│   ├── alice.md
│   ├── bob.md
│   └── carol.md
└── bin/
    ├── alice              # user-facing launcher
    ├── bob                # user-facing launcher
    ├── carol              # user-facing launcher
    └── run                # internal generic pi launcher
```

## Layering

- `prompts/*.md` describes role behavior.
- `policy.md` defines cross-role permissions and escalation.
- `bin/run` implements only generic launch mechanics; persona defaults live in `bin/alice`, `bin/bob`, and `bin/carol`.
- Project facts and package rules still live in root `AGENTS.md`.

## Hierarchy

```text
User > Alice > Bob / Carol
```

Bob and Carol may exchange facts/evidence/test output directly. Task assignment, plan changes, merge/release decisions, and final user-facing summaries flow through Alice and ultimately the user.
