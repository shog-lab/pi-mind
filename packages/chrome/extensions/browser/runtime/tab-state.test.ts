import { Subject, firstValueFrom, skip, take } from "rxjs";
import { afterEach, describe, expect, it } from "vitest";

import type { CdpClient, CdpEvent } from "../../../lib/cdp-events.js";
import {
  clearTabs,
  initTabStateFromCdp,
  snapshotTabs,
  tabs$,
  trackTab,
  untrackTab,
} from "./tab-state.js";

describe("tab-state", () => {
  afterEach(() => clearTabs());

  it("trackTab adds a tab; snapshotTabs returns its values", () => {
    trackTab({ id: "t1", url: "https://a.example", openedAt: 1 });
    trackTab({ id: "t2", url: "https://b.example", openedAt: 2 });
    const snap = snapshotTabs();
    expect(snap).toHaveLength(2);
    expect(snap.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("trackTab on an existing id updates the entry", () => {
    trackTab({ id: "t1", url: "https://old.example", openedAt: 1 });
    trackTab({ id: "t1", url: "https://new.example", title: "New", openedAt: 2 });
    const snap = snapshotTabs();
    expect(snap).toHaveLength(1);
    expect(snap[0].url).toBe("https://new.example");
    expect(snap[0].title).toBe("New");
  });

  it("untrackTab removes a tracked tab", () => {
    trackTab({ id: "t1", url: "https://a.example", openedAt: 1 });
    trackTab({ id: "t2", url: "https://b.example", openedAt: 2 });
    untrackTab("t1");
    const snap = snapshotTabs();
    expect(snap.map((t) => t.id)).toEqual(["t2"]);
  });

  it("untrackTab on a missing id is a no-op (no spurious emission)", async () => {
    let emissions = 0;
    const sub = tabs$.subscribe(() => { emissions++; });
    // BehaviorSubject delivers the current value immediately on subscribe.
    expect(emissions).toBe(1);
    untrackTab("does-not-exist");
    expect(emissions).toBe(1);
    sub.unsubscribe();
  });

  it("clearTabs empties the map", () => {
    trackTab({ id: "t1", url: "https://a.example", openedAt: 1 });
    trackTab({ id: "t2", url: "https://b.example", openedAt: 2 });
    clearTabs();
    expect(snapshotTabs()).toEqual([]);
  });

  it("tabs$ emits a new map on each mutation", async () => {
    // skip(1) drops the BehaviorSubject's initial replay.
    const seen = firstValueFrom(tabs$.pipe(skip(1), take(1)));
    trackTab({ id: "tx", url: "https://x.example", openedAt: 9 });
    const map = await seen;
    expect(map.get("tx")?.url).toBe("https://x.example");
  });

  describe("initTabStateFromCdp", () => {
    function makeFakeClient(initialTargets: Array<{ targetId: string; type: string; url: string; title?: string }> = []) {
      const events = new Subject<CdpEvent>();
      const sent: Array<{ method: string; params: unknown; sessionId?: string }> = [];
      const client: CdpClient = {
        events$: events.asObservable(),
        pageSessionId: "P",
        closed: false,
        close() { /* noop */ },
        async send(method, params, sessionId) {
          sent.push({ method, params, sessionId });
          if (method === "Target.getTargets") return { targetInfos: initialTargets };
          return {};
        },
      };
      return { client, events, sent };
    }

    it("seeds tab-state from Target.getTargets and tracks new pages", async () => {
      const { client, events, sent } = makeFakeClient([
        { targetId: "t-init", type: "page", url: "https://seeded.example", title: "Seeded" },
        { targetId: "t-bg", type: "service_worker", url: "https://ignored.example" },
      ]);
      const teardown = await initTabStateFromCdp(client);
      expect(sent.find((c) => c.method === "Target.setDiscoverTargets")).toBeTruthy();
      expect(snapshotTabs().map((t) => t.id)).toEqual(["t-init"]);

      events.next({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "t-new", type: "page", url: "https://new.example", title: "New" } },
      });
      expect(snapshotTabs().map((t) => t.id).sort()).toEqual(["t-init", "t-new"]);
      teardown();
    });

    it("updates an existing tab on targetInfoChanged", async () => {
      const { client, events } = makeFakeClient([
        { targetId: "t1", type: "page", url: "https://old.example", title: "Old" },
      ]);
      const teardown = await initTabStateFromCdp(client);
      events.next({
        method: "Target.targetInfoChanged",
        params: { targetInfo: { targetId: "t1", type: "page", url: "https://new.example", title: "New" } },
      });
      const t = snapshotTabs().find((t) => t.id === "t1")!;
      expect(t.url).toBe("https://new.example");
      expect(t.title).toBe("New");
      teardown();
    });

    it("removes a tab on targetDestroyed", async () => {
      const { client, events } = makeFakeClient([
        { targetId: "t1", type: "page", url: "https://a.example" },
        { targetId: "t2", type: "page", url: "https://b.example" },
      ]);
      const teardown = await initTabStateFromCdp(client);
      events.next({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
      expect(snapshotTabs().map((t) => t.id)).toEqual(["t2"]);
      teardown();
    });

    it("teardown stops further updates", async () => {
      const { client, events } = makeFakeClient();
      const teardown = await initTabStateFromCdp(client);
      teardown();
      events.next({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "ghost", type: "page", url: "https://x.example" } },
      });
      expect(snapshotTabs()).toEqual([]);
    });
  });
});
