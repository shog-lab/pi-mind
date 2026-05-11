import { firstValueFrom, take } from "rxjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events$ } from "./event-bus.js";
import {
  getLastActivity,
  heartbeat$,
  startStallWatchdog,
  stopStallWatchdog,
  tickActivity,
} from "./watchdog.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchdog", () => {
  beforeEach(() => {
    stopStallWatchdog();
  });
  afterEach(() => {
    stopStallWatchdog();
  });

  it("tickActivity updates getLastActivity", async () => {
    const before = getLastActivity();
    await sleep(5);
    tickActivity();
    expect(getLastActivity()).toBeGreaterThan(before);
  });

  it("tickActivity emits on heartbeat$", async () => {
    const seen = firstValueFrom(heartbeat$.pipe(take(1)));
    tickActivity();
    const beat = await seen;
    expect(beat.lastActivity).toBe(getLastActivity());
  });

  it("startStallWatchdog emits a stall event after idleMs", async () => {
    const stallSeen = firstValueFrom(
      events$.pipe(take(20)),
    );
    // Race a 100ms idle threshold; if it doesn't fire we'll fail via timeout.
    const stallPromise = new Promise<unknown>((resolve) => {
      const sub = events$.subscribe((e) => {
        if (e.type === "stall") {
          sub.unsubscribe();
          resolve(e.data);
        }
      });
    });
    startStallWatchdog(50);
    const data = await stallPromise;
    expect(data).toMatchObject({ idleMs: 50 });
    void stallSeen; // satisfy unused-binding lint
  });

  it("tickActivity resets the stall timer", async () => {
    let stalled = false;
    const sub = events$.subscribe((e) => {
      if (e.type === "stall") stalled = true;
    });

    startStallWatchdog(80);
    // Tick before threshold to keep it alive.
    await sleep(40);
    tickActivity();
    await sleep(40);
    tickActivity();
    await sleep(40);
    // ~120ms elapsed, but no 80ms gap → no stall yet.
    expect(stalled).toBe(false);

    // Now stop ticking; stall should fire ~80ms later.
    await sleep(120);
    expect(stalled).toBe(true);

    sub.unsubscribe();
  });

  it("stopStallWatchdog cancels the pending stall", async () => {
    let stalled = false;
    const sub = events$.subscribe((e) => {
      if (e.type === "stall") stalled = true;
    });

    startStallWatchdog(40);
    await sleep(10);
    stopStallWatchdog();
    await sleep(80);
    expect(stalled).toBe(false);

    sub.unsubscribe();
  });

  it("starting twice + stop tears down both subscriptions cleanly", async () => {
    let stalled = false;
    const sub = events$.subscribe((e) => {
      if (e.type === "stall") stalled = true;
    });

    startStallWatchdog(60);
    startStallWatchdog(60);
    stopStallWatchdog();

    // After stop, ticks must NOT re-arm the timer via leaked heartbeat subscriptions.
    tickActivity();
    await sleep(120);

    expect(stalled).toBe(false);
    sub.unsubscribe();
  });
});
