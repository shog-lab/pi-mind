# pi-chrome

**Drive Chrome from a pi agent — both batch automation and live co-piloting of the user's browser.**

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension built on
[`agent-browser`](https://github.com/vercel-labs/agent-browser) (Rust CLI, Chrome via CDP)
with an RxJS-based composition layer. Two modes:

- **Batch automation** — URL-driven, retry-heavy: `test_page`, `scrape`, `fill_form`.
  Good for smoke tests, scraping, scripted form fills.
- **Co-pilot** — live, attached to the user's Chrome, reacts to real CDP events:
  `look`, `nav`, `click`, `fill`, `current_url`, `watch_until`. Good for "look at
  this page, click that, wait for the response" flows.

## Install

```bash
npm i -D pi-chrome
```

`postinstall` symlinks `extensions/browser/` and `skills/*/` into the host repo's `.pi/`
so pi auto-discovers them.

## Use

```bash
cd ~/my-repo
pi              # extension and skills loaded automatically
```

The agent now has both toolsets and skills available. Skills:

| Skill           | Mode      | Use when                                      |
| --------------- | --------- | --------------------------------------------- |
| `black-box-test`| batch     | "verify this page renders / smoke a deploy"   |
| `web-scrape`    | batch     | "extract these fields from this URL"          |
| `form-fill`     | batch     | "fill these inputs and submit"                |
| `co-pilot`      | live      | "look at the page I have open and do X"       |

## Co-pilot quick start

To drive the user's actual Chrome (with their logins):

```bash
# Start Chrome with a debug port (one time)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-agent

# In another terminal — point agent-browser at that Chrome
export AGENT_BROWSER_BIN="agent-browser --cdp 9222"
pi
```

Or let agent-browser launch its own Chrome but reuse the user's profile:

```bash
export AGENT_BROWSER_BIN="agent-browser --profile Default"
pi
```

The `co-pilot` skill teaches the agent the look→act→react loop. CDP events
flow into the in-process event bus and `watch_until` consumes them.

## Design

```
pi process
├── extension load   → RxJS Subjects initialized, tools registered
├── CDP attach (best-effort) → tab-state populated from Target events,
│                              event bus bridged from Page/Network/Runtime/...
├── batch tools      → CLI-driven Observable pipelines (open → snapshot → ...)
├── primitive tools  → single CLI call per turn, no retry, work on active tab
├── watch_until      → bus subscription with predicate + timeout
└── process exit     → automatic cleanup (subscriptions disposed, child procs killed)
```

No daemon outside of pi itself. Cross-process state goes through
[pi-mind](https://github.com/shog-lab/pi-mind)'s `episodic/browser/` filesystem
convention.

## Status

v0.3.0 — co-pilot mode added. APIs may still change.

See `CHANGELOG.md` for details.
