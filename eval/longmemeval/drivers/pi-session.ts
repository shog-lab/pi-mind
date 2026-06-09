/**
 * PiSessionDriver — runs an EvalQuestion against a real pi-mind session.
 *
 * For each question:
 *   1. Create an isolated tmpdir + .pi-mind subdir (PI_MIND_DIR override)
 *   2. Seed memory by replaying `history` via direct file writes (faster than
 *      spawning pi for each turn; the eval is about retrieval, not ingestion fidelity)
 *   3. Spawn pi with the question, with the memory extension loaded
 *   4. Collect response + tokens
 *   5. Caller is responsible for calling close() to remove the tmpdir
 *
 * The "history" replay shortcut is the main correctness risk: it assumes
 * memory's classification + indexing produce the same state as running real
 * conversation turns would. Once we have the LongMemEval baseline working,
 * we should compare both ingestion modes on a sample to validate this.
 */

import { existsSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, type PiTokens } from "@shog-lab/pi-utils";
import type { Driver, EvalQuestion } from "../types.js";
import { seedMemoryFromHistory } from "../seed.js";

export interface PiSessionDriverOptions {
  /** Extra args passed to pi (e.g. ["--model", "openai/gpt-4o-mini"]) */
  extraArgs?: string[];
  /** Per-question timeout. Default 180s. */
  timeoutMs?: number;
  /**
   * Path to pi-mind's compiled memory extension entry (index.js). If omitted,
   * the driver walks up from this module to find packages/memory/dist/extensions/memory/index.js
   * — works when running inside the pi-mind monorepo, fails loudly otherwise.
   */
  memoryExtensionPath?: string;
}

/**
 * Auto-resolve the memory extension by walking up from this file's location
 * to the monorepo root, then into packages/memory.
 *
 * Returns null if not found (caller decides how to fail).
 */
function autoResolveMemoryExtension(): string | null {
  let dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
  // The compiled entry point lives at
  //   <repo-root>/packages/memory/dist/extensions/memory/index.js
  // This driver currently lives at <repo-root>/eval/longmemeval/drivers/.
  // Walk up at most 6 levels (covers both "packages/core/eval" legacy and
  // "eval/longmemeval" current locations plus a margin).
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "packages", "memory", "dist", "extensions", "memory", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export class PiSessionDriver implements Driver {
  name = "pi-session";
  private tmpDirs: string[] = [];
  private resolvedMemoryExt: string;

  constructor(private opts: PiSessionDriverOptions = {}) {
    const resolved = opts.memoryExtensionPath ?? autoResolveMemoryExtension();
    if (!resolved) {
      throw new Error(
        "PiSessionDriver: could not locate pi-mind memory extension. " +
        "Build the memory package first (`npm run build --workspace=@shog-lab/pi-memory`), " +
        "or pass memoryExtensionPath explicitly.",
      );
    }
    this.resolvedMemoryExt = resolve(resolved);
  }

  async run(question: EvalQuestion): Promise<{ response: string; tokens?: PiTokens; durationMs: number }> {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-eval-"));
    this.tmpDirs.push(sessionDir);

    const piMindDir = join(sessionDir, ".pi-mind");
    seedMemoryFromHistory(piMindDir, question);

    // --no-extensions disables .pi/extensions/ discovery so we only get memory,
    // not whatever extensions happen to be installed in the host's pi config.
    const args = [
      "-p",
      "--no-extensions",
      "-e", this.resolvedMemoryExt,
      ...(this.opts.extraArgs ?? []),
    ];
    args.push(question.question);

    const chunks: string[] = [];
    const startedAt = Date.now();
    const result = await spawnPi({
      cwd: sessionDir,
      args,
      env: { PI_MIND_DIR: piMindDir },
      onStdout: (text) => chunks.push(text),
      timeoutMs: this.opts.timeoutMs ?? 180_000,
    });
    const durationMs = Date.now() - startedAt;

    return {
      response: chunks.join(""),
      tokens: result.tokens,
      durationMs,
    };
  }

  async close(): Promise<void> {
    for (const dir of this.tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this.tmpDirs = [];
  }
}
