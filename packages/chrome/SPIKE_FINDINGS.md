# Spike findings — agent-browser attach & event stream

**Date:** 2026-05-09
**Time-box:** 45 min (used ~35)
**Disposition:** Throwaway notes. Decide path → delete this file.

## Goals

1. Can agent-browser cleanly attach to a user's existing Chrome?
2. Does agent-browser expose an event stream we can subscribe to?

## Answers

### 1. Attach to user's Chrome — **YES, well supported**

Three documented modes (refs: `commands.md`, `--help`):

```
agent-browser --cdp <port> <cmd>          # attach by explicit CDP port
agent-browser connect <port>              # alias
agent-browser --auto-connect <cmd>        # auto-discover running Chrome
```

Plus session/profile knobs that compose with attach:

```
--profile Default         # reuse user's real Chrome profile (cookies, login)
--profile <path>          # persistent custom profile
--session-name <name>     # auto-save/restore state
--session <name>          # isolated parallel sessions
```

User flow for "agent attaches to my real Chrome":
```bash
# user starts Chrome:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-agent

# agent-browser then drives it:
agent-browser --cdp 9222 snapshot
```

### 2. Event stream — **mixed; raw CDP is the win**

#### `agent-browser stream` WebSocket — screencast only

`stream enable` opens a WebSocket on a random localhost port (verifiable via
`stream status --json`). Probed it with a custom WS client while running
`open / snapshot / click / snapshot` in parallel:

- Got exactly **1 message**: a `{type:"status", connected, screencasting, viewportWidth/Height, ...}` snapshot.
- Zero messages during navigation, click, snapshot.
- Stream is for **screencast frames** (image push), not CDP event firehose.
  Frames only flow when screencasting is started (CDP `Page.startScreencast`).

→ Not useful as a CDP event channel.

#### Polling primitives — useful but cheap

agent-browser buffers some events server-side; CLI pulls them on demand:

```
agent-browser console            # buffered console.log/warn/error
agent-browser errors             # uncaught exceptions
agent-browser network requests   # captured requests with filters
```

These are pull-style. Fine for "what happened recently" but not push.

#### Raw CDP via `get cdp-url` — **the actual answer**

```bash
agent-browser get cdp-url --json
# → {"data":{"cdpUrl":"ws://127.0.0.1:50827/devtools/browser/<uuid>"}}
```

Connected directly with a 60-line WebSocket client (`/tmp/ab-cdp-probe.mjs`),
attached to the page target via `Target.attachToTarget(flatten:true)`,
enabled `Page / Network / Runtime / DOM / Log` domains, then navigated.
Captured event types:

```
Runtime.executionContextCreated     ×2
Runtime.executionContextsCleared    ×2
DOM.documentUpdated                 ×2
Target.attachedToTarget             ×1
Page.frameStartedNavigating         ×1
Page.frameStartedLoading            ×1
Page.frameNavigated                 ×1
Page.domContentEventFired           ×1
Page.loadEventFired                 ×1
Page.frameStoppedLoading            ×1
Network.requestWillBeSent           ×1
Network.responseReceived            ×1
Network.dataReceived                ×1
Network.loadingFinished             ×1
Network.policyUpdated               ×1
```

Full CDP firehose. Coexists fine with normal agent-browser command flow:
agent-browser keeps owning RPC commands (snapshot / click / fill / wait),
we get a side-channel for events.

## Implications for pi-chrome

The Codex-style co-pilot is **buildable on this stack**, but the architecture
needs to split:

| Concern                        | Source                                  |
| ------------------------------ | --------------------------------------- |
| RPC commands (open/click/fill) | `agent-browser` CLI (what we already do) |
| Page/Network/DOM events stream | direct CDP WebSocket via `get cdp-url`  |
| Screencast preview             | `agent-browser stream` WS               |
| Buffered console/errors        | `agent-browser console` / `errors`      |
| Attach to user's Chrome        | `--cdp <port>` / `--auto-connect`       |

**RxJS earns its keep here**: the CDP event stream is exactly the
"merge multiple async sources, reactively compose, takeUntil(userTakesOver)"
pattern that Observables fit.

## Concrete next steps if we pivot

1. New `lib/cdp-events.ts` — wrap the raw CDP WebSocket as `Observable<CdpEvent>`.
   Accepts cdpUrl from `agent-browser get cdp-url`. Auto-attaches to first page
   target, enables a configurable set of domains.
2. New tools as thin primitives over the current tab (no `open` first):
   - `look()` → snapshot of currently active tab
   - `current_url()` / `current_title()`
   - `click(@ref)` / `fill(@ref, val)` / `nav(url)` operating on active tab
   - `watch_until(predicate)` → returns an Observable that emits when a
     CDP event matches (e.g. "navigation to /dashboard completed")
3. Repurpose `runtime/tab-state.ts`: keep it in sync from `Target.targetInfoChanged`
   CDP events instead of leaving it empty.
4. `runtime/event-bus.ts` becomes the merge point for CDP events, finally
   gaining real subscribers.
5. Existing `test_page` / `scrape` / `fill_form` stay as-is — they're useful
   for the headless/batch use case, just not the co-pilot one. README should
   distinguish the two modes.

## Files

- `/tmp/ab-stream-probe.mjs` — first WS probe, idle (1 msg)
- `/tmp/ab-stream-probe2.mjs` — WS probe with concurrent activity (still ~1 msg)
- `/tmp/ab-cdp-probe.mjs` — raw CDP probe (full event firehose)
- `/tmp/ab-core.md` — full `skills get core --full` dump (2425 lines)

All `/tmp` files are throwaway.
