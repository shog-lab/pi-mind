/**
 * Seed helper — shared between the pi-session QA driver and the
 * retrieval-only driver. Both write the same knowledge files for
 * a given question so the two tracks can be compared apples-to-apples
 * (same ingestion, different downstream consumption).
 *
 * File naming: `eval-${sessionId}.md` (one per logical session).
 * Each file's frontmatter carries an explicit `session_id` field so
 * downstream code can map a retrieved filePath back to its sessionId
 * deterministically (no fragile string guesses).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalQuestion, HistoryMessage } from "./types.js";

/** Tag prefix used in the frontmatter `tags` array. */
export const SESSION_TAG_PREFIX = "session:";

/** Build the frontmatter + body string for a single session. */
export function formatSessionFile(sessionId: string, msgs: HistoryMessage[], sessionDate: string): string {
  const body = formatSessionBody(msgs);
  return [
    "---",
    `date: ${normalizeDate(sessionDate)}`,
    `type: reference`,
    `tier: L2`,
    `tags: [eval-seed, ${SESSION_TAG_PREFIX}${sessionId}]`,
    `session_id: ${sessionId}`,
    "---",
    "",
    body,
  ].join("\n");
}

/** Write one .md file per session into the given knowledge dir. */
export function seedMemoryFromHistory(piMindDir: string, question: EvalQuestion): void {
  const knowledgeDir = join(piMindDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  // Group history by sessionId; preserve insertion order within each session.
  const buckets = new Map<string, HistoryMessage[]>();
  for (const msg of question.history) {
    const key = msg.sessionId ?? `eval-${question.id}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(msg);
  }

  for (const [sessionId, msgs] of buckets) {
    const sessionDate = msgs[0]?.timestamp ?? new Date().toISOString();
    const content = formatSessionFile(sessionId, msgs, sessionDate);
    const fileName = `eval-${sessionId}.md`;
    writeFileSync(join(knowledgeDir, fileName), content, "utf-8");
  }
}

function formatSessionBody(msgs: HistoryMessage[]): string {
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
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const m = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return new Date().toISOString().slice(0, 10);
}
