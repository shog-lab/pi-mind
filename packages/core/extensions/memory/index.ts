/**
 * pi-mind Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - before_agent_start → capture user prompt + inject L1 + L2 memories
 * - turn_end           → archive sessions (no tool-result capture)
 * - session_compact    → save compaction summary to raw/compaction/ + sync index
 *
 * Memory write paths (all originate from agent action in a visible turn — see
 * "Memory is passive" in the ecosystem AGENTS.md "Design Principles"):
 *   - remember_this tool   — explicit save by agent (typically in response to user)
 *   - observe tool         — explicit low-bar field note
 *   - session_compact      — periodic context-compression summary
 *
 * Two background memory writers were removed for violating "memory is passive":
 * the `agent_end` `worth-remembering-llm` detector (qwen3:4b via Ollama, which
 * decided whether a turn was worth saving and wrote silently), and the
 * `session_compact` classifier sub-agent that promoted each compaction summary
 * into a knowledge/ entry. Both were lifecycle-triggered LLMs writing curated
 * state with no user in the trigger chain. All curated memory now requires
 * explicit agent action in a visible turn (remember_this / observe), or
 * promotion via the memory-audit skill.
 */

import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, appendFileSync, unlinkSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiMindDir } from "@shog-lab/pi-utils";

import { MemoryCore } from "./core.js";
import { getAuditStatus, markAuditDone, renderAuditNotice, readMarker, summarizeTokensSince, AUDIT_INTERVAL_HOURS } from "./auto-audit.js";
import type { Subject, Tier } from "../../lib/schema.js";
import { encodeCwdPrefix, isOwnSessionDir } from "../../lib/session-archive.js";
import { storeImage } from "../../lib/image-store.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---

// Resolved once at module load. Respects $PI_MIND_DIR; otherwise points at the
// main repo's .pi-mind (via git-common-dir), so worktrees share state and
// memory survives worktree teardown.
const PI_MIND_DIR = resolvePiMindDir();
const DB_PATH = join(PI_MIND_DIR, ".pi-mind-index.db");

// --- Turn-state cache ---
//
// before_agent_start captures the user prompt into this module-level cache so
// `remember_this`, called later in the same turn, can attach it as context
// when saving a memory entry. The cache is overwritten each turn; multiple
// `remember_this` calls within a turn all see the same prompt.
let lastUserPrompt = "";

// --- Turn counter for session archival ---

const ARCHIVE_EVERY_N_TURNS = 10;
let turnCount = 0;

// --- Session archival ---

/** Where pi writes its session JSONL files (host-side, user home). */
function getSessionsDir(): string {
  return join(process.env.HOME ?? ".", ".pi", "agent", "sessions");
}

/** Where we archive sessions into pi-mind's raw store. */
function getArchiveSessionsDir(): string {
  return join(PI_MIND_DIR, "raw", "sessions");
}

/** Recursively copy .jsonl files from src to dest, preserving directory structure */
function copyRecursive(src: string, dest: string): number {
  let copied = 0;
  if (!existsSync(src)) return 0;
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copied += copyRecursive(join(src, entry), join(dest, entry));
    }
  } else if (stat.isFile() && src.endsWith(".jsonl")) {
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      copied++;
    }
  }
  return copied;
}

function archiveSession(): void {
  const sessionsDir = getSessionsDir();
  const archiveDir = getArchiveSessionsDir();
  if (!existsSync(sessionsDir)) return;

  // Only archive sessions whose cwd belongs to this host repo. pi's global
  // session directory (~/.pi/agent/sessions/) accumulates one subdir per cwd
  // across all repos *and* across all subprocess-spawned pi instances (eval
  // tempdirs, judge, our own L2 subagents). Without this filter every
  // .pi-mind/raw/sessions/ would end up as a full N-way redundant snapshot
  // of every cwd that ever ran pi on this machine.
  const hostRoot = dirname(PI_MIND_DIR); // <host-repo>/.pi-mind → <host-repo>
  const hostPrefix = encodeCwdPrefix(hostRoot);
  const excludePrefix = encodeCwdPrefix(PI_MIND_DIR);

  mkdirSync(archiveDir, { recursive: true });

  let copied = 0;
  for (const entry of readdirSync(sessionsDir)) {
    if (!isOwnSessionDir(entry, hostPrefix, excludePrefix)) continue;
    copied += copyRecursive(join(sessionsDir, entry), join(archiveDir, entry));
  }
  if (copied > 0) console.log(`[memory] archived ${copied} session file(s)`);
}

// --- Core singleton ---

let _core: MemoryCore | null = null;

function getCore(): MemoryCore {
  if (_core) return _core;
  _core = new MemoryCore({
    groupDir: PI_MIND_DIR,
    dbPath: DB_PATH,
  });
  _core.syncIndex();
  return _core;
}

// --- Maintenance log ---

// One-time alert on logMaintenance failure. The function intentionally swallows
// errors so a broken log doesn't crash the agent loop, but if it goes silent
// EVERY observability signal in pi-mind (compaction saves, forget runs,
// audit markers, image stores, etc.) silently disappears with it.
// One console.error per process makes the meta-failure visible without
// spamming if every subsequent write also fails.
let _logMaintenanceFailedOnce = false;

function logMaintenance(action: string, detail: Record<string, unknown>): void {
  const logDir = join(PI_MIND_DIR, "raw", "maintenance-log");
  try {
    mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `${date}.jsonl`);
    const entry = { timestamp: new Date().toISOString(), action, ...detail };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch (e) {
    if (!_logMaintenanceFailedOnce) {
      _logMaintenanceFailedOnce = true;
      console.error(`[pi-mind] maintenance-log write failed (subsequent failures suppressed): ${e instanceof Error ? e.message : String(e)}. All pi-mind observability is offline until this is fixed (check disk space / permissions on ${logDir}).`);
    }
  }
}

// --- Observation helper ---

/**
 * Write an episodic observation to raw/observations/<ts>_<slug>.jsonl-style
 * markdown file. Returns the absolute path written.
 *
 * Observations are intentionally lighter than knowledge entries:
 *   - No type/tier classification (they're all "notes")
 *   - No classification or lint pipeline
 *   - Frontmatter: date + tags only
 *   - Body: the note itself
 *
 * knowledge-lint / memory-audit periodically scan this directory and may
 * surface recurring observations for the agent to promote into knowledge/.
 */
function saveObservation(piMindDir: string, note: string, tags: string[]): string {
  const obsDir = join(piMindDir, "raw", "observations");
  mkdirSync(obsDir, { recursive: true });

  const ts = new Date();
  const tsSlug = ts.toISOString().replace(/[:.]/g, "-");
  // Build a short content-based slug for filename readability + light dedup
  // (two identical notes within the same second collide and only one wins).
  const contentSlug = note
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "note";
  const fileName = `${tsSlug}_${contentSlug}.md`;
  const fp = join(obsDir, fileName);

  const tagsLine = tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` : "";
  const body = `---\ndate: ${ts.toISOString()}\n${tagsLine}---\n\n${note}\n`;
  writeFileSync(fp, body, "utf-8");
  return fp;
}

// --- Extension ---

/** Resolve pi-mind's bundled system-prompt.md regardless of symlink chain.
 *
 * The compiled file sits at <pkg-root>/dist/extensions/memory/index.js, so we
 * need to climb THREE levels (memory → extensions → dist → pkg-root) to reach
 * the source-of-truth `system-prompt.md` at the package root. An earlier
 * version of this function used only two — that resolved to dist/system-prompt.md,
 * which never exists, so readFileSync threw and the whole "inject pi-mind's
 * system prompt into the agent" mechanism silently no-op'd for the entire
 * dev cycle. Every edit to system-prompt.md was effectively a doc change
 * with no runtime effect until this fix landed.
 */
function loadSystemPrompt(): string | null {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const promptPath = join(dirname(here), "..", "..", "..", "system-prompt.md");
    return readFileSync(promptPath, "utf-8");
  } catch {
    return null;
  }
}

export default function memExtension(pi: ExtensionAPI) {
  // Inject pi-mind's memory rules into the agent's system context.
  // Falls back silently if pi version doesn't expose injectContext at extension level —
  // README documents `pi --append-system-prompt "$(cat node_modules/pi-mind/system-prompt.md)"` as workaround.
  const systemPrompt = loadSystemPrompt();
  if (systemPrompt && pi.injectContext) {
    pi.injectContext(systemPrompt);
  }

  // Memory-maintenance startup hook: surface "audit overdue" status as a context note.
  // Agent decides when to honor — typically before substantive work in this session.
  // The hook does NOT run the audit itself; memory-audit is an LLM-executed skill.
  // Caller signals completion via mark_daily_audit_complete tool below.
  // (Tool name is historical — will be renamed mark_memory_audit_complete in a
  // future breaking release to match the renamed skill.)
  pi.registerTool({
    name: "mark_daily_audit_complete",
    label: "Mark Memory Audit Complete",
    description:
      "Call this once after running the memory-audit skill end-to-end. Updates the audit timestamp so the overdue notice is silenced for the next 24 hours. Pass an optional one-line summary that will surface in the next audit notice. (Tool name is mark_daily_audit_complete for historical reasons — skill was renamed daily-audit → memory-audit; tool will follow in next breaking release.)",
    parameters: { type: "object", properties: { summary: { type: "string", description: "Optional one-line summary of audit findings" } } },
    async execute(_id: string, params: { summary?: string }) {
      markAuditDone(PI_MIND_DIR, params.summary);
      return { content: [{ type: "text" as const, text: "Memory audit marked complete. Next overdue check in 24h." }], details: {} };
    },
  });

  pi.registerTool({
    name: "remember_this",
    label: "Remember This",
    description: [
      "Save a piece of content to long-term memory. CALL THIS ONLY when:",
      "  - The user explicitly asks to remember / save something",
      "    (e.g. \"记一下\", \"save this\", \"remember this\", \"把这个记下来\")",
      "  - You just fetched a substantive fact via tool (article, doc, code, data)",
      "    that has lasting value beyond this conversation",
      "",
      "DO NOT CALL for:",
      "  - Normal task work or status updates",
      "  - Anything you can re-derive from current code / context",
      "  - Content already discussed earlier in this conversation",
      "",
      "There is NO background auto-capture. If you don't call remember_this",
      "(or observe) for something, it isn't saved. When in doubt, prefer to",
      "save explicit, high-signal items.",
      "",
      "Saved content must be SELF-CONTAINED: a future agent reading only this",
      "entry (without conversation history) should understand it.",
      "",
      "If passing image_path, content MUST include a description of what's in",
      "the image (describe it yourself from what you can see). The image",
      "itself is stored alongside the entry; without a textual description",
      "the entry is not retrievable — FTS5 and vector search only see text.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Self-contained text to save. Do not reference conversation context with phrases like \"as I said\" or \"that thing above\". If saving alongside an image, include a description of the image." },
        type: { type: "string", enum: ["user", "project", "reference", "agent-feedback"], description: "Subject. Default: reference. Use 'user' for user preferences/constraints, 'project' for project facts / architecture / decisions, 'agent-feedback' for your own decisions/insights." },
        tier: { type: "string", enum: ["L1", "L2"], description: "L1 = always injected next session (use sparingly, only for durable preferences). L2 = retrieved by relevance (default)." },
        tags: { type: "array", items: { type: "string" }, description: "1-3 topic keywords to aid future retrieval." },
        image_path: { type: "string", description: "Optional absolute path to an image (.png/.jpg/.jpeg/.gif/.webp). The file will be copied into pi-mind's content-addressed image store and linked from the memory entry. Files >2MB are auto-compressed; >20MB are rejected." },
      },
      required: ["content"],
    },
    async execute(_id: string, params: { content: string; type?: string; tier?: string; tags?: string[]; image_path?: string }) {
      const validTypes = new Set(["user", "reference", "agent-feedback"]);
      const type = (params.type && validTypes.has(params.type) ? params.type : "reference") as Subject;
      const tier = (params.tier === "L1" ? "L1" : "L2") as Tier;
      const tags = Array.isArray(params.tags) ? params.tags.filter((t) => typeof t === "string").slice(0, 5) : undefined;

      // Image handling: validate + (optionally compress) + copy into raw/images/.
      // If image storage fails, abort the entire save — agent decided the image
      // was worth keeping, so a description-only save would silently lose that.
      let imageRelPath: string | undefined;
      if (params.image_path) {
        const result = await storeImage(params.image_path, PI_MIND_DIR);
        if (!result.ok) {
          logMaintenance("remember-this-image-error", { reason: result.reason, detail: result.detail.slice(0, 200) });
          return { content: [{ type: "text" as const, text: `image storage failed (${result.reason}): ${result.detail}` }], details: {}, isError: true as const };
        }
        imageRelPath = result.relPath;
        logMaintenance("remember-this-image-stored", { relPath: result.relPath, bytes: result.bytes, compressed: result.compressed });
      }

      try {
        const fp = await getCore().saveMemory({
          type,
          primary: params.content,
          context: { userPrompt: lastUserPrompt || undefined },
          tier,
          tags,
          source: "explicit",
          image: imageRelPath,
        });
        const text = fp
          ? (imageRelPath ? `Saved to ${fp} (image at ${imageRelPath})` : `Saved to ${fp}`)
          : "Skipped (duplicate of existing memory)";
        logMaintenance("remember-this", { saved: !!fp, type, tier, hasImage: !!imageRelPath });
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Save failed: ${String(e)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "recall_memory",
    label: "Recall Memory",
    description: [
      "Search long-term memory for entries relevant to a query. Returns a",
      "formatted context block with the top matches across vector, FTS5,",
      "[[link]] graph expansion, and knowledge-graph entity facts.",
      "",
      "Use this when:",
      "  - You need to verify a fact mid-task that the auto-injected memory didn't surface",
      "  - The user references a past discussion / preference / decision and you want to look it up",
      "  - You're about to make a decision and want to know if past memory has bearing",
      "  - A tool result mentions an entity (person, project, term) you may already know about",
      "",
      "Do NOT use this when:",
      "  - The auto-injected memory at turn start already answered the question",
      "  - You're just exploring; trust the auto-RAG unless you have a specific gap",
      "",
      "Returns an empty result silently if nothing relevant matches.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query. Be specific — vague queries return noise." },
        max_results: { type: "number", description: "Soft cap on retrieved entries. Default and recommended: leave unset; the pipeline applies its own token budget." },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; max_results?: number }) {
      try {
        // skipL1: L1 entries were already injected at turn start; emitting
        // them again from the tool just duplicates context the agent has.
        const ctx = await getCore().buildContext(params.query, { skipL1: true });
        logMaintenance("recall-memory", { hit: !!ctx, queryLen: params.query.length });
        const text = ctx || "(no relevant memory found)";
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (e) {
        logMaintenance("recall-memory-error", { error: String(e) });
        return { content: [{ type: "text" as const, text: `recall_memory failed: ${String(e)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "observe",
    label: "Observe",
    description: [
      "Log a quick observation to long-term episodic memory.",
      "",
      "Use this for things you noticed that aren't ready to commit as durable",
      "knowledge — half-formed hypotheses, friction signals, things worth",
      "checking later. Lower bar than remember_this: observations are messy",
      "field notes, not curated facts.",
      "",
      "Call when:",
      "  - You spotted something surprising mid-task (\"the test passed but",
      "    only because the fixture had a typo\")",
      "  - You noticed a pattern across multiple turns (\"this is the third",
      "    time the user has rejected suggestions starting with 'maybe'\")",
      "  - A tool result hinted at something worth follow-up later",
      "",
      "Don't call for status updates, task progress, or anything already",
      "covered by remember_this (concrete facts). Observations are",
      "intentionally lossy — knowledge-lint / memory-audit may later promote",
      "recurring observations to knowledge.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "Self-contained observation. One paragraph, no conversation references." },
        tags: { type: "array", items: { type: "string" }, description: "1-3 topic keywords." },
      },
      required: ["note"],
    },
    async execute(_id: string, params: { note: string; tags?: string[] }) {
      const tags = Array.isArray(params.tags) ? params.tags.filter((t) => typeof t === "string").slice(0, 5) : [];
      try {
        const fp = saveObservation(PI_MIND_DIR, params.note, tags);
        logMaintenance("observe", { file: fp });
        return { content: [{ type: "text" as const, text: `Observed → ${fp}` }], details: {} };
      } catch (e) {
        logMaintenance("observe-error", { error: String(e) });
        return { content: [{ type: "text" as const, text: `observe failed: ${String(e)}` }], details: {} };
      }
    },
  });

  // On compaction: persist the summary to raw/compaction/ and refresh the index.
  //
  // syncIndex scans raw/ as well as knowledge/, so the saved summary is
  // immediately retrievable on its own (FTS5 + vector, type=compaction, L2).
  // There is no background "promote to knowledge/" step: a fire-and-forget
  // classifier sub-agent used to run here, but it was removed — it was a
  // background curator (lifecycle-triggered LLM writing knowledge with no user
  // in the chain), which violates the "Memory is passive" / "trigger chain must
  // originate from user action" principles in AGENTS.md. Promotion of a
  // compaction summary into durable knowledge/, when wanted, happens via the
  // memory-audit skill in a visible turn. Unpromoted summaries age out of
  // raw/compaction/ via the normal retention policy.
  pi.on("session_compact", async (event) => {
    const summary = event.compactionEntry.summary;

    try {
      await getCore().saveMemory({ type: "compaction", primary: summary, source: "compaction" });
      await getCore().syncIndex();
      logMaintenance("compaction-saved", { synced: true });
    } catch (e) {
      console.error("[memory] saveMemory/syncIndex failed:", e);
      logMaintenance("compaction-error", { error: String(e) });
    }
  });

  // turn_end: archive session every N turns. We intentionally do NOT capture
  // event.toolResults: pi-mind's own tools (remember_this etc.) would feed
  // their results back into our detector, and the agent's message already
  // contains the curated digest of anything external tools returned.
  pi.on("turn_end", () => {
    turnCount++;
    if (turnCount % ARCHIVE_EVERY_N_TURNS === 0) {
      try { archiveSession(); } catch {}
    }
  });

  // (No agent_end handler. Memory writes are passive — explicit only via
  // remember_this / observe. The "memory is passive" principle in
  // AGENTS.md "Design Principles" replaced the prior worth-remembering-llm
  // auto-capture path in 0.6.0.)

  // Inject memories before agent starts processing
  pi.on("before_agent_start", async (event) => {
    const userText = (event as { prompt?: string }).prompt ?? "";

    // Cache the user prompt so remember_this / observe (called later in this
    // turn) can attach it as context when saving. Overwritten each turn.
    lastUserPrompt = userText;

    const mc = getCore();
    // syncIndex is self-locking — safe without outer lock wrapper
    await mc.syncIndex();

    const parts: string[] = [];

    // Memory maintenance: surface audit-overdue status, plus token spend since last audit
    const auditStatus = getAuditStatus(PI_MIND_DIR);
    let tokenSummary;
    if (auditStatus.overdue) {
      const marker = readMarker(PI_MIND_DIR);
      // If we've never run an audit, fall back to a 24h window so the number
      // is bounded and meaningful rather than "all time".
      const sinceMs = marker?.lastRun ?? (Date.now() - AUDIT_INTERVAL_HOURS * 3600_000);
      tokenSummary = summarizeTokensSince(PI_MIND_DIR, sinceMs);
    }
    const auditNotice = renderAuditNotice(auditStatus, tokenSummary);
    if (auditNotice) parts.push(auditNotice);

    // Hybrid retrieval: L1 + vector (primary) / FTS5 (fallback) +
    // [[link]] expansion + KG entity facts. Delegates to MemoryCore's
    // buildContext so the hook and the recall_memory tool share a single
    // pipeline implementation.
    const hybridContext = await mc.buildContext((event as { prompt?: string }).prompt ?? "");
    if (hybridContext) parts.push(hybridContext);

    if (parts.length > 0) {
      event.injectContext?.(parts.join("\n"));
    }
  });
}
