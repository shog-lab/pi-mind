/**
 * RetrievalOnlyDriver — retrieval-only evaluation of pi-mind.
 *
 * For each question:
 *   1. Create an isolated tmpdir + .pi-mind subdir
 *   2. Seed memory via the shared seed helper (same ingestion as the
 *      pi-session QA driver, so the two tracks are comparable)
 *   3. Open MemoryCore directly (no pi spawn) and run the same
 *      hybrid retrieval pipeline the agent sees: FTS5 + vector,
 *      merged via RRF, KG entity-fact block on top
 *   4. Return the structured retrieval result so the runner can
 *      compare against `metadata.answerSessionIds`
 *
 * Why retrieval-only? LongMemEval tests BOTH ingestion fidelity and
 * generation quality. pi-mind's generation quality is a property of
 * the model (and the model is fixed by the spawn). The thing pi-mind
 * actually owns is retrieval — given a history seeded into memory,
 * does the right session come back when the question is asked?
 *
 * This driver measures that directly. Compare with MemPalace-style
 * R@k metrics. NB: NOT comparable to LongMemEval's QA accuracy (the
 * official eval judges the final response, not retrieval).
 */

import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryCore, parseFrontmatter } from "../../../packages/memory/dist/extensions/memory/core.js";
import { seedMemoryFromHistory } from "../seed.js";
import type { Driver, EvalQuestion } from "../types.js";

export interface RetrievalHit {
  /** Absolute file path returned by memory's hybrid search. */
  filePath: string;
  /** RRF-merged score (higher = better). */
  score: number;
  /** Which search path produced this hit: "fts" | "vector" | "both" | "kg". */
  source: "fts" | "vector" | "both" | "kg" | "l1";
}

export interface RetrievalResult {
  /** Question that was asked. */
  questionId: string;
  /** Question text. */
  question: string;
  /** Top retrieved filePaths in retrieval order (deduplicated, best-score first). */
  topFilePaths: string[];
  /** Per-file score, aligned with topFilePaths. */
  topScores: number[];
  /** Per-file source method, aligned with topFilePaths. */
  topSources: RetrievalHit["source"][];
  /** True if the question is an abstention case (no evidence in haystack). */
  isAbstention: boolean;
  /** Mapping from filePath → sessionId extracted from frontmatter (so the
   *  metric can compute RecallAny against answerSessionIds). */
  fileToSessionId: Record<string, string>;
  /** Wall-clock duration of the retrieval call (syncIndex + searchFTS5 + searchVector + KG). */
  durationMs: number;
  /** Per-category metadata (e.g. "temporal-reasoning"), mirrored from question.metadata. */
  category?: string;
  /** Engine error string if the retrieval call threw (rare; usually means
   *  the memory extension didn't init — record NaN, don't fail the run). */
  error?: string;
}

export interface RetrievalOnlyDriverOptions {
  /** Override the memory extension's max-inject-tokens (default 4000). */
  maxInjectTokens?: number;
  /** Per-question timeout in ms (default 30s). */
  timeoutMs?: number;
}

export class RetrievalOnlyDriver implements Driver {
  name = "retrieval-only";
  private tmpDirs: string[] = [];

  constructor(private opts: RetrievalOnlyDriverOptions = {}) {}

  async run(question: EvalQuestion): Promise<{ response: string; durationMs: number; retrieval: RetrievalResult }> {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-eval-retrieval-"));
    this.tmpDirs.push(sessionDir);

    const piMindDir = join(sessionDir, ".pi-mind");
    const answerSessionIds = Array.isArray(question.metadata?.answerSessionIds)
      ? (question.metadata!.answerSessionIds as string[])
      : [];
    const isAbstention = (question.metadata?.isAbstention as boolean | undefined) ?? answerSessionIds.length === 0;

    const result: RetrievalResult = {
      questionId: question.id,
      question: question.question,
      topFilePaths: [],
      topScores: [],
      topSources: [],
      isAbstention,
      fileToSessionId: {},
      durationMs: 0,
      category: question.metadata?.category as string | undefined,
    };

    const startedAt = Date.now();
    try {
      seedMemoryFromHistory(piMindDir, question);

      // Open MemoryCore with a writable DB (searchFTS5 calls syncIndex
      // internally which needs to write). Same DB path convention as
      // PiSessionDriver.
      const dbPath = join(piMindDir, ".pi-mind-index.db");
      const mc = new MemoryCore({ groupDir: piMindDir, dbPath });
      try {
        // Force the seeded knowledge into FTS5 + vectors + KG.
        await mc.syncIndex();
        // Run the same hybrid pipeline the agent uses. Both searches
        // are independent and may return overlapping filePaths.
        const [ftsHits, vecHits] = await Promise.all([
          mc.searchFTS5(question.question),
          mc.searchVector(question.question),
        ]);
        const merged = mc.mergeHybridResults(vecHits, ftsHits);
        // KG block: file paths that appear in the KG render path. Cheap
        // because the KG is small at the eval scale.
        const kg = await kgEntityFilePaths(mc, question.question);

        // Build a source-tagged top-K. Deduplicate by filePath, keeping
        // the best score and tagging which path produced it.
        const byPath = new Map<string, RetrievalHit>();
        for (const r of merged) {
          const fp = r.entry.filePath;
          const hit: RetrievalHit = { filePath: fp, score: r.score, source: scoreSource(r, ftsHits, vecHits) };
          const prev = byPath.get(fp);
          if (!prev || hit.score > prev.score) byPath.set(fp, hit);
        }
        for (const fp of kg) {
          if (!byPath.has(fp)) byPath.set(fp, { filePath: fp, score: 0, source: "kg" });
        }
        const sorted = [...byPath.values()].sort((a, b) => b.score - a.score);

        for (const hit of sorted) {
          result.topFilePaths.push(hit.filePath);
          result.topScores.push(hit.score);
          result.topSources.push(hit.source);
        }

        // Build filePath → sessionId by re-parsing each .md's frontmatter.
        // The seed helper embeds `session_id: <id>` (and a `session:<id>`
        // tag) so this round-trip is deterministic.
        for (const fp of result.topFilePaths) {
          try {
            const raw = readFileSync(fp, "utf-8");
            const { meta } = parseFrontmatter(raw);
            const sid = typeof meta.session_id === "string"
              ? meta.session_id
              : Array.isArray(meta.tags)
                ? (meta.tags as string[]).find((t) => t.startsWith("session:"))?.slice("session:".length) ?? ""
                : "";
            if (sid) result.fileToSessionId[fp] = sid;
          } catch { /* unreadable file — leave it out of the map */ }
        }
      } finally {
        mc.close();
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    result.durationMs = Date.now() - startedAt;

    // The Driver interface requires a `response: string`; for retrieval,
    // we encode the structured result as JSON so downstream writers can
    // recover it from the existing `results[].response` slot without
    // adding a new field to the public interface. The retrieval track's
    // dedicated writer prefers `result.retrieval` when present.
    return {
      response: JSON.stringify({ kind: "retrieval", topK: result.topFilePaths.length, abstention: result.isAbstention }),
      durationMs: result.durationMs,
      retrieval: result,
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
 * Return the set of file paths that the KG context block would surface
 * for this query.
 *
 * Strategy: parse the rendered `### Knowledge Graph: <name>` headers
 * from `kg.buildContext(question)`, then for each entity name call
 * `kg.queryEntity(name)` to get the triples — the `source_file` field
 * on each triple gives us the file path deterministically. This
 * matches what the production retrieval path effectively surfaces
 * (KG entity → its triples → the .md files that hold those triples).
 */
async function kgEntityFilePaths(mc: MemoryCore, question: string): Promise<Set<string>> {
  const rendered = mc.kg.buildContext(question);
  const out = new Set<string>();
  for (const m of rendered.matchAll(/^### Knowledge Graph: (.+)$/gm)) {
    const entityName = m[1].trim();
    try {
      const triples = mc.kg.queryEntity(entityName);
      for (const t of triples) {
        if (t.source_file) out.add(t.source_file);
      }
    } catch { /* queryEntity can throw if entity vanished — skip */ }
  }
  return out;
}

/** Tag a hit with which search path produced it (fts / vector / both). */
function scoreSource(r: { entry: { filePath: string } }, fts: { entry: { filePath: string } }[], vec: { entry: { filePath: string } }[]): RetrievalHit["source"] {
  const fp = r.entry.filePath;
  const inFts = fts.some((h) => h.entry.filePath === fp);
  const inVec = vec.some((h) => h.entry.filePath === fp);
  if (inFts && inVec) return "both";
  if (inFts) return "fts";
  if (inVec) return "vector";
  return "both"; // came from RRF merge — should already be in at least one
}
