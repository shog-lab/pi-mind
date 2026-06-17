# Personas

`personas/` is pi-mind's repo-local operator prompt and launcher layer.

The current default is intentionally simple: **one persona, Shog**. Multi-agent Alice/Bob/Carol orchestration was useful while dogfooding `pi-bus`, but the day-to-day project workflow is now Shog operating directly, with extra agents started only when the user explicitly wants them.

## Start

```bash
cd /Users/maoxiongyu/Code/pi-mind
./personas/bin/shog
```

You should not need to remember prompt paths, model names, agent names, or launch flags.

## Defaults

| Persona | Launcher | Default model | Default thinking | Notes |
|---|---|---|---|---|
| Shog | `./personas/bin/shog` | `openai/gpt-5.5` | `high` | planner / implementer / reviewer / writer / release runner / memory lead |

## Overrides

Temporary model / thinking override:

```bash
SHOG_MODEL=minimax-cn/MiniMax-M3 ./personas/bin/shog
SHOG_THINKING=medium ./personas/bin/shog
# or pass pi args directly; later --model / --thinking wins
./personas/bin/shog --model deepseek/deepseek-v4-pro --thinking high
```

Extra tool deny-list:

```bash
SHOG_EXCLUDE_TOOLS=bash ./personas/bin/shog
```

Disable skills for one run:

```bash
SHOG_NO_SKILLS=1 ./personas/bin/shog
```

All extra arguments are passed through to `pi`.

## Files

```text
personas/
├── README.md
├── policy.md              # repo-local side-effect policy
├── prompts/
│   └── shog.md            # Shog behavior prompt
└── bin/
    ├── shog               # user-facing launcher
    └── run                # internal generic pi launcher
```

## Layering

- `prompts/shog.md` describes Shog's behavior.
- `policy.md` defines side-effect permissions and escalation rules.
- `bin/run` implements generic launch mechanics; Shog defaults live in `bin/shog`.
- Project facts and package rules still live in root `AGENTS.md`.

## Hierarchy

```text
User > Shog
```

Shog may use `pi-bus`, `pi-subagent`, or extra manually started agents when useful, but they are optional tools — not standing authorities. Destructive, externally visible, cost-bearing, or behavior-changing actions still require explicit user approval.
