/**
 * In-process tracking of currently-open tabs.
 *
 * Two ways to populate it:
 *   1. Manual: trackTab / untrackTab / clearTabs (used by tests, ad-hoc tools).
 *   2. Live from CDP: initTabStateFromCdp(client) subscribes to
 *      Target.targetCreated / targetInfoChanged / targetDestroyed and keeps
 *      the BehaviorSubject in sync with the real browser state.
 *
 * Discarded on pi process exit.
 */

import { BehaviorSubject, Observable, Subscription } from "rxjs";
import { filter } from "rxjs/operators";

import type { CdpClient, CdpEvent } from "../../../lib/cdp-events.js";

export interface TabInfo {
  id: string;
  url: string;
  title?: string;
  openedAt: number;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

const _tabs = new BehaviorSubject<Map<string, TabInfo>>(new Map());

export const tabs$: Observable<Map<string, TabInfo>> = _tabs.asObservable();

export function trackTab(tab: TabInfo): void {
  const next = new Map(_tabs.value);
  next.set(tab.id, tab);
  _tabs.next(next);
}

export function untrackTab(id: string): void {
  const next = new Map(_tabs.value);
  if (next.delete(id)) _tabs.next(next);
}

export function snapshotTabs(): TabInfo[] {
  return [..._tabs.value.values()];
}

export function clearTabs(): void {
  _tabs.next(new Map());
}

/**
 * Subscribe to a CDP client's Target.* events and keep tab-state in sync with
 * the live browser. Returns a teardown function. Only `type === "page"`
 * targets are tracked.
 */
export async function initTabStateFromCdp(client: CdpClient): Promise<() => void> {
  // Browser-level Target domain doesn't need a sessionId.
  await client.send("Target.setDiscoverTargets", { discover: true });

  const initial = await client.send("Target.getTargets") as { targetInfos: TargetInfo[] };
  for (const t of initial.targetInfos) {
    if (t.type === "page") trackTabFromTarget(t);
  }

  const sub = new Subscription();
  sub.add(
    (client.events$ as Observable<CdpEvent>)
      .pipe(filter((e) => e.method === "Target.targetCreated"))
      .subscribe((e) => {
        const ti = (e.params as { targetInfo?: TargetInfo }).targetInfo;
        if (ti?.type === "page") trackTabFromTarget(ti);
      }),
  );
  sub.add(
    client.events$
      .pipe(filter((e) => e.method === "Target.targetInfoChanged"))
      .subscribe((e) => {
        const ti = (e.params as { targetInfo?: TargetInfo }).targetInfo;
        if (ti?.type === "page") trackTabFromTarget(ti);
        else if (ti) untrackTab(ti.targetId); // type changed away from "page"
      }),
  );
  sub.add(
    client.events$
      .pipe(filter((e) => e.method === "Target.targetDestroyed"))
      .subscribe((e) => {
        const id = (e.params as { targetId?: string }).targetId;
        if (id) untrackTab(id);
      }),
  );

  return () => sub.unsubscribe();
}

function trackTabFromTarget(t: TargetInfo): void {
  const existing = _tabs.value.get(t.targetId);
  trackTab({
    id: t.targetId,
    url: t.url,
    title: t.title,
    openedAt: existing?.openedAt ?? Date.now(),
  });
}
