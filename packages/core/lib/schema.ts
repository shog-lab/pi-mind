/**
 * Memory frontmatter schema — executable type definition.
 *
 * type  = subject axis:  who this memory is about
 * tier  = recall axis:   how this memory is retrieved
 * tags  = free-form topic keywords (no subject encoding)
 *
 * Valid values:
 *   type:  user | project | agent-feedback | reference | compaction
 *   tier:  L1 | L2
 *   tags:  string[]
 */

// Single source of truth: literal values as const, types derived via typeof.
const SUBJECTS = ["user", "project", "agent-feedback", "reference", "compaction"] as const;
const TIERS = ["L1", "L2"] as const;

export type Subject = typeof SUBJECTS[number];
export type Tier = typeof TIERS[number];

/** Runtime set for O(1) membership checks (subject axis) */
export const VALID_SUBJECTS = new Set(SUBJECTS);
/** Runtime set for O(1) membership checks (recall axis) */
export const VALID_TIERS = new Set(TIERS);

/**
 * Legacy L1 types — only used for migration-period tier inference.
 * NOT valid subjects in the new schema.
 * These are the old type values that meant "always inject" in pre-Plan-C systems.
 */
export const LEGACY_L1_TYPES = new Set(["fact", "preference", "decision"]);

/**
 * Legacy type → canonical subject mapping.
 *
 * ⚠️ Some mappings are lossy — these decisions were made pragmatically:
 *
 * - fact → user:  "facts about the user" were most common; project-level facts
 *              could also be user decisions but we picked user as the default
 * - decision → project: decisions are treated as project knowledge; user-level
 *              decisions (preferences) still lose some signal (would be preference→user)
 * - workflow → project: workflows are project artifacts
 *
 * If precise distinction matters, do a targeted re-classification with the LLM.
 */
export const LEGACY_TYPE_MAP: Record<string, string> = {
  feedback: "agent-feedback",
  note: "reference",
  research: "reference",
  workflow: "project",
  decision: "project",   // ⚠️ lossy: user-level decisions lose user signal
  fact: "user",          // ⚠️ lossy: project-level facts lose project signal
  preference: "user",
  article: "reference",
  paper: "reference",
  concept: "reference",
  tool: "project",
  maintenance: "agent-feedback",
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Normalize a legacy or arbitrary type value to a valid subject.
 * Returns the canonical subject, or null if unclassifiable.
 */
export function normalizeSubject(type: string | undefined | null): Subject | null {
  if (!type) return null;
  const lower = type.toLowerCase() as Subject;
  if (VALID_SUBJECTS.has(lower)) return lower;
  const legacy = LEGACY_TYPE_MAP[lower] as Subject | undefined;
  return legacy ?? null;
}

// --- KG triples frontmatter format ---
//
// The knowledge/*.md frontmatter accepts an optional `triples` field:
//   triples: [["alice", "owns", "auth-service"], ["bob", "role", "engineer"]]
//
// This is a JSON-encoded array of 3-string tuples. The array is the
// SoT for the KG; the SQLite kg_* tables are a derived, rebuildable
// index (see extensions/memory/core.ts:rebuildKGFromFiles).
//
// Predicate normalization (lowercase, spaces → underscores) is performed
// by the KG layer on ingest; the frontmatter format is the raw tuples
// so authors can use natural-language predicates ("works at", "is a")
// that read well in the .md file. Length caps in kg.addTriple (subject/
// object 500, predicate 100) act as a second-line guard if the author
// is over-enthusiastic.

export type Triple = readonly [string, string, string];
export type Triples = ReadonlyArray<Triple>;

export interface TriplesValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a triples value as it would appear in frontmatter.
 * `value` is whatever was in the `triples:` field — it could be the
 * parsed array, the raw JSON string, or something malformed from a
 * hand-edited .md file.
 *
 * The return is structured: `valid: true` means the value can be
 * trusted as input to kg.addTriple (subject/predicate/object all
 * non-empty strings; the array shape is correct). Empty arrays are
 * valid (no triples is a legitimate state). Anything else is invalid
 * with a per-element error message.
 */
export function validateTriples(value: unknown): TriplesValidationResult {
  if (value === undefined || value === null) {
    return { valid: true, errors: [] }; // absent → no triples, fine
  }
  if (!Array.isArray(value)) {
    return { valid: false, errors: ["triples must be an array of [subject, predicate, object] tuples"] };
  }
  const errors: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const t = value[i];
    if (!Array.isArray(t)) {
      errors.push(`triples[${i}]: must be an array, got ${typeof t}`);
      continue;
    }
    if (t.length !== 3) {
      errors.push(`triples[${i}]: must have exactly 3 elements [subject, predicate, object], got ${t.length}`);
      continue;
    }
    if (typeof t[0] !== "string" || typeof t[1] !== "string" || typeof t[2] !== "string") {
      errors.push(`triples[${i}]: all entries must be strings, got [${typeof t[0]}, ${typeof t[1]}, ${typeof t[2]}]`);
      continue;
    }
    if (t[0].trim().length === 0 || t[1].trim().length === 0 || t[2].trim().length === 0) {
      errors.push(`triples[${i}]: entries must be non-empty strings (whitespace-only is rejected)`);
      continue;
    }
  }
  return { valid: errors.length === 0, errors };
}
