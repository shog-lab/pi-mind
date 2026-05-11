/**
 * watch_until — wait for a CDP-derived event matching a predicate.
 *
 * Pulls from the in-process event bus (populated by `runtime/cdp-bridge.ts`).
 * Returns the first matching event, or fails on timeout / cancel.
 *
 * Use this for "do X, then wait for Y" patterns instead of fixed sleeps:
 *
 *   click(@e9)                                # submit
 *   watch_until("cdp.navigation", {           # wait for the redirect
 *     urlContains: "/welcome", timeoutMs: 10000
 *   })
 *
 * Supported event types (from cdp-bridge defaults):
 *   cdp.navigation        — page nav completed; data: {url, frameId}
 *   cdp.load              — load event fired; data: {}
 *   cdp.network.request   — request started; data: {url, method, requestId}
 *   cdp.network.response  — response received; data: {url, status, requestId}
 *   cdp.console           — console.* call; data: {level, text}
 *   cdp.log               — Log.entryAdded; data: {level, text, source}
 *   cdp.dialog            — alert/confirm/prompt opening; data: {type, message}
 *   cdp.raw               — any CDP event when bridge has forwardRaw (data: {method, params})
 */

import { Type, type Static } from "@sinclair/typebox";
import { firstValueFrom, throwError, timeout } from "rxjs";
import { catchError, filter, map, take, takeUntil } from "rxjs/operators";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cancel$ } from "../runtime/cancel.js";
import { ensureCdpAttached } from "../runtime/cdp-lifecycle.js";
import { emit, on, type BrowserEvent } from "../runtime/event-bus.js";

const WatchUntilParams = Type.Object({
  event: Type.String({
    description:
      "Bus event type to watch, e.g. 'cdp.navigation', 'cdp.network.response', 'cdp.console'.",
  }),
  urlContains: Type.Optional(Type.String({
    description: "Substring match on data.url. AND-combined with other predicates.",
  })),
  urlMatches: Type.Optional(Type.String({
    description: "Regex match on data.url (no flags).",
  })),
  status: Type.Optional(Type.Number({
    description: "For network.response: required HTTP status.",
  })),
  textContains: Type.Optional(Type.String({
    description: "For console/log/dialog events: substring match on data.text or data.message.",
  })),
  timeoutMs: Type.Optional(Type.Number({
    description: "Max time to wait for a match. Default 30000.",
  })),
});

interface EventData {
  url?: string;
  status?: number;
  text?: string;
  message?: string;
}

function matches(p: Static<typeof WatchUntilParams>, data: unknown): boolean {
  const d = (data ?? {}) as EventData;
  if (p.urlContains !== undefined && !(d.url ?? "").includes(p.urlContains)) return false;
  if (p.urlMatches !== undefined) {
    let re: RegExp;
    try { re = new RegExp(p.urlMatches); } catch { return false; }
    if (!re.test(d.url ?? "")) return false;
  }
  if (p.status !== undefined && d.status !== p.status) return false;
  if (p.textContains !== undefined) {
    const haystack = d.text ?? d.message ?? "";
    if (!haystack.includes(p.textContains)) return false;
  }
  return true;
}

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: {} };
}
function fail(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
    isError: true as const,
  };
}

export function registerWatchUntil(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "watch_until",
    label: "Watch Until",
    description:
      "Wait for the next bus event of a given type matching optional predicates " +
      "(urlContains/urlMatches/status/textContains). Returns the matched event or fails on " +
      "timeout. Use after an action to wait for its observable consequence (navigation, " +
      "API response, console message) instead of sleeping a fixed duration.",
    parameters: WatchUntilParams,
    async execute(_id: string, params: Static<typeof WatchUntilParams>) {
      const totalTimeout = params.timeoutMs ?? 30000;
      emit({ type: "watch_until.start", data: params });

      // Lazy CDP attach — fire-and-forget so the bus subscription below is
      // wired up immediately. Don't await: ensureCdpAttached() takes up to
      // 3s to fail if no daemon, and we don't want to miss events emitted
      // during that window (especially in tests that emit() directly).
      //
      // - Daemon running: attach succeeds, bridge feeds events into bus
      // - No daemon: attach fails silently, watch_until eventually times out
      //   (or matches events emitted by other code paths, e.g. tests)
      ensureCdpAttached().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "watch_until.cdp_unavailable", data: { message: msg } });
      });

      const flow$ = on(params.event).pipe(
        filter((e: BrowserEvent) => matches(params, e.data)),
        take(1),
        timeout({
          each: totalTimeout,
          with: () => throwError(() => new Error(
            `watch_until: no '${params.event}' matched within ${totalTimeout}ms`,
          )),
        }),
        takeUntil(cancel$),
        map((e) => ({
          event: e.type,
          data: e.data,
          timestamp: e.timestamp,
        })),
        catchError((err) => {
          emit({ type: "watch_until.error", data: { params, message: err.message } });
          throw err;
        }),
      );

      try {
        const result = await firstValueFrom(flow$);
        emit({ type: "watch_until.result", data: result });
        return ok({ matched: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail({ matched: false, error: msg });
      }
    },
  });
}
