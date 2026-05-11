/**
 * Lazy CDP attach for the in-process runtime.
 *
 * Most tools (test_page, scrape, fill_form, nav/click/fill/look/current_url)
 * spawn a one-shot agent-browser CLI per call — they don't need a persistent
 * CDP connection. Only watch_until consumes the event bus (which is fed by
 * the CDP bridge), so only it needs to ensure CDP is attached.
 *
 * Eager attach at extension load time would hold the Node event loop alive
 * via the WebSocket, breaking `pi -p` (one-shot mode). Lazy attach means
 * users who never call watch_until pay no cost.
 *
 * `ensureCdpAttached()` is idempotent and safe to call from multiple tools —
 * the first call kicks off the connection; subsequent calls await the
 * in-flight or already-resolved promise.
 *
 * Failure (e.g. agent-browser daemon not running) is non-fatal — the promise
 * rejects, watch_until surfaces an error to the agent, and the next call
 * retries.
 */

import { connectCdp, type CdpClient } from "../../../lib/cdp-events.js";
import { bridgeCdpToEventBus } from "./cdp-bridge.js";
import { emit } from "./event-bus.js";
import { initTabStateFromCdp } from "./tab-state.js";

const CDP_HANDSHAKE_TIMEOUT_MS = 3000;

let attachPromise: Promise<CdpClient> | null = null;
let attachedClient: CdpClient | null = null;
let bridgeTeardown: (() => void) | null = null;
let tabStateTeardown: (() => void) | null = null;

/**
 * Attach to a CDP client, set up event-bus bridge and tab-state sync.
 * Idempotent — first call starts the work; subsequent calls await the same promise.
 *
 * Resolves to the connected CdpClient or rejects if the daemon isn't reachable.
 */
export async function ensureCdpAttached(): Promise<CdpClient> {
  if (attachedClient) return attachedClient;
  if (attachPromise) return attachPromise;

  attachPromise = (async () => {
    try {
      const client = await connectCdp({ handshakeTimeoutMs: CDP_HANDSHAKE_TIMEOUT_MS });
      bridgeTeardown = bridgeCdpToEventBus(client);
      tabStateTeardown = await initTabStateFromCdp(client);
      attachedClient = client;
      emit({ type: "cdp.attached", data: { pageSessionId: client.pageSessionId } });
      return client;
    } catch (e) {
      attachPromise = null; // allow retry on next call
      const message = e instanceof Error ? e.message : String(e);
      emit({ type: "cdp.attach.failed", data: { message } });
      throw e;
    }
  })();

  return attachPromise;
}

/**
 * Tear down any active CDP attach. Used by tests and graceful shutdown paths.
 * Safe to call when nothing is attached.
 */
export function detachCdp(): void {
  if (bridgeTeardown) { bridgeTeardown(); bridgeTeardown = null; }
  if (tabStateTeardown) { tabStateTeardown(); tabStateTeardown = null; }
  if (attachedClient) {
    try { attachedClient.close(); } catch { /* ignore */ }
    attachedClient = null;
  }
  attachPromise = null;
}

/** Inspection helper for tests / diagnostics. */
export function isCdpAttached(): boolean {
  return attachedClient !== null;
}
