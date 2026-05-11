/**
 * Central event bus for the pi-chrome runtime.
 *
 * All runtime modules and tools emit/subscribe through this Subject.
 * Lifetime is tied to the pi process — Subjects are created on extension load
 * and garbage-collected on process exit.
 */

import { Observable, Subject } from "rxjs";
import { filter } from "rxjs/operators";

export interface BrowserEvent {
  type: string;
  data?: unknown;
  timestamp: number;
}

const _bus = new Subject<BrowserEvent>();

export function emit(event: Omit<BrowserEvent, "timestamp">): void {
  _bus.next({ ...event, timestamp: Date.now() });
}

export function on(type: string): Observable<BrowserEvent> {
  return _bus.asObservable().pipe(filter((e) => e.type === type));
}

export const events$: Observable<BrowserEvent> = _bus.asObservable();
