---
name: memory-audit
description: Audit memory store — lint schema, sample recent writes, archive old compactions, report.
---

# memory-audit

Periodic health check over `$PI_MIND_DIR/`. Not scheduled by the system — triggered when the user asks or when an "audit overdue" context block (auto-injected if last audit > 24h) suggests running it.

(Was named `daily-audit` through 0.6.0. The "daily" was misleading: nothing in the system actually runs this on a daily cadence; the trigger is the user or the overdue notice. Renamed to describe what it is, not how often it's supposed to run.)

## What it does

1. Run knowledge-lint over `knowledge/` and report errors / warnings / duplicates
2. Sample recent memory writes from the maintenance log
3. Archive compaction files older than 14 days
4. Report results as a single concise summary
5. Mark audit complete (silences the overdue notice for 24h)

**The agent does not auto-apply destructive operations.** Anything that mutates state (`lint --fix`, prune, archive) requires explicit user approval — show the preview, ask, only then apply.

## Steps

### 1. Lint scan (read-only)

```bash
npx pi-mind-lint
```

Read the `Summary:` line — capture errors / warnings / duplicates counts.

### 2. Auto-fixable issues (requires user approval)

If lint reported errors that the `--fix` flag handles, **always show the preview first**:

```bash
npx pi-mind-lint --dry-run --fix
```

Show the dry-run output to the user. Ask explicitly: "These N changes would be applied. OK to proceed?"

Only after the user approves:

```bash
npx pi-mind-lint --fix
```

Then re-scan to verify errors hit zero:

```bash
npx pi-mind-lint
```

Do not skip the dry-run step, even if the changes look obviously safe. The skill is the *enforcement* of the principle; collapsing dry-run into "apply directly" defeats the point.

### 3. Memory write sample

Since 0.6.0 there is no background auto-capture — every entry in `knowledge/` came from an explicit `remember_this` / `observe` call (or `session_compact`). Sample recent activity:

```bash
DATE=$(date +%Y-%m-%d)
LOG="$PI_MIND_DIR/raw/maintenance-log/${DATE}.jsonl"
grep "remember-this" "$LOG" 2>/dev/null | head -5
grep "observe-saved" "$LOG" 2>/dev/null | head -3
grep "compaction-saved" "$LOG" 2>/dev/null | head -3
```

Eyeball the sample: are the saved entries useful and self-contained? Anything obviously low-signal should be surfaced to the user for manual prune (don't auto-delete).

### 4. Archive old compactions

Move compaction files older than 14 days to `raw/compaction/archived/`. This is mechanical movement, no LLM judgment — safe to run without per-file approval, but mention the count in the report:

```bash
COMPACTION_DIR="$PI_MIND_DIR/raw/compaction"
ARCHIVE_DIR="$COMPACTION_DIR/archived"
mkdir -p "$ARCHIVE_DIR"
find "$COMPACTION_DIR" -maxdepth 1 -type f -name '*.md' -mtime +14 -exec mv {} "$ARCHIVE_DIR/" \;
```

### 5. Report

Output a single message in this shape:

```
## Memory audit (YYYY-MM-DD)

### Lint
- Errors: N (M auto-fixed after your approval, K remaining)
- Warnings: N
- Duplicates: N

### Memory writes today (sample)
- <hash or excerpt> → <remember-this / observe / compaction>
- ...
- Quality: <ok / N entries look low-signal — recommend manual review>

### Compaction archive
- Archived N files older than 14 days

### Issues for user
- <bullets, only if anything needs human attention>
```

If everything is clean, the report should still be sent — its absence shouldn't be the only signal of health. Brevity is fine when there are no issues.

### 6. Write audit log

Save the report as a knowledge entry so audit history is queryable:

```markdown
---
date: 2026-05-09T22:00:00.000Z
type: agent-feedback
tier: L2
tags: [memory-audit, audit-log]
---

## Memory audit YYYY-MM-DD

<paste the report body>
```

### 7. Mark complete

After writing the audit log, call:

```
mark_daily_audit_complete({ summary: "<one-line: lint errors / warnings / archived count>" })
```

Tool name is `mark_daily_audit_complete` for now (historical — will be renamed `mark_memory_audit_complete` in a future breaking release). Functionally identical; updates the audit timestamp so the overdue notice is silenced for the next 24 hours.

## How memory-audit gets triggered

Pi-mind installs no cron job. Instead, when you start a pi session and the last audit was > 24 hours ago, an `<self-evolution>` block is injected into context with the message "Audit overdue — suggest running it before substantive work." That's your cue.

Honor the suggestion at the start of the session unless the user is asking about something time-critical that would be derailed by a 30-second pause. In that case, finish the user's task first, then run audit, then call mark_daily_audit_complete.

## When invoked manually

If the user explicitly asks "run memory audit" / "run audit" / "use memory-audit skill", follow the full flow including step 7. If they only want a one-off summary report (e.g., "give me a one-off lint check, don't touch the marker"), skip step 7.
