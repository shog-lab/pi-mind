/**
 * pi-mind Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - before_agent_start → capture user prompt + inject L1 + L2/L3 memories
 * - turn_end           → archive sessions + capture toolResults into turn state
 * - agent_end          → run worth-remembering detector + save high-signal memories
 * - session_compact    → save compaction summary + B+D+F maintenance
 *
 * Memory write paths:
 *   worth-remembering-llm @ agent_end — automatic capture (replaces old feedback-llm)
 *   remember_this tool                — explicit save by agent / user-prompted agent
 *   session_compact                    — periodic context-compression summary
 */

import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, appendFileSync, unlinkSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, resolvePiMindDir } from "@shog-lab/pi-utils";

import { MemoryCore } from "./core.js";
import { getAuditStatus, markAuditDone, renderAuditNotice, readMarker, summarizeTokensSince, AUDIT_INTERVAL_HOURS } from "./auto-audit.js";
import type { Subject, Tier } from "../../lib/schema.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---

// Resolved once at module load. Respects $PI_MIND_DIR; otherwise points at the
// main repo's .pi-mind (via git-common-dir), so worktrees share state and
// memory survives worktree teardown.
const PI_MIND_DIR = resolvePiMindDir();
const DB_PATH = join(PI_MIND_DIR, ".pi-mind-index.db");
const LEGACY_MEMORY_DIR = join(PI_MIND_DIR, "memory");
const LEGACY_LLM_WIKI_DIR = join(PI_MIND_DIR, "llm-wiki");
const MIN_SCORE_THRESHOLD = 0.001;

// --- Semaphore for concurrent L2 task limiting ---

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private maxConcurrent: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) { this.running++; next(); }
  }
}

let _semaphore: Semaphore | null = null;
function getSemaphore(): Semaphore {
  if (!_semaphore) _semaphore = new Semaphore(getCore().config.semaphore.maxConcurrent);
  return _semaphore;
}

// --- Worth-remembering detection (LLM-only) ---
//
// Replaces the old feedback-llm path. Single detector runs at agent_end:
// looks at the full turn (user prompt + agent messages + tool results) and
// decides whether anything is worth crystallizing into long-term memory.
//
// Sub-classifies into one of the existing Subject types. Absorbs the four
// feedback sub-types (correction/complaint/preference/self-admission) as
// well as new sources (agent reflections, tool-fetched facts, decisions).
//
// Same operational shape as the old feedback-llm: async fire-and-forget,
// 3s timeout, format:json, silent on failure. Logs every decision for audit.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
// Default to qwen3:4b: the verifier (scripts/verify-worth-remembering.ts)
// shows 7/7 on this prompt vs 1.5B's 5/7 — qwen2.5:1.5b is overeager and
// false-positives on casual chat / status updates with the multi-class
// worth-remembering schema. Calls are async fire-and-forget, so the extra
// latency (a few hundred ms) does not affect the user-facing agent loop.
// Override with PI_MIND_LLM_MODEL=qwen2.5:1.5b if the larger model isn't pulled.
const LLM_MODEL = process.env.PI_MIND_LLM_MODEL || "qwen3:4b";

const WORTH_REMEMBERING_SUBJECTS = ["user", "project", "agent-feedback", "reference"] as const;

interface WorthRememberingResult {
  shouldRemember: boolean;
  type: typeof WORTH_REMEMBERING_SUBJECTS[number];
  primary: string;
  tier: "L1" | "L2";
  suggestedTags: string[];
}

function truncateForLLM(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 20) + "\n...[truncated]";
}

async function detectWorthRemembering(input: {
  userPrompt: string;
  agentMessagesText: string;
  toolResultsText: string;
}): Promise<WorthRememberingResult | null> {
  // Per-call timeout: qwen3:4b is slower than 1.5B; give it more headroom
  // before treating the response as a miss. Async fire-and-forget anyway,
  // so timeout only affects observability ("did the LLM finish before we gave up").
  const timeoutMs = LLM_MODEL.startsWith("qwen2.5:1.5b") ? 3_000 : 8_000;
  const prompt = [
    "判断这一轮交互里有没有值得长期记忆的内容。",
    "",
    "===== 应该 remember 的（true）=====",
    "",
    "A. 用户偏好 / 纠错 / 抱怨（type=user）",
    "  例：「我更喜欢 ripgrep」「不对，应该用 git revert」「抱歉我刚才说错了」",
    "  → true",
    "",
    "B. 工具拿回新事实，跨会话有复用价值（type=reference）",
    "  例：agent 读了一篇文章，要点是「Rust 借用检查在编译期保证内存安全」",
    "  → true",
    "",
    "C. agent 自己做了非显然决策 / 反思（type=agent-feedback 或 project）",
    "  例：「决定用 polling 而不是 webhook，因为 webhook 需要公网 IP」",
    "  → true",
    "",
    "===== 一律 false =====",
    "",
    "D. 状态汇报 / 进度更新（跑完了 / 通过了 / OK 我去做）",
    "E. 一次性查询的答案（今天天气 / 现在几点 — 明天就不准了）",
    "F. 闲聊 / 寒暄（你好 / 谢谢 / 天气不错）",
    "G. 普通工作流（用户给任务 + agent 完成，没新规则没新事实）",
    "",
    "type: user | project | agent-feedback | reference",
    "tier: L1（仅持久用户偏好，保守用）| L2（默认）",
    "",
    `=== user prompt ===\n${truncateForLLM(input.userPrompt, 800)}`,
    "",
    `=== agent messages ===\n${truncateForLLM(input.agentMessagesText, 2000)}`,
    "",
    `=== tool results ===\n${truncateForLLM(input.toolResultsText, 1200)}`,
    "",
    '输出 JSON: {"shouldRemember": bool, "type": "user|project|agent-feedback|reference", "primary": "一句话自包含浓缩", "tier": "L1|L2", "suggestedTags": ["1-3个topic词"]}',
  ].join("\n");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LLM_MODEL, format: "json", messages: [{ role: "user", content: prompt }], stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as { message?: { content?: string } };
    const raw = (data.message?.content ?? "").trim();

    try {
      const json = JSON.parse(raw);
      const shouldRemember = json.shouldRemember === true;
      if (!shouldRemember) return { shouldRemember: false, type: "reference", primary: "", tier: "L2", suggestedTags: [] };

      const type = (WORTH_REMEMBERING_SUBJECTS as readonly string[]).includes(json.type) ? json.type : "reference";
      const tier = json.tier === "L1" ? "L1" : "L2";
      const primary = typeof json.primary === "string" ? json.primary.trim() : "";
      if (!primary) return null;
      const suggestedTags = Array.isArray(json.suggestedTags)
        ? json.suggestedTags.filter((t: unknown) => typeof t === "string").slice(0, 3)
        : [];
      return { shouldRemember: true, type, primary, tier, suggestedTags };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// --- Turn-state cache (per pi process, single agent loop at a time) ---
//
// Captured across hooks so agent_end can see what happened during the turn:
//   before_agent_start → sets lastUserPrompt
//   turn_end           → appends serialized toolResults
//   agent_end          → consumes both, then resets
let lastUserPrompt = "";
let lastToolResults: string[] = [];

function summarizeToolResult(tr: unknown): string {
  if (typeof tr === "string") return tr.slice(0, 300);
  try {
    return JSON.stringify(tr).slice(0, 300);
  } catch {
    return String(tr).slice(0, 300);
  }
}

function serializeAgentMessages(messages: unknown[]): string {
  return messages
    .map((m) => {
      if (typeof m === "object" && m !== null) {
        const msg = m as { role?: string; content?: unknown };
        const role = msg.role ?? "?";
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        return `[${role}] ${content}`;
      }
      return String(m);
    })
    .join("\n")
    .slice(0, 4000);
}

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
  mkdirSync(archiveDir, { recursive: true });
  const copied = copyRecursive(sessionsDir, archiveDir);
  if (copied > 0) console.log(`[memory] archived ${copied} session file(s)`);
}

// --- Core singleton ---

let _core: MemoryCore | null = null;

function getCore(): MemoryCore {
  if (_core) return _core;
  _core = new MemoryCore({
    groupDir: PI_MIND_DIR,
    dbPath: DB_PATH,
    legacyMemoryDir: existsSync(LEGACY_MEMORY_DIR) ? LEGACY_MEMORY_DIR : undefined,
  });
  if (existsSync(LEGACY_LLM_WIKI_DIR)) {
    _core.migrateLegacyLlmWiki(LEGACY_LLM_WIKI_DIR);
  }
  _core.syncIndex();
  recoverPendingSpawns(_core);
  return _core;
}

// --- Maintenance log ---

function logMaintenance(action: string, detail: Record<string, unknown>): void {
  const logDir = join(PI_MIND_DIR, "raw", "maintenance-log");
  try {
    mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `${date}.jsonl`);
    const entry = { timestamp: new Date().toISOString(), action, ...detail };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {}
}

// --- L2 spawn helpers ---

let _spawnId = 0;

/**
 * Fire-and-forget L2 spawn with file-based stdio and ack-file handshake.
 *
 * Uses shared spawnPi with stdoutFile for fire-and-forget semantics.
 * Acknowledgement via ack-file: L2 touches ${id}.done after writing result.
 * Sweep at next hook invocation checks for ack and quarantines orphans.
 */
function spawnL2Task(taskType: "B" | "F", params: Record<string, unknown>): void {
  const id = `${Date.now()}-${String(_spawnId++).padStart(4, "0")}`;
  const logDir = join(PI_MIND_DIR, "raw", "maintenance-log");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${id}.log`);
  const ackPath = join(logDir, `${id}.done`);

  // Register in memory Map — sweep reads from here, not jsonl
  getCore().pendingSpawns.set(id, { id, taskType, ackPath, timestamp: Date.now() });

  const systemPrompt = taskType === "B"
    ? [
        "You are a memory classifier sub-agent.",
        "Classify each memory by subject: who is this memory about?",
        "",
        "## user — User preferences, requests, or constraints",
        "When: The user explicitly asked for something or stated a preference/constraint",
        'Examples: "用户希望用 pm2 管理进程" / "用户要求不提命令行"',
        "",
        "## project — Project code, architecture, or technical decisions",
        "When: The content is about project structure, code, files, or how the system works",
        'Examples: "代码迁移到了 raw/compaction/" / "项目用 Docker 管理"',
        "",
        "## agent-feedback — Agent's own suggestions, decisions, or reflections",
        "When: The agent recommends something, decides an approach, or reflects on what was done",
        'Examples: "我建议用 subject tag 分类" / "决定把 compaction 移出 knowledge"',
        "",
        "## reference — External knowledge, docs, or research",
        "When: The content is about reading papers, docs, or external information",
        'Examples: "读了一篇关于 agent memory 的论文"',
        "",
        "Rules:",
        `- Write to <PI_MIND_DIR>/knowledge/<slug>-${id}.md  (id at end of filename for traceability)`,
        "- Use frontmatter: date, type=<subject>, tier=L2",
        "- Example: date: 2026-05-08, type: project, tier: L2",
        "",
        `After writing the knowledge file, write a single JSON line to:`,
        `${ackPath}`,
        `The JSON line should be: {"type": "<subject>", "knowledgeFile": "<absolute path written>"}`,
        "",
        `<PI_MIND_DIR> is ${PI_MIND_DIR}`,
      ].join("\n")
    : [
        "You are a skill synthesizer sub-agent.",
        "Read the provided goal and related compaction summaries, then generate a useful SKILL.md.",
        "",
        "Rules:",
        "- Extract constraints, decisions, typical next steps from the summaries",
        "- Generate concrete, actionable skill content",
        `- Write to <PI_MIND_DIR>/skills/<slug>-${id}/SKILL.md  (id at end of dirname for traceability)`,
        "",
        `After writing the SKILL.md file, write a single JSON line to:`,
        `${ackPath}`,
        `The JSON line should be: {"skillName": "<slug>", "skillFile": "<absolute path written>"}`,
        "",
        `<PI_MIND_DIR> is ${PI_MIND_DIR}`,
      ].join("\n");

  const taskPrompt = taskType === "B"
    ? `Classify this summary:\n\n${params.summary}\n\nWrite the knowledge file, then echo the JSON line to ${ackPath}.`
    : `Goal: ${params.goal}\n\nRelated compaction summaries:\n${params.summaries}\n\nWrite SKILL.md, then echo the JSON line to ${ackPath}.`;

  // Log before spawn (sweep reads from pending Map, not log timing)
  logMaintenance(`${taskType}-spawn`, { id, taskType, ackPath, pid: 0 });

  spawnPi({
    cwd: PI_MIND_DIR,
    args: [
      "-p",
      "--no-extensions",
      "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
      "--append-system-prompt", systemPrompt,
      taskPrompt,
    ],
    stdoutFile: logPath,
    timeoutMs: 120_000,
  }).then((result) => {
    // Memory tracks token usage of its own L2 spawns for audit. No enforcement here —
    // ralph owns budget circuit-breaking; memory just records what it spent.
    if (result.tokens) {
      logMaintenance(`${taskType}-tokens`, {
        id,
        code: result.code,
        killed: result.killed,
        tokens: result.tokens,
      });
    }
  }).catch(() => { /* fire-and-forget; sweep handles ack-based outcome */ });
}

// --- Startup recovery ---

/** Read today + yesterday jsonl to recover pending spawns after restart */
function recoverPendingSpawns(core: MemoryCore): void {
  const logDir = join(PI_MIND_DIR, "raw", "maintenance-log");
  if (!existsSync(logDir)) return;

  const now = new Date();
  const dates = [
    now.toISOString().slice(0, 10),
    new Date(now.getTime() - 86400000).toISOString().slice(0, 10),
  ];

  for (const date of dates) {
    const logFile = join(logDir, `${date}.jsonl`);
    if (!existsSync(logFile)) continue;
    try {
      const content = readFileSync(logFile, "utf-8");
      for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.action === "B-spawn" || entry.action === "F-spawn") {
            if (!core.pendingSpawns.has(entry.id)) {
              core.pendingSpawns.set(entry.id, {
                id: entry.id,
                taskType: entry.taskType,
                ackPath: entry.ackPath,
                timestamp: new Date(entry.timestamp).getTime(),
              });
            }
          } else if (
            entry.action === "B-confirmed" || entry.action === "F-confirmed" ||
            entry.action === "B-lost" || entry.action === "F-lost"
          ) {
            core.pendingSpawns.delete(entry.id);
          }
        } catch {}
      }
    } catch {}
  }
}

// --- Sweep and quarantine ---

/** Sweep pending L2 spawns — check ack files, quarantine orphans */
function sweepSpawns(): void {
  const SWEEP_THRESHOLD_MS = 5 * 60 * 1000;

  const pending = getCore().pendingSpawns;
  const toDelete: string[] = [];

  for (const [id, spawn] of pending) {
    if (Date.now() - spawn.timestamp < SWEEP_THRESHOLD_MS) continue;

    toDelete.push(id);

    if (existsSync(spawn.ackPath)) {
      try {
        const raw = readFileSync(spawn.ackPath, "utf-8").trim();
        const ack = JSON.parse(raw);
        unlinkSync(spawn.ackPath);
        logMaintenance(`${spawn.taskType}-confirmed`, { id, knowledgeFile: ack.knowledgeFile ?? ack.skillFile });
      } catch {
        try { unlinkSync(spawn.ackPath); } catch {}
        quarantineHalfWritten(id, spawn.taskType);
        logMaintenance(`${spawn.taskType}-lost`, { id, reason: "ack-parse-failed" });
      }
    } else {
      quarantineHalfWritten(id, spawn.taskType);
      logMaintenance(`${spawn.taskType}-lost`, { id });
    }
  }

  for (const id of toDelete) {
    pending.delete(id);
  }
}

/** Quarantine half-written files from a failed L2 spawn */
function quarantineHalfWritten(spawnId: string, taskType: string): void {
  if (taskType === "B") {
    const knowledgeDir = join(PI_MIND_DIR, "knowledge");
    const quarantineDir = join(PI_MIND_DIR, "knowledge", "quarantine");
    if (existsSync(knowledgeDir)) {
      mkdirSync(quarantineDir, { recursive: true });
      const files = readdirSync(knowledgeDir).filter((f) => f.endsWith(`-${spawnId}.md`));
      for (const file of files) {
        try { renameSync(join(knowledgeDir, file), join(quarantineDir, file)); } catch {}
      }
    }
  } else {
    const skillsDir = join(PI_MIND_DIR, "skills");
    if (!existsSync(skillsDir)) return;
    for (const subDir of readdirSync(skillsDir)) {
      if (!subDir.endsWith(`-${spawnId}`)) continue;
      const srcDir = join(skillsDir, subDir);
      const quarantineSubDir = join(skillsDir, "quarantine", subDir);
      mkdirSync(quarantineSubDir, { recursive: true });
      for (const file of readdirSync(srcDir)) {
        try { renameSync(join(srcDir, file), join(quarantineSubDir, file)); } catch {}
      }
      try { rmdirSync(srcDir); } catch {}
    }
  }
}

// --- Extension ---

/** Resolve pi-mind's bundled system-prompt.md regardless of symlink chain. */
function loadSystemPrompt(): string | null {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const promptPath = join(dirname(here), "..", "..", "system-prompt.md");
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

  // Self-evolution startup hook: surface "audit overdue" status as a context note.
  // Agent decides when to honor — typically before substantive work in this session.
  // The hook does NOT run the audit itself; daily-audit is an LLM-executed skill.
  // Caller signals completion via mark_daily_audit_complete tool below.
  pi.registerTool({
    name: "mark_daily_audit_complete",
    label: "Mark Daily Audit Complete",
    description:
      "Call this once after running the daily-audit skill end-to-end. Updates the audit timestamp so the overdue notice is silenced for the next 24 hours. Pass an optional one-line summary that will surface in the next audit notice.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "Optional one-line summary of audit findings" } } },
    async execute(_id: string, params: { summary?: string }) {
      markAuditDone(PI_MIND_DIR, params.summary);
      return { content: [{ type: "text" as const, text: "Daily audit marked complete. Next overdue check in 24h." }], details: {} };
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
      "A worth-remembering detector runs automatically at turn end as backup.",
      "When in doubt, do NOT call — explicit save is for high-signal moments only.",
      "",
      "Saved content must be SELF-CONTAINED: a future agent reading only this",
      "entry (without conversation history) should understand it.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Self-contained text to save. Do not reference conversation context with phrases like \"as I said\" or \"that thing above\"." },
        type: { type: "string", enum: ["user", "reference", "agent-feedback"], description: "Subject. Default: reference. Use 'user' for user preferences/constraints, 'agent-feedback' for your own decisions/insights." },
        tier: { type: "string", enum: ["L1", "L2"], description: "L1 = always injected next session (use sparingly, only for durable preferences). L2 = retrieved by relevance (default)." },
        tags: { type: "array", items: { type: "string" }, description: "1-3 topic keywords to aid future retrieval." },
      },
      required: ["content"],
    },
    async execute(_id: string, params: { content: string; type?: string; tier?: string; tags?: string[] }) {
      const validTypes = new Set(["user", "reference", "agent-feedback"]);
      const type = (params.type && validTypes.has(params.type) ? params.type : "reference") as Subject;
      const tier = (params.tier === "L1" ? "L1" : "L2") as Tier;
      const tags = Array.isArray(params.tags) ? params.tags.filter((t) => typeof t === "string").slice(0, 5) : undefined;

      try {
        const fp = await getCore().saveMemory({
          type,
          primary: params.content,
          context: {
            userPrompt: lastUserPrompt || undefined,
            toolResults: lastToolResults.length ? [...lastToolResults] : undefined,
          },
          tier,
          tags,
          source: "explicit",
        });
        const text = fp ? `Saved to ${fp}` : "Skipped (duplicate of existing memory)";
        logMaintenance("remember-this", { saved: !!fp, type, tier });
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Save failed: ${String(e)}` }], details: {} };
      }
    },
  });

  // On compaction: save summary + do B+D+F maintenance
  pi.on("session_compact", async (event) => {
    const summary = event.compactionEntry.summary;

    // 1. Save compaction summary + 3. D: sync index — both are now self-locking
    try {
      await getCore().saveMemory({ type: "compaction", primary: summary, source: "compaction" });
      await getCore().syncIndex();
      logMaintenance("D", { synced: true });
    } catch (e) {
      console.error("[memory] saveMemory/syncIndex failed:", e);
      logMaintenance("D-error", { error: String(e) });
    }

    // 2. B: fire-and-forget spawn
    getSemaphore().acquire().then(() => {
      spawnL2Task("B", { summary });
      getSemaphore().release();
    });

    // 4. F: detect repeated goals, then fire-and-forget spawn
    const skillResult = detectSkillPattern();
    if (skillResult) {
      getSemaphore().acquire().then(() => {
        spawnL2Task("F", { goal: skillResult.goal, summaries: skillResult.summaries });
        getSemaphore().release();
      });
    }

    // 5. Sweep pending spawns from previous hook invocations
    sweepSpawns();
  });

  // turn_end: archive session every N turns + capture toolResults into the
  // turn-state cache for agent_end's worth-remembering detector.
  pi.on("turn_end", (event) => {
    turnCount++;
    if (turnCount % ARCHIVE_EVERY_N_TURNS === 0) {
      try { archiveSession(); } catch {}
    }
    const toolResults = (event as { toolResults?: unknown[] }).toolResults;
    if (Array.isArray(toolResults)) {
      for (const tr of toolResults) {
        lastToolResults.push(summarizeToolResult(tr));
      }
    }
  });

  // agent_end: run worth-remembering detection over the full turn.
  // Snapshots state at fire time (including the toolResults array, not just its
  // joined text — saveMemory's context.toolResults wants the array), resets the
  // module cache immediately, then runs detection async against the snapshot.
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const snapshot = {
      userPrompt: lastUserPrompt,
      agentMessagesText: serializeAgentMessages(messages),
      toolResults: [...lastToolResults],
      toolResultsText: lastToolResults.join("\n"),
    };
    lastUserPrompt = "";
    lastToolResults = [];

    if (!snapshot.userPrompt.trim()) return;

    detectWorthRemembering({
      userPrompt: snapshot.userPrompt,
      agentMessagesText: snapshot.agentMessagesText,
      toolResultsText: snapshot.toolResultsText,
    }).then(async (result) => {
      logMaintenance("worth-remembering-llm", {
        shouldRemember: result?.shouldRemember ?? null,
        type: result?.type,
      });
      if (!result?.shouldRemember) return;
      try {
        const fp = await getCore().saveMemory({
          type: result.type,
          primary: result.primary,
          context: {
            userPrompt: snapshot.userPrompt,
            toolResults: snapshot.toolResults.length ? snapshot.toolResults : undefined,
          },
          tier: result.tier,
          tags: result.suggestedTags,
          source: "worth-remembering",
        });
        if (fp) logMaintenance("worth-remembering-saved", { file: fp });
      } catch (e) {
        logMaintenance("worth-remembering-error", { error: String(e) });
      }
    }).catch(() => { /* silent — Ollama unavailable is non-fatal */ });
  });

  // Inject memories before agent starts processing
  pi.on("before_agent_start", async (event) => {
    const userText = (event as { prompt?: string }).prompt ?? "";

    // Capture user prompt into turn-state cache for agent_end's detector.
    lastUserPrompt = userText;

    const mc = getCore();
    // syncIndex is self-locking — safe without outer lock wrapper
    await mc.syncIndex();

    const parts: string[] = [];

    // Self-evolution: surface audit-overdue status, plus token spend since last audit
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

    // L1: Always inject preferences, decisions, facts
    const l1Entries = mc.loadL1();
    if (l1Entries.length > 0) {
      const lines = ["<critical-memory>"];
      let totalTokens = 0;
      for (const entry of l1Entries) {
        const tokens = Math.ceil(entry.content.length / 4);
        if (totalTokens + tokens > 2000 && lines.length > 1) break;
        // entry.type IS the subject axis
        lines.push(`\n### ${entry.type} (${entry.date.slice(0, 10)})\n`);
        lines.push(entry.content);
        totalTokens += tokens;
      }
      lines.push("\n</critical-memory>");
      parts.push(lines.join("\n"));
    }

    // L2/L3: Query-relevant search (FTS5)
    const l1Paths = new Set(l1Entries.map((e) => e.filePath));
    const searchResults = mc.searchFTS5((event as { prompt?: string }).prompt ?? "")
      .filter((r) => r.score >= MIN_SCORE_THRESHOLD && !l1Paths.has(r.entry.filePath));

    if (searchResults.length > 0) {
      const lines = ["<long-term-memory>"];
      for (const { entry, score } of searchResults) {
        // entry.type IS the subject axis
        const meta = [`subject=${entry.type}`, `date=${entry.date.slice(0, 10)}`];
        if (entry.tags?.length) {
          meta.push(`tags=${entry.tags.join(",")}`);
        }
        lines.push(`\n### Memory (${meta.join(" | ")} | relevance=${score.toFixed(2)})\n`);
        lines.push(entry.content);
      }
      lines.push("\n</long-term-memory>");
      parts.push(lines.join("\n"));
    }

    // [[link]] resolution
    const seenPaths = new Set([...l1Paths, ...searchResults.map((r) => r.entry.filePath)]);
    const linkedEntries = [];
    for (const { entry } of searchResults) {
      for (const linked of mc.resolveLinkedContent(entry.content)) {
        if (!seenPaths.has(linked.filePath)) {
          seenPaths.add(linked.filePath);
          linkedEntries.push(linked);
        }
      }
    }
    if (linkedEntries.length > 0) {
      const lines = ["<linked-memory>"];
      for (const entry of linkedEntries) {
        lines.push(`\n### ${entry.date.slice(0, 10)}\n`);
        lines.push(entry.content);
      }
      lines.push("\n</linked-memory>");
      parts.push(lines.join("\n"));
    }

    if (parts.length > 0) {
      event.injectContext?.(parts.join("\n"));
    }
  });
}

// --- Skill pattern detection (for F task) ---

function detectSkillPattern(): { goal: string; summaries: string } | null {
  try {
    const compactionDir = join(PI_MIND_DIR, "raw", "compaction");
    if (!existsSync(compactionDir)) return null;
    const files = readdirSync(compactionDir).filter((f) => f.endsWith(".md"));
    if (files.length < getCore().config.spawn.recentCompactionsToScan) return null;

    const recent = files.slice(-getCore().config.spawn.recentCompactionsToScan);
    const goalMap = new Map<string, { goal: string; count: number; files: string[] }>();

    for (const name of recent) {
      const content = readFileSync(join(compactionDir, name), "utf-8");
      const goal = extractGoal(content);
      if (!goal) continue;
      if (goalMap.has(goal)) {
        goalMap.get(goal)!.count++;
        goalMap.get(goal)!.files.push(name);
      } else {
        goalMap.set(goal, { goal, count: 1, files: [name] });
      }
    }

    const goals = Array.from(goalMap.values());
    if (goals.length < getCore().config.spawn.goalRepeatThreshold) return null;

    goals.sort((a, b) => b.count - a.count);
    const repeated = goals.find((g) => g.count >= getCore().config.spawn.goalRepeatThreshold);
    if (!repeated) return null;

    const relatedSummaries: string[] = [];
    for (const name of repeated.files) {
      const content = readFileSync(join(compactionDir, name), "utf-8");
      const body = content.replace(/^---[\s\S]*?---\n/, "").slice(0, 2000);
      relatedSummaries.push(`=== ${name} ===\n${body}`);
    }

    return { goal: repeated.goal, summaries: relatedSummaries.join("\n\n") };
  } catch {
    return null;
  }
}

function extractGoal(content: string): string | null {
  const m = content.match(/^## Goal\s*\n(.+)/m);
  return m ? m[1].trim().slice(0, 100) : null;
}
