---
name: daily-audit
description: Daily memory audit — lint schema, sample feedback decisions, archive old compactions, report.
---

# daily-audit

Run a periodic health check over `$PI_MIND_DIR/`. Designed to be triggered by OS cron once a day; can also be invoked manually.

## What it does

1. Run wiki-lint over `knowledge/` and report errors / warnings / duplicates
2. Sample recent feedback-llm decisions from the maintenance log (precision spot-check)
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

### 2. Feedback-LLM decision sample

```bash
DATE=$(date +%Y-%m-%d)
LOG="$PI_MIND_DIR/episodic/maintenance-log/${DATE}.jsonl"
grep "feedback-llm" "$LOG" 2>/dev/null | head -3
```

Each entry: `{shouldRemember: true | false | null}`.
- `null` = Ollama call failed (down / timeout / network)
- Several consecutive `null` = Ollama unhealthy, surface to user

### 3. Archive old compactions

Move compaction files older than 14 days to `episodic/compaction/archived/`:

```bash
COMPACTION_DIR="$PI_MIND_DIR/episodic/compaction"
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
date: 2026-05-08T22:00:00.000Z
type: agent-feedback
tier: L2
tags: [daily-audit, audit-log]
---

## Daily audit YYYY-MM-DD

<paste the report body>
```

## Cron invocation

Recommended user crontab:

```
0 22 * * * cd /path/to/repo && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1
```

The agent does NOT install this. Output a snippet for the user when asked to "schedule" anything.

## When invoked manually

If the user runs `pi -p "use daily-audit skill"` interactively, follow the same flow but skip step 5 (audit log) if the user only wants a one-off report.
