/**
 * LongMemEval dataset adapter (real).
 *
 * Maps the upstream JSON schema:
 *   {
 *     question_id, question_type, question, answer,
 *     question_date, haystack_dates, haystack_session_ids,
 *     haystack_sessions: [[{role, content}, ...], ...],
 *     answer_session_ids,
 *   }
 *
 * into our EvalQuestion shape, preserving session boundaries via
 * HistoryMessage.sessionId and timestamps via HistoryMessage.timestamp.
 *
 * Categories observed in oracle split (500 entries total):
 *   temporal-reasoning (133), multi-session (133), knowledge-update (78),
 *   single-session-user (70), single-session-assistant (56),
 *   single-session-preference (30)
 *
 * The 'abstention' label from the LongMemEval paper isn't a separate
 * category here — abstention items are mixed into the above. Detect them
 * via metadata.answer_session_ids being empty if needed.
 */

import { readFileSync } from "node:fs";
import type { Dataset, EvalQuestion, HistoryMessage } from "../types.js";
import { ensureCached, type LongMemEvalSplit } from "./longmemeval-download.js";

interface UpstreamTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface UpstreamEntry {
  question_id: string;
  question_type: string;
  question: string;
  /** Upstream answer can be string OR int (32 of 500 oracle entries are int) — we coerce in toEvalQuestion. */
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: UpstreamTurn[][];
  answer_session_ids: string[];
}

export interface LongMemEvalOptions {
  /** Which split to load. Default 'oracle' (smallest, fastest, easiest baseline). */
  split?: LongMemEvalSplit;
}

export class LongMemEvalDataset implements Dataset {
  readonly name: string;
  private readonly split: LongMemEvalSplit;

  constructor(opts: LongMemEvalOptions = {}) {
    this.split = opts.split ?? "oracle";
    this.name = `longmemeval-${this.split}`;
  }

  async *load(opts?: { category?: string; limit?: number }): AsyncIterable<EvalQuestion> {
    const path = await ensureCached(this.split, {
      onProgress: (received, total) => {
        // Coarse progress: log at each 10% boundary
        const pct = (received / total) * 100;
        const prevPct = ((received - 1_048_576) / total) * 100;
        if (Math.floor(pct / 10) > Math.floor(prevPct / 10)) {
          process.stderr.write(`\r[longmemeval] downloading: ${pct.toFixed(0)}%`);
          if (pct >= 100) process.stderr.write("\n");
        }
      },
    });

    // Oracle is 15MB; full load is fine. For larger splits, callers should use
    // --limit to bound memory rather than us implementing a streaming parser
    // (the input is a top-level JSON array, which streaming parsers handle
    // poorly without external deps).
    const raw = JSON.parse(readFileSync(path, "utf-8")) as UpstreamEntry[];

    let yielded = 0;
    for (const entry of raw) {
      if (opts?.category && entry.question_type !== opts.category) continue;
      if (opts?.limit !== undefined && yielded >= opts.limit) break;

      yield toEvalQuestion(entry);
      yielded++;
    }
  }
}

function toEvalQuestion(entry: UpstreamEntry): EvalQuestion {
  const history: HistoryMessage[] = [];
  for (let i = 0; i < entry.haystack_sessions.length; i++) {
    const sessionId = entry.haystack_session_ids[i];
    const timestamp = entry.haystack_dates[i];
    for (const turn of entry.haystack_sessions[i]) {
      history.push({
        role: turn.role,
        content: turn.content,
        sessionId,
        timestamp,
      });
    }
  }

  return {
    id: entry.question_id,
    history,
    question: entry.question,
    // Some upstream entries have integer answers (e.g. day counts); coerce to string.
    groundTruth: String(entry.answer),
    metadata: {
      category: entry.question_type,
      questionDate: entry.question_date,
      answerSessionIds: entry.answer_session_ids,
      /** True when the question has no evidence in haystack (abstention case). */
      isAbstention: entry.answer_session_ids.length === 0,
    },
  };
}
