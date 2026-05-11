import { describe, expect, it } from "vitest";

import { emit } from "../runtime/event-bus.js";
import { registerWatchUntil } from "./watch-until.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: true;
  }>;
}

function makeTool(): CapturedTool {
  let captured: CapturedTool | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi: any = { registerTool: (o: CapturedTool) => { captured = o; } };
  registerWatchUntil(pi);
  if (!captured) throw new Error("registerWatchUntil did not register a tool");
  return captured;
}

function parseResult(res: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("watch_until", () => {
  it("matches the first event of the requested type", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.navigation",
      timeoutMs: 1000,
    });
    setTimeout(() => emit({ type: "cdp.navigation", data: { url: "https://x/dashboard" } }), 20);
    const res = await promise;

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.matched).toBe(true);
    expect(data.event).toBe("cdp.navigation");
    expect((data.data as { url: string }).url).toBe("https://x/dashboard");
  });

  it("filters by urlContains", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.navigation",
      urlContains: "/welcome",
      timeoutMs: 1000,
    });
    setTimeout(() => emit({ type: "cdp.navigation", data: { url: "https://x/login" } }), 10);
    setTimeout(() => emit({ type: "cdp.navigation", data: { url: "https://x/welcome" } }), 30);
    const res = await promise;

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect((data.data as { url: string }).url).toBe("https://x/welcome");
  });

  it("filters by urlMatches regex", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.network.response",
      urlMatches: "/api/users/\\d+$",
      timeoutMs: 1000,
    });
    setTimeout(() => emit({ type: "cdp.network.response", data: { url: "/api/users", status: 200 } }), 10);
    setTimeout(() => emit({ type: "cdp.network.response", data: { url: "/api/users/42", status: 200 } }), 30);
    const res = await promise;

    const data = parseResult(res);
    expect((data.data as { url: string }).url).toBe("/api/users/42");
  });

  it("filters by status code", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.network.response",
      status: 500,
      timeoutMs: 1000,
    });
    setTimeout(() => emit({ type: "cdp.network.response", data: { url: "/a", status: 200 } }), 10);
    setTimeout(() => emit({ type: "cdp.network.response", data: { url: "/b", status: 500 } }), 30);
    const res = await promise;

    const data = parseResult(res);
    expect((data.data as { status: number }).status).toBe(500);
  });

  it("filters by textContains for console events", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.console",
      textContains: "checkout",
      timeoutMs: 1000,
    });
    setTimeout(() => emit({ type: "cdp.console", data: { level: "log", text: "page ready" } }), 10);
    setTimeout(() => emit({ type: "cdp.console", data: { level: "log", text: "starting checkout flow" } }), 30);
    const res = await promise;

    const data = parseResult(res);
    expect((data.data as { text: string }).text).toContain("checkout");
  });

  it("fails with timeout error when no match arrives", async () => {
    const tool = makeTool();
    const res = await tool.execute("1", {
      event: "cdp.navigation",
      urlContains: "never",
      timeoutMs: 80,
    });
    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.matched).toBe(false);
    expect(data.error).toMatch(/no 'cdp\.navigation' matched within 80ms/);
  });

  it("ignores non-matching events of the same type", async () => {
    const tool = makeTool();
    const promise = tool.execute("1", {
      event: "cdp.navigation",
      urlContains: "/target",
      timeoutMs: 200,
    });
    for (let i = 0; i < 5; i++) {
      setTimeout(() => emit({ type: "cdp.navigation", data: { url: `/other/${i}` } }), 5 + i);
    }
    setTimeout(() => emit({ type: "cdp.navigation", data: { url: "/target" } }), 100);
    const res = await promise;

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect((data.data as { url: string }).url).toBe("/target");
  });
});
