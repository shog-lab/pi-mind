/**
 * Reusable RxJS operators for browser task composition.
 *
 * - retryWithBackoff: exponential retry with jitter
 * - withWatchdog: hard timeout that throws a labeled error
 * - takeUntilCancel: convenience to terminate on the runtime's global cancel signal
 */

import { MonoTypeOperatorFunction, Observable, race, retry, throwError, timer } from "rxjs";
import { map, switchMap, takeUntil } from "rxjs/operators";

export interface BackoffConfig {
  count?: number;
  initialDelayMs?: number;
  factor?: number;
  jitter?: boolean;
}

export function retryWithBackoff<T>(opts: BackoffConfig = {}): MonoTypeOperatorFunction<T> {
  const count = opts.count ?? 3;
  const initialDelayMs = opts.initialDelayMs ?? 500;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? true;
  return retry({
    count,
    delay: (_err, retryIndex) => {
      const base = initialDelayMs * Math.pow(factor, retryIndex - 1);
      const ms = jitter ? base + Math.random() * base * 0.3 : base;
      return timer(ms);
    },
  });
}

export class WatchdogError extends Error {
  constructor(public readonly durationMs: number, public readonly label?: string) {
    super(`watchdog timeout after ${durationMs}ms${label ? ` (${label})` : ""}`);
    this.name = "WatchdogError";
  }
}

export function withWatchdog<T>(durationMs: number, label?: string): MonoTypeOperatorFunction<T> {
  return (source$: Observable<T>) =>
    race(
      source$,
      timer(durationMs).pipe(switchMap(() => throwError(() => new WatchdogError(durationMs, label)))),
    );
}

/** Take values until the given cancel Subject emits. */
export function takeUntilCancel<T>(cancel$: Observable<unknown>): MonoTypeOperatorFunction<T> {
  return takeUntil(cancel$);
}

/** Tap-style passthrough that lets you observe results without altering the stream. */
export function tap<T>(fn: (v: T) => void): MonoTypeOperatorFunction<T> {
  return map((v) => {
    fn(v);
    return v;
  });
}
