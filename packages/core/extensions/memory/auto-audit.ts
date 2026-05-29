/**
 * Startup-triggered self-evolution: detect when memory-audit is overdue
 * and inject a context note suggesting the agent run it.
 *
 * The hook does NOT run the audit itself — memory-audit is a skill executed
 * by an LLM agent, not a sync TS function. The hook just signals overdue
 * status; the agent decides when to honor the suggestion (typically before
 * substantive work in the current session).
 *
 * State lives in a single marker file so the check is fast and atomic:
 *   $PI_MIND_DIR/raw/maintenance-log/last-audit.json
 *   { "lastRun": <ms epoch>, "summary": "<optional one-line>" }
 *
 * Mark-as-done is exposed as a tool the memory-audit skill calls at the end
 * of its workflow; that's the one and only writer of this file. The tool is
 * named `mark_daily_audit_complete` for historical reasons (will be renamed
 * `mark_memory_audit_complete` in a future breaking release).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUDIT_INTERVAL_HOURS = 24;

export interface TokenSummary {
  totalTokens: number;
  costUsd: number;
  callCount: number;
  /** Earliest entry counted (ms epoch). Useful for "since when" framing. */
  sinceMs: number;
}

/**
 * Aggregate token usage from maintenance-log/*.jsonl entries whose `action`
 * ends in `-tokens` (e.g. B-tokens, F-tokens) since `sinceMs`.
 *
 * Only scans files for dates that could contain matching entries — typically
 * today + yesterday for a 24h audit window. If sinceMs spans further back,
 * passes a wider date range.
 */
export function summarizeTokensSince(piMindDir: string, sinceMs: number, now: number = Date.now()): TokenSummary {
  const logDir = join(piMindDir, "raw", "maintenance-log");
  const summary: TokenSummary = { totalTokens: 0, costUsd: 0, callCount: 0, sinceMs };
  if (!existsSync(logDir)) return summary;

  // Build the set of YYYY-MM-DD files to scan. Capped at 7 days to keep this cheap.
  const dayMs = 86_400_000;
  const spanDays = Math.min(7, Math.ceil((now - sinceMs) / dayMs) + 1);
  const dates = new Set<string>();
  for (let i = 0; i < spanDays; i++) {
    dates.add(new Date(now - i * dayMs).toISOString().slice(0, 10));
  }

  let logFiles: string[];
  try {
    logFiles = readdirSync(logDir).filter((f) => f.endsWith(".jsonl") && dates.has(f.slice(0, 10)));
  } catch { return summary; }

  for (const filename of logFiles) {
    let content: string;
    try { content = readFileSync(join(logDir, filename), "utf-8"); } catch { continue; }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      const action = entry.action;
      if (typeof action !== "string" || !action.endsWith("-tokens")) continue;
      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const tokens = entry.tokens as { totalTokens?: number; costUsd?: number } | undefined;
      if (!tokens) continue;
      summary.totalTokens += tokens.totalTokens ?? 0;
      summary.costUsd += tokens.costUsd ?? 0;
      summary.callCount += 1;
    }
  }
  return summary;
}

interface AuditMarker {
  lastRun: number;
  summary?: string;
}

function markerPath(piMindDir: string): string {
  return join(piMindDir, "raw", "maintenance-log", "last-audit.json");
}

export function readMarker(piMindDir: string): AuditMarker | null {
  const path = markerPath(piMindDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AuditMarker;
  } catch {
    return null;
  }
}

export interface AuditStatus {
  overdue: boolean;
  hoursSinceLast: number | null;
  lastSummary?: string;
}

export function getAuditStatus(piMindDir: string, now: number = Date.now()): AuditStatus {
  const marker = readMarker(piMindDir);
  if (!marker) return { overdue: true, hoursSinceLast: null };
  const hoursSinceLast = (now - marker.lastRun) / 3600_000;
  return {
    overdue: hoursSinceLast >= AUDIT_INTERVAL_HOURS,
    hoursSinceLast,
    lastSummary: marker.summary,
  };
}

export function markAuditDone(piMindDir: string, summary?: string): void {
  const path = markerPath(piMindDir);
  mkdirSync(dirname(path), { recursive: true });
  const data: AuditMarker = { lastRun: Date.now() };
  if (summary) data.summary = summary.slice(0, 500);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Build a context-injection block to surface audit-overdue status to the agent. */
export function renderAuditNotice(status: AuditStatus, tokenSummary?: TokenSummary): string | null {
  if (!status.overdue) return null;
  const lines = ["<self-evolution>"];
  if (status.hoursSinceLast === null) {
    lines.push("Daily audit has never run in this repo.");
  } else {
    const hrs = Math.round(status.hoursSinceLast);
    lines.push(`Daily audit last ran ${hrs}h ago — overdue.`);
    if (status.lastSummary) {
      lines.push(`Last audit summary: ${status.lastSummary}`);
    }
  }
  if (tokenSummary && tokenSummary.callCount > 0) {
    // costUsd shown to 4 decimal places — typical L2 spawn is $0.0003-0.001
    const cost = tokenSummary.costUsd.toFixed(4);
    lines.push(
      `Memory L2 spend since last audit: ${tokenSummary.totalTokens.toLocaleString()} tokens / $${cost} across ${tokenSummary.callCount} call(s).`,
    );
  }
  lines.push(
    "Suggest: run `use memory-audit skill` before substantive work in this session.",
    "When done, call mark_daily_audit_complete(summary?) to silence this notice for 24h.",
  );
  lines.push("</self-evolution>");
  return lines.join("\n");
}
