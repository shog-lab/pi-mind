/**
 * pi-bus extension — inter-pi messaging primitive.
 *
 * Every pi process loading this extension auto-joins a per-repo "bus":
 *   - Registers itself under .pi-mind/bus/sessions/<id>/meta.json
 *   - Watches its own inbox/ for incoming messages
 *   - Heartbeats every 30s; stale sessions (>90s) filtered out by others
 *
 * 3 LLM-facing tools:
 *   - agent_list:  who else is live in this repo's bus
 *   - agent_send:  drop a message into another session's inbox
 *   - agent_inbox: read your own inbox (mostly redundant — incoming messages
 *                  auto-trigger your agent via pi.sendUserMessage)
 *
 * When a message lands in your inbox, pi-bus calls pi.sendUserMessage with
 * deliverAs:"followUp" — your agent treats it as if a user typed
 * `[from <sender>] <body>` and starts a turn. This is how an idle pi gets
 * woken up by another pi.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
  renameSync, rmSync, statSync, watch as fsWatch, type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiMindDir } from "@shog-lab/pi-utils";

// --- Constants ---

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const MAX_BODY_BYTES = 16_000;       // cap inbound message body to avoid silly abuse

// --- Schemas ---

const SessionMetaSchema = Type.Object({
  name: Type.String(),
  pid: Type.Number(),
  cwd: Type.String(),
  joinedAt: Type.String(),
  heartbeatAt: Type.String(),
});
type SessionMeta = Static<typeof SessionMetaSchema>;

const InboxMessageSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  body: Type.String(),
  sentAt: Type.String(),
});
type InboxMessage = Static<typeof InboxMessageSchema>;

// --- Friendly name generation ---

const ADJECTIVES = [
  "calm", "bold", "wry", "quiet", "swift", "keen", "deft", "vivid",
  "gentle", "stark", "amber", "azure", "indigo", "scarlet", "olive", "violet",
];
const ANIMALS = [
  "fox", "owl", "lynx", "wolf", "raven", "otter", "hawk", "swan",
  "mole", "bear", "crow", "moth", "deer", "lark", "hare", "vole",
];

function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${adj}-${animal}-${suffix}`;
}

function generateMsgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Paths ---

function busRoot(): string {
  return join(resolvePiMindDir(), "bus");
}

function sessionsRoot(): string {
  return join(busRoot(), "sessions");
}

function ownSessionDir(sessionId: string): string {
  return join(sessionsRoot(), sessionId);
}

// --- Session registry I/O ---

function readMeta(sessionId: string): SessionMeta | null {
  const p = join(sessionsRoot(), sessionId, "meta.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (Value.Check(SessionMetaSchema, parsed)) return parsed;
  } catch { /* corrupt file → treat as missing */ }
  return null;
}

function writeMeta(sessionId: string, meta: SessionMeta): void {
  const dir = ownSessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "inbox"), { recursive: true });
  // Atomic via tmp+rename to avoid readers seeing half-written meta.
  const tmp = join(dir, "meta.json.tmp");
  const final = join(dir, "meta.json");
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, final);
}

/** List live sessions (stale-filtered). Excludes `excludeId` if given (yourself). */
function listLiveSessions(excludeId?: string): SessionMeta[] {
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
function findByName(name: string, excludeId?: string): { id: string; meta: SessionMeta } | { error: string } {
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

// --- Inbox I/O ---

function inboxDir(sessionId: string): string {
  return join(sessionsRoot(), sessionId, "inbox");
}

function writeInboxMessage(targetSessionId: string, msg: InboxMessage): void {
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

function readInbox(sessionId: string, consume: boolean): InboxMessage[] {
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

// --- Tool parameter schemas ---

const AgentListParams = Type.Object({});
const AgentSendParams = Type.Object({
  to: Type.String({ description: "Recipient agent's name (from agent_list)" }),
  body: Type.String({ description: "Message body (text only, capped at 16KB)" }),
});
const AgentInboxParams = Type.Object({
  consume: Type.Optional(Type.Boolean({
    description: "If true, delete messages after reading (default false). " +
      "Normally you don't need to call this tool at all — incoming messages " +
      "auto-trigger your agent via [from <name>] user messages.",
  })),
});

// --- Extension entry ---

export default function busExtension(pi: ExtensionAPI) {
  // Derive own identity. PI_AGENT_NAME env wins; otherwise auto-generate.
  const sessionId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const name = process.env.PI_AGENT_NAME?.trim() || generateName();
  const cwd = process.cwd();
  const joinedAt = new Date().toISOString();

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let shuttingDown = false;
  const processedMsgIds = new Set<string>();   // dedup against fs.watch firing twice

  function updateHeartbeat(): void {
    if (shuttingDown) return;
    try {
      writeMeta(sessionId, {
        name, pid: process.pid, cwd, joinedAt,
        heartbeatAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[pi-bus] heartbeat write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function deliverIncoming(msg: InboxMessage): void {
    if (processedMsgIds.has(msg.id)) return;
    processedMsgIds.add(msg.id);
    // Keep processedMsgIds bounded; LRU via simple size cap.
    if (processedMsgIds.size > 1000) {
      const oldest = processedMsgIds.values().next().value;
      if (oldest) processedMsgIds.delete(oldest);
    }
    // Hand the message off as if the user typed it. deliverAs:"followUp" waits
    // until the agent is fully idle (no pending tool calls) before injecting —
    // so it never interrupts a real user mid-conversation.
    const text = `[from ${msg.from}] ${msg.body}`;
    void pi.sendUserMessage(text, { deliverAs: "followUp" });
    // Delete the inbox file so it's not re-delivered if fs.watch fires again
    // or on next startup.
    try { unlinkSync(join(inboxDir(sessionId), `${msg.id}.json`)); }
    catch { /* may have been consumed via agent_inbox tool */ }
  }

  function startInboxWatch(): void {
    const dir = inboxDir(sessionId);
    if (!existsSync(dir)) return;
    try {
      watcher = fsWatch(dir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".json") || filename.endsWith(".tmp")) return;
        const path = join(dir, filename);
        if (!existsSync(path)) return;
        try {
          const parsed = JSON.parse(readFileSync(path, "utf-8"));
          if (Value.Check(InboxMessageSchema, parsed)) {
            deliverIncoming(parsed);
          }
        } catch { /* mid-write; will fire again on next event */ }
      });
    } catch (e) {
      console.warn(`[pi-bus] fs.watch failed (incoming messages won't auto-trigger): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
    try { rmSync(ownSessionDir(sessionId), { recursive: true, force: true }); } catch { /* */ }
  }

  // --- Lifecycle ---

  updateHeartbeat();
  heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat.
  heartbeatTimer.unref();
  startInboxWatch();
  // On startup, drain any messages that landed while pi wasn't running.
  for (const msg of readInbox(sessionId, false)) deliverIncoming(msg);

  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(130); });
  process.on("SIGTERM", () => { shutdown(); process.exit(143); });

  // pi unloads and rebuilds the extension instance on /reload (and on
  // new/resume/fork) WITHOUT exiting the process, so the signal handlers above
  // never fire. Without cleaning up here, reload would leave this instance's
  // session dir behind while session_start registers a fresh one under a new
  // random id — same pid, two live bus identities, which makes agent_send to
  // this name fail as "ambiguous". Clean up our session dir on shutdown; the
  // rebuilt instance registers anew in its own session_start.
  pi.on("session_shutdown", () => { shutdown(); });

  console.log(`[pi-bus] joined as "${name}" (id=${sessionId.slice(0, 12)}…)`);

  // --- Tools ---

  // `details` is uniformly `{}` across all tools — TS narrows the generic
  // result type to whatever the FIRST returned shape is, and divergent shapes
  // across success/error branches break inference. All actionable info lives
  // in `content[].text` instead.

  pi.registerTool({
    name: "agent_list",
    label: "List Agents",
    description:
      "List other pi sessions live in the same repo's bus. " +
      "Each entry has { name, pid, cwd, joinedAt, heartbeatAt }. " +
      "Use the `name` field with agent_send.",
    parameters: AgentListParams,
    async execute(_id: string, _params: Static<typeof AgentListParams>) {
      const live = listLiveSessions(sessionId);
      const lines = live.length === 0
        ? [`(no other agents live; you are "${name}")`]
        : [
          `## Live agents (${live.length}) — you are "${name}"`,
          ...live.map((m) =>
            `- ${m.name}  pid=${m.pid}  cwd=${m.cwd}  joined=${m.joinedAt}  lastBeat=${m.heartbeatAt}`
          ),
        ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "Send Message to Another Agent",
    description:
      "Send a text message to another live pi agent (by name). The recipient's " +
      "agent will be triggered to start a turn with your message (`[from <yourName>] <body>`) " +
      "next time it's idle. Fire-and-forget — if you want a reply, ask them to use agent_send back.",
    parameters: AgentSendParams,
    async execute(_id: string, params: Static<typeof AgentSendParams>) {
      const body = params.body.slice(0, MAX_BODY_BYTES);
      const found = findByName(params.to, sessionId);
      if ("error" in found) {
        return {
          content: [{ type: "text" as const, text: `Error: ${found.error}` }],
          details: {},
          isError: true,
        };
      }
      const msg: InboxMessage = {
        id: generateMsgId(),
        from: name,
        body,
        sentAt: new Date().toISOString(),
      };
      try {
        writeInboxMessage(found.id, msg);
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to deliver: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Sent ${msg.id} to ${params.to} (${body.length} chars)` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_inbox",
    label: "Read Own Inbox",
    description:
      "Read messages currently in your own inbox. Mostly redundant — incoming " +
      "messages auto-appear as user messages prefixed `[from <name>]`. Use this " +
      "only when you want to explicitly enumerate/consume pending messages.",
    parameters: AgentInboxParams,
    async execute(_id: string, params: Static<typeof AgentInboxParams>) {
      const messages = readInbox(sessionId, params.consume ?? false);
      const lines = messages.length === 0
        ? ["(inbox empty)"]
        : [
          `## Inbox (${messages.length} message${messages.length === 1 ? "" : "s"})${params.consume ? " — consumed" : ""}`,
          ...messages.map((m) => `- [${m.sentAt}] from ${m.from}: ${m.body}`),
        ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
