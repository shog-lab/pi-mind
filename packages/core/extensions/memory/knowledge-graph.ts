/**
 * Temporal Knowledge Graph for pi-mind memory system.
 *
 * Entity-relationship graph with temporal validity, deduplication,
 * confidence scoring, and bidirectional queries.
 *
 * Shares the same SQLite DB as FTS5 and vector search (.pi-mind-index.db).
 */

import Database from "better-sqlite3";

// --- Types ---

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_file: string | null;
  current: boolean;
}

export interface EntityInfo {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

// --- Validation ---

const MAX_SUBJECT_LEN = 500;
const MAX_PREDICATE_LEN = 100;
const MAX_OBJECT_LEN = 500;

function validateTripleInput(subject: string, predicate: string, object: string): string | null {
  if (!subject?.trim()) return "subject must be non-empty";
  if (!predicate?.trim()) return "predicate must be non-empty";
  if (!object?.trim()) return "object must be non-empty";
  if (subject.length > MAX_SUBJECT_LEN) return `subject exceeds ${MAX_SUBJECT_LEN} chars`;
  if (predicate.length > MAX_PREDICATE_LEN) return `predicate exceeds ${MAX_PREDICATE_LEN} chars`;
  if (object.length > MAX_OBJECT_LEN) return `object exceeds ${MAX_OBJECT_LEN} chars`;
  return null;
}

function entityId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_").replace(/'/g, "");
}

// --- KG-only stopwords for entity matching ---
//
// Deliberately a small, KG-only set — NOT imported from core.ts to avoid
// coupling knowledge-graph (leaf) back to core. Used only inside
// buildContext() to filter out common English particles and Chinese
// function words from query tokens before the token-bounded entity lookup.
// Does NOT affect the triple storage layer (addTriple, queryEntity, etc.).
const KG_STOPWORDS = new Set([
  // English common particles / function words
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "or", "not", "no", "so", "if", "but", "than", "too", "very",
  "what", "when", "where", "why", "how", "who", "whom", "which",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their", "its",
  "this", "that", "these", "those", "it",
  "go", "on",
  // Chinese common function words / particles
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有",
  "看", "好", "自己", "这", "他", "她", "它", "们",
]);

/**
 * Tokenize a lowercased entity name for the KG entity index.
 *
 * Rules:
 *  - ASCII alphanumerics + hyphen + underscore form tokens. Hyphen and
 *    underscore are split as token boundaries: "auth-service" ->
 *    ["auth", "service"], "oauth_token" -> ["oauth", "token"].
 *  - Runs of non-ASCII characters (CJK, etc.) are kept as a single token.
 *    "毛雄禹" -> ["毛雄禹"]. Cheap; word segmentation isn't worth it for
 *    an in-process memory store, and a non-ASCII substring fallback in
 *    buildContext catches the long-phrase Chinese case.
 *  - Tokens shorter than 2 chars and KG_STOPWORDS are dropped.
 */
function tokenizeEntityName(nameLower: string): string[] {
  const out: string[] = [];
  // Match either an ASCII alphanumeric+hyphen+underscore run, or a
  // non-ASCII run. The "i" flag is harmless here (no ASCII letters
  // outside [a-z] after lowercase).
  const re = /[a-z0-9_-]+|[^\x00-\x7f]+/g;
  for (const m of nameLower.matchAll(re)) {
    const t = m[0];
    if (t.includes("-") || t.includes("_")) {
      for (const part of t.split(/[-_]+/)) {
        if (part.length >= 2 && !KG_STOPWORDS.has(part)) out.push(part);
      }
    } else if (t.length >= 2 && !KG_STOPWORDS.has(t)) {
      out.push(t);
    }
  }
  return out;
}

/** Tokenize a lowercased query string. Same rules as entity tokenization. */
function tokenizeQuery(queryLower: string): string[] {
  return tokenizeEntityName(queryLower);
}

// --- KnowledgeGraph class ---

export class KnowledgeGraph {
  private db: InstanceType<typeof Database>;
  /**
   * Lazy in-memory token → entity-name index, used by buildContext() to
   * avoid scanning all entity names + doing substring matching in JS on
   * every agent turn. null = not yet built; the first buildContext() call
   * triggers ensureEntityIndex(). Cleared on any addTriple() (newly
   * inserted triples can introduce new entities) and via
   * invalidateEntityIndexCache() from external bulk writers like
   * MemoryCore.rebuildKGFromFiles() after wiping the tables.
   */
  private _entityTokenIndex: Map<string, Set<string>> | null = null;
  /**
   * Set of all entity names present in the index, kept in sync with
   * _entityTokenIndex. Used by the non-ASCII substring fallback in
   * buildContext (avoiding a second SELECT name FROM kg_entities).
   */
  private _entityNames: Set<string> = new Set();

  constructor(db: InstanceType<typeof Database>, opts?: { initSchema?: boolean }) {
    this.db = db;
    // Default to true for the normal write/read path used by
    // MemoryCore. Read-only callers (pi-mind-lint --kg-health) pass
    // { initSchema: false } to skip CREATE TABLE / PRAGMA /
    // migration — the schema is already on disk for any DB they
    // would open, and any write would violate read-only.
    if (opts?.initSchema !== false) this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'unknown',
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kg_triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        source_file TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (subject) REFERENCES kg_entities(id),
        FOREIGN KEY (object) REFERENCES kg_entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_kg2_subject ON kg_triples(subject);
      CREATE INDEX IF NOT EXISTS idx_kg2_object ON kg_triples(object);
      CREATE INDEX IF NOT EXISTS idx_kg2_predicate ON kg_triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_kg2_valid ON kg_triples(valid_from, valid_to);
    `);

    // Migrate from old knowledge_graph table if it exists
    this.migrateOldTable();
  }

  /** Migrate triples from old knowledge_graph table to new kg_triples */
  private migrateOldTable(): void {
    try {
      const hasOld = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_graph'"
      ).get();
      if (!hasOld) return;

      const oldRows = this.db.prepare(
        "SELECT subject, predicate, object, valid_from, valid_to, source_file FROM knowledge_graph"
      ).all() as Array<{ subject: string; predicate: string; object: string; valid_from: string | null; valid_to: string | null; source_file: string | null }>;

      for (const row of oldRows) {
        this.addTriple(row.subject, row.predicate, row.object, {
          validFrom: row.valid_from ?? undefined,
          sourceFile: row.source_file ?? undefined,
        });
      }

      this.db.exec("DROP TABLE knowledge_graph");
    } catch { /* ignore migration errors */ }
  }

  // --- Entity operations ---

  /** Ensure an entity exists, return its ID */
  private ensureEntity(name: string, type: string = "unknown"): string {
    const id = entityId(name);
    this.db.prepare(
      "INSERT OR IGNORE INTO kg_entities (id, name, type) VALUES (?, ?, ?)"
    ).run(id, name, type);
    return id;
  }

  /** Get entity info */
  getEntity(name: string): EntityInfo | null {
    const id = entityId(name);
    const row = this.db.prepare(
      "SELECT id, name, type, properties FROM kg_entities WHERE id = ?"
    ).get(id) as { id: string; name: string; type: string; properties: string } | undefined;
    if (!row) return null;
    return { ...row, properties: JSON.parse(row.properties) };
  }

  // --- Write operations ---

  /** Add a triple with deduplication. Returns triple ID or null if duplicate/invalid. */
  addTriple(
    subject: string,
    predicate: string,
    object: string,
    opts?: {
      validFrom?: string;
      validTo?: string;
      confidence?: number;
      sourceFile?: string;
    },
  ): string | null {
    const err = validateTripleInput(subject, predicate, object);
    if (err) return null;

    const subId = this.ensureEntity(subject);
    const objId = this.ensureEntity(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, "_");

    // Dedup: skip if same active triple exists
    const existing = this.db.prepare(
      "SELECT id FROM kg_triples WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL"
    ).get(subId, pred, objId) as { id: string } | undefined;

    if (existing) return existing.id;

    const tripleId = `t_${subId}_${pred}_${objId}_${Date.now().toString(36)}`;
    this.db.prepare(
      `INSERT INTO kg_triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tripleId,
      subId,
      pred,
      objId,
      opts?.validFrom ?? null,
      opts?.validTo ?? null,
      opts?.confidence ?? 1.0,
      opts?.sourceFile ?? null,
    );
    // Index may now contain new entity names; rebuild lazily on next
    // buildContext. Cheaper than updating the index incrementally, and
    // the cache hit rate is still high because the typical pattern is
    // "many reads, few writes" (agent turns are reads, remember_this is
    // a write). For batch paths like addTriplesBatch / rebuildKGFromFiles
    // the caller should call invalidateEntityIndexCache() once instead
    // of relying on this per-triple invalidation.
    this.invalidateEntityIndexCache();
    return tripleId;
  }

  /** Add multiple triples in a single transaction */
  addTriplesBatch(
    triples: Array<[string, string, string, string?]>,
    sourceFile?: string,
  ): number {
    if (triples.length === 0) return 0;
    let count = 0;
    const addOne = this.db.transaction(() => {
      for (const t of triples) {
        const result = this.addTriple(t[0], t[1], t[2], {
          validFrom: t[3],
          sourceFile,
        });
        if (result) count++;
      }
    });
    addOne();
    return count;
  }

  /** Mark a triple as expired */
  invalidate(subject: string, predicate: string, object: string, ended?: string): void {
    const subId = entityId(subject);
    const objId = entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, "_");
    const endDate = ended ?? new Date().toISOString().slice(0, 10);

    this.db.prepare(
      "UPDATE kg_triples SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL"
    ).run(endDate, subId, pred, objId);
  }

  // --- Query operations ---

  /** Query all triples for an entity (bidirectional) */
  queryEntity(
    name: string,
    opts?: { asOf?: string; direction?: "outgoing" | "incoming" | "both" },
  ): Triple[] {
    const id = entityId(name);
    const direction = opts?.direction ?? "both";
    const results: Triple[] = [];

    if (direction === "outgoing" || direction === "both") {
      let sql = `
        SELECT t.*, e.name as obj_name FROM kg_triples t
        JOIN kg_entities e ON t.object = e.id WHERE t.subject = ?`;
      const params: (string)[] = [id];
      if (opts?.asOf) {
        sql += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)";
        params.push(opts.asOf, opts.asOf);
      }
      sql += " ORDER BY t.created_at DESC LIMIT 50";

      const rows = this.db.prepare(sql).all(...params) as Array<any>;
      for (const row of rows) {
        results.push({
          subject: name,
          predicate: row.predicate,
          object: row.obj_name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_file: row.source_file,
          current: row.valid_to === null,
        });
      }
    }

    if (direction === "incoming" || direction === "both") {
      let sql = `
        SELECT t.*, e.name as sub_name FROM kg_triples t
        JOIN kg_entities e ON t.subject = e.id WHERE t.object = ?`;
      const params: (string)[] = [id];
      if (opts?.asOf) {
        sql += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)";
        params.push(opts.asOf, opts.asOf);
      }
      sql += " ORDER BY t.created_at DESC LIMIT 50";

      const rows = this.db.prepare(sql).all(...params) as Array<any>;
      for (const row of rows) {
        results.push({
          subject: row.sub_name,
          predicate: row.predicate,
          object: name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_file: row.source_file,
          current: row.valid_to === null,
        });
      }
    }

    return results;
  }

  /** Query by relationship type */
  queryRelationship(predicate: string, asOf?: string): Triple[] {
    const pred = predicate.toLowerCase().replace(/\s+/g, "_");
    let sql = `
      SELECT t.*, s.name as sub_name, o.name as obj_name FROM kg_triples t
      JOIN kg_entities s ON t.subject = s.id
      JOIN kg_entities o ON t.object = o.id
      WHERE t.predicate = ?`;
    const params: string[] = [pred];
    if (asOf) {
      sql += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)";
      params.push(asOf, asOf);
    }
    sql += " ORDER BY t.created_at DESC LIMIT 50";

    return (this.db.prepare(sql).all(...params) as Array<any>).map((row) => ({
      subject: row.sub_name,
      predicate: row.predicate,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_file: row.source_file,
      current: row.valid_to === null,
    }));
  }

  /** Get timeline of all triples for an entity, sorted by valid_from */
  timeline(entityName?: string): Triple[] {
    let sql: string;
    let params: string[];

    if (entityName) {
      const id = entityId(entityName);
      sql = `
        SELECT t.*, s.name as sub_name, o.name as obj_name FROM kg_triples t
        JOIN kg_entities s ON t.subject = s.id
        JOIN kg_entities o ON t.object = o.id
        WHERE t.subject = ? OR t.object = ?
        ORDER BY t.valid_from ASC NULLS LAST LIMIT 100`;
      params = [id, id];
    } else {
      sql = `
        SELECT t.*, s.name as sub_name, o.name as obj_name FROM kg_triples t
        JOIN kg_entities s ON t.subject = s.id
        JOIN kg_entities o ON t.object = o.id
        ORDER BY t.valid_from ASC NULLS LAST LIMIT 100`;
      params = [];
    }

    return (this.db.prepare(sql).all(...params) as Array<any>).map((row) => ({
      subject: row.sub_name,
      predicate: row.predicate,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_file: row.source_file,
      current: row.valid_to === null,
    }));
  }

  /** Get top-confidence current triples for L1 injection */
  getTopTriples(limit: number = 15, minConfidence: number = 0.9): Triple[] {
    const rows = this.db.prepare(`
      SELECT t.*, s.name as sub_name, o.name as obj_name FROM kg_triples t
      JOIN kg_entities s ON t.subject = s.id
      JOIN kg_entities o ON t.object = o.id
      WHERE t.valid_to IS NULL AND t.confidence >= ?
      ORDER BY t.confidence DESC LIMIT ?
    `).all(minConfidence, limit) as Array<any>;

    return rows.map((row) => ({
      subject: row.sub_name,
      predicate: row.predicate,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_file: row.source_file,
      current: true,
    }));
  }

  /** Get all entity names (for prompt matching) */
  getAllEntityNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM kg_entities").all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // --- Entity index for buildContext (lazy, invalidated on writes) ---

  /**
   * Public invalidation hook. Callers that bulk-modify kg_entities /
   * kg_triples outside addTriple (notably MemoryCore.rebuildKGFromFiles
   * after DELETEing the tables) MUST call this so the next buildContext
   * doesn't serve a stale index. No-op if the index isn't built yet.
   */
  invalidateEntityIndexCache(): void {
    this._entityTokenIndex = null;
    this._entityNames = new Set();
  }

  private ensureEntityIndex(): void {
    if (this._entityTokenIndex !== null) return;
    this._entityTokenIndex = new Map();
    this._entityNames = new Set();
    const rows = this.db.prepare("SELECT name FROM kg_entities").all() as Array<{ name: string }>;
    for (const r of rows) {
      this._entityNames.add(r.name);
      for (const tok of tokenizeEntityName(r.name.toLowerCase())) {
        let set = this._entityTokenIndex.get(tok);
        if (!set) { set = new Set(); this._entityTokenIndex.set(tok, set); }
        set.add(r.name);
      }
    }
  }

  /** Build KG context block for a query (matches entity names in query text) */
  buildContext(query: string): string {
    this.ensureEntityIndex();
    const queryLower = query.toLowerCase();
    const queryTokens = tokenizeQuery(queryLower);
    const matched = new Set<string>();

    // Step 1: token-bounded matching for ASCII / hyphenated / underscored
    // entity names. For each query token:
    //   - exact lookup (preserves the "auth" → entity-with-token-auth case)
    //   - if query token is long enough (>=4), also do token-prefix lookup
    //     (preserves "auth" → "auth-service" since "auth" is length 4).
    //     Threshold of 4, not 3, because at 3 the false-positive rate
    //     spikes on common 3-letter stems: "car" → "carol", "mat" →
    //     "matrix", "pol" → "policy". NOT reverse-prefix: "go" must not
    //     match "go-service" via the OTHER direction.
    for (const qt of queryTokens) {
      if (KG_STOPWORDS.has(qt)) continue;
      const exact = this._entityTokenIndex!.get(qt);
      if (exact) for (const e of exact) matched.add(e);
      if (qt.length >= 4) {
        for (const [idxTok, ents] of this._entityTokenIndex!) {
          if (idxTok !== qt && idxTok.startsWith(qt)) {
            for (const e of ents) matched.add(e);
          }
        }
      }
    }

    // Step 2: non-ASCII substring fallback for CJK (and other non-ASCII
    // scripts) entity names. We don't have word segmentation for Chinese
    // and full-string includes() over a short list of entity names is
    // cheap. Whitelist is "entity has non-ASCII and length >= 2" — the
    // same floor as the ASCII token length filter. This deliberately
    // does NOT apply to ASCII entity names: an entity like "oauth_token"
    // must not be substring-matched by the query token "auth" (covered
    // by Step 1's token-bounded logic only).
    for (const name of this._entityNames) {
      if (name.length < 2) continue;
      if (!/[^\x00-\x7f]/.test(name)) continue;
      if (queryLower.includes(name.toLowerCase())) matched.add(name);
    }

    // Step 3: render. Same shape as before — one `### Knowledge Graph: <name>`
    // block per matched entity, populated from queryEntity(name).
    const parts: string[] = [];
    for (const name of matched) {
      const triples = this.queryEntity(name);
      if (triples.length > 0) {
        const lines = [`\n### Knowledge Graph: ${name}`];
        for (const t of triples) {
          const time = t.valid_from
            ? ` (since ${t.valid_from}${t.valid_to ? ` until ${t.valid_to}` : ""})`
            : "";
          const conf = t.confidence < 1.0 ? ` [${Math.round(t.confidence * 100)}%]` : "";
          lines.push(`  - ${t.subject} → ${t.predicate} → ${t.object}${time}${conf}`);
        }
        parts.push(lines.join("\n"));
      }
    }

    if (parts.length > 0) {
      return "<knowledge-graph>" + parts.join("\n") + "\n</knowledge-graph>";
    }
    return "";
  }

  /** Stats for diagnostics */
  stats(): { entities: number; triples: number; currentFacts: number; expiredFacts: number } {
    const entities = (this.db.prepare("SELECT COUNT(*) as c FROM kg_entities").get() as any).c;
    const triples = (this.db.prepare("SELECT COUNT(*) as c FROM kg_triples").get() as any).c;
    const current = (this.db.prepare("SELECT COUNT(*) as c FROM kg_triples WHERE valid_to IS NULL").get() as any).c;
    return { entities, triples, currentFacts: current, expiredFacts: triples - current };
  }

  // --- Read-only health report (memory-audit integration) ---

  /**
   * Predicates that are too generic / ambiguous to carry real signal.
   * Used by healthReport() to surface relation fragmentation: an agent
   * that writes `owns` in one place and `owner_of` in another will see
   * two top-predicates that should be one. The set is intentionally
   * small and obvious — adding entries should require a real observed
   * noise pattern, not a hunch.
   */
  private static readonly SUSPICIOUS_PREDICATES = new Set([
    // too short / copula / light verb
    "is", "has", "have", "had", "do", "does", "did",
    // ambiguous direction or relation
    "related_to", "related", "kind", "tag", "type", "category",
    // too generic
    "use", "uses", "used", "thing", "stuff", "misc", "other", "with",
    // placeholders / separators (after snake_case normalization)
    "_", "-",
  ]);

  /**
   * Build a read-only health snapshot of the KG. Used by
   * `pi-mind-lint --kg-health` and surfaced via the `memory-audit` skill.
   * No writes. Safe to call from any context, including concurrent with
   * a syncIndex — the worst case is reading a mid-rebuild count, which
   * is still self-consistent within the call.
   */
  healthReport(topN: number = 10): {
    summary: { entities: number; triples: number; currentFacts: number; expiredFacts: number };
    topPredicates: Array<{ predicate: string; count: number }>;
    topSourceFiles: Array<{ source_file: string; triples: number }>;
    topEntities: Array<{ name: string; outgoing: number; incoming: number; degree: number }>;
    suspiciousPredicates: Array<{ predicate: string; count: number; reason: string }>;
    orphans: { triplesPointingToMissingEntity: number };
  } {
    const summary = this.stats();

    // Top predicates by current-fact count.
    const topPredicates = (this.db.prepare(
      `SELECT predicate, COUNT(*) as c FROM kg_triples
       WHERE valid_to IS NULL
       GROUP BY predicate
       ORDER BY c DESC, predicate ASC
       LIMIT ?`,
    ).all(topN) as Array<{ predicate: string; c: number }>).map((r) => ({
      predicate: r.predicate,
      count: r.c,
    }));

    // Top source files by triple count.
    const topSourceFiles = (this.db.prepare(
      `SELECT source_file, COUNT(*) as c FROM kg_triples
       WHERE source_file IS NOT NULL
       GROUP BY source_file
       ORDER BY c DESC, source_file ASC
       LIMIT ?`,
    ).all(topN) as Array<{ source_file: string; c: number }>).map((r) => ({
      source_file: r.source_file,
      triples: r.c,
    }));

    // Top entities by current-fact degree.
    const topEntities = (this.db.prepare(
      `SELECT e.name,
              (SELECT COUNT(*) FROM kg_triples t WHERE t.subject = e.id AND t.valid_to IS NULL) AS out_count,
              (SELECT COUNT(*) FROM kg_triples t WHERE t.object  = e.id AND t.valid_to IS NULL) AS in_count
       FROM kg_entities e
       ORDER BY (out_count + in_count) DESC, e.name ASC
       LIMIT ?`,
    ).all(topN) as Array<{ name: string; out_count: number; in_count: number }>).map((r) => ({
      name: r.name,
      outgoing: r.out_count,
      incoming: r.in_count,
      degree: r.out_count + r.in_count,
    }));

    // Suspicious predicates: too short or in the noise set. Surface ALL
    // occurrences (not topN) so the agent can see whether a single bad
    // predicate is in heavy use vs scattered.
    const allPredCounts = this.db.prepare(
      `SELECT predicate, COUNT(*) as c FROM kg_triples
       WHERE valid_to IS NULL
       GROUP BY predicate
       ORDER BY c DESC`,
    ).all() as Array<{ predicate: string; c: number }>;
    const suspiciousPredicates: Array<{ predicate: string; count: number; reason: string }> = [];
    for (const r of allPredCounts) {
      const reason =
        r.predicate.length < 3
          ? `too short (${r.predicate.length} chars)`
          : KnowledgeGraph.SUSPICIOUS_PREDICATES.has(r.predicate)
          ? "in noise set (too generic / ambiguous direction)"
          : null;
      if (reason) suspiciousPredicates.push({ predicate: r.predicate, count: r.c, reason });
    }

    // Orphan check: any triple whose subject or object is not in
    // kg_entities. Should be 0 because the schema has FOREIGN KEY
    // constraints, but a manual SQL poke or a future migration could
    // break that. Reporting it keeps the audit honest.
    const orphans = (this.db.prepare(
      `SELECT COUNT(*) as c FROM kg_triples t
       LEFT JOIN kg_entities s ON t.subject = s.id
       LEFT JOIN kg_entities o ON t.object  = o.id
       WHERE s.id IS NULL OR o.id IS NULL`,
    ).get() as { c: number });

    return {
      summary,
      topPredicates,
      topSourceFiles,
      topEntities,
      suspiciousPredicates,
      orphans: { triplesPointingToMissingEntity: orphans.c },
    };
  }
}
