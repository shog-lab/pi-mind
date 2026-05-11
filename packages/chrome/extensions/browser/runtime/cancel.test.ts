import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { abortControllerFromCancel, cancel$, cancelAll } from "./cancel.js";
import { events$ } from "./event-bus.js";
import type { BrowserEvent } from "./event-bus.js";

describe("cancel", () => {
  it("cancelAll emits a CancelSignal on cancel$", async () => {
    const seen = firstValueFrom(cancel$);
    cancelAll("user-cancel", "test");
    const sig = await seen;
    expect(sig.reason).toBe("user-cancel");
    expect(sig.source).toBe("test");
  });

  it("cancelAll also emits a 'cancel' event on the bus", async () => {
    const seen = firstValueFrom(events$.pipe(take(1)));
    cancelAll("bus-check", "evt-test");
    const ev: BrowserEvent = await seen;
    expect(ev.type).toBe("cancel");
    expect(ev.data).toMatchObject({ reason: "bus-check", source: "evt-test" });
  });

  it("default reason is 'user-cancel'", async () => {
    const seen = firstValueFrom(cancel$);
    cancelAll();
    const sig = await seen;
    expect(sig.reason).toBe("user-cancel");
    expect(sig.source).toBeUndefined();
  });

  it("multiple subscribers each receive the cancel signal", async () => {
    const a = firstValueFrom(cancel$);
    const b = firstValueFrom(cancel$);
    cancelAll("fanout");
    const [sa, sb] = await Promise.all([a, b]);
    expect(sa.reason).toBe("fanout");
    expect(sb.reason).toBe("fanout");
  });

  it("abortControllerFromCancel triggers AbortSignal on next cancel", async () => {
    const ctrl = abortControllerFromCancel();
    expect(ctrl.signal.aborted).toBe(false);

    const aborted = new Promise<string | undefined>((resolve) => {
      ctrl.signal.addEventListener("abort", () => {
        const reason = ctrl.signal.reason;
        resolve(typeof reason === "string" ? reason : reason?.toString());
      }, { once: true });
    });

    cancelAll("abort-me");
    const reason = await aborted;
    expect(reason).toBe("abort-me");
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("cancel$ delivers each cancelAll invocation in order", async () => {
    const collected = firstValueFrom(cancel$.pipe(take(3), toArray()));
    cancelAll("one");
    cancelAll("two");
    cancelAll("three");
    const sigs = await collected;
    expect(sigs.map((s) => s.reason)).toEqual(["one", "two", "three"]);
  });
});
