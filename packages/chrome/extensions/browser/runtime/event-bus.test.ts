import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { emit, events$, on, type BrowserEvent } from "./event-bus.js";

describe("event-bus", () => {
  it("emit attaches a timestamp", async () => {
    const before = Date.now();
    const seen = firstValueFrom(events$.pipe(take(1)));
    emit({ type: "test.timestamp" });
    const ev = await seen;
    expect(ev.type).toBe("test.timestamp");
    expect(ev.timestamp).toBeGreaterThanOrEqual(before);
    expect(ev.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("on(type) only emits matching events", async () => {
    const collected = firstValueFrom(on("test.match").pipe(take(2), toArray()));
    emit({ type: "test.other" });
    emit({ type: "test.match", data: 1 });
    emit({ type: "test.other" });
    emit({ type: "test.match", data: 2 });
    const events: BrowserEvent[] = await collected;
    expect(events.map((e) => e.data)).toEqual([1, 2]);
    expect(events.every((e) => e.type === "test.match")).toBe(true);
  });

  it("events$ surfaces all event types", async () => {
    const collected = firstValueFrom(events$.pipe(take(3), toArray()));
    emit({ type: "a" });
    emit({ type: "b" });
    emit({ type: "c" });
    const events: BrowserEvent[] = await collected;
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  it("fans out to multiple subscribers", async () => {
    const subA = firstValueFrom(events$.pipe(take(1)));
    const subB = firstValueFrom(events$.pipe(take(1)));
    emit({ type: "fanout", data: 42 });
    const [a, b] = await Promise.all([subA, subB]);
    expect(a.data).toBe(42);
    expect(b.data).toBe(42);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it("does not deliver events emitted before subscription (Subject semantics)", async () => {
    emit({ type: "before-sub" });
    const collected = firstValueFrom(events$.pipe(take(1)));
    emit({ type: "after-sub" });
    const ev = await collected;
    expect(ev.type).toBe("after-sub");
  });
});
