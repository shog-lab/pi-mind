# Personas — Policy

This is the repo-local side-effect policy for Alice / Bob / Carol.

- `prompts/*.md` says how each persona behaves.
- `policy.md` says who may cause side effects.
- `bin/run` enforces the small subset that can be enforced by CLI flags; persona-specific defaults live in `bin/alice`, `bin/bob`, and `bin/carol`.

User remains the final authority. Anything destructive, externally visible, or cost-bearing is proposed first and executed only after approval.

## Hard tool excludes

`personas/bin/bob` and `personas/bin/carol` pass these disabled tools to `bin/run`:

```text
remember_this,observe,update_memory,mark_memory_audit_complete,create_skill,update_skill
```

Rationale: durable memory writes and skill changes are centralized through Alice and, for skills, require the ask-first user gate.

## Matrix

Legend: `✓` allowed within role scope; `✗` not allowed; `△` requires explicit approval / escalation.

| Action | Alice | Bob | Carol | User |
|---|:---:|:---:|:---:|:---:|
| Read repo / memory / skills | ✓ | ✓ | ✓ | ✓ |
| Propose plan / review | ✓ | ✓ | ✓ | ✓ |
| Edit tracked files | ✓ | ✓ when assigned | ✗ | ✓ |
| Temporary probe files | ✓ | ✓ | ✓ `/tmp` or `.tmp-verify-*` only | ✓ |
| Delete files | △ | ✗ | ✗ | ✓ |
| Commit to `main` | ✓ | ✓ when assigned | ✗ | ✓ |
| Push to `origin` | △ | ✗ | ✗ | ✓ |
| Durable memory write/update | ✓ / △ for semantic or destructive updates | ✗ | ✗ | ✓ via Alice |
| Skill create/update | △ propose, then user gate | ✗ | ✗ | ✓ |
| npm publish / deprecate | △ | ✗ | ✗ | ✓ |
| Full LongMemEval / costly model changes | △ | △ via Alice | △ review/propose only | ✓ |

## Escalation rules

1. **Destructive or external side effects** — delete, push, publish, deprecate, costly eval, model/context override: Alice proposes; user approves; Alice executes unless explicitly delegated.
2. **Cross-cutting changes** — rename, schema/public API changes, retrieval behavior, persona/permission changes: Alice plans; Carol may pre-review; Bob executes after assignment.
3. **Throughput split** — Alice may directly do low-risk small edits (README, metadata, typo, config, small grep replacement). Larger implementation work goes to Bob. High-risk plans can go to Carol before execution.
4. **Unclear scope** — Bob/Carol ask Alice; Alice asks the user. Do not silently broaden the task.
5. **Carol disagreement** — Carol reports PASS / CONDITIONAL / BLOCK to Alice with evidence; she does not bypass Alice or direct Bob to implement changes.

## Cron-triggered behavior

OS-scheduled tasks (`schedule_cron` in toolkit) deliver messages via bus inbox — the same mechanism as `agent_send`. When a cron message arrives:

- The target agent (identified by `PI_AGENT_NAME`) receives it as `[from cron] <message>` in a visible turn.
- Permission boundaries are **unchanged**: Bob and Carol are still hard-excluded from memory writes and skill changes regardless of trigger source.
- Alice may self-execute cron tasks, or dispatch to Bob / Carol if they are online.
- If the target agent is not online, the inbox write fails silently (session directory doesn't exist) and the message is dropped.
- Inline-gate operations (`create_skill`, `update_skill`) still require explicit user approval — cron does not bypass the gate.

## Context / cost budget

- Bob and Carol default to **512K context**.
- Bumping Bob/Carol above 512K requires Alice approval and a one-line justification.
- Alice is not capped by this file; she should compact when needed.
- Cost-bearing actions still require user approval even if they fit within context.
