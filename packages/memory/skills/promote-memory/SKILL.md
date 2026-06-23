---
name: promote-memory
description: Review retrieved memory and propose user-approved promotions into project documentation such as AGENTS.md, README.md, or docs/.
---

# promote-memory

Use this when the user wants to turn useful agent memory into durable, human-reviewed project documentation. This is a promotion workflow, not a memory sync: never commit `.pi-mind/**` wholesale, and never edit docs before showing the proposed changes.

## Usage

User examples:

- “把有价值的记忆整理进文档”
- “promote memory into docs”
- “看看哪些 memory 应该进 AGENTS.md”
- “这次事故整理成项目规则”

## Principles

- Memory is private/local working state by default.
- Git-tracked docs are shared source of truth.
- Promotion requires human review.
- Do not copy raw transcripts, observations, or compaction files verbatim.
- Do not promote secrets, personal preferences, temporary status, or unverified claims.
- After promotion, the document becomes the source of truth; memory may remain only as historical context.

## Steps

1. Clarify the promotion target if unclear:
   - `AGENTS.md` for agent/project operating rules.
   - `README.md` or package README for user-facing usage.
   - `docs/**` for design notes, incidents, runbooks, or longer explanations.
   - `.pi/skills/**` only if the user explicitly wants future agent behavior changed.

2. Retrieve candidate memory:
   - Use `recall_memory` with a focused query from the user’s request.
   - If the user asks for broad cleanup, query recent project, user, and agent-feedback memories separately.
   - Do not inspect `.pi-mind/raw/**` directly unless the user asks for forensic review.

3. Classify each candidate:
   - **Promote**: durable, verified, useful to future humans/agents, belongs in shared docs.
   - **Keep local**: useful context but personal, temporary, too detailed, or not generally useful.
   - **Stale / needs audit**: conflicts with current docs or should be corrected later.
   - **Do not promote**: secrets, raw conversation, speculative notes, accidental writes.

4. Present a promotion proposal before editing:
   - Candidate memory summary.
   - Why it should or should not be promoted.
   - Target file and target section.
   - Draft wording or patch outline.
   - Any memory entries that may need `update_memory` after docs are updated.

5. Wait for explicit user approval.

6. After approval, edit docs with normal file tools:
   - Use `read` to inspect target files.
   - Use `edit` for precise changes.
   - Keep wording human-readable; do not paste memory metadata unless relevant.
   - Prefer concise project rules over long incident logs.

7. Verify:
   - Run formatting/tests only if relevant.
   - Run `git diff` and summarize changed files.
   - Confirm `.pi-mind/**` was not staged or committed accidentally.

8. Optional follow-up:
   - If a memory is now superseded by docs, ask whether to mark it as promoted/superseded via `update_memory`.
   - Do not delete memory unless the user explicitly approves.

## Common failures

- If memory conflicts with current docs, treat docs as current unless the user says memory is newer.
- If no good candidates are found, say so and do not invent documentation.
- If the target is a skill, switch to the stricter skill create/update gate: show the full skill draft/diff and wait for explicit approval.
- If a candidate contains sensitive or personal information, summarize the general lesson without copying details.

## Anti-patterns

- Do not sync `.pi-mind/knowledge` into git.
- Do not commit raw sessions, observations, compactions, bus inboxes, cron state, or SQLite indexes.
- Do not silently turn memory into future behavior.
- Do not use this as a generic documentation rewrite skill.
