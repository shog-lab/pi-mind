/**
 * Global cancellation signal for browser tasks.
 *
 * Tools subscribe via `takeUntilCancel(cancel$)` so any in-flight stream
 * terminates when `cancelAll()` is invoked. Typical triggers:
 *   - user Ctrl-C reaching the host pi process
 *   - higher-level orchestration aborting a task
 *   - extension shutdown sequence
 */

import { Observable, Subject } from "rxjs";
import { emit } from "./event-bus.js";

export interface CancelSignal {
  reason: string;
  source?: string;
}

const _cancel = new Subject<CancelSignal>();

export const cancel$: Observable<CancelSignal> = _cancel.asObservable();

export function cancelAll(reason: string = "user-cancel", source?: string): void {
  const sig: CancelSignal = { reason, source };
  emit({ type: "cancel", data: sig });
  _cancel.next(sig);
}

/** Returns an AbortController whose signal aborts on cancel$. */
export function abortControllerFromCancel(): AbortController {
  const controller = new AbortController();
  const sub = _cancel.subscribe((sig) => controller.abort(sig.reason));
  controller.signal.addEventListener("abort", () => sub.unsubscribe(), { once: true });
  return controller;
}
