/**
 * pi-mind Memory Extension for pi-coding-agent
 *
 * Hooks into agent lifecycle:
 * - turn_end → archive session every N turns
 * - session_compact → auto-save compaction summary + B+D+F maintenance
 * - before_agent_start → detect feedback + inject L1 + L2/L3 memories into system prompt
 */

import { existsSync, readdirSync, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, appendFileSync, unlinkSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, resolvePiMindDir } from "pi-utils";

import { MemoryCore, parseFrontmatter, TIER_L1, withGroupLock } from "./core.js";
import { getAuditStatus, markAuditDone, renderAuditNotice, readMarker, summarizeTokensSince, AUDIT_INTERVAL_HOURS } from "./auto-audit.js";
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

// --- Feedback detection (LLM-only) ---
//
// Single layer: qwen2.5:1.5b classifies both whether to remember AND sub-type.
// Async fire-and-forget, non-blocking, <3s timeout, silent on failure.
// LLM returns { answer: "是/否", type: "correction|complaint|preference|self-admission" }
// Regex was removed: both sub-type and recall decisions now via LLM.
//
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LLM_MODEL = "qwen2.5:1.5b";

type FeedbackType = "correction" | "complaint" | "preference" | "self-admission";

interface LlmFeedbackResult {
  shouldRemember: boolean;
  /** Sub-type: only meaningful when shouldRemember=true */
  subType: FeedbackType;
}

async function detectFeedbackWithLLM(text: string): Promise<LlmFeedbackResult | null> {
  const prompt = [
    "判断用户输入是否值得记忆为反馈，并分类。",
    "",
    "值得记忆（answer=是）：",
    "  - 纠正 agent 错误（不对、应该是、你搞错了）",
    "  - 抱怨或不满（太差了、垃圾、根本不行）",
    "  - 透露偏好或建议（我觉得应该、我更喜欢）",
    "  - 承认自己错误或收回（抱歉我错了、我收回刚才说的）",
    "",
    "不值得记忆（answer=否）：",
    "  - 正常提问和请求（帮我查一下、告诉我怎么做）",
    "  - 无情绪的闲聊（今天天气不错）",
    "",
    "分类（只在answer=是时填写）：",
    "  correction: 纠正 agent 的错误",
    "  complaint: 抱怨或不满",
    "  preference: 透露偏好或建议",
    "  self-admission: 承认自己错误或收回之前的话",
    "",
    `用户输入：${text.slice(0, 1500)}`,
    "",
    '回复格式：{"answer": "是"或"否", "type": "correction"|"complaint"|"preference"|"self-admission"}',
  ].join("\n");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
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

    // Parse: Ollama format:json guarantees valid JSON
    const VALID_TYPES: FeedbackType[] = ["correction", "complaint", "preference", "self-admission"];
    let shouldRemember = false;
    let subType: FeedbackType = "preference";
    try {
      const json = JSON.parse(raw);
      if (json.answer === "是") shouldRemember = true;
      if (VALID_TYPES.includes(json.type)) subType = json.type;
    } catch {
      // format:json should guarantee valid JSON; treat parse failure as miss
      shouldRemember = false;
    }
    return { shouldRemember, subType };
  } catch {
    return null; // silent — LLM failure is non-fatal
  }
}

// Cooldown to avoid writing twice in quick succession
const recentFeedback: Array<{ timestamp: number }> = [];
const FEEDBACK_COOLDOWN_MS = 60_000;

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

// --- Feedback detection (integrated from feedback_tracker) ---

/**
 * Detect and save user feedback as memory entries.
 * Writes via saveMemory so it goes through the subject tag pipeline.
 * Optionally creates a follow-up observation task file.
 * @param caughtBy — detection source: regex (explicit keyword) or llm (implicit/tone)
 */
async function processFeedback(
  userText: string,
  feedbackType: FeedbackType = "preference",
  caughtBy: "regex" | "llm" = "regex",
): Promise<void> {
  await withGroupLock(PI_MIND_DIR, async () => {
    const mc = getCore();

    // Determine follow-up days from config (default: disabled / 0)
    let followUpDays = 0;
    try {
      const configPath = join(PI_MIND_DIR, "pi-mind-config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        followUpDays = config.feedback?.followUpDays ?? 0;
      }
    } catch {}

    // Save as memory — goes to knowledge/, type field carries subject, enters L1 pipeline
    const content = [
      `## 用户反馈（${feedbackType}）`,
      "",
      `- **类型**: ${feedbackType}`,
      `- **内容**: ${userText}`,
    ].join("\n");

    // type field = "agent-feedback" (subject axis), tier = L1 (always injected)
    const tags = [`feedback:${feedbackType}`, `caught:${caughtBy}`];
    await mc.saveMemory("agent-feedback", content, { tier: TIER_L1, tags });

    // Optional follow-up observation file (only if followUpDays > 0)
    if (followUpDays > 0) {
      try {
        const followUpDir = join(PI_MIND_DIR, "knowledge", "follow-up");
        mkdirSync(followUpDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const slug = userText.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const followUpPath = join(followUpDir, `${ts}_${slug}.md`);
        const followUpDate = new Date(Date.now() + followUpDays * 86400_000).toISOString().slice(0, 10);
        const body = [
          "---",
          `date: ${new Date().toISOString().slice(0, 10)}`,
          `source: follow-up`,
          `tags: [subject:user, feedback:${feedbackType}, follow-up]`,
          "---",
          "",
          "## 观察任务",
          "",
          `- **反馈类型**: ${feedbackType}`,
          `- **反馈内容**: ${userText.slice(0, 200)}`,
          `- **观察期**: ${followUpDays} 天（至 ${followUpDate}）`,
          `- **验证标准**: 后续 3 次相关交互中用户不再反馈同类问题`,
          "",
          "## 验证记录",
          "",
          "- [ ] 交互 1：",
          "- [ ] 交互 2：",
          "- [ ] 交互 3：",
          "",
          "## 结论",
          "",
          "- 有效 / 需继续观察 / 已复发",
        ].join("\n");
        writeFileSync(followUpPath, body, "utf-8");
      } catch {}
    }
  });
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

  // On compaction: save summary + do B+D+F maintenance
  pi.on("session_compact", async (event) => {
    const summary = event.compactionEntry.summary;

    // 1. Save compaction summary + 3. D: sync index — both are now self-locking
    try {
      // saveMemory and syncIndex each acquire the group lock internally.
      // The reentrant lock lets them nest safely.
      await getCore().saveMemory("compaction", summary);
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

  // Archive session every N turns (non-blocking, no spawn)
  pi.on("turn_end", () => {
    turnCount++;
    if (turnCount % ARCHIVE_EVERY_N_TURNS === 0) {
      try {
        archiveSession();
      } catch {}
    }
  });

  // Inject memories before agent starts processing
  pi.on("before_agent_start", async (event) => {
    const userText = (event as { prompt?: string }).prompt ?? "";
    const nowMs = Date.now();

    // Feedback detection — LLM-only (qwen2.5:1.5b via Ollama).
    // Async fire-and-forget, non-blocking. Runs in L1 only (not in L2 sub-agents).
    // Sub-agents use `pi -p --no-extensions`, so they do NOT run this hook.
    if (userText.trim().length > 0) {
      const last = recentFeedback[recentFeedback.length - 1];
      const cooldownMs = nowMs - (last?.timestamp ?? 0);

      if (cooldownMs >= FEEDBACK_COOLDOWN_MS * 0.8) {
        detectFeedbackWithLLM(userText).then(async (result) => {
          // Log LLM decision for audit (every call, not just saves)
          // shouldRemember: null = LLM call failed (Ollama down / timeout)
          // daily-audit monitors null rate as Ollama health signal
          logMaintenance("feedback-llm", {
            shouldRemember: result?.shouldRemember ?? null,
          });
          if (result?.shouldRemember) {
            const lastEntry = recentFeedback[recentFeedback.length - 1];
            if (!lastEntry || Date.now() - lastEntry.timestamp >= FEEDBACK_COOLDOWN_MS) {
              recentFeedback.push({ timestamp: Date.now() });
              await processFeedback(userText, result.subType, "llm");
            }
          }
        }).catch((err) => {
          console.warn("[memory] LLM feedback detection failed:", err?.message ?? err);
        });
      }
    }

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
