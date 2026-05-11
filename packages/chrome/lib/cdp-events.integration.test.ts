/**
 * Integration test for connectCdp().
 *
 * Skipped by default. Enable with:
 *
 *   RUN_INTEGRATION_TESTS=1 npm test
 *
 * Drives a real `agent-browser` daemon, opens https://example.com, then
 * subscribes to the CDP stream and asserts we receive the expected page
 * lifecycle and network events.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { firstValueFrom, timeout, toArray } from "rxjs";
import { filter, take } from "rxjs/operators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectCdp, type CdpClient, type CdpEvent } from "./cdp-events.js";

const BIN = resolve("node_modules/.bin/agent-browser");
const ENABLED = process.env.RUN_INTEGRATION_TESTS === "1" && existsSync(BIN);
const integrationDescribe = ENABLED ? describe : describe.skip;

integrationDescribe("integration: connectCdp against a real agent-browser daemon", () => {
  let client: CdpClient;

  beforeAll(async () => {
    process.env.AGENT_BROWSER_BIN = BIN;
    // Make sure there's a Chrome up so a page target exists.
    execFileSync(BIN, ["open", "about:blank"], { timeout: 30000, stdio: "ignore" });
    client = await connectCdp({ handshakeTimeoutMs: 10000 });
  }, 60000);

  afterAll(() => {
    client?.close();
    try {
      execFileSync(BIN, ["close", "--all"], { timeout: 10000, stdio: "ignore" });
    } catch { /* best effort */ }
    delete process.env.AGENT_BROWSER_BIN;
  });

  it("attaches to a page target and exposes a session id", () => {
    expect(client.pageSessionId).toMatch(/^[A-F0-9]+$/i);
    expect(client.closed).toBe(false);
  });

  it("emits Page.frameNavigated when navigating", async () => {
    const navigated = firstValueFrom(
      client.events$.pipe(
        filter((e: CdpEvent) => e.method === "Page.frameNavigated"),
        take(1),
        timeout(15000),
      ),
    );
    await client.send("Page.navigate", { url: "https://example.com/" }, client.pageSessionId);
    const ev = await navigated;
    expect(ev.method).toBe("Page.frameNavigated");
    const frame = (ev.params as { frame?: { url?: string } }).frame;
    expect(frame?.url).toBe("https://example.com/");
  }, 30000);

  it("emits a Network.responseReceived for the navigation", async () => {
    const response = firstValueFrom(
      client.events$.pipe(
        filter((e: CdpEvent) => e.method === "Network.responseReceived"),
        take(1),
        timeout(15000),
      ),
    );
    // Bounce away first, then back, so we observe a fresh response on example.com.
    await client.send("Page.navigate", { url: "about:blank" }, client.pageSessionId);
    await new Promise((r) => setTimeout(r, 200));
    await client.send("Page.navigate", { url: "https://example.com/" }, client.pageSessionId);
    const ev = await response;
    const r = (ev.params as { response?: { status?: number; url?: string } }).response;
    expect(typeof r?.status).toBe("number");
    expect(r?.url).toMatch(/example\.com/);
  }, 30000);

  it("close() completes events$ and rejects further send()s", async () => {
    const localClient = await connectCdp({ handshakeTimeoutMs: 10000 });
    const closed = firstValueFrom(
      localClient.events$.pipe(toArray(), timeout(5000)),
    );
    localClient.close();
    await expect(closed).resolves.toBeInstanceOf(Array);
    expect(localClient.closed).toBe(true);
    await expect(localClient.send("Page.reload", {}, localClient.pageSessionId))
      .rejects.toThrow(/closed/);
  }, 30000);
});

if (!ENABLED) {
  describe.skip("cdp-events integration skipped", () => {
    it("set RUN_INTEGRATION_TESTS=1 to enable", () => {});
  });
}
