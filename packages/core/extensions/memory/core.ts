/**
 * pi-mind Memory Core — pure logic, no pi-coding-agent dependency.
 * Used by both the extension (index.ts) and benchmark scripts.
 *
 * Two-layer memory model (the KG is a derived SQLite index, not a third layer):
 *   knowledge/   — compiled, durable facts and decisions. Source of truth for
 *                  the KG via its frontmatter `triples:` field.
 *   raw/         — append-only event stream (sessions, observations, compactions).
 *
 * The KG state lives in SQLite tables `kg_entities` / `kg_triples` in
 * `.pi-mind-index.db`. It is rebuildable from the current set of
 * knowledge/*.md frontmatter on every syncIndex. There is no
 * `.pi-mind/graph/` directory.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, basename } from "node:path";
import Database from "better-sqlite3";
import { KnowledgeGraph } from "./knowledge-graph.js";
import { LEGACY_L1_TYPES, Subject, Tier } from "../../lib/schema.js";
import { bumpAndMaybeForget } from "../../lib/forget.js";

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
  /** Informational: which writer produced this (explicit, observe, compaction, ...) */
  source?: string;
  /**
   * Path (relative to PI_MIND_DIR, e.g. "raw/images/abc123.png") to an
   * image that lives alongside this memory entry. The image itself is
   * stored by the caller (typically via lib/image-store.ts) before
   * saveMemory is invoked; this field only records the link in frontmatter.
   */
  image?: string;
  /**
   * Optional structured KG relations: each entry is [subject, predicate, object]
   * (all 3 strings). Written into the knowledge file's frontmatter as
   * `triples: [["s","p","o"], ...]`; syncIndex then re-derives the SQLite
   * kg_* tables from this. The frontmatter is the source of truth —
   * never write to kg_triples directly from here.
   */
  triples?: Array<[string, string, string]>;
}

function renderMemoryBody(input: SaveMemoryInput): string {
  const ctx = input.context;
  const hasContext = !!(ctx && (ctx.userPrompt || ctx.priorAgentMessage));
  const hasImage = !!input.image;
  if (!hasContext && !hasImage) return input.primary;

  const lines: string[] = [input.primary];

  if (hasImage) {
    // Render a markdown image link so the file is self-contained when viewed
    // outside pi-mind (any markdown viewer can show it). The path is PI_MIND_DIR-
    // relative (e.g. "raw/images/abc.png"); from the .md file's location
    // (knowledge/), "../" reaches the .pi-mind root.
    lines.push("", `![](../${input.image})`);
  }

  if (hasContext) {
    lines.push("", "## Context", "");
    if (ctx!.userPrompt) lines.push(`- **User prompt**: ${ctx!.userPrompt}`);
    if (ctx!.priorAgentMessage) lines.push(`- **Prior agent message**: ${ctx!.priorAgentMessage}`);
  }

  return lines.join("\n");
}

// --- Config ---

/** Load pi-mind-config.json from group dir, fall back to defaults */
export interface WikiConfig {
  search: { maxInjectTokens: number; l1MaxTokens: number; vectorSimilarityThreshold: number; maxSearchResults: number };
  embedding: { model: string; ollamaUrl: string; maxInputChars: number };
  typeWeights: Record<string, number>;
  recency: { maxBoost: number; decayDays: number };
  l1: { perSubjectCap: number };
}

const DEFAULT_CONFIG: WikiConfig = {
  search: { maxInjectTokens: 4000, l1MaxTokens: 2000, vectorSimilarityThreshold: 0.3, maxSearchResults: 20 },
  embedding: { model: "nomic-embed-text", ollamaUrl: "http://localhost:11434", maxInputChars: 8000 },
  typeWeights: { user: 1.5, "agent-feedback": 1.4, project: 1.2, reference: 1.0 },
  recency: { maxBoost: 0.15, decayDays: 60 },
  l1: { perSubjectCap: 10 },
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

  // --- Scan directories ---

  /** Get all directories to scan for indexing */
  private getScanDirs(): string[] {
    return [this.knowledgeDir, this.rawDir];
  }

  // --- Index sync ---

  async syncIndex(): Promise<void> {
    return withGroupLock(this.groupDir, async () => {
      // Guard: syncIndex is called fire-and-forget from several hooks. By the
      // time the lock is acquired the MemoryCore may have been disposed (e.g.
      // pi shutdown, test teardown). Avoid touching a closed DB.
      if (!this.db.open) return;

      const files: string[] = [];
      for (const dir of this.getScanDirs()) {
        files.push(...collectMdFiles(dir));
      }
      // Do NOT early-return on files.length === 0: the cleanup loop below
      // still needs to evict dangling FTS5 entries when forget (or knowledge-lint
      // --prune) removed every .md file in the scan dirs.

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
            { date: new Date().toISOString(), type: "reference", tier: "L2", tags: ["auto-healed"] },
            rawContent,
          );
          try { writeFileSync(filePath, healed, "utf-8"); } catch {}
          rawContent = healed;
        }

        const { meta, body } = parseFrontmatter(rawContent);

        // Auto-heal: add missing type (subject axis) and tier (recall axis)
        let needsRewrite = false;
        if (!meta.type) {
          meta.type = "reference";
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

      // KG: full rebuild from knowledge/*.md frontmatter triples. The
      // knowledge/ directory is the SoT for the KG; kg_triples is a
      // derived index we can rebuild from scratch on every syncIndex.
      // Cheap (typical repos have <1000 knowledge .md files) and
      // eliminates an entire class of stale-triple drift bugs. Pre-0.8.0
      // noise from autoExtractTriples is also cleaned up automatically
      // on the first syncIndex after upgrade. raw/compaction/*.md is
      // deliberately NOT included — see rebuildKGFromFiles doc.
      this.rebuildKGFromFiles();

      // Persist any queued embeddings now. Previously flushEmbeddings was
      // only called from buildContext, which the production hook bypassed —
      // result was that memory_vectors stayed empty forever even though
      // every saveMemory and every syncIndex iteration queued entries.
      // Flushing here makes vector search actually usable.
      try { await this.flushEmbeddings(); } catch { /* Ollama may be down; non-fatal */ }

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
   * Dedup: hash is computed from (type, primary, canonical triples).
   *   - Two saves with identical (type, primary) but different triples
   *     produce distinct files — structured KG metadata is not silently
   *     dropped on dedup. (The tool layer trims triples before passing
   *     them in, and the hash normalizes triple order so logically-
   *     equivalent triples dedup.)
   *   - Same (type, primary, triples) dedups to null.
   * Existing file in destDir with the same hash suffix is treated as
   * duplicate and the new write is skipped. This lets multiple writers
   * (remember_this, observe, compaction) race on the same content
   * without polluting.
   */
  async saveMemory(input: SaveMemoryInput): Promise<string | null> {
    return withGroupLock(this.groupDir, async () => {
      const destDir = input.type === "compaction"
        ? join(this.rawDir, "compaction")
        : this.knowledgeDir;
      mkdirSync(destDir, { recursive: true });

      // Dedup hash includes (type, primary, canonical triples) so that
      // saving the same content with different triples produces distinct
      // files (no silent loss of structured KG metadata). Triple order
      // is normalized so logically-equivalent triples dedup; missing
      // triples hashes as the empty string.
      //
      // Trim each triple value before hashing so that hand-edited
      // whitespace (e.g. `["  alice  ", " owns ", " x "]`) and tool-
      // layer-trimmed input produce the same hash. parseTriplesFrom-
      // Frontmatter applies the same trim at ingestion; this keeps the
      // two paths consistent.
      const normalizedTriples: Array<[string, string, string]> | undefined =
        input.triples && input.triples.length > 0
          ? input.triples.map(([s, p, o]) => [s.trim(), p.trim(), o.trim()] as [string, string, string])
          : undefined;
      const triplesKey = normalizedTriples && normalizedTriples.length > 0
        ? JSON.stringify(
            [...normalizedTriples].sort((a, b) =>
              a[0] === b[0] ? (a[1] === b[1] ? a[2].localeCompare(b[2]) : a[1].localeCompare(b[1])) : a[0].localeCompare(b[0]),
            ),
          )
        : "";
      const hash = createHash("sha256")
        .update(`${input.type}:${input.primary}:${triplesKey}`)
        .digest("hex")
        .slice(0, 8);

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
      if (input.image) frontmatter.image = input.image;
      // KG triples: serialized as a JSON array of [s, p, o] tuples.
      // Validation happens at the tool boundary (remember_this), so by
      // the time we get here the shape is guaranteed. The frontmatter
      // is the SoT — syncIndex will re-derive kg_triples from it.
      //
      // Use the trimmed `normalizedTriples` (computed above for the
      // dedup hash) for the frontmatter write too, so what's on disk
      // is the canonical clean form regardless of what the caller
      // passed in. This matches what parseTriplesFromFrontmatter
      // will produce on re-read — so save→read roundtrips are stable.
      if (normalizedTriples && normalizedTriples.length > 0) {
        frontmatter.triples = JSON.stringify(normalizedTriples);
      }

      const body = renderMemoryBody(input);
      const raw = serializeFrontmatter(frontmatter, body);
      writeFileSync(filePath, raw, "utf-8");
      // KG triples: the frontmatter is SoT. The kg_* tables are rebuilt
      // on the next syncIndex (called from before_agent_start hook,
      // turn_end, session_compact). No direct SQLite write here.
      // Bump the persistent write counter; auto-runs forget on threshold.
      // Best-effort — failures here are non-fatal (filesystem hiccup, marker
      // unwritable, etc.). saveMemory's own success path is already complete.
      try { bumpAndMaybeForget(this.groupDir); } catch {}
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
    // 5s timeout — Ollama is local-network-fast on a healthy box; >5s means
    // the daemon is wedged, the model is loading, or the network is gone.
    // In any of those cases we degrade to FTS5-only retrieval and warn, rather
    // than letting `fetch` hang for minutes and blocking the whole turn.
    const timeoutMs = 5_000;
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, input: text.slice(0, this.config.embedding.maxInputChars) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        console.warn(`[pi-mind] embedding HTTP ${resp.status} from ${this.ollamaUrl} (model: ${this.embedModel}). Vector search will not work for new entries until this is fixed.`);
        return null;
      }
      const data = await resp.json() as { embeddings?: number[][] };
      if (!data.embeddings?.[0]) {
        console.warn(`[pi-mind] embedding response had no embeddings field (model: ${this.embedModel}). Vector search degraded.`);
        return null;
      }
      return new Float64Array(data.embeddings[0]);
    } catch (e) {
      // Network unreachable, Ollama down, fetch aborted, timeout, JSON parse failure.
      // Previously caught silently — every new memory entry then went un-embedded
      // and vector search degraded to FTS5-only without anyone knowing.
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      if (isTimeout) {
        console.warn(`[pi-mind] embedding timed out after ${timeoutMs}ms from ${this.ollamaUrl} (model: ${this.embedModel}). Vector search degraded to FTS5.`);
      } else {
        console.warn(`[pi-mind] embedding call failed: ${msg}. Vector search degraded.`);
      }
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

  async searchFTS5(query: string): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    // Awaited — syncIndex is async. Without await, fresh writes (e.g.
    // remember_this in this same turn) wouldn't be visible to FTS5 search,
    // because the fire-and-forget Promise would not have completed before
    // we run the FTS5 query below.
    await this.syncIndex();

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
  //
  // Source of truth: frontmatter `triples:` field in knowledge/*.md ONLY.
  // raw/compaction/*.md is deliberately excluded from KG ingest — it's
  // the conversation-scoped event stream, not the curated knowledge
  // layer, and folding it in would inject noise as durable "facts".
  // The kg_* SQLite tables are a derived index rebuilt from scratch on
  // every syncIndex. We do NOT auto-extract from body content — that
  // was a pre-0.8.0 hack with high false-positive rate; the agent now
  // writes triples explicitly via the remember_this tool's `triples`
  // parameter (which serializes to frontmatter), or by editing the
  // .md file directly.

  /**
   * Parse the `triples:` field from a knowledge file's frontmatter.
   * Pure function: file content in, [s, p, o][] out.
   * No filesystem, no SQLite, no I/O. Unit-testable in isolation.
   *
   * Format: a single frontmatter line
   *   triples: [["alice", "owns", "auth-service"], ...]
   * The value is a JSON array of 3-string tuples.
   */
  parseTriplesFromFrontmatter(rawContent: string): Array<[string, string, string]> {
    if (!rawContent.startsWith("---")) return [];
    const endIdx = rawContent.indexOf("\n---", 3);
    if (endIdx === -1) return [];
    const yamlBlock = rawContent.slice(4, endIdx);
    for (const line of yamlBlock.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("triples:")) continue;
      const jsonStr = trimmed.slice("triples:".length).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) return [];
        const out: Array<[string, string, string]> = [];
        for (const t of parsed) {
          if (
            Array.isArray(t) &&
            t.length === 3 &&
            typeof t[0] === "string" &&
            typeof t[1] === "string" &&
            typeof t[2] === "string" &&
            t[0].trim().length > 0 &&
            t[1].trim().length > 0 &&
            t[2].trim().length > 0
          ) {
            // Trim before storing. Hand-edited .md files often have
            // `[["  alice  ", " owns ", " x "]]` (whitespace from
            // human formatting). If we don't trim, the KG entity
            // becomes "  alice  " and `buildContext('alice')` won't
            // match. The tool layer trims on its own, but the parser
            // is the SoT path for hand-edited files and must trim too.
            out.push([t[0].trim(), t[1].trim(), t[2].trim()] as [string, string, string]);
          }
        }
        return out;
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Full KG rebuild from the knowledge directory. Wipes kg_triples,
   * re-derives from each knowledge/*.md file's frontmatter, then
   * vacuums kg_entities that are no longer referenced by any triple.
   *
   * Only files under `knowledgeDir` are ingested — the KG SoT is the
   * curated knowledge layer, NOT the raw/ event stream. raw/compaction
   * entries are FTS5/vector-indexed for retrieval but never contribute
   * to the KG; compaction summaries are conversation-scoped, not
   * curated entity-relation facts, and folding them in would inject
   * noise as durable "facts" (e.g. "user said X on Tuesday").
   *
   * Called at the end of every syncIndex(). Cheap (typical repos have
   * <1000 .md files) and eliminates stale-triple drift by construction:
   * we never accumulate triples that don't match a current knowledge file.
   *
   * Public so the integration tests (and the future memory-audit
   * "force rebuild" action) can invoke it directly. The optional
   * `dir` parameter is a test seam — production callers omit it and
   * the default `this.knowledgeDir` is used.
   */
  rebuildKGFromFiles(dir?: string): { triples: number; entities: number } {
    const targetDir = dir ?? this.knowledgeDir;
    if (!this.db.open) return { triples: 0, entities: 0 };

    // 1. Wipe all triples. Vacuum entities afterward so we don't leave
    //    orphan rows pointing at nothing.
    this.db.exec("DELETE FROM kg_triples;");
    this.db.exec("DELETE FROM kg_entities;");

    // 2. Re-derive from each knowledge/*.md file's frontmatter.
    let totalTriples = 0;
    for (const filePath of collectMdFiles(targetDir)) {
      let raw: string;
      try { raw = readFileSync(filePath, "utf-8"); } catch { continue; }
      const { meta } = parseFrontmatter(raw);
      const dateStr = (meta.date as string)?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      // parseTriplesFromFrontmatter already trims, but trim defensively
      // here too so the KG entity_id never has leading/trailing
      // whitespace. (The kg layer's entityId() replaces \s+ with "_",
      // so untrimmed inputs become e.g. "__alice__" — which then
      // doesn't match `buildContext('alice')`.)
      const triples = this.parseTriplesFromFrontmatter(raw);
      for (const [s, p, o] of triples) {
        this.kg.addTriple(s, p, o, { validFrom: dateStr, sourceFile: filePath });
        totalTriples++;
      }
    }

    return { triples: totalTriples, entities: this.kg.stats().entities };
  }

  // --- Build full context ---

  /**
   * Build a context block from the hybrid retrieval pipeline (L1 + vector +
   * FTS5 + [[link]] expansion + KG). Used by:
   *   - the before_agent_start hook for automatic RAG injection
   *   - the remember_this and recall_memory tools
   *
   * skipL1=true is for callers that already injected L1 separately (the tool
   * path: the hook already injected L1 at turn start, so the tool result
   * shouldn't repeat it). The set of L1 file paths is still returned via
   * the L1 dedup logic so that L2/[[link]] don't re-emit them.
   */
  async buildContext(query: string, opts: { skipL1?: boolean } = {}): Promise<string> {
    const parts: string[] = [];
    const skipL1 = opts.skipL1 ?? false;

    // L1: always-loaded critical memories
    const l1Entries = this.loadL1();
    if (!skipL1 && l1Entries.length > 0) {
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

    // L2/L3: Hybrid vector + FTS5 search, merged via RRF.
    // Both run in parallel — we don't fall back from one to the other anymore.
    // Reasoning: FTS5 catches exact-term / rare-token matches that vector
    // embeddings smooth away; vector catches semantic paraphrases that FTS5
    // can't tokenize. Each catches what the other misses, so we want both.
    // A doc that BOTH retrieve is more likely relevant (RRF boosts it).
    //
    // Even when skipL1 is true we still load L1 paths so L2 search results
    // don't re-emit content the agent already has in its injected L1 block.
    const l1Paths = new Set(l1Entries.map((e) => e.filePath));
    await this.flushEmbeddings();
    const [vectorResults, ftsResults] = await Promise.all([
      this.searchVector(query),
      this.searchFTS5(query),
    ]);
    let searchResults = this.mergeHybridResults(vectorResults, ftsResults);
    // Enforce the per-turn token cap on the merged list. We can't easily
    // cap before merge (don't know the union size) and shouldn't cap each
    // list independently (would drop FTS hits just because vector was lucky).
    const cappedAfterL1Filter = searchResults.filter((r) => !l1Paths.has(r.entry.filePath));
    let tokenUsed = 0;
    searchResults = [];
    for (const r of cappedAfterL1Filter) {
      const tokens = estimateTokens(r.entry.content);
      if (tokenUsed + tokens > this.maxInjectTokens && searchResults.length > 0) break;
      searchResults.push(r);
      tokenUsed += tokens;
    }

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

  // --- Hybrid merge ---

  /**
   * Merge vector-search results and FTS5 results via Reciprocal Rank Fusion.
   *
   * Why RRF and not score-addition: vector returns cosine similarity in
   * roughly [0, 1], FTS5 returns -bm25() which can be any positive number
   * depending on corpus size. Adding them is meaningless; the relative
   * ordering within each list is what matters.
   *
   * RRF score for a doc = Σ 1 / (k + rank_in_list), summed across both
   * lists. k=60 is the constant from the original paper (Cormack et al.
   * 2009) — robust, no tuning needed.
   *
   * Dedup is automatic: a filePath that appears in both lists gets its
   * RRF contributions summed (boosting files that BOTH retrieval signals
   * agree are relevant). Order ties broken by `sources` alphabetical so
   * the merge is deterministic across runs.
   */
  mergeHybridResults(
    vectorResults: SearchResult[],
    ftsResults: SearchResult[],
    opts: { k?: number } = {},
  ): SearchResult[] {
    const k = opts.k ?? 60;
    interface Merged {
      entry: MemoryEntry;
      rrfScore: number;
      sources: string[]; // for tie-break determinism
    }
    const byPath = new Map<string, Merged>();

    const fuse = (list: SearchResult[], source: string) => {
      list.forEach((r, i) => {
        const path = r.entry.filePath;
        const rrfScore = 1 / (k + i + 1);
        const existing = byPath.get(path);
        if (existing) {
          existing.rrfScore += rrfScore;
          existing.sources.push(source);
        } else {
          byPath.set(path, { entry: r.entry, rrfScore, sources: [source] });
        }
      });
    };

    fuse(vectorResults, "vector");
    fuse(ftsResults, "fts");

    return [...byPath.values()]
      .map((m): SearchResult => ({ entry: m.entry, score: m.rrfScore }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Deterministic tie-break: filePath ascending. Avoids flakiness when
        // two files share an RRF score (e.g. one hit per list, same rank).
        return a.entry.filePath.localeCompare(b.entry.filePath);
      });
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

// Reentrant lock: reference-counted per groupDir.
// safe-lockfile doesn't support reentry, so we track it ourselves.
//
// The lock file lives UNDER the groupDir itself (`<groupDir>/.locks/memory.lock`),
// not under some module-load PI_MIND_DIR. This way:
//   - two MemoryCore instances with different groupDir get independent locks
//     (no cross-repo collision when two pi-mind repos run side-by-side);
//   - tests can construct a temp groupDir and assert the lock file is local.
//   - changing PI_MIND_DIR after module load (rare) doesn't strand the lock
//     in an unrelated dir.
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
  const lockDir = join(groupDir, ".locks");
  const lockFile = join(lockDir, "memory.lock");
  mkdirSync(lockDir, { recursive: true });
  const entry = _locks.get(groupDir) ?? { count: 0 };

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
  _locks.set(groupDir, entry);

  try {
    return await fn();
  } finally {
    entry.count--;
    if (entry.count === 0) {
      await entry.release?.();
      _locks.delete(groupDir);
    }
  }
}
