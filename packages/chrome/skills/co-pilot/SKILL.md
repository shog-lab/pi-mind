---
name: co-pilot
description: Drive the user's Chrome interactively. Look at what's on screen, act on it, react to navigations and network responses. Use this when the user is following along in their browser ("look at this page", "click the buy button", "wait until the order confirms"), not when you're writing a batch automation script.
---

# co-pilot

Operate the user's actual, logged-in Chrome turn by turn. The agent sees what
the user sees, acts on the active tab, and reacts to live browser events
(navigations, network responses, console output). Built on raw CDP — no fixed
sleeps, no headless replay.

This is the **live** mode. For URL-driven batch automation (smoke tests,
scraping a list of URLs, scripted form fills), see the sibling skills
`black-box-test`, `web-scrape`, `form-fill`.

## When to use this skill

- The user references "this page" / "what I'm looking at" / "my browser"
- You need to react to a real user action or page event (not a pre-known URL)
- You want the user's auth (cookies, login) — use their real session
- The flow has decision points based on what actually rendered

## The core loop

```
look → decide → act → watch_until (or look) → decide → ...
```

```
1. look()                          # snapshot the active tab; get @eN refs
2. (you reason about what's there)
3. click(@e7)  or  fill(@e3, "...") or  nav("https://...")
4. watch_until("cdp.navigation", { urlContains: "/welcome" })
   # or look() again, depending on whether the next state is event-detectable
5. repeat
```

Refs (`@e1`, `@e2`) are assigned per snapshot and **stale after any page
change**. Re-`look` before your next ref-based action.

## Tools

### `look(interactive?, selector?, timeoutMs?)`
Snapshot of the currently active tab. Returns the indented tree.
- `interactive: true` (default) — only interactive elements; usually what you want
- `interactive: false` — full tree
- `selector` — scope to a CSS selector

### `current_url() / nav(url)`
Read or change the active tab's URL. `nav` replaces the current tab (does NOT
open a new one).

### `click(ref) / fill(ref, value)`
Single-element actions. `ref` is `@eN` from a recent `look`, or a CSS selector.
On failure (e.g. stale ref), the tool returns `isError: true` — your signal
to re-`look`, not to retry the same ref.

### `watch_until(event, predicates..., timeoutMs?)`
Wait for the next bus event of `event` type matching predicates. Use this
instead of `wait 2000` after an action. Available event types:

| event                 | data                               | predicates                |
| --------------------- | ---------------------------------- | ------------------------- |
| `cdp.navigation`      | `{url, frameId}`                   | urlContains, urlMatches   |
| `cdp.load`            | `{}`                               | (none — fires on each load) |
| `cdp.network.request` | `{requestId, url, method}`         | urlContains, urlMatches   |
| `cdp.network.response`| `{requestId, url, status}`         | urlContains, urlMatches, status |
| `cdp.console`         | `{level, text}`                    | textContains              |
| `cdp.log`             | `{level, text, source}`            | textContains              |
| `cdp.dialog`          | `{type, message}`                  | textContains              |

Returns the matched event's `data` plus a `timestamp`. Times out → `isError`.

## Pattern: log into a site

```
1. nav("https://app.example/login")
2. watch_until("cdp.load")                    # wait for page to render
3. look()                                     # discover form refs
4. fill(@e_email, "user@example.com")
5. fill(@e_pw, "...")
6. click(@e_submit)
7. watch_until("cdp.navigation", { urlContains: "/dashboard", timeoutMs: 10000 })
8. look()                                     # see what's on the dashboard
```

## Pattern: trigger an action and verify the API call

```
1. look()
2. click(@e_save)
3. watch_until("cdp.network.response", {
     urlMatches: "/api/items/\\d+", status: 200, timeoutMs: 5000
   })
   # if you got here, the save round-tripped successfully
```

## Pattern: detect an error toast / console error

```
1. (do something risky)
2. watch_until("cdp.console", {
     textContains: "error", timeoutMs: 3000
   })
```

If the watch times out, no error fired — that's the success signal. Catch
the timeout in the calling code rather than treating it as a fatal failure.

## Attaching to the user's actual Chrome

By default, `agent-browser` launches its own Chrome instance. To drive the
user's existing browser (with their logins and tabs):

```bash
# user starts Chrome with a debug port (one time):
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-agent

# tell agent-browser to attach to that Chrome:
export AGENT_BROWSER_BIN="agent-browser --cdp 9222"

# now run pi
pi
```

Or use `agent-browser --auto-connect` to discover any running Chrome with a
debug port. With `--profile Default`, agent-browser launches its own Chrome
but reuses the user's actual profile (cookies, login state, extensions).

## Known limitation: CDP timing

CDP-driven features (live tab-state, `cdp.*` events, `watch_until`) need
agent-browser's daemon to be running **at the moment pi starts**. If the
daemon hasn't started yet, the in-process bus stays empty. Workaround: run
`agent-browser open about:blank` in another terminal *before* starting pi.

If you call `look` or `nav` first (which spawns the daemon), CDP events from
that point onward will not be in the bus until pi is restarted. Lazy
reconnect is on the v0.4 roadmap.

## When NOT to use this skill

- The user gave you a URL and a batch goal ("scrape these 50 URLs", "smoke
  test this list of pages") — use `black-box-test` / `web-scrape`.
- You have no need to react to events — fixed-step automation can use the
  CLI directly via Bash.
- The user's Chrome is closed and they don't want it open — these tools all
  require an active Chrome session.
