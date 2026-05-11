import { Subject, defer, firstValueFrom, interval, lastValueFrom, of, throwError, timer, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import {
  retryWithBackoff,
  takeUntilCancel,
  tap,
  WatchdogError,
  withWatchdog,
} from "./operators.js";

describe("retryWithBackoff", () => {
  it("eventually succeeds when source recovers within retry count", async () => {
    let attempts = 0;
    const source$ = defer(() => {
      attempts++;
      return attempts < 3 ? throwError(() => new Error("transient")) : of("ok");
    });

    const result = await firstValueFrom(
      source$.pipe(retryWithBackoff({ count: 5, initialDelayMs: 1, jitter: false })),
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("surfaces the error after exhausting retries", async () => {
    let attempts = 0;
    const source$ = defer(() => {
      attempts++;
      return throwError(() => new Error("nope"));
    });

    await expect(
      firstValueFrom(
        source$.pipe(retryWithBackoff({ count: 2, initialDelayMs: 1, jitter: false })),
      ),
    ).rejects.toThrow("nope");
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("does not retry when count is 0", async () => {
    let attempts = 0;
    const source$ = defer(() => {
      attempts++;
      return throwError(() => new Error("nope"));
    });

    await expect(
      firstValueFrom(source$.pipe(retryWithBackoff({ count: 0 }))),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("waits between retries (delay actually applied)", async () => {
    let attempts = 0;
    const source$ = defer(() => {
      attempts++;
      return attempts < 2 ? throwError(() => new Error("x")) : of("done");
    });

    const start = Date.now();
    await firstValueFrom(
      source$.pipe(retryWithBackoff({ count: 1, initialDelayMs: 80, jitter: false })),
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(70);
  });
});

describe("withWatchdog", () => {
  it("passes values through when source completes in time", async () => {
    const result = await firstValueFrom(of(42).pipe(withWatchdog(1000)));
    expect(result).toBe(42);
  });

  it("throws WatchdogError when source is slower than the budget", async () => {
    const start = Date.now();
    await expect(
      firstValueFrom(timer(1000).pipe(withWatchdog(50, "test_op"))),
    ).rejects.toMatchObject({
      name: "WatchdogError",
      durationMs: 50,
      label: "test_op",
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("WatchdogError carries label in its message", () => {
    const e = new WatchdogError(123, "scrape");
    expect(e.message).toContain("123ms");
    expect(e.message).toContain("scrape");
  });
});

describe("takeUntilCancel", () => {
  it("terminates the stream when the cancel subject emits", async () => {
    const cancel$ = new Subject<unknown>();
    const collected: number[] = [];

    const done = lastValueFrom(
      interval(10).pipe(takeUntilCancel(cancel$), toArray()),
    );

    setTimeout(() => {
      collected.push(-1);
      cancel$.next("stop");
    }, 35);

    const values = await done;
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThan(10);
    expect(collected).toEqual([-1]);
  });
});

describe("tap", () => {
  it("invokes the side effect for each value without altering the stream", async () => {
    const fn = vi.fn();
    const values = await lastValueFrom(of(1, 2, 3).pipe(tap(fn), toArray()));

    expect(values).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, 1);
    expect(fn).toHaveBeenNthCalledWith(2, 2);
    expect(fn).toHaveBeenNthCalledWith(3, 3);
  });
});
