# Changelog

## 0.3.0

### Co-pilot mode

A second toolset and architecture aimed at the
[Codex Chrome extension](https://developers.openai.com/codex/app/chrome-extension)
pattern — agent attaches to the user's running Chrome, sees what the user
sees, reacts to live browser events.

### Added

- **`lib/cdp-events.ts`** — `connectCdp()` returns a `CdpClient` with an
  `Observable<CdpEvent>` over the raw Chrome DevTools Protocol WebSocket
  (discovered via `agent-browser get cdp-url`). Auto-attaches to the first
  page target, enables Page / Network / Runtime / DOM / Log domains.
- **`runtime/cdp-bridge.ts`** — forwards selected CDP events into the
  in-process bus with normalized types: `cdp.navigation`, `cdp.load`,
  `cdp.network.request`, `cdp.network.response`, `cdp.console`, `cdp.log`,
  `cdp.dialog`. Optional `forwardRaw` for the full firehose.
- **`runtime/tab-state.ts`** — was a placeholder; now populated live from
  `Target.targetCreated/Changed/Destroyed`. `initTabStateFromCdp(client)`
  is wired in the extension entry.
- **Co-pilot primitive tools** (`tools/primitives.ts`):
  `look`, `current_url`, `nav`, `click`, `fill`. Operate on the active tab,
  no `open <url>` first.
- **`watch_until` tool** (`tools/watch-until.ts`) — wait for a normalized
  CDP event matching predicates (urlContains/urlMatches/status/textContains)
  with a timeout. Replaces fixed-sleep patterns.
- **`co-pilot` skill** (`skills/co-pilot/SKILL.md`) — teaches the look →
  act → watch loop, attach modes (`--cdp <port>`, `--auto-connect`,
  `--profile`), event-type catalog.

### Architectural notes

- `agent-browser stream` was investigated and found to be screencast-only
  (image frames over WebSocket), not a CDP event channel. Raw CDP via
  `get cdp-url` is what we use.
- RxJS now earns its keep: CDP events fan out via the bus, `watch_until`
  composes filter + take + timeout + takeUntil(cancel$), tab-state is a
  BehaviorSubject driven by Target events.

### Known limitation

CDP attach is eager at extension load. If no `agent-browser` daemon is
running yet, the bus stays empty — `watch_until` will time out. Workaround:
`agent-browser open about:blank` before starting pi. Lazy reconnect is on
the v0.4 roadmap.

### Tests

- 83 unit tests across 14 files (added cdp-events integration, cdp-bridge,
  primitives, watch-until, tab-state-from-cdp).
- 8 integration tests skipped by default; opt-in via
  `RUN_INTEGRATION_TESTS=1`. Includes a real-CDP test that drives a live
  agent-browser daemon and asserts `Page.frameNavigated` /
  `Network.responseReceived` flow.

## 0.2.0

### Added

- **`scrape` tool** — open a URL, snapshot the a11y tree, extract structured
  fields by `{role, name?, nameMatches?}`. Returns `@eN` refs for follow-up
  actions. v2 supports:
  - `multi: true` per field → collect all matches as an array
  - `paginate: { next, maxPages?, waitMs? }` → follow a "next page" element,
    aggregate multi-fields across pages
- **`fill_form` tool** — open a URL, fill fields by `@eN` ref in insertion
  order, optionally click submit and wait for a confirmation selector. Stops
  on the first failing step; returns per-step status.
- Integration smoke test (`*.integration.test.ts`) that runs `test_page` and
  `scrape` against the real `agent-browser` CLI + `https://example.com`.
  Opt-in via `RUN_INTEGRATION_TESTS=1`.

### Fixed

- **`test_page` invoked an invalid CLI subcommand.** It used
  `agent-browser nav <url> --snapshot`, but `nav` is not a valid command and
  `--snapshot` is not a flag on `open`. Replaced with `open <url>` followed
  by a separate `snapshot` call. Outputs are concatenated for substring
  matching.
- **Watchdog leaked heartbeat subscriptions.** `startStallWatchdog` called
  `_heartbeat.subscribe(...)` without ever unsubscribing. Repeat calls
  accumulated subscriptions, and `stopStallWatchdog` only cleared the timer,
  so the next `tickActivity` would re-arm via leaked subs. Now `stop`
  unsubscribes, and `start` calls `stop` first to reset cleanly.

### Tests

- 59 unit tests across 9 files (cli-adapter, operators, runtime/event-bus,
  runtime/cancel, runtime/watchdog, runtime/tab-state, tools/test-page,
  tools/scrape, tools/fill-form).
- Tool tests use a shared mock binary (`__test-helpers__/mock-binary.ts`)
  that simulates `open`, `snapshot`, `snapshot --json`, `fill`, `click`,
  `type`, `wait`. Argv is logged per call so tests can assert ordering.
  Snapshot sequences (per-page fixtures) supported via `MOCK_SNAPSHOT_SEQ`.

### Skills

- `web-scrape` and `form-fill` SKILL.md files updated from
  phase-1-placeholder to real tool contracts with v1/v2 limitations
  documented.

## 0.1.0

- Initial release: `test_page` tool, RxJS runtime (event bus, cancel,
  watchdog, tab state), CLI adapter, postinstall symlinks into host repo's
  `.pi/` tree.
