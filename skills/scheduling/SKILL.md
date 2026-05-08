---
name: scheduling
description: Help the user install, list, or remove crontab entries for periodic pi tasks. Use whenever the user wants something to happen on a schedule — "every day at X", "weekly", "remind me", "run this nightly" — or wants to see/cancel a previously scheduled task. Uses install_cron / list_cron / remove_cron tools. Always show the user the full crontab line and get explicit confirmation before installing or removing.
---

# scheduling

The user wants to manage periodic tasks. You have three tools:

- `install_cron(cron_expression, command, description)` — add a new entry
- `list_cron()` — show all pi-mind-installed entries
- `remove_cron(match)` — remove one entry by description substring

These tools edit the user's actual crontab. **Always confirm with the user
before calling install_cron or remove_cron.** Show the full line first.

## Intent recognition

| User says | You do |
|---|---|
| "every day / week / hour at X", "schedule Y", "run Y nightly" | propose install_cron |
| "what cron jobs are running?", "show me my schedules" | call list_cron immediately (read-only, no confirm needed) |
| "stop / cancel / remove the X reminder" | call list_cron first to find the match, then propose remove_cron |
| "change Y to run at 9 instead of 8" | propose remove + install (the tools don't have an update operation) |

## install_cron workflow

### 1. Build the cron expression

Convert plain English → 5-field cron syntax:

| User says | Cron expression |
|---|---|
| every day at 22:00 | `0 22 * * *` |
| every day at 09:30 | `30 9 * * *` |
| every Monday at 09:00 | `0 9 * * 1` |
| every weekday at 18:00 | `0 18 * * 1-5` |
| every hour | `0 * * * *` |
| every 15 minutes | `*/15 * * * *` |
| every 1st of month | `0 0 1 * *` |
| every Sunday midnight | `0 0 * * 0` |

Field order: `minute hour day-of-month month day-of-week`.
Day-of-week: 0=Sunday or 7=Sunday, 1=Monday … 6=Saturday.

### 2. Build the command

Standard shape:

```
cd <abs-repo-path> && pi -p "<prompt>" >> .pi-mind/cron.log 2>&1
```

For pi-mind built-ins use the dedicated CLIs (faster, no LLM for lint):

```
cd <abs-repo-path> && npx pi-mind-lint --fix >> .pi-mind/cron.log 2>&1
cd <abs-repo-path> && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1
```

Always include:
- `cd <abs-path>` — cron's working dir is `$HOME` by default
- `>> .pi-mind/cron.log 2>&1` — capture stdout AND stderr for debugging

### 3. Pick a description

Short identifier, used by remove_cron later. Make it unique among existing entries (call list_cron first if unsure).

Good: `"daily-audit"`, `"weekly-tweet-summary"`, `"morning-email-digest"`.
Bad: `"task1"`, `"my-cron"`, `"abc"`.

### 4. Show + confirm

Before calling the tool, show the user the full line you're about to install:

```
I'll install:
  0 22 * * * cd /Users/foo/proj && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1   # pi-mind: daily-audit

Proceed? (y/N)
```

Wait for user confirmation. Only on explicit "yes / y / 确认" call install_cron.

### 5. Call install_cron

```
install_cron({
  cron_expression: "0 22 * * *",
  command: 'cd /Users/foo/proj && pi -p "use daily-audit skill" >> .pi-mind/cron.log 2>&1',
  description: "daily-audit"
})
```

The tool returns a confirmation message including the line installed.

## remove_cron workflow

```
list_cron()           → user sees their entries
user identifies one to remove
show full line you're about to remove → confirm → remove_cron({match: "daily-audit"})
```

If the user's match is ambiguous (matches multiple entries), the tool will
return an error listing all matches; ask the user to be more specific.

## What you must NOT do

- ❌ Call install_cron or remove_cron without showing the line and getting explicit confirmation
- ❌ Bash-edit crontab directly (`crontab -l > x && echo ... >> x && crontab x`) — use the tools so the pi-mind marker is preserved
- ❌ Touch any line in the user's crontab that doesn't carry `# pi-mind:` — those are user-written, off-limits
- ❌ Suggest a daemon process (pm2, systemd, launchd) when cron is sufficient

## Verifying it ran

When asked "did the cron job run?":

```bash
tail -50 .pi-mind/cron.log              # success and failure output
crontab -l | grep "# pi-mind:"           # confirm entries are still there
```

## Platform notes

- **macOS**: crontab works; first run may prompt for "Full Disk Access" permission
- **Linux**: works out of the box; minimal containers may need `cron` package installed
- **Windows**: cron isn't native — these tools won't work. Suggest WSL.
