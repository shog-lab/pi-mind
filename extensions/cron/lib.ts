/**
 * Crontab read/write/parse helpers for the cron extension.
 *
 * Identity marker: every line installed by pi-mind ends with
 *   "# pi-mind: <description>"
 * and only such lines are listed/removed. User-written crontab content is
 * never touched.
 */

import { execSync } from "node:child_process";

export const PI_MIND_MARKER = "# pi-mind:";

export interface CronEntry {
  cron: string;
  command: string;
  description: string;
  fullLine: string;
}

/** Read the current user's crontab. Returns "" if none. */
export function readCrontab(): string {
  try {
    return execSync("crontab -l", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    // "no crontab for <user>" is normal — user simply has none yet
    if (/no crontab/i.test(msg)) return "";
    throw new Error(`failed to read crontab: ${msg.trim() || String(e)}`);
  }
}

/** Replace the user's entire crontab with the given content. */
export function writeCrontab(content: string): void {
  // Ensure trailing newline; cron daemon prefers it.
  const final = content.endsWith("\n") ? content : content + "\n";
  try {
    execSync("crontab -", {
      input: final,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`failed to write crontab: ${msg.trim() || String(e)}`);
  }
}

/** Build a full crontab line with the pi-mind identity marker. */
export function buildLine(cron: string, command: string, description: string): string {
  // Sanitize description: collapse whitespace, no newlines
  const desc = description.replace(/\s+/g, " ").trim();
  return `${cron.trim()} ${command.trim()} ${PI_MIND_MARKER} ${desc}`;
}

/** Extract pi-mind entries from a crontab content string. */
export function parseEntries(content: string): CronEntry[] {
  const entries: CronEntry[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || !isPiMindEntry(line)) continue;
    const markerIdx = line.indexOf(PI_MIND_MARKER);
    const beforeMarker = line.slice(0, markerIdx).trimEnd();
    const description = line.slice(markerIdx + PI_MIND_MARKER.length).trim();
    // Cron expression is the first 5 whitespace-separated fields
    const parts = beforeMarker.split(/\s+/);
    if (parts.length < 6) continue; // malformed
    const cron = parts.slice(0, 5).join(" ");
    const command = parts.slice(5).join(" ");
    entries.push({ cron, command, description, fullLine: line });
  }
  return entries;
}

/** Does this line carry the pi-mind identity marker? */
export function isPiMindEntry(line: string): boolean {
  return line.includes(PI_MIND_MARKER);
}

/** Validate a 5-field cron expression. Loose check — defers full validation to cron daemon. */
export function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Each field is one or more of: digits, *, ranges (a-b), steps (*/n), lists (a,b,c)
  const fieldRe = /^[\d*,/-]+$/;
  return parts.every((p) => fieldRe.test(p));
}
