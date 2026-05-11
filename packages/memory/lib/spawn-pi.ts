/**
 * Shared pi spawn helper.
 *
 * Sub-agent and memory extensions both spawn pi for sub-tasks.
 * This module centralizes the spawn lifecycle including the critical
 * stdio handling that was previously buggy in both places.
 *
 * Key invariants:
 * - stdio must be ["ignore", logFd, logFd] OR ["ignore", "pipe", "pipe"] with active reader
 * - Never ["ignore", "pipe", "pipe"] without reading — pipe buffer fills and child hangs
 * - proc.unref() always called so parent process can exit
 *
 * Pi binary resolution:
 * - Defaults to "pi" (resolved via PATH)
 * - Override with PI_BIN env var if pi lives elsewhere (e.g. monorepo node_modules)
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export interface SpawnPiOptions {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  /** Redirect stdout/stderr to a file (fire-and-forget, ack via external mechanism) */
  stdoutFile?: string;
  /** Stream stdout via callback (parent waits via promise) */
  onStdout?: (data: string) => void;
  /** Stream stderr via callback */
  onStderr?: (data: string) => void;
  /** Timeout in ms (default: no timeout) */
  timeoutMs?: number;
}

export interface SpawnPiResult {
  pid: number;
  /** null if killed/timeout */
  code: number | null;
  killed: boolean;
}

/**
 * Spawn a pi process with proper stdio handling.
 *
 * Usage (fire-and-forget):
 *   spawnPi({ cwd, args, stdoutFile: "/path/to/log", timeoutMs: 60000 });
 *
 * Usage (streaming, parent waits):
 *   const result = await spawnPi({ cwd, args, onStdout: (d) => chunks.push(d) });
 */
export function spawnPi(opts: SpawnPiOptions): Promise<SpawnPiResult> {
  const {
    cwd,
    args,
    env,
    stdoutFile,
    onStdout,
    onStderr,
    timeoutMs,
  } = opts;

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

  if (!stdoutFile && onStdout) {
    proc.stdout?.on("data", (d) => onStdout(d.toString()));
  }
  if (!stdoutFile && onStderr) {
    proc.stderr?.on("data", (d) => onStderr(d.toString()));
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
      resolve({ pid: proc.pid ?? 0, code, killed });
    });

    proc.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ pid: proc.pid ?? 0, code: null, killed: true });
    });
  });
}
