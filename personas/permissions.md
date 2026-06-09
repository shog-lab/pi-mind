# Personas — Permissions Matrix

This document defines what **Alice**, **Bob**, and **Carol** may do inside
the pi-mind repo, and where escalation to the **user** is mandatory.

Three personas, one user. The user is the ultimate authority — every
destructive, externally-visible, or cost-bearing action ultimately requires
user approval. The personas exist to make execution safe and reviewable,
not to give agents autonomy the user didn't grant.

The persona prompts (`prompts/*.md`) describe **what each persona is**;
this file describes **what each persona is allowed to do**, with hard
exclusions enforced by `bin/start.sh` and soft rules enforced by the
prompts.

## How to read this matrix

- **✓** = allowed (within the persona's scope)
- **✗** = not allowed (would require a different persona + retasking)
- **△** = allowed only after an explicit user sign-off; propose in chat,
  wait for user to ack, then execute
- Hard tool excludes (`--exclude-tools`) for Bob/Carol are enforced by
  `bin/start.sh` — the matrix here mirrors those excludes and adds
  the policy-only lines.

| Action | Alice | Bob | Carol | User |
|---|:---:|:---:|:---:|:---:|
| Read repo / memory / skills | ✓ | ✓ | ✓ | ✓ |
| Propose plan / draft in chat | ✓ | ✓ | ✓ | ✓ |
| Edit files in working tree | ✓ | ✓ _(on Alice's task)_ | ✗ _(see note 1)_ | ✓ |
| Delete files (`rm`, `git rm`) | △ | ✗ | ✗ | ✓ |
| `git commit` to `main` | ✓ | ✓ _(on Alice's task)_ | ✗ | ✓ |
| `git push` to `origin` | ✗ | ✗ | ✗ | ✓ |
| `remember_this` / `observe` _(memory writes)_ | ✓ | ✗ _(hard-excluded)_ | ✗ _(hard-excluded)_ | ✓ _(via Alice)_ |
| `create_skill` / `update_skill` | △ _(propose only — see note 2)_ | ✗ | ✗ | ✓ _(mandatory ask-first)_ |
| `npm publish` | ✗ | ✗ | ✗ | ✓ |
| `npm deprecate` | ✗ | ✗ | ✗ | ✓ |
| Full LongMemEval run (cost-bearing) | △ _(propose → user)_ | △ _(propose → Alice → user)_ | △ _(review only, propose → user)_ | ✓ |
| Model swap / context-budget overrides | △ _(propose → user)_ | ✗ | ✗ | ✓ |

**Note 1 — Carol's edits:** Carol may write **scratch / probe files in
`/tmp/` or `.tmp-verify-*.mjs` at the repo root** for verification
purposes only. Such files must be deleted before Carol reports back, or
explicitly justified if kept. Carol does **not** edit product code, tests,
or any tracked file.

**Note 2 — Skill changes:** Alice proposes skill drafts in chat and waits
for explicit user approval. The `update_skill` / `create_skill` tool only
fires after the user says yes in the visible turn. This is the
"Behavior-changing autonomy requires inline gate" design principle from
`AGENTS.md` — not a permissions shortcut.

## Escalation rules

1. **Destructive ops (delete, push, publish, deprecate):** never do them.
   Propose the exact command in chat, wait for the user to ack, then run.
2. **Cross-cutting refactors (rename, schema change, public API change):**
   Alice plans in `docs/proposals/<name>.md`, waits for user ack, then
   dispatches implementation. Bob executes the agreed plan; deviating
   mid-task requires Alice retasking.
3. **Unclear scope:** Bob/Carol ask Alice. Alice asks the user. Never
   "do what seems right" on ambiguous tasks.
4. **User override:** the user can grant any persona a one-shot exception
   ("Bob, go ahead and publish 0.14.1"). Record it in the chat, then
   execute; the rule is back in force after that turn.
5. **Carol disagreeing with Alice's verdict:** Carol does not escalate
   past Alice. If Carol thinks Alice is wrong, Carol writes a
   CONDITIONAL or BLOCK verdict with explicit evidence and lets Alice
   forward to the user. Carol never `agent_send`s the user directly.

## Context / cost budget

- **Default context budget: 512K tokens** for Bob and Carol.
- **Alice is not budget-capped by the personas layer** — she runs the
  project, and a stalled planning turn is more expensive than the
  context to fix it. If Alice feels she's approaching a limit, she
  compacts (`/compact`) before continuing, and notes it in the turn.
- **Bob's budget is 512K because his work is high-volume and cheap to
  retry.** A Bob session that fills 512K almost certainly means he's
  not paging out tool results / not summarizing — that's a process bug,
  not a budget problem.
- **Carol's budget is 512K because reviews are bounded** — she should be
  reading diffs + running commands, not accumulating chat history.
  If a review genuinely needs more context (e.g. cross-cutting rename
  touching 50+ files), Carol pauses and proposes to Alice: "this review
  needs >512K to do properly — bump to 1M for this run, or split into
  per-area reviews?"
- **Escalation to >512K** for Bob/Carol requires Alice's approval and a
  one-line justification in the chat. The bump is for that turn only.
- **Cost-bearing actions** (full eval runs, model swaps, context-budget
  overrides) are user-approved regardless of token budget — see
  escalation rule 1.

## What this document is NOT

- **Not a global overlay.** Permissions are repo-local. Other repos
  (`browser-mono`, etc.) will copy the structure but set their own
  boundaries.
- **Not a runtime ACL.** The hard excludes in `bin/start.sh` are the
  only machine-enforced layer; everything else is prompt-level. That's
  by design — see `AGENTS.md` Design Principles.
- **Not a persona DSL.** No new YAML / framework / runtime. Three
  markdown prompts + one shell script + this file. If you need
  something more elaborate, justify it first.