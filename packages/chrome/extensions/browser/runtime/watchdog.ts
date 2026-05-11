/**
 * Process-wide watchdog registry.
 *
 * Most tasks use the per-stream `withWatchdog` operator from lib/operators.
 * This module is for cross-task watchdogs (e.g. "no browser activity for 5 minutes
 * → emit warning"). Currently exposes a simple keep-alive heartbeat.
 */

import { Subject, Subscription, Observable } from "rxjs";
import { emit } from "./event-bus.js";

const _heartbeat = new Subject<{ lastActivity: number }>();
let lastActivity = Date.now();

export function tickActivity(): void {
  lastActivity = Date.now();
  _heartbeat.next({ lastActivity });
}

export const heartbeat$: Observable<{ lastActivity: number }> = _heartbeat.asObservable();

export function getLastActivity(): number {
  return lastActivity;
}

let stallTimer: NodeJS.Timeout | undefined;
let heartbeatSub: Subscription | undefined;

/**
 * Emit a `stall` event if no activity for `idleMs`. Auto-resets on each tick.
 *
 * Calling this repeatedly is safe — any previous timer + heartbeat subscription
 * is torn down first, so callers can't accidentally leak subscriptions.
 */
export function startStallWatchdog(idleMs: number): void {
  stopStallWatchdog();
  const arm = () => {
    stallTimer = setTimeout(() => {
      emit({ type: "stall", data: { idleMs, lastActivity } });
    }, idleMs);
    // unref so this idle timer never keeps the pi process alive on its own.
    // Without this, `pi -p` (one-shot mode) hangs after producing output
    // because Node's event loop sees an active 5-min timer.
    stallTimer.unref();
  };
  arm();
  heartbeatSub = _heartbeat.subscribe(() => {
    if (stallTimer) clearTimeout(stallTimer);
    arm();
  });
}

export function stopStallWatchdog(): void {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = undefined;
  if (heartbeatSub) {
    heartbeatSub.unsubscribe();
    heartbeatSub = undefined;
  }
}
