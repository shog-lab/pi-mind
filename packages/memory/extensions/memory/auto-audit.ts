/**
 * Startup-triggered self-evolution: detect when daily-audit is overdue
 * and inject a context note suggesting the agent run it.
 *
 * The hook does NOT run the audit itself — daily-audit is a skill executed
 * by an LLM agent, not a sync TS function. The hook just signals overdue
 * status; the agent decides when to honor the suggestion (typically before
 * substantive work in the current session).
 *
 * State lives in a single marker file so the check is fast and atomic:
 *   $PI_MIND_DIR/episodic/maintenance-log/last-audit.json
 *   { "lastRun": <ms epoch>, "summary": "<optional one-line>" }
 *
 * Mark-as-done is exposed as a tool the daily-audit skill calls at the end
 * of its workflow; that's the one and only writer of this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUDIT_INTERVAL_HOURS = 24;

interface AuditMarker {
  lastRun: number;
  summary?: string;
}

function markerPath(piMindDir: string): string {
  return join(piMindDir, "episodic", "maintenance-log", "last-audit.json");
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
export function renderAuditNotice(status: AuditStatus): string | null {
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
  lines.push(
    "Suggest: run `use daily-audit skill` before substantive work in this session.",
    "When done, call mark_daily_audit_complete(summary?) to silence this notice for 24h.",
  );
  lines.push("</self-evolution>");
  return lines.join("\n");
}
