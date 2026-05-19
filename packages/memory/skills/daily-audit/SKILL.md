---
name: daily-audit
description: Daily memory audit — lint schema, sample worth-remembering decisions, archive old compactions, report.
---

# daily-audit

Run a periodic health check over `$PI_MIND_DIR/`. Designed to be triggered by OS cron once a day; can also be invoked manually.

## What it does

1. Run wiki-lint over `knowledge/` and report errors / warnings / duplicates
2. Sample recent worth-remembering-llm decisions from the maintenance log (precision spot-check)
3. Archive compaction files older than 14 days
4. Report results as a single concise summary

The agent **does not auto-fix anything beyond lint --fix**. Anything ambiguous is reported to the user, who decides.

## Commands

### 1. Wiki lint

```bash
npx pi-mind-lint
```

Read the `Summary:` line — capture errors / warnings / duplicates counts.

If errors are auto-fixable:

```bash
npx pi-mind-lint --dry-run --fix   # preview
npx pi-mind-lint --fix              # apply (after user confirms if invoked interactively)
```

Detailed flow: `../wiki-lint/SKILL.md`.

### 2. Worth-remembering LLM decision sample

```bash
DATE=$(date +%Y-%m-%d)
LOG="$PI_MIND_DIR/raw/maintenance-log/${DATE}.jsonl"
grep "worth-remembering-llm" "$LOG" 2>/dev/null | head -3
grep "worth-remembering-saved" "$LOG" 2>/dev/null | head -3
grep "remember-this" "$LOG" 2>/dev/null | head -3
```

`worth-remembering-llm` entries: `{shouldRemember: true | false | null, type?}`.
- `null` = Ollama call failed (down / timeout / network)
- Several consecutive `null` = Ollama unhealthy, surface to user

`worth-remembering-saved` entries log actual writes to knowledge/.
`remember-this` entries log explicit tool calls from the agent.

### 3. Archive old compactions

Move compaction files older than 14 days to `raw/compaction/archived/`:

```bash
COMPACTION_DIR="$PI_MIND_DIR/raw/compaction"
ARCHIVE_DIR="$COMPACTION_DIR/archived"
mkdir -p "$ARCHIVE_DIR"
find "$COMPACTION_DIR" -maxdepth 1 -type f -name '*.md' -mtime +14 -exec mv {} "$ARCHIVE_DIR/" \;
```

Record archived count.

### 4. Report

Output a single message in this shape:

```
## Daily audit (YYYY-MM-DD)

### Wiki lint
- Errors: N (M auto-fixed)
- Warnings: N
- Duplicates: N
- Action: <none / list of remaining issues>

### Feedback detection sample (3 most recent)
- <hash or excerpt> → <true/false/null>
- ...
- Health: <ok / Ollama failures detected>

### Compaction archive
- Archived N files older than 14 days

### Issues for user
- <bullets, only if anything needs human attention>
```

If everything is clean, the report should still be sent — its absence shouldn't be the only signal of health. Brevity is fine when there are no issues.

### 5. Write audit log

Save the report as a knowledge entry so daily-audit history is queryable:

```markdown
---
date: 2026-05-09T22:00:00.000Z
type: agent-feedback
tier: L2
tags: [daily-audit, audit-log]
---

## Daily audit YYYY-MM-DD

<paste the report body>
```

### 6. Mark complete

After writing the audit log, call:

```
mark_daily_audit_complete({ summary: "<one-line: lint errors / warnings / archived count>" })
```

This silences the "audit overdue" notice in `<self-evolution>` context for the next 24 hours. Without this call, the next pi session will keep flagging audit as overdue.

## How daily-audit gets triggered

Pi-mind does NOT install a cron job. Instead, when you start a pi session and the last audit was > 24 hours ago, an `<self-evolution>` block is injected into your context with the message "Daily audit overdue — suggest running it before substantive work." That's your cue.

Honor the suggestion at the start of the session unless the user is asking about something time-critical that would be derailed by a 30-second pause. In that case, finish the user's task first, then run audit, then call mark_daily_audit_complete.

## When invoked manually

If the user explicitly asks "run daily audit", follow the full flow including step 6. If they only want a one-off summary report (e.g., "give me a one-off lint check, don't touch the marker"), skip step 6.
