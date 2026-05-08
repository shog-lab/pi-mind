---
name: scheduling
description: Help the user install a crontab entry to run a periodic pi task. Use whenever the user wants something to happen on a schedule — "every day", "every Monday", "remind me to X weekly", "run wiki-lint nightly", "check Y every hour". Outputs a crontab snippet for the user to install with `crontab -e`. Never modifies crontab automatically.
---

# scheduling

The user wants something to happen periodically. You produce a crontab snippet
they can install themselves. You never edit `crontab` yourself — that's a
sensitive system change.

## Intent triggers

Use this skill when the user says:

- "every day / week / hour at X o'clock"
- "remind me to ... weekly"
- "run X periodically / nightly / every Monday"
- "schedule Y" / "set up a cron job"
- "check the build every 30 minutes"

## Workflow

### 1. Determine the schedule

Convert plain English to a cron expression:

| User says | Cron expression |
|---|---|
| every day at 22:00 | `0 22 * * *` |
| every day at 09:30 | `30 9 * * *` |
| every Monday at 09:00 | `0 9 * * 1` |
| every weekday at 18:00 | `0 18 * * 1-5` |
| every hour | `0 * * * *` |
| every 15 minutes | `*/15 * * * *` |
| every 1st of the month | `0 0 1 * *` |
| every Sunday at midnight | `0 0 * * 0` |

Field order: `minute hour day-of-month month day-of-week command`. Day-of-week
0=Sunday or 7=Sunday, 1=Monday … 6=Saturday.

### 2. Determine the command

What should run periodically? Common cases:

- **A pi-mind built-in skill (daily-audit, wiki-lint)** — there's a shortcut:
  ```bash
  npx pi-mind-cron --skill daily-audit    # prints the recommended snippet
  npx pi-mind-cron --skill wiki-lint
  ```
  Just run the command and show the output to the user. No need to compose by hand.

- **A custom skill the user wrote** — you compose:
  ```
  cd <repo-abs-path> && pi -p "use <skill-name> skill" >> .pi-mind/cron.log 2>&1
  ```

- **An ad-hoc prompt** — you compose:
  ```
  cd <repo-abs-path> && pi -p "<prompt-text>" >> .pi-mind/cron.log 2>&1
  ```

### 3. Format the full crontab line

Always include:

- **`cd <abs-path>`** — cron's working dir is `$HOME` by default; force the repo
- **`pi -p "..."`** — non-interactive prompt mode (pi exits when done)
- **`>> .pi-mind/cron.log 2>&1`** — redirect both stdout and stderr to a log so failures are debuggable

Final shape:

```
<cron-expression> cd <abs-repo-path> && pi -p "<prompt>" >> .pi-mind/cron.log 2>&1
```

Example for "wiki-lint every night at 02:00 in /Users/foo/proj":

```
0 2 * * * cd /Users/foo/proj && npx pi-mind-lint --fix >> /Users/foo/proj/.pi-mind/cron.log 2>&1
```

(For pi-mind-built-in tasks, prefer using the dedicated CLI like
`npx pi-mind-lint` over `pi -p "use wiki-lint skill"` — same result, faster
because it skips loading the LLM.)

### 4. Hand to the user

Tell them:

1. Run `crontab -e`
2. Paste the line
3. Save and exit (`:wq` in vim, Ctrl-O/Ctrl-X in nano)
4. Verify with `crontab -l`

Do **not** offer to install it for them, even if they ask. crontab edits
should always be manual — the user sees what's in their crontab.

## Verifying it ran

When asked "did the cron job run?", check:

```bash
tail -50 .pi-mind/cron.log              # recent runs (success and failure)
crontab -l | grep pi-mind                # confirm it's actually installed
```

Failed cron runs typically show in the log; if the log is empty after expected
run-time, the cron daemon may not be enabled or the entry may be syntactically
wrong.

## What you must NOT do

- ❌ `crontab -l > /tmp/x && echo "..." >> /tmp/x && crontab /tmp/x` (silently editing user crontab)
- ❌ Writing a node script that runs `setInterval` or `setTimeout` to simulate scheduling
- ❌ Telling the user to install a daemon process (pm2, systemd, launchd) without confirming they want that complexity
- ❌ Recommending Windows Task Scheduler instructions on macOS/Linux (and vice versa)

## Platform notes

- **macOS**: `crontab` works, but launchd is more idiomatic for system services. For user-level periodic tasks, `crontab -e` is the simplest path. macOS may ask for "Full Disk Access" permission for cron the first time.
- **Linux**: `crontab` works out of the box. Some minimal containers/distros need `cron` package installed.
- **Windows**: cron isn't native. Suggest WSL or PowerShell Scheduled Tasks; ask the user which they prefer before composing.
