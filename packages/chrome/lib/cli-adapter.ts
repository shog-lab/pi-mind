/**
 * Wraps `agent-browser` CLI invocations as RxJS Observables.
 *
 * - One spawn per Observable subscription.
 * - Unsubscribe → SIGTERM the child process.
 * - Timeout option fires SIGTERM after deadline.
 * - External AbortSignal supported for higher-level cancellation.
 *
 * The CLI binary is resolved from PATH by default; override with AGENT_BROWSER_BIN.
 */

import { Observable } from "rxjs";
import { spawn } from "node:child_process";

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CliOptions {
  cwd?: string;
  /** Hard kill timeout in milliseconds. */
  timeoutMs?: number;
  /** External abort signal — when triggered, child gets SIGTERM. */
  signal?: AbortSignal;
  /** Extra environment variables for the child. */
  env?: Record<string, string>;
}

const BIN = () => process.env.AGENT_BROWSER_BIN || "agent-browser";

export function runAgentBrowser(args: string[], opts: CliOptions = {}): Observable<CliResult> {
  return new Observable<CliResult>((subscriber) => {
    const proc = spawn(BIN(), args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGTERM");
      }, opts.timeoutMs);
    }

    const onAbort = () => {
      if (!proc.killed) proc.kill("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      subscriber.next({ stdout, stderr, code, signal });
      subscriber.complete();
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      subscriber.error(err);
    });

    return () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      if (!proc.killed) proc.kill("SIGTERM");
    };
  });
}
