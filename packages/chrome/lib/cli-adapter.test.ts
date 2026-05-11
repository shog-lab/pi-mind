import { firstValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentBrowser } from "./cli-adapter.js";

const script = (s: string): string[] => ["-e", s];

describe("runAgentBrowser", () => {
  beforeEach(() => {
    process.env.AGENT_BROWSER_BIN = "node";
  });
  afterEach(() => {
    delete process.env.AGENT_BROWSER_BIN;
  });

  it("captures stdout and exit code 0", async () => {
    const result = await firstValueFrom(
      runAgentBrowser(script("process.stdout.write('hello'); process.exit(0)")),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.signal).toBeNull();
  });

  it("captures stderr and non-zero exit", async () => {
    const result = await firstValueFrom(
      runAgentBrowser(script("process.stderr.write('boom'); process.exit(2)")),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("passes custom env to the child", async () => {
    const result = await firstValueFrom(
      runAgentBrowser(
        script("process.stdout.write(process.env.PI_TEST_VAR || '')"),
        { env: { PI_TEST_VAR: "abc" } },
      ),
    );
    expect(result.stdout).toBe("abc");
  });

  it("kills child on external AbortSignal", async () => {
    const ctrl = new AbortController();
    const promise = firstValueFrom(
      runAgentBrowser(script("setInterval(() => {}, 1000)"), { signal: ctrl.signal }),
    );
    setTimeout(() => ctrl.abort(), 50);
    const result = await promise;
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();
  });

  it("kills child immediately when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await firstValueFrom(
      runAgentBrowser(script("setInterval(() => {}, 1000)"), { signal: ctrl.signal }),
    );
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();
  });

  it("kills child after timeoutMs", async () => {
    const start = Date.now();
    const result = await firstValueFrom(
      runAgentBrowser(script("setInterval(() => {}, 1000)"), { timeoutMs: 100 }),
    );
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("emits error when binary cannot be spawned", async () => {
    process.env.AGENT_BROWSER_BIN = "/nonexistent/path/agent-browser-xyz";
    await expect(firstValueFrom(runAgentBrowser(["nav", "x"]))).rejects.toThrow();
  });

  it("does not deliver values after unsubscribe", async () => {
    const obs = runAgentBrowser(script("setInterval(() => {}, 1000)"));
    let nextCalls = 0;
    let completeCalls = 0;
    const sub = obs.subscribe({
      next: () => { nextCalls++; },
      complete: () => { completeCalls++; },
    });
    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();
    await new Promise((r) => setTimeout(r, 200));
    expect(nextCalls).toBe(0);
    expect(completeCalls).toBe(0);
  });
});
