import { Subject, firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import type { CdpClient, CdpEvent } from "../../../lib/cdp-events.js";
import { bridgeCdpToEventBus } from "./cdp-bridge.js";
import { events$, on, type BrowserEvent } from "./event-bus.js";

function makeFakeClient() {
  const events = new Subject<CdpEvent>();
  const client: CdpClient = {
    events$: events.asObservable(),
    pageSessionId: "P",
    closed: false,
    close() {},
    async send() { return {}; },
  };
  return { client, events };
}

describe("bridgeCdpToEventBus", () => {
  it("translates Page.frameNavigated to cdp.navigation", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client);
    const seen = firstValueFrom(on("cdp.navigation").pipe(take(1)));
    events.next({
      method: "Page.frameNavigated",
      params: { frame: { id: "F1", url: "https://x.example/" } },
    });
    const ev: BrowserEvent = await seen;
    expect(ev.data).toEqual({ url: "https://x.example/", frameId: "F1" });
    teardown();
  });

  it("translates Network.responseReceived to cdp.network.response", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client);
    const seen = firstValueFrom(on("cdp.network.response").pipe(take(1)));
    events.next({
      method: "Network.responseReceived",
      params: {
        requestId: "R1",
        response: { url: "https://api.example/x", status: 200 },
      },
    });
    const ev: BrowserEvent = await seen;
    expect(ev.data).toEqual({ requestId: "R1", url: "https://api.example/x", status: 200 });
    teardown();
  });

  it("flattens console args into a single text", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client);
    const seen = firstValueFrom(on("cdp.console").pipe(take(1)));
    events.next({
      method: "Runtime.consoleAPICalled",
      params: { type: "warn", args: [{ value: "hello" }, { value: 42 }, { value: { a: 1 } }] },
    });
    const ev: BrowserEvent = await seen;
    expect(ev.data).toEqual({ level: "warn", text: 'hello 42 {"a":1}' });
    teardown();
  });

  it("forwardRaw also emits cdp.raw for unmapped events", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client, { forwardRaw: true });
    const seen = firstValueFrom(on("cdp.raw").pipe(take(1)));
    events.next({ method: "DOM.documentUpdated", params: {} });
    const ev: BrowserEvent = await seen;
    expect(ev.data).toEqual({ method: "DOM.documentUpdated", params: {} });
    teardown();
  });

  it("teardown stops bridging further events", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client);
    teardown();

    let received = 0;
    const sub = events$.subscribe((e) => {
      if (e.type.startsWith("cdp.")) received++;
    });
    events.next({ method: "Page.loadEventFired", params: {} });
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();

    expect(received).toBe(0);
  });

  it("custom mappings extend the default set", async () => {
    const { client, events } = makeFakeClient();
    const teardown = bridgeCdpToEventBus(client, {
      mappings: {
        "DOM.documentUpdated": {
          busType: "cdp.dom.updated",
          extract: () => ({}),
        },
      },
    });
    const collected = firstValueFrom(on("cdp.dom.updated").pipe(take(1), toArray()));
    events.next({ method: "DOM.documentUpdated", params: {} });
    const evs = await collected;
    expect(evs).toHaveLength(1);
    teardown();
  });
});
