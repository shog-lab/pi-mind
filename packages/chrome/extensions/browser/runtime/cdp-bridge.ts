/**
 * Bridge a CdpClient's events$ into the in-process event bus.
 *
 * Tools/skills subscribe via the existing `on(type)` / `events$` API. CDP
 * methods are translated into normalized bus event types so callers don't
 * need to know the wire format.
 *
 * Mappings (default):
 *   Page.frameNavigated         → cdp.navigation        { url, frameId }
 *   Page.loadEventFired         → cdp.load              {}
 *   Network.requestWillBeSent   → cdp.network.request   { url, method, requestId }
 *   Network.responseReceived    → cdp.network.response  { url, status, requestId }
 *   Runtime.consoleAPICalled    → cdp.console           { level, text }
 *   Log.entryAdded              → cdp.log               { level, text, source }
 *   Page.javascriptDialogOpening → cdp.dialog           { type, message }
 *
 * Returns a teardown function that unsubscribes from the CDP stream.
 */

import { Subscription } from "rxjs";

import type { CdpClient, CdpEvent } from "../../../lib/cdp-events.js";
import { emit } from "./event-bus.js";

interface Mapping {
  busType: string;
  extract: (params: unknown) => Record<string, unknown> | null;
}

const DEFAULT_MAPPINGS: Record<string, Mapping> = {
  "Page.frameNavigated": {
    busType: "cdp.navigation",
    extract: (p) => {
      const frame = (p as { frame?: { url?: string; id?: string } }).frame;
      if (!frame) return null;
      return { url: frame.url, frameId: frame.id };
    },
  },
  "Page.loadEventFired": {
    busType: "cdp.load",
    extract: () => ({}),
  },
  "Network.requestWillBeSent": {
    busType: "cdp.network.request",
    extract: (p) => {
      const x = p as { requestId?: string; request?: { url?: string; method?: string } };
      return { requestId: x.requestId, url: x.request?.url, method: x.request?.method };
    },
  },
  "Network.responseReceived": {
    busType: "cdp.network.response",
    extract: (p) => {
      const x = p as { requestId?: string; response?: { url?: string; status?: number } };
      return { requestId: x.requestId, url: x.response?.url, status: x.response?.status };
    },
  },
  "Runtime.consoleAPICalled": {
    busType: "cdp.console",
    extract: (p) => {
      const x = p as { type?: string; args?: Array<{ value?: unknown }> };
      const text = (x.args ?? []).map((a) => stringifyConsoleArg(a.value)).join(" ");
      return { level: x.type, text };
    },
  },
  "Log.entryAdded": {
    busType: "cdp.log",
    extract: (p) => {
      const x = p as { entry?: { level?: string; text?: string; source?: string } };
      const e = x.entry;
      if (!e) return null;
      return { level: e.level, text: e.text, source: e.source };
    },
  },
  "Page.javascriptDialogOpening": {
    busType: "cdp.dialog",
    extract: (p) => {
      const x = p as { type?: string; message?: string };
      return { type: x.type, message: x.message };
    },
  },
};

export interface BridgeOptions {
  /** Override or extend the default method → bus-event mappings. */
  mappings?: Record<string, Mapping>;
  /**
   * If true, all CDP events are also forwarded as `cdp.raw` with `{method, params}`.
   * Off by default — chatty.
   */
  forwardRaw?: boolean;
}

export function bridgeCdpToEventBus(client: CdpClient, opts: BridgeOptions = {}): () => void {
  const mappings = { ...DEFAULT_MAPPINGS, ...(opts.mappings ?? {}) };
  const sub = new Subscription();
  sub.add(
    client.events$.subscribe((e: CdpEvent) => {
      const m = mappings[e.method];
      if (m) {
        const data = m.extract(e.params);
        if (data) emit({ type: m.busType, data });
      }
      if (opts.forwardRaw) {
        emit({ type: "cdp.raw", data: { method: e.method, params: e.params } });
      }
    }),
  );
  return () => sub.unsubscribe();
}

function stringifyConsoleArg(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
