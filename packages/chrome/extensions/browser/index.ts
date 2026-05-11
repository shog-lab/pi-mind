/**
 * pi-chrome browser extension entry point.
 *
 * On load:
 *   - Initializes the in-process runtime (event bus, cancel signal, idle stall watchdog).
 *     The watchdog timer is unref'd so it can't keep `pi -p` (one-shot mode) alive on its own.
 *   - Registers all tools — both batch automation (test_page, scrape, fill_form)
 *     and co-pilot primitives (look, current_url, nav, click, fill, watch_until).
 *
 * CDP attach is **lazy** (see runtime/cdp-lifecycle.ts):
 *   - Batch tools and primitives spawn their own short-lived agent-browser CLI
 *     per call — no persistent CDP needed.
 *   - watch_until is the only tool that consumes the event bus (which is
 *     populated by the CDP bridge). It calls `ensureCdpAttached()` at execute
 *     time, so the WebSocket only opens when actually needed.
 *   - This keeps `pi -p test_page ...` clean-exiting; only watch_until in
 *     one-shot mode would hold the loop (and that's a usage anti-pattern —
 *     watch_until is meant for interactive sessions).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { emit } from "./runtime/event-bus.js";
import { startStallWatchdog } from "./runtime/watchdog.js";
import { registerFillForm } from "./tools/fill-form.js";
import { registerCoPilotPrimitives } from "./tools/primitives.js";
import { registerScrape } from "./tools/scrape.js";
import { registerTestPage } from "./tools/test-page.js";
import { registerWatchUntil } from "./tools/watch-until.js";

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 min idle → stall event (timer is unref'd)

export default function browserExtension(pi: ExtensionAPI): void {
  emit({ type: "extension.loaded" });
  startStallWatchdog(STALL_THRESHOLD_MS);

  // Batch automation tools — URL-driven, retry-heavy
  registerTestPage(pi);
  registerScrape(pi);
  registerFillForm(pi);

  // Co-pilot primitives — operate on the active tab via CLI per-call
  registerCoPilotPrimitives(pi);

  // watch_until consumes the CDP event bus — registers ensureCdpAttached at execute time
  registerWatchUntil(pi);
}
