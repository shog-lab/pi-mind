/**
 * pi-mind Memory Core — pure logic, no pi-coding-agent dependency.
 * Used by both the extension (index.ts) and benchmark scripts.
 *
 * Three-layer memory model:
 *   knowledge/   — compiled, durable facts and decisions
 *   raw/    — append-only event stream (sessions, observations, compactions)
 *   graph/       — relations extracted from frontmatter triples (managed by KG module)
 *
 * All directories are peers under PI_MIND_DIR.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { resolvePiMindDir } from "@shog-lab/pi-utils";
import { KnowledgeGraph } from "./knowledge-graph.js";
import { LEGACY_L1_TYPES, Subject, Tier } from "../../lib/schema.js";

// --- Types ---

export interface Frontmatter {
  [key: string]: string | string[] | undefined;
}

export interface MemoryEntry {
  filePath: string;
  date: string;
  type: string;
  tags?: string[];
  content: string;
  links?: string[]; // [[link]] targets found in content
  _score?: number; // used internally for loadL1 sorting
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * Input to saveMemory: structured so writers carry both the memory itself
 * (primary) and the conversation context that produced it.
 *
 * We intentionally do NOT carry raw tool results in context. The agent's
 * message is already the curated digest of what tools returned; capturing
 * raw tool output would (a) duplicate signal already present in the agent
 * message and (b) leak pi-mind's own tool calls (e.g. remember_this) back
 * into the memory, creating a self-observation loop.
 */
export interface SaveMemoryInput {
  type: Subject;
  primary: string;
  context?: {
    userPrompt?: string;
    priorAgentMessage?: string;
  };
  tier?: Tier;
  tags?: string[];
  /** Informational: which writer produced this (worth-remembering, explicit, compaction, ...) */
  source?: string;
}

function renderMemoryBody(input: SaveMemoryInput): string {
  const ctx = input.context;
  const hasContext = !!(ctx && (ctx.userPrompt || ctx.priorAgentMessage));
  if (!hasContext) return input.primary;

  const lines = [input.primary, "", "## Context", ""];
  if (ctx!.userPrompt) lines.push(`- **User prompt**: ${ctx!.userPrompt}`);
  if (ctx!.priorAgentMessage) lines.push(`- **Prior agent message**: ${ctx!.priorAgentMessage}`);
  return lines.join("\n");
}

// --- Config ---

/** Load pi-mind-config.json from group dir, fall back to defaults */
export interface WikiConfig {
  search: { maxInjectTokens: number; l1MaxTokens: number; minScoreThreshold: number; vectorSimilarityThreshold: number; maxSearchResults: number };
  embedding: { model: string; ollamaUrl: string; maxInputChars: number };
  typeWeights: Record<string, number>;
  recency: { maxBoost: number; decayDays: number };
  l1: { perSubjectCap: number };
  spawn: { goalRepeatThreshold: number; recentCompactionsToScan: number };
  semaphore: { maxConcurrent: number };
}

const DEFAULT_CONFIG: WikiConfig = {
  search: { maxInjectTokens: 4000, l1MaxTokens: 2000, minScoreThreshold: 0.001, vectorSimilarityThreshold: 0.3, maxSearchResults: 20 },
  embedding: { model: "nomic-embed-text", ollamaUrl: "http://localhost:11434", maxInputChars: 8000 },
  typeWeights: { user: 1.5, "agent-feedback": 1.4, project: 1.2, reference: 1.0 },
  recency: { maxBoost: 0.15, decayDays: 60 },
  l1: { perSubjectCap: 10 },
  semaphore: { maxConcurrent: 2 },
  spawn: { goalRepeatThreshold: 3, recentCompactionsToScan: 10 },
};

export function loadWikiConfig(groupDir: string): WikiConfig {
  const configPath = join(groupDir, "pi-mind-config.json");
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return {
        search: { ...DEFAULT_CONFIG.search, ...raw.search },
        embedding: { ...DEFAULT_CONFIG.embedding, ...raw.embedding },
        typeWeights: { ...DEFAULT_CONFIG.typeWeights, ...raw.typeWeights },
        recency: { ...DEFAULT_CONFIG.recency, ...raw.recency },
        l1: { ...DEFAULT_CONFIG.l1, ...raw.l1 },
        semaphore: { ...DEFAULT_CONFIG.semaphore, ...raw.semaphore },
        spawn: { ...DEFAULT_CONFIG.spawn, ...raw.spawn },
      };
    }
  } catch { /* fall through to default */ }
  return DEFAULT_CONFIG;
}

/** Resolved type weights — loaded from pi-mind-config.json or defaults */
let TYPE_WEIGHTS: Record<string, number> = DEFAULT_CONFIG.typeWeights;

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","shall","can","need","dare","ought",
  "used","to","of","in","for","on","with","at","by","from",
  "as","into","through","during","before","after","above","below",
  "between","out","off","over","under","again","further","then",
  "once","here","there","when","where","why","how","all","each",
  "every","both","few","more","most","other","some","such","no",
  "not","only","own","same","so","than","too","very","just",
  "because","but","and","or","if","while","about","up","this",
  "that","these","those","it","its","he","she","we","they",
  "me","him","her","us","them","my","his","our","your","their",
  "what","which","who","whom",
  "的","了","在","是","我","有","和","就","不","人","都",
  "一","一个","上","也","很","到","说","要","去","你","会",
  "着","没有","看","好","自己","这","他","她","它",
]);

/** Tier axis: recall strategy — L1 = always injected, L2 = on-demand retrieval */
export const TIER_L1: Tier = "L1";



/** Compute recency boost: 1.0 for recent, decays to (1 - maxBoost) for old entries */
function recencyBoost(dateStr: string, recency: WikiConfig["recency"]): number {
  if (!dateStr) return 0.5;
  const ageMs = Date.now() - new Date(dateStr).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decayFactor = Math.min(1.0, ageDays / recency.decayDays);
  return 1.0 - (1.0 - recency.maxBoost) * (1.0 - decayFactor);
}

/** Map memory type → raw/ subdirectory (compaction only) */
const TYPE_SUBDIR: Record<string, string> = {
  compaction: "compaction",
};

// --- Frontmatter ---

export function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const meta: Frontmatter = {};
  if (!raw.startsWith("---")) return { meta, body: raw };
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return { meta, body: raw };
  const yamlBlock = raw.slice(4, endIdx);
  const body = raw.slice(endIdx + 4).replace(/^\n+/, "");
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      meta[key] = rawValue.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = rawValue;
    }
  }
  return { meta, body };
}

export function serializeFrontmatter(meta: Frontmatter, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}



/** Extract [[link]] targets from content */
export function isPathSafe(filePath: string, allowedDir: string): boolean {
  const normalized = resolve(filePath);
  const allowed = resolve(allowedDir);
  return normalized.startsWith(allowed + sep);
}

export function extractLinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

// --- Recursive file scanning ---

/** Recursively collect all .md files from a directory */
function collectMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// --- MemoryCore class ---

export class MemoryCore {
  private db: InstanceType<typeof Database>;
  /** Group root directory (parent of wiki/, raw/, schema/) */
  public groupDir: string;
  /** Primary write target: wiki/ */
  public knowledgeDir: string;
  /** Read-only source materials: raw/ */
  public rawDir: string;
  /** @internal */
  public config: WikiConfig;
  private maxInjectTokens: number;
  private l1MaxTokens: number;
  private ollamaUrl: string;
  private embedModel: string;
  private _pendingEmbeddings: Array<{ filePath: string; content: string }> = [];
  /** All known .md file paths → slug mapping for [[link]] resolution */
  private _slugIndex = new Map<string, string>();
  /** Knowledge graph (entities + triples) */
  public kg: KnowledgeGraph;
  /** In-memory map of pending L2 spawns (id → spawn info) */
  public pendingSpawns = new Map<string, { id: string; taskType: string; ackPath: string; timestamp: number }>();

  constructor(opts: {
    groupDir: string;
    dbPath: string;
    maxInjectTokens?: number;
    l1MaxTokens?: number;
    freshDb?: boolean;
    ollamaUrl?: string;
    embedModel?: string;
    /** Extra scan directories beyond wiki/ and raw/ */
    extraScanDirs?: string[];
    /** Legacy: if provided, migrate files from this dir to wiki/ */
    legacyMemoryDir?: string;
  }) {
    this.groupDir = opts.groupDir;
    this.knowledgeDir = join(opts.groupDir, "knowledge");
    this.rawDir = join(opts.groupDir, "raw");

    // Load config from pi-mind-config.json (group-level overrides defaults)
    this.config = loadWikiConfig(opts.groupDir);
    TYPE_WEIGHTS = this.config.typeWeights;

    this.maxInjectTokens = opts.maxInjectTokens ?? this.config.search.maxInjectTokens;
    this.l1MaxTokens = opts.l1MaxTokens ?? this.config.search.l1MaxTokens;
    this.ollamaUrl = opts.ollamaUrl ?? this.config.embedding.ollamaUrl;
    this.embedModel = opts.embedModel ?? this.config.embedding.model;

    // Ensure wiki/ and raw/ subdirectories exist
    mkdirSync(this.knowledgeDir, { recursive: true });
    mkdirSync(this.rawDir, { recursive: true });

    // Migrate legacy memory/ → wiki/ if needed
    if (opts.legacyMemoryDir && existsSync(opts.legacyMemoryDir)) {
      this.migrateLegacyMemory(opts.legacyMemoryDir);
    }

    if (opts.freshDb && existsSync(opts.dbPath)) {
      try { unlinkSync(opts.dbPath); } catch {}
    }

    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");  // wait up to 5s on SQLITE_BUSY before failing
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        file_path, content, date, type, tier, tags, tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        file_path TEXT PRIMARY KEY, mtime_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS memory_vectors (
        file_path TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      );
    `);

    // Migration: add tier column to FTS table if missing (existing DBs)
    // NOTE: FTS5 virtual tables do not support ALTER TABLE ADD COLUMN.
    // We rebuild the table using a temporary name, copy data, then rename.
    this.addTierColumnToFts();

    // Initialize knowledge graph (shares the same DB)
    this.kg = new KnowledgeGraph(this.db);
  }

  /** Rebuild FTS table to add tier column (FTS5 does not support ALTER TABLE ADD COLUMN) */
  private addTierColumnToFts(): void {
    const tableInfo = this.db
      .prepare("PRAGMA table_info(memory_fts)")
      .all() as Array<{ name: string }>;
    if (tableInfo.some((c) => c.name === "tier")) return; // Already migrated

    const tmp = "memory_fts_tmp";
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tmp} USING fts5(
      file_path, content, date, type, tier, tags, tokenize='unicode61'
    )`);
    // Copy existing rows (tier defaults to 'L2' for legacy rows)
    this.db.exec(`INSERT INTO ${tmp}(file_path, content, date, type, tier, tags)
      SELECT file_path, content, date, type, 'L2', tags FROM memory_fts`);
    this.db.exec(`DROP TABLE memory_fts`);
    this.db.exec(`ALTER TABLE ${tmp} RENAME TO memory_fts`);
  }

  // --- Legacy migration ---

  /** Move memory/*.md → wiki/{subdir}/ based on type */
  private migrateLegacyMemory(legacyDir: string): void {
    if (!existsSync(legacyDir)) return;
    const files = readdirSync(legacyDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return;

    let migrated = 0;
    for (const file of files) {
      const src = join(legacyDir, file);
      try {
        const raw = readFileSync(src, "utf-8");
        const { meta } = parseFrontmatter(raw);
        const memType = (meta.type as string) || "note";
        const subdir = TYPE_SUBDIR[memType]; // only compaction has a subdir
        const destDir = subdir ? join(this.rawDir, subdir) : this.knowledgeDir;
        mkdirSync(destDir, { recursive: true });
        const dest = join(destDir, file);
        if (!existsSync(dest)) {
          renameSync(src, dest);
          migrated++;
        }
      } catch {
        // Skip files that can't be migrated
      }
    }

    if (migrated > 0) {
      // Leave a marker so we know migration happened
      const marker = join(legacyDir, ".migrated-to-wiki");
      try { writeFileSync(marker, `Migrated ${migrated} files on ${new Date().toISOString()}\n`); } catch {}
    }
  }

  // --- Legacy llm-wiki migration ---

  /** Move llm-wiki/wiki/*.md → wiki/, llm-wiki/raw/ → raw/, llm-wiki/schema/ → schema/ */
  migrateLegacyLlmWiki(llmWikiDir: string): void {
    if (!existsSync(llmWikiDir)) return;

    // Move wiki/ contents
    const wikiSrc = join(llmWikiDir, "wiki");
    if (existsSync(wikiSrc)) {
      for (const file of collectMdFiles(wikiSrc)) {
        const rel = relative(wikiSrc, file);
        const dest = join(this.knowledgeDir, rel);
        if (!existsSync(dest)) {
          mkdirSync(join(dest, ".."), { recursive: true });
          try { renameSync(file, dest); } catch {}
        }
      }
    }

    // Move raw/ contents
    const rawSrc = join(llmWikiDir, "raw");
    if (existsSync(rawSrc)) {
      for (const file of collectMdFiles(rawSrc)) {
        const rel = relative(rawSrc, file);
        const dest = join(this.rawDir, rel);
        if (!existsSync(dest)) {
          mkdirSync(join(dest, ".."), { recursive: true });
          try { renameSync(file, dest); } catch {}
        }
      }
    }

    // Move schema/ contents
    const schemaSrc = join(llmWikiDir, "schema");
    const schemaDest = join(this.groupDir, "schema");
    if (existsSync(schemaSrc)) {
      mkdirSync(schemaDest, { recursive: true });
      for (const file of collectMdFiles(schemaSrc)) {
        const rel = relative(schemaSrc, file);
        const dest = join(schemaDest, rel);
        if (!existsSync(dest)) {
          mkdirSync(join(dest, ".."), { recursive: true });
          try { renameSync(file, dest); } catch {}
        }
      }
    }
  }

  // --- Scan directories ---

  /** Get all directories to scan for indexing */
  private getScanDirs(): string[] {
    return [this.knowledgeDir, this.rawDir];
  }

  // --- Index sync ---

  async syncIndex(): Promise<void> {
    return withGroupLock(this.groupDir, async () => {
      const files: string[] = [];
      for (const dir of this.getScanDirs()) {
        files.push(...collectMdFiles(dir));
      }
      if (files.length === 0) return;

      // Build slug index for [[link]] resolution
      this._slugIndex.clear();
      for (const filePath of files) {
        const slug = basename(filePath, ".md").toLowerCase();
        this._slugIndex.set(slug, filePath);
      }

      const indexed = new Map<string, number>();
      for (const row of this.db
        .prepare("SELECT file_path, mtime_ms FROM memory_meta")
        .all() as Array<{ file_path: string; mtime_ms: number }>) {
        indexed.set(row.file_path, row.mtime_ms);
      }

      const currentFiles = new Set<string>();
      for (const filePath of files) {
        currentFiles.add(filePath);
        let mtime: number;
        try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
        const lastMtime = indexed.get(filePath);
        if (lastMtime && Math.abs(lastMtime - mtime) < 1) continue;

        let rawContent: string;
        try { rawContent = readFileSync(filePath, "utf-8"); } catch { continue; }

        // Auto-heal: add missing frontmatter
        if (!rawContent.startsWith("---")) {
          const healed = serializeFrontmatter(
            { date: new Date().toISOString(), type: "note", tier: "L2", tags: ["auto-healed"] },
            rawContent,
          );
          try { writeFileSync(filePath, healed, "utf-8"); } catch {}
          rawContent = healed;
        }

        const { meta, body } = parseFrontmatter(rawContent);

        // Auto-heal: add missing type (subject axis) and tier (recall axis)
        let needsRewrite = false;
        if (!meta.type) {
          meta.type = "note";
          needsRewrite = true;
        }
        if (!meta.tier) {
          const typeLower = (meta.type as string)?.toLowerCase() ?? "";
          meta.tier = LEGACY_L1_TYPES.has(typeLower) ? "L1" : "L2";
          needsRewrite = true;
        }
        if (!meta.date) {
          try { meta.date = statSync(filePath).mtime.toISOString(); } catch { meta.date = new Date().toISOString(); }
          needsRewrite = true;
        }
        if (needsRewrite) {
          try { writeFileSync(filePath, serializeFrontmatter(meta, body), "utf-8"); } catch {}
        }

        const date = (meta.date as string) || "";
        const type = (meta.type as string) || "note";
        const tier = (meta.tier as string) || "L2";
        const tags = Array.isArray(meta.tags) ? meta.tags.join(",") : "";

        this.db.prepare("DELETE FROM memory_fts WHERE file_path = ?").run(filePath);
        this.db.prepare(
          "INSERT INTO memory_fts (file_path, content, date, type, tier, tags) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(filePath, body, date, type, tier, tags);
        this.db.prepare(
          "INSERT OR REPLACE INTO memory_meta (file_path, mtime_ms) VALUES (?, ?)"
        ).run(filePath, mtime);

        try { this.extractTriplesFromFile(filePath); } catch {}
        this._pendingEmbeddings.push({ filePath, content: body });
      }

      // Remove deleted files from index
      for (const [filePath] of indexed) {
        if (!currentFiles.has(filePath)) {
          this.db.prepare("DELETE FROM memory_fts WHERE file_path = ?").run(filePath);
          this.db.prepare("DELETE FROM memory_meta WHERE file_path = ?").run(filePath);
          this.db.prepare("DELETE FROM memory_vectors WHERE file_path = ?").run(filePath);
        }
      }

      // Auto-generate wiki/index.md
      this.generateIndex(files);
    });
  }

  /** Generate wiki/index.md — grouped by subdirectory, with [[links]] */
  private generateIndex(allFiles: string[]): void {
    const wikiFiles = allFiles.filter((f) => f.startsWith(this.knowledgeDir + "/"));
    if (wikiFiles.length === 0) return;

    const indexPath = join(this.knowledgeDir, "index.md");

    // Group by subdirectory
    const groups = new Map<string, string[]>();
    for (const filePath of wikiFiles) {
      const rel = relative(this.knowledgeDir, filePath);
      if (rel === "index.md") continue; // skip self
      const parts = rel.split("/");
      const dir = parts.length > 1 ? parts[0] : "(root)";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(rel);
    }

    const lines = [`# Wiki Index\n`, `Auto-generated. ${wikiFiles.length - 1} pages.\n`];
    for (const [dir, files] of [...groups.entries()].sort()) {
      lines.push(`## ${dir}\n`);
      for (const rel of files.sort()) {
        const slug = basename(rel, ".md");
        lines.push(`- [[${slug}]]`);
      }
      lines.push("");
    }

    try { writeFileSync(indexPath, lines.join("\n"), "utf-8"); } catch {}
  }

  // --- Store ---

  /**
   * Save a memory entry (thread-safe via internal withGroupLock).
   *
   * Structured input: writers pass `primary` (the memory itself) and optional
   * `context` (the conversation that produced it). Rendered into one markdown
   * body with frontmatter.
   *
   * Dedup: hash is computed from (type, primary). Existing file in destDir
   * with the same hash suffix is treated as duplicate and the new write is
   * skipped (returns null). This lets multiple writers (worth-remembering,
   * remember_this) race on the same content without polluting.
   */
  async saveMemory(input: SaveMemoryInput): Promise<string | null> {
    return withGroupLock(this.groupDir, async () => {
      const destDir = input.type === "compaction"
        ? join(this.rawDir, "compaction")
        : this.knowledgeDir;
      mkdirSync(destDir, { recursive: true });

      const hash = createHash("sha256").update(`${input.type}:${input.primary}`).digest("hex").slice(0, 8);

      // Dedup: any existing file with this hash suffix means we've already saved this content.
      try {
        const existing = readdirSync(destDir).find((f) => f.endsWith(`_${hash}.md`));
        if (existing) return null;
      } catch { /* destDir freshly created, no existing files */ }

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-");
      const fileName = `${timestamp}_${hash}.md`;
      const filePath = join(destDir, fileName);

      const frontmatter: Frontmatter = {
        date: now.toISOString(),
        type: input.type,
        tier: input.type === "compaction" ? "L2" : (input.tier ?? "L2"),
      };
      if (input.tags?.length) frontmatter.tags = input.tags;
      if (input.source) frontmatter.source = input.source;

      const body = renderMemoryBody(input);
      const raw = serializeFrontmatter(frontmatter, body);
      writeFileSync(filePath, raw, "utf-8");
      try { this.extractTriplesFromFile(filePath); } catch {}
      return filePath;
    });
  }

  // --- [[link]] resolution ---

  /** Resolve a [[link]] target to a file path */
  resolveLink(linkTarget: string): string | null {
    const slug = linkTarget.toLowerCase().replace(/\s+/g, "-");
    // Exact slug match
    const exact = this._slugIndex.get(slug);
    if (exact) return exact;
    // Partial match: slug contains the target
    for (const [s, path] of this._slugIndex) {
      if (s.includes(slug) || slug.includes(s)) return path;
    }
    return null;
  }

  /** Load linked pages from [[link]] references in content (one level deep) */
  resolveLinkedContent(content: string): MemoryEntry[] {
    const links = extractLinks(content);
    if (links.length === 0) return [];

    const entries: MemoryEntry[] = [];
    const seen = new Set<string>();

    for (const link of links.slice(0, 5)) { // Max 5 linked pages
      const filePath = this.resolveLink(link);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);

      try {
        const raw = readFileSync(filePath, "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        entries.push({
          filePath,
          date: (meta.date as string) || "",
          type: (meta.type as string) || "note",
          tags: Array.isArray(meta.tags) ? meta.tags : undefined,
          content: body,
        });
      } catch {}
    }
    return entries;
  }

  // --- Embedding ---

  async flushEmbeddings(): Promise<void> {
    if (this._pendingEmbeddings.length === 0) return;
    const pending = this._pendingEmbeddings.splice(0);
    for (const { filePath, content } of pending) {
      await this.embedFile(filePath, content);
    }
  }

  private async getEmbedding(text: string): Promise<Float64Array | null> {
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, input: text.slice(0, this.config.embedding.maxInputChars) }),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { embeddings?: number[][] };
      if (!data.embeddings?.[0]) return null;
      return new Float64Array(data.embeddings[0]);
    } catch {
      return null;
    }
  }

  private cosineSimilarity(a: Float64Array, b: Float64Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  async embedFile(filePath: string, content: string): Promise<void> {
    const embedding = await this.getEmbedding(content);
    if (!embedding) return;
    const buffer = Buffer.from(embedding.buffer);
    this.db.prepare(
      "INSERT OR REPLACE INTO memory_vectors (file_path, embedding) VALUES (?, ?)"
    ).run(filePath, buffer);
  }

  // --- Vector search ---

  async searchVector(query: string): Promise<SearchResult[]> {
    const queryEmbedding = await this.getEmbedding(query);
    if (!queryEmbedding) return [];

    const rows = this.db.prepare(
      "SELECT v.file_path, v.embedding, f.content, f.date, f.type, f.tier, f.tags FROM memory_vectors v JOIN memory_fts f ON v.file_path = f.file_path"
    ).all() as Array<{ file_path: string; embedding: Buffer; content: string; date: string; type: string; tier: string; tags: string }>;

    if (rows.length === 0) return [];

    const scored: Array<{ row: typeof rows[0]; score: number }> = [];
    for (const row of rows) {
      const docEmbedding = new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);
      let score = this.cosineSimilarity(queryEmbedding, docEmbedding);

      // Use type (subject axis) for TYPE_WEIGHTS scoring
      score *= TYPE_WEIGHTS[row.type] || 1.0;

      if (row.date) {
        const age = Date.now() - new Date(row.date).getTime();
        const recencyBoost = Math.max(0, 1 - age / (this.config.recency.decayDays * 86400000)) * this.config.recency.maxBoost;
        score *= 1 + recencyBoost;
      }

      if (row.tags?.includes("stale") || row.tags?.includes("superseded")) {
        score *= 0.3;
      }

      if (score > this.config.search.vectorSimilarityThreshold) scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const results: SearchResult[] = [];
    let totalTokens = 0;
    for (const { row, score } of scored) {
      const tokens = estimateTokens(row.content);
      if (totalTokens + tokens > this.maxInjectTokens && results.length > 0) break;
      results.push({
        entry: {
          filePath: row.file_path, date: row.date, type: row.type,
          tags: row.tags ? row.tags.split(",").map(t => t.trim()) : undefined,
          content: row.content,
        },
        score,
      });
      totalTokens += tokens;
    }
    return results;
  }

  // --- FTS5 Search ---

  searchFTS5(query: string): SearchResult[] {
    if (!query.trim()) return [];
    this.syncIndex();

    const terms = query.toLowerCase()
      .split(/[\s,.\-:;!?()[\]{}"'`#*_/\\|@&=+<>]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
    if (terms.length === 0) return [];

    const ftsQuery = terms.join(" OR ");
    let rows: Array<{ file_path: string; content: string; date: string; type: string; tier: string; tags: string; rank: number }>;
    try {
      rows = this.db.prepare(
        `SELECT file_path, content, date, type, tier, tags, bm25(memory_fts) as rank
         FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ${this.config.search.maxSearchResults}`
      ).all(ftsQuery) as typeof rows;
    } catch { return []; }
    if (rows.length === 0) return [];

    const results: SearchResult[] = [];
    let totalTokens = 0;
    for (const row of rows) {
      let score = -row.rank;
      if (score <= 0) continue;
      // Use type (subject axis) for TYPE_WEIGHTS scoring
      score *= TYPE_WEIGHTS[row.type] || 1.0;
      if (row.date) {
        const age = Date.now() - new Date(row.date).getTime();
        const recencyBoost = Math.max(0, 1 - age / (this.config.recency.decayDays * 86400000)) * this.config.recency.maxBoost;
        score *= 1 + recencyBoost;
      }
      if (row.tags?.includes("stale") || row.tags?.includes("superseded")) {
        score *= 0.3;
      }
      const tokens = estimateTokens(row.content);
      if (totalTokens + tokens > this.maxInjectTokens && results.length > 0) break;
      results.push({
        entry: {
          filePath: row.file_path, date: row.date, type: row.type,
          tags: row.tags ? row.tags.split(",").map((t) => t.trim()) : undefined,
          content: row.content,
        },
        score,
      });
      totalTokens += tokens;
    }
    return results;
  }

  // --- L1 Always-loaded ---

  loadL1(): MemoryEntry[] {
    const recency = this.config.recency;

    // Collect all L1 entries (tier: L1) with effective scores
    type ScoredEntry = MemoryEntry & { _score: number };
    const scored: ScoredEntry[] = [];

    for (const dir of this.getScanDirs()) {
      for (const filePath of collectMdFiles(dir)) {
        try {
          const rawContent = readFileSync(filePath, "utf-8");
          const { meta, body } = parseFrontmatter(rawContent);
          const tags = Array.isArray(meta.tags) ? meta.tags : [];
          // Filter by tier = L1 (recall axis)
          const tier = (meta.tier as string) || "L2";
          if (tier !== TIER_L1) continue;

          const type = (meta.type as string) || "note"; // subject axis
          const date = (meta.date as string) || "";
          const typeWeight = this.config.typeWeights[type] ?? 1.0;
          const boost = recencyBoost(date, recency);
          const score = typeWeight * boost;
          scored.push({
            filePath,
            date,
            type,
            tags: tags.length ? tags : undefined,
            content: body,
            _score: score,
          });
        } catch {}
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    // Per-subject cap: keep top N per subject (type)
    const bySubject = new Map<string, ScoredEntry[]>();
    for (const entry of scored) {
      const subject = entry.type; // type IS the subject axis
      const list = bySubject.get(subject) ?? [];
      list.push(entry);
      bySubject.set(subject, list);
    }

    // Collect capped entries with score preserved
    const scoreMap = new Map<string, number>();
    const result: MemoryEntry[] = [];
    for (const [, entries] of bySubject) {
      for (const e of entries.slice(0, this.config.l1.perSubjectCap)) {
        scoreMap.set(e.filePath, e._score);
        result.push(e);
      }
    }

    // Final sort by score (O(N log N), score lookup is O(1) via Map)
    result.sort((a, b) => (scoreMap.get(b.filePath) ?? 0) - (scoreMap.get(a.filePath) ?? 0));

    return result;
  }

  // --- Triple extraction from files ---

  private extractTriplesFromFile(filePath: string): void {
    let rawContent: string;
    try { rawContent = readFileSync(filePath, "utf-8"); } catch { return; }

    const { meta, body } = parseFrontmatter(rawContent);
    const date = (meta.date as string) || new Date().toISOString();

    // Manual triples from frontmatter
    if (rawContent.startsWith("---")) {
      const endIdx = rawContent.indexOf("\n---", 3);
      if (endIdx !== -1) {
        const yamlBlock = rawContent.slice(4, endIdx);
        for (const line of yamlBlock.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("triples:")) continue;
          const jsonStr = trimmed.slice("triples:".length).trim();
          try {
            const triples = JSON.parse(jsonStr);
            if (!Array.isArray(triples)) break;
            for (const t of triples) {
              if (Array.isArray(t) && t.length >= 3) {
                this.kg.addTriple(t[0], t[1], t[2], { validFrom: t[3] || date.slice(0, 10), sourceFile: filePath });
              }
            }
          } catch {}
          break;
        }
      }
    }

    // Auto-extract from content
    this.autoExtractTriples(body, date.slice(0, 10), filePath);
  }

  private autoExtractTriples(content: string, defaultDate: string, sourceFile: string): void {
    const months: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
    };

    const dateEventRegex = /(?:on|since|from|starting|began?|started)\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi;
    let match;
    while ((match = dateEventRegex.exec(content)) !== null) {
      const monthStr = match[1].toLowerCase();
      const day = match[2].padStart(2, "0");
      const year = match[3] || defaultDate.slice(0, 4);
      const monthNum = months[monthStr];
      if (!monthNum) continue;
      const dateStr = `${year}-${monthNum}-${day}`;
      const start = Math.max(0, match.index - 100);
      const end = Math.min(content.length, match.index + match[0].length + 100);
      const context = content.slice(start, end);
      const actionMatch = context.match(/I\s+(bought|got|started|finished|attended|visited|joined|moved|received|completed|took|had|went|made|tried|began|signed up|enrolled|registered|scheduled|booked)\s+(.{3,40}?)(?:\.|,|!|\?|on\s)/i);
      if (actionMatch) {
        const action = actionMatch[1].toLowerCase();
        const object = actionMatch[2].trim().replace(/^(a|an|the|my|our)\s+/i, "");
        this.kg.addTriple("user", action, object, { validFrom: dateStr, sourceFile });
      }
    }

    const isoDateRegex = /(\d{4})-(\d{2})-(\d{2})/g;
    while ((match = isoDateRegex.exec(content)) !== null) {
      const dateStr = match[0];
      const start = Math.max(0, match.index - 100);
      const end = Math.min(content.length, match.index + 15);
      const context = content.slice(start, end);
      const actionMatch = context.match(/I\s+(bought|got|started|finished|attended|visited|joined|moved|received|completed|took|had|went|made|tried|began)\s+(.{3,40}?)(?:\.|,|!|\?|\s+on)/i);
      if (actionMatch) {
        const action = actionMatch[1].toLowerCase();
        const object = actionMatch[2].trim().replace(/^(a|an|the|my|our)\s+/i, "");
        this.kg.addTriple("user", action, object, { validFrom: dateStr, sourceFile });
      }
    }

    const actionDateRegex = /I\s+(bought|got|started|finished|attended|visited|joined|moved to|received|completed|took|signed up for|enrolled in|registered for|scheduled|booked)\s+(.{3,60}?)\s+(?:on|in|at|around|since)\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/gi;
    while ((match = actionDateRegex.exec(content)) !== null) {
      const action = match[1].toLowerCase();
      const object = match[2].trim().replace(/^(a|an|the|my|our)\s+/i, "");
      const dateText = match[3];
      const dateMatch = dateText.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/);
      if (dateMatch) {
        const monthNum = months[dateMatch[1].toLowerCase()];
        if (monthNum) {
          const day = dateMatch[2].padStart(2, "0");
          const year = dateMatch[3] || defaultDate.slice(0, 4);
          this.kg.addTriple("user", action, object, { validFrom: `${year}-${monthNum}-${day}`, sourceFile });
        }
      }
    }

    const possessionRegex = /(?:my|I have a|I own a|I got a)\s+(new\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/g;
    while ((match = possessionRegex.exec(content)) !== null) {
      const object = (match[1] || "") + match[2];
      if (object.length > 3 && object.length < 40) {
        this.kg.addTriple("user", "has", object.trim(), { validFrom: defaultDate, sourceFile });
      }
    }
  }

  // --- Build full context ---

  async buildContext(query: string): Promise<string> {
    const parts: string[] = [];

    // L1: always-loaded critical memories
    const l1Entries = this.loadL1();
    if (l1Entries.length > 0) {
      const l1Lines = ["<critical-memory>"];
      let l1Tokens = 0;
      for (const entry of l1Entries) {
        const tokens = estimateTokens(entry.content);
        if (l1Tokens + tokens > this.l1MaxTokens && l1Lines.length > 1) break;
        // entry.type IS the subject axis
        l1Lines.push(`\n### ${entry.type} (${entry.date.slice(0, 10)})\n`);
        l1Lines.push(entry.content);
        l1Tokens += tokens;
      }
      l1Lines.push("\n</critical-memory>");
      parts.push(l1Lines.join("\n"));
    }

    // L2/L3: Vector search (primary), FTS5 (fallback)
    const l1Paths = new Set(l1Entries.map((e) => e.filePath));
    await this.flushEmbeddings();
    let searchResults = await this.searchVector(query);
    if (searchResults.length === 0) {
      searchResults = this.searchFTS5(query);
    }
    searchResults = searchResults.filter((r) => !l1Paths.has(r.entry.filePath));

    if (searchResults.length > 0) {
      const lines = ["<long-term-memory>"];
      for (const { entry, score } of searchResults) {
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

    // [[link]] resolution: collect linked pages from search results
    const linkedEntries: MemoryEntry[] = [];
    const seenPaths = new Set([...l1Paths, ...searchResults.map((r) => r.entry.filePath)]);
    for (const { entry } of searchResults) {
      for (const linked of this.resolveLinkedContent(entry.content)) {
        if (!seenPaths.has(linked.filePath)) {
          seenPaths.add(linked.filePath);
          linkedEntries.push(linked);
        }
      }
    }
    if (linkedEntries.length > 0) {
      const lines = ["<linked-pages>"];
      for (const entry of linkedEntries) {
        const slug = basename(entry.filePath, ".md");
        lines.push(`\n### [[${slug}]]\n`);
        // Truncate long pages
        const truncated = entry.content.length > 2000
          ? entry.content.slice(0, 2000) + "\n...(truncated)"
          : entry.content;
        lines.push(truncated);
      }
      lines.push("\n</linked-pages>");
      parts.push(lines.join("\n"));
    }

    // Knowledge Graph
    const kgBlock = this.kg.buildContext(query);
    if (kgBlock) parts.push(kgBlock);

    return parts.join("\n\n");
  }

  /** Build knowledge graph context block for a query (delegates to KG) */
  buildKGContext(query: string): string {
    return this.kg.buildContext(query);
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }

  cleanup(): void {
    this.close();
  }
}

// --- Group-wide lock for multi-pi concurrent write safety ---

const LOCK_DIR = join(resolvePiMindDir(), ".locks");

// Reentrant lock: reference-counted per lock file.
// safe-lockfile doesn't support reentry, so we track it ourselves.
const _locks = new Map<string, { count: number; release?: () => Promise<void> }>();

/**
 * Acquire an exclusive lock for a group directory, run an async function,
 * then release. Safe to call nested — uses reference counting so the underlying
 * proper-lockfile lock is acquired once and released after the last nested
 * call exits.
 */
export async function withGroupLock<T>(
  groupDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockFile = join(LOCK_DIR, `memory-${basename(groupDir)}.lock`);
  const entry = _locks.get(lockFile) ?? { count: 0 };

  if (entry.count === 0) {
    const { lock } = await import("proper-lockfile");
    // realpath:true (default) calls fs.realpath on the lockfile, which fails
    // with ENOENT if the file doesn't exist yet (first time).  Disable it.
    const release = await lock(lockFile, {
      retries: { retries: 20, minTimeout: 100, maxTimeout: 1000 },
      realpath: false,
    });
    entry.release = release;
  }

  entry.count++;
  _locks.set(lockFile, entry);

  try {
    return await fn();
  } finally {
    entry.count--;
    if (entry.count === 0) {
      await entry.release?.();
      _locks.delete(lockFile);
    }
  }
}
