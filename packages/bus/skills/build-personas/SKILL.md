---
name: build-personas
description: Design and scaffold repo-local pi personas that coordinate through pi-bus, with prompts, launchers, permission policy, and a verification flow.
---

# Build Personas

Use this skill when the user wants to create or improve a repo-local multi-agent workflow using `pi-bus`, for example planner / implementer / reviewer terminals that can message each other with `agent_send`.

This skill scaffolds a **persona convention**, not an autonomous workflow engine. The bus remains a simple messaging primitive; personas are role prompts, launch scripts, and permission rules layered on top.

## Output shape

Default scaffold:

```text
personas/
├── README.md
├── policy.md
├── prompts/
│   ├── planner.md
│   ├── implementer.md
│   └── reviewer.md
└── bin/
    ├── planner
    ├── implementer
    └── reviewer
```

Adapt names to the user's domain if requested (for example architect/builder/auditor, growth/writer/reviewer, planner/implementer/reviewer).

## Workflow

1. **Clarify the collaboration pattern**
   - Ask what roles the user wants, or propose the default 3-role split:
     - planner / dispatcher / final reviewer
     - implementer / tester
     - independent reviewer / auditor
   - Ask which model defaults, thinking levels, or context budgets should differ by role.
   - Ask which actions require user approval: publish, push, delete, costly evals, behavior-changing skills, external services.

2. **Propose before writing**
   - Show the directory plan.
   - Show the full drafts or concise diffs for every file to be created/changed.
   - Wait for explicit user approval before writing files.

3. **Write minimal repo-local files**
   - `personas/prompts/*.md` should define role, workflow, boundaries, and report format.
   - `personas/policy.md` should define side-effect permissions and escalation rules.
   - `personas/bin/*` should launch `pi` with `PI_AGENT_NAME=<role>` and role prompt loading.
   - `personas/README.md` should explain how to start terminals and verify bus communication.

4. **Verify the mesh**
   - Start two or more persona terminals.
   - Use `agent_list` to verify they are visible on the same repo bus.
   - Use `agent_send` for a small fact-only handoff.
   - Confirm the recipient receives `[from <sender>] ...` as a follow-up turn.

## Recommended boundaries

- User remains final approver for destructive, externally visible, or cost-bearing actions.
- Planner coordinates and reviews; it does not blindly trust implementer reports.
- Implementer edits/runs tests/commits only when assigned.
- Reviewer is read-only by default and reports PASS / CONDITIONAL / BLOCK with evidence.
- Durable memory writes and behavior-changing skill creation should be centralized or explicitly approved.
- Horizontal role-to-role communication is for facts/evidence, not for bypassing the planner/user decision chain.

## Launcher template

A simple role launcher can look like this:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROLE="planner"
export PI_AGENT_NAME="${PI_AGENT_NAME:-$ROLE}"
exec pi --append-system-prompt "$REPO_ROOT/personas/prompts/$ROLE.md" "$@"
```

If the repo already uses a shared `personas/bin/run` wrapper, prefer that to duplicating launch logic.

## Prompt template checklist

Each persona prompt should include:

- role and responsibilities;
- what inputs it accepts;
- what files or systems it may touch;
- what it must never do without approval;
- how it reports completion or review verdicts;
- how it uses `agent_send` without creating ping-pong loops;
- a reminder that actual repo state and command output beat claims.

## Anti-patterns

Do **not**:

- build an autonomous loop that keeps dispatching work without user checkpoints;
- create a runtime ACL/persona DSL when prompts + launchers are enough;
- grant all roles memory-write, publish, push, or delete authority by default;
- let reviewer personas edit product code unless the user grants one-shot permission;
- make agents auto-acknowledge every bus message, which can create ping-pong loops;
- hide side effects in background hooks or scheduled tasks.

## Verification checklist

Before calling the scaffold done:

- `bash -n personas/bin/*` passes for shell launchers.
- `agent_list` shows the expected names after launching multiple terminals.
- `agent_send` delivers one test message successfully.
- The policy file clearly identifies user-approved actions.
- The README explains how to start, stop, and troubleshoot the persona mesh.
