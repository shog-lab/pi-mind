---
name: define-skill
description: Author a new pi skill from a user request — draft, review with the user, then commit via create_skill.
---

# define-skill

Use this when the user asks you to create a new skill. A skill is a markdown document that future-you (or another agent) can load with `use <name> skill` to follow a focused procedure.

## What makes a good skill

Skills are **instructions for an agent**, not documentation for humans. Write for an LLM reader who has the tools available but doesn't know the convention or trade-off you're encoding.

Good skills are:

- **Procedural** — concrete steps in order, not abstract advice. "Run X, check Y, if Z then …" beats "Consider the implications."
- **Bounded** — one job, narrow scope. If the steps fork into "now do skill A or skill B," it's two skills.
- **Self-contained** — assume the loading agent has no prior conversation. Don't reference "what we just discussed."
- **Concrete on tools** — name the actual tool calls and shell commands. Don't say "check the tests"; say "run `npm test --workspace=packages/X` and look for 'passed'/'failed' in tail output."
- **Honest about edges** — note where the procedure breaks down, what to do if a step fails, what assumptions it makes about the repo.

## Anti-patterns

- ❌ Restating things that are in the user's AGENTS.md / system-prompt — skills are for non-default workflows, not the basics
- ❌ Embedding company / secret values (use env vars or just reference where they live)
- ❌ "Step 1: think about the problem" — agents already do this; skip filler
- ❌ Bullet lists without verb–object form ("Authentication" instead of "Verify the user is logged in via …")
- ❌ Long preamble before the first concrete step

## Skill structure

```markdown
---
name: <kebab-case-name>
description: <one sentence; will appear in the agent's skill list>
---

# <Name>

<2-3 sentence summary: what this skill solves and when to use it>

## Usage

<How the user invokes it, e.g. "Load this skill and tell me which deploy target.">

## Steps

1. <Concrete step with the actual tool/command>
2. ...

## Common failures

<Likely error modes + how to handle each>

## Anti-patterns

<What this skill is NOT for>
```

## Process

1. **Clarify the scope with the user** if their request is vague. Skills should solve one named job. "Make a deployment skill" → ask "for staging or prod, which target?"
2. **Pick a name**: kebab-case, ≤64 chars, descriptive of the *job*, not the *implementation*. `deploy-staging` > `run-bash-script`.
3. **Sketch the body** following the structure above. Lean concrete; cite specific files / commands / env vars from this repo when possible.
4. **Show the draft to the user** in your reply — let them eyeball it before writing.
5. **When they approve**, call `create_skill({name, description, body})`. (`create_skill` will FAIL if a skill with that name exists — use `revise-skill` workflow + `update_skill` tool for that case.) The tool will write `.pi/skills/<name>/SKILL.md`.
6. **Remind the user** that pi has to restart before the new skill is loadable.

## Don't

- Don't call `create_skill` without showing the body to the user first. The user reviewing and saying "yes" IS the gate — without that explicit ok, you must not commit a skill. (See "Behavior-changing autonomy requires inline gate" in AGENTS.md.)
- Don't pick a name that collides with an installed-package skill (the tool will refuse).
- Don't write skills speculatively ("the user might want this later"). Skills are written on demand.
