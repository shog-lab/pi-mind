/**
 * Shared pi spawn helper.
 *
 * Spawns pi-coding-agent as a child process and exposes its lifecycle as a
 * Promise. Always invokes pi with `--mode json` (unless caller already
 * specified --mode), parses the JSON event stream, and:
 *
 *   - Calls onStdout with assistant text only (text_delta events) — callers
 *     receive plain text, not raw JSON.
 *   - Extracts the final agent_end event's usage and returns it as
 *     SpawnPiResult.tokens.
 *
 * For stdoutFile (fire-and-forget) callers, the raw JSON event stream is
 * written to the file; tokens are extracted by reading the file after the
 * child exits.
 *
 * Pi binary resolution:
 * - Defaults to "pi" (resolved via PATH)
 * - Override with PI_BIN env var if pi lives elsewhere
 */

import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync } from "node:fs";

export interface SpawnPiOptions {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  /** Redirect stdout/stderr to a file (fire-and-forget, ack via external mechanism) */
  stdoutFile?: string;
  /** Stream extracted assistant text via callback (text_delta events from pi's JSON stream) */
  onStdout?: (data: string) => void;
  /** Stream stderr via callback */
  onStderr?: (data: string) => void;
  /** Timeout in ms (default: no timeout) */
  timeoutMs?: number;
}

export interface PiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export interface SpawnPiResult {
  pid: number;
  /** null if killed/timeout */
  code: number | null;
  killed: boolean;
  /**
   * Token usage from the final agent_end event. Undefined if pi didn't
   * complete normally (crash / kill / no agent_end event emitted).
   */
  tokens?: PiTokens;
}

/** Ensure pi runs with --mode json so we can parse usage. Preserves caller-specified --mode. */
function withJsonMode(args: string[]): string[] {
  const hasMode = args.includes("--mode") || args.some((a) => a.startsWith("--mode="));
  return hasMode ? args : ["--mode", "json", ...args];
}

/**
 * Extract token usage from pi's JSON event stream content (either streamed
 * chunks joined, or contents of a stdoutFile). Returns null if no agent_end
 * event with assistant usage was found.
 */
export function extractTokensFromStream(content: string): PiTokens | null {
  let lastAssistantUsage: Record<string, unknown> | null = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== "agent_end") continue;
    const messages = evt.messages;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      const m = msg as { role?: string; usage?: Record<string, unknown> };
      if (m.role === "assistant" && m.usage) {
        lastAssistantUsage = m.usage;
      }
    }
  }
  if (!lastAssistantUsage) return null;
  const cost = (lastAssistantUsage.cost ?? {}) as Record<string, number>;
  return {
    input: (lastAssistantUsage.input as number) ?? 0,
    output: (lastAssistantUsage.output as number) ?? 0,
    cacheRead: (lastAssistantUsage.cacheRead as number) ?? 0,
    cacheWrite: (lastAssistantUsage.cacheWrite as number) ?? 0,
    totalTokens: (lastAssistantUsage.totalTokens as number) ?? 0,
    costUsd: cost.total ?? 0,
  };
}

/**
 * Parse a single line of pi's JSON event stream and forward any assistant
 * text content to the onStdout callback.
 */
function processEventLine(line: string, onStdout: ((s: string) => void) | undefined): void {
  if (!onStdout || !line.trim()) return;
  let evt: Record<string, unknown>;
  try { evt = JSON.parse(line); } catch { return; }
  // Stream text_delta events (incremental assistant text)
  if (evt.type === "message_update") {
    const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      onStdout(ame.delta);
    }
  }
}

/**
 * Spawn a pi process with JSON-mode token tracking.
 *
 * Usage (fire-and-forget):
 *   spawnPi({ cwd, args, stdoutFile: "/path/to/log", timeoutMs: 60000 });
 *
 * Usage (streaming, parent waits):
 *   const result = await spawnPi({ cwd, args, onStdout: (text) => chunks.push(text) });
 *   console.log(result.tokens?.totalTokens, result.tokens?.costUsd);
 */
export function spawnPi(opts: SpawnPiOptions): Promise<SpawnPiResult> {
  const {
    cwd,
    env,
    stdoutFile,
    onStdout,
    onStderr,
    timeoutMs,
  } = opts;

  const args = withJsonMode(opts.args);

  let logFd: number | undefined;
  let stdio: ["ignore", "pipe", "pipe"] | ["ignore", number, number];

  if (stdoutFile) {
    logFd = openSync(stdoutFile, "a");
    stdio = ["ignore", logFd, logFd];
  } else {
    stdio = ["ignore", "pipe", "pipe"];
  }

  const piBin = process.env.PI_BIN || "pi";
  const proc = spawn(piBin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio,
  });

  if (logFd !== undefined) closeSync(logFd);

  proc.unref();

  let killed = false;
  let code: number | null = null;

  // Accumulate stdout chunks for token extraction (pipe mode only).
  // Pi's events are line-delimited JSON; buffer partial lines across chunks.
  const stdoutLines: string[] = [];
  let lineBuffer = "";

  if (!stdoutFile) {
    proc.stdout?.on("data", (d: Buffer) => {
      lineBuffer += d.toString();
      const parts = lineBuffer.split("\n");
      lineBuffer = parts.pop() ?? "";
      for (const line of parts) {
        stdoutLines.push(line);
        processEventLine(line, onStdout);
      }
    });
  }
  if (!stdoutFile && onStderr) {
    proc.stderr?.on("data", (d: Buffer) => onStderr(d.toString()));
  }

  return new Promise((resolve) => {
    const timer = timeoutMs ? setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, timeoutMs) : null;

    proc.on("close", (c) => {
      if (timer) clearTimeout(timer);
      code = c;

      // Flush any tail buffer (last line without trailing newline)
      if (lineBuffer.trim()) {
        stdoutLines.push(lineBuffer);
        processEventLine(lineBuffer, onStdout);
        lineBuffer = "";
      }

      // Extract tokens from accumulated stream or from file
      let tokens: PiTokens | undefined = undefined;
      try {
        const content = stdoutFile
          ? readFileSync(stdoutFile, "utf-8")
          : stdoutLines.join("\n");
        const t = extractTokensFromStream(content);
        if (t) tokens = t;
      } catch { /* ignore extraction failures */ }

      resolve({ pid: proc.pid ?? 0, code, killed, tokens });
    });

    proc.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ pid: proc.pid ?? 0, code: null, killed: true });
    });
  });
}
