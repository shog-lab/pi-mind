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

// --- KnowledgeGraph class ---

export class KnowledgeGraph {
  private db: InstanceType<typeof Database>;

  constructor(db: InstanceType<typeof Database>) {
    this.db = db;
    this.initSchema();
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

  /** Build KG context block for a query (matches entity names in query text) */
  buildContext(query: string): string {
    const queryLower = query.toLowerCase();
    const entityNames = this.getAllEntityNames();
    const parts: string[] = [];

    for (const name of entityNames) {
      if (queryLower.includes(name.toLowerCase())) {
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
}
