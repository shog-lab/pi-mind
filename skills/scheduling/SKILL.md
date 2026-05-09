---
name: scheduling
description: Help the user set up periodic tasks. pi-mind cannot install scheduled jobs itself — it provides the snippet/plist content; the user installs it via crontab or launchctl. Use when the user wants something to happen on a schedule and is willing to do the install step themselves.
---

# scheduling

You **cannot** install scheduled tasks. There are no install_cron / install_schedule
tools in pi-mind. Two reasons:

1. **macOS Authorization model**: the OS prompts the user's terminal app for
   broad "manage your computer" rights when crontab is invoked. Many users
   reasonably refuse this prompt.
2. **Self-evolution doesn't need cron**: pi-mind's daily-audit and wiki-lint
   are auto-triggered when you start a pi session and they're overdue (see
   the `<self-evolution>` context block). No external scheduler required.

So this skill is **for time-bound tasks the user explicitly wants on a fixed
schedule** (e.g. "post a tweet at 9am Monday", "back up the DB at midnight"),
not for memory hygiene.

## Workflow

### 1. Confirm it actually needs a schedule

If the user says "audit memory periodically" — that already runs automatically.
Tell them so and skip the rest. Only proceed if the task is genuinely
time-bound.

### 2. Build the cron expression

Convert plain English → 5-field cron syntax:

| User says | Cron expression |
|---|---|
| every day at 22:00 | `0 22 * * *` |
| every day at 09:30 | `30 9 * * *` |
| every Monday at 09:00 | `0 9 * * 1` |
| every weekday at 18:00 | `0 18 * * 1-5` |
| every hour | `0 * * * *` |
| every 15 minutes | `*/15 * * * *` |
| every Sunday midnight | `0 0 * * 0` |

Field order: `minute hour day-of-month month day-of-week`.
Day-of-week: 0=Sunday or 7=Sunday, 1=Monday … 6=Saturday.

### 3. Build the command

Standard shape:

```
cd <abs-repo-path> && pi -p "<prompt>" >> .pi-mind/cron.log 2>&1
```

Always include `cd`, the prompt, and the log redirect (cron has no terminal).

### 4. Hand to the user

Output the line and tell them to install:

```
0 9 * * 1 cd /Users/foo/proj && pi -p "post weekly tweet" >> .pi-mind/cron.log 2>&1
```

Then:

> Run `crontab -e` and paste the line above. Save and exit.
>
> **macOS heads-up**: the first time crontab runs, macOS may prompt your
> terminal app (Terminal.app / Ghostty / iTerm) for "manage your computer"
> permission. The wording is alarming but it only enables crontab access for
> your per-user spool. You can deny — in which case scheduling won't work
> on this machine and you'd need launchd (see below) or a remote scheduler.

### 5. macOS-specific alternative: launchd

If the user denies the macOS Authorization prompt, suggest launchd instead.
Launchd uses per-user plist files in `~/Library/LaunchAgents/` and needs **no
elevation**.

Output a plist for them to save:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pi-mind.weekly-tweet</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd /Users/foo/proj && pi -p "post weekly tweet" >> .pi-mind/cron.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
    <key>Weekday</key><integer>1</integer>
  </dict>
</dict>
</plist>
```

Tell them:

```
1. Save above as ~/Library/LaunchAgents/com.pi-mind.weekly-tweet.plist
2. Activate: launchctl load ~/Library/LaunchAgents/com.pi-mind.weekly-tweet.plist
3. Verify: launchctl list | grep pi-mind
4. Remove later: launchctl unload <path> && rm <path>
```

## What you must NOT do

- ❌ Try to write to user's crontab via Bash (`echo ... | crontab -`) — this triggers the macOS prompt and bypasses informed consent
- ❌ Try to write a launchd plist via Bash — same trust principle; user should see and place it themselves
- ❌ Suggest a long-running daemon (pm2, forever) when cron/launchd is sufficient
- ❌ Tell the user to "schedule daily-audit" — it auto-triggers

## Verifying it ran

When asked "did the scheduled job run?":

```bash
tail -50 .pi-mind/cron.log              # cron output
launchctl list | grep pi-mind            # launchd jobs (macOS)
crontab -l                               # crontab contents (if they used cron)
```
