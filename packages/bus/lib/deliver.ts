/**
 * pi-bus deliver API — pure filesystem primitives for inter-pi messaging.
 *
 * Extracted from extensions/bus/index.ts so non-extension callers (cron
 * triggers, CLI scripts, other extensions) can drop messages into a session's
 * inbox without booting a full pi extension.
 *
 * What lives here:
 *   - Path helpers (busRoot, sessionsRoot, ownSessionDir, inboxDir)
 *   - Session meta + inbox message schemas
 *   - Pure I/O: readMeta, listLiveSessions, findByName, writeInboxMessage,
 *     readInbox, generateMsgId
 *
 * What stays in the extension:
 *   - generateName (auto-generated friendly name; only used at session registration)
 *   - writeMeta, updateHeartbeat (write your own meta; tied to closure scope)
 *   - deliverIncoming, startInboxWatch, shutdown (tied to pi extension lifecycle)
 *
 * If you're writing a script that needs to drop a message into a session's
 * inbox, import from this file. Example:
 *
 *   import { findByName, writeInboxMessage, generateMsgId } from "@shog-lab/pi-bus/lib/deliver";
 *   const found = findByName("alice");
 *   if (!("error" in found)) {
 *     writeInboxMessage(found.id, {
 *       id: generateMsgId(),
 *       from: "cron",
 *       body: "wake up",
 *       sentAt: new Date().toISOString(),
 *     });
 *   }
 */

import {
  existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { resolvePiMindDir } from "@shog-lab/pi-utils";

// --- Constants ---

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALE_AFTER_MS = 90_000;
export const MAX_BODY_BYTES = 16_000;       // cap inbound message body to avoid silly abuse

// --- Schemas ---

export const SessionMetaSchema = Type.Object({
  name: Type.String(),
  pid: Type.Number(),
  cwd: Type.String(),
  joinedAt: Type.String(),
  heartbeatAt: Type.String(),
});
export type SessionMeta = Static<typeof SessionMetaSchema>;

export const InboxMessageSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  body: Type.String(),
  sentAt: Type.String(),
});
export type InboxMessage = Static<typeof InboxMessageSchema>;

// --- Paths ---

export function busRoot(): string {
  return join(resolvePiMindDir(), "bus");
}

export function sessionsRoot(): string {
  return join(busRoot(), "sessions");
}

export function ownSessionDir(sessionId: string): string {
  return join(sessionsRoot(), sessionId);
}

export function inboxDir(sessionId: string): string {
  return join(sessionsRoot(), sessionId, "inbox");
}

// --- Session registry I/O ---

export function readMeta(sessionId: string): SessionMeta | null {
  const p = join(sessionsRoot(), sessionId, "meta.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (Value.Check(SessionMetaSchema, parsed)) return parsed;
  } catch { /* corrupt file → treat as missing */ }
  return null;
}

/** List live sessions (stale-filtered). Excludes `excludeId` if given (yourself). */
export function listLiveSessions(excludeId?: string): SessionMeta[] {
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const now = Date.now();
  const live: SessionMeta[] = [];
  for (const id of readdirSync(root)) {
    if (id === excludeId) continue;
    const meta = readMeta(id);
    if (!meta) continue;
    const lastBeat = new Date(meta.heartbeatAt).getTime();
    if (now - lastBeat > STALE_AFTER_MS) continue;
    live.push(meta);
  }
  return live;
}

/** Look up a live session by name. Returns null if not found / stale / ambiguous. */
export function findByName(name: string, excludeId?: string): { id: string; meta: SessionMeta } | { error: string } {
  const root = sessionsRoot();
  if (!existsSync(root)) return { error: `bus has no sessions registered` };
  const now = Date.now();
  const matches: Array<{ id: string; meta: SessionMeta }> = [];
  for (const id of readdirSync(root)) {
    if (id === excludeId) continue;
    const meta = readMeta(id);
    if (!meta) continue;
    if (meta.name !== name) continue;
    const lastBeat = new Date(meta.heartbeatAt).getTime();
    if (now - lastBeat > STALE_AFTER_MS) continue;
    matches.push({ id, meta });
  }
  if (matches.length === 0) return { error: `no live session named "${name}"` };
  if (matches.length > 1) {
    return { error: `ambiguous: ${matches.length} live sessions named "${name}" (pids: ${matches.map((m) => m.meta.pid).join(", ")})` };
  }
  return matches[0];
}

export function generateMsgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Inbox I/O ---

export function writeInboxMessage(targetSessionId: string, msg: InboxMessage): void {
  const dir = inboxDir(targetSessionId);
  if (!existsSync(dir)) {
    throw new Error(`target session ${targetSessionId} has no inbox dir (race?)`);
  }
  // Atomic: write to .tmp then rename so fs.watch sees one final event.
  const tmp = join(dir, `${msg.id}.json.tmp`);
  const final = join(dir, `${msg.id}.json`);
  writeFileSync(tmp, JSON.stringify(msg, null, 2));
  renameSync(tmp, final);
}

export function readInbox(sessionId: string, consume: boolean): InboxMessage[] {
  const dir = inboxDir(sessionId);
  if (!existsSync(dir)) return [];
  const messages: InboxMessage[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    const path = join(dir, f);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (Value.Check(InboxMessageSchema, parsed)) {
        messages.push(parsed);
        if (consume) {
          try { unlinkSync(path); } catch { /* race with reader, ignore */ }
        }
      }
    } catch { /* corrupt file; skip + clean if consume */
      if (consume) { try { unlinkSync(path); } catch { /* */ } }
    }
  }
  messages.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  return messages;
}
