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

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, type PiTokens } from "pi-mind/dist/lib/spawn-pi.js";
import type { Driver, EvalQuestion } from "../types.js";

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
  for (let i = 0; i < 8; i++) {
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
        "Build the memory package first (`npm run build --workspace packages/memory`), " +
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

/**
 * Seed memory by writing each logical session as one knowledge .md file under
 * `<piMindDir>/knowledge/`.
 *
 * Why this shape: memory's `before_agent_start` hook only injects L1 entries
 * (always-on preferences) and the top-K L2/L3 search hits — it does NOT load
 * raw session files directly. So if we only wrote raw/sessions/*.jsonl, pi
 * would start with empty memory context. By emitting knowledge files with
 * tier=L2 and type=reference, memory's syncIndex will register them in FTS5
 * on first run and the search path will retrieve the relevant ones when the
 * question is asked.
 *
 * Subject choice: `reference` because:
 *   - `user`     → L1 always-injected, would dump entire history into context
 *   - `project`  → semantically wrong (this isn't project info)
 *   - `agent-feedback` → semantically wrong
 *   - `reference` → fits "external knowledge for retrieval"; tests the actual
 *                   FTS+KG search path, which is what LongMemEval measures
 *
 * Tradeoff: we skip the compaction/summarization step that production memory
 * runs before storing knowledge — full session text becomes the body. This
 * tests memory's retrieval over raw text, not over summarized facts. To compare
 * "raw vs summarized" body, swap formatSessionBody() for a summarizer.
 */
function seedMemoryFromHistory(piMindDir: string, question: EvalQuestion): void {
  const knowledgeDir = join(piMindDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  // Group history by sessionId; preserve insertion order within each session.
  const buckets = new Map<string, typeof question.history>();
  for (const msg of question.history) {
    const key = msg.sessionId ?? `eval-${question.id}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(msg);
  }

  for (const [sessionId, msgs] of buckets) {
    const sessionDate = msgs[0]?.timestamp ?? new Date().toISOString();
    const body = formatSessionBody(msgs);
    const frontmatter = [
      "---",
      `date: ${normalizeDate(sessionDate)}`,
      `type: reference`,
      `tier: L2`,
      `tags: [eval, session-${sessionId}]`,
      "---",
      "",
      body,
    ].join("\n");

    const fileName = `eval-${sessionId}.md`;
    writeFileSync(join(knowledgeDir, fileName), frontmatter, "utf-8");
  }
}

function formatSessionBody(msgs: { role: string; content: string }[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    lines.push(`**${m.role}:** ${m.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * LongMemEval timestamps look like "2023/04/10 (Mon) 14:47" — normalize to
 * ISO so memory's frontmatter validator and date-based heuristics don't choke.
 */
function normalizeDate(raw: string): string {
  // Already ISO? pass through.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  // LongMemEval format: "YYYY/MM/DD (Day) HH:MM"
  const m = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Fallback: today's date — better than crashing
  return new Date().toISOString().slice(0, 10);
}
