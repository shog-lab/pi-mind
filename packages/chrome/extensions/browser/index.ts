/**
 * pi-chrome browser extension entry point.
 *
 * On load:
 *   - Initializes the in-process runtime (event bus, cancel, watchdog).
 *   - Registers all tools — both batch automation (test_page, scrape, fill_form)
 *     and co-pilot primitives (look, current_url, nav, click, fill, watch_until).
 *   - Best-effort attaches to a running agent-browser daemon via CDP. If it
 *     succeeds, the bus is bridged from CDP events and tab-state is kept live.
 *     If it fails (no daemon running yet), the batch + primitive tools still
 *     work — they spawn their own daemon on first CLI call. CDP-driven
 *     features (watch_until, cdp.* events, live tab-state) need a
 *     re-attach after the daemon comes up; for now, the simplest workaround
 *     is `agent-browser open about:blank` before starting pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { connectCdp } from "../../lib/cdp-events.js";
import { bridgeCdpToEventBus } from "./runtime/cdp-bridge.js";
import { emit } from "./runtime/event-bus.js";
import { initTabStateFromCdp } from "./runtime/tab-state.js";
import { startStallWatchdog } from "./runtime/watchdog.js";
import { registerFillForm } from "./tools/fill-form.js";
import { registerCoPilotPrimitives } from "./tools/primitives.js";
import { registerScrape } from "./tools/scrape.js";
import { registerTestPage } from "./tools/test-page.js";
import { registerWatchUntil } from "./tools/watch-until.js";

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 min idle → stall event
const CDP_HANDSHAKE_TIMEOUT_MS = 3000;

export default function browserExtension(pi: ExtensionAPI): void {
  emit({ type: "extension.loaded" });
  startStallWatchdog(STALL_THRESHOLD_MS);

  // Batch automation tools — URL-driven, retry-heavy
  registerTestPage(pi);
  registerScrape(pi);
  registerFillForm(pi);

  // Co-pilot primitives — operate on the active tab
  registerCoPilotPrimitives(pi);
  registerWatchUntil(pi);

  // CDP layer comes up async; failures are non-fatal.
  void connectCdpInBackground();
}

async function connectCdpInBackground(): Promise<void> {
  try {
    const client = await connectCdp({ handshakeTimeoutMs: CDP_HANDSHAKE_TIMEOUT_MS });
    bridgeCdpToEventBus(client);
    await initTabStateFromCdp(client);
    emit({ type: "cdp.connected", data: { pageSessionId: client.pageSessionId } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: "cdp.connect.failed", data: { message } });
  }
}
