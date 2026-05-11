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

/**
 * Validate frontmatter fields against the memory schema.
 *
 * @param meta - parsed frontmatter object
 * @param filePath - for error messages
 * @param body - content body (used for stale/duplicate checks)
 */
export function validateFrontmatter(
  meta: Record<string, unknown>,
  filePath: string,
  _body?: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // type (subject axis) — required
  const type = meta.type as string | undefined;
  if (!type) {
    errors.push(`missing type field`);
  } else if (!VALID_SUBJECTS.has(type as Subject) && !Object.hasOwn(LEGACY_TYPE_MAP, type.toLowerCase())) {
    errors.push(`invalid type value: '${type}' (expected one of: ${[...SUBJECTS].join(", ")})`);
  }

  // tier (recall axis) — required
  const tier = meta.tier as string | undefined;
  if (!tier) {
    errors.push(`missing tier field`);
  } else if (!VALID_TIERS.has(tier as Tier)) {
    errors.push(`invalid tier value: '${tier}' (expected L1 or L2)`);
  }

  // date — required, ISO format
  const date = meta.date as string | undefined;
  if (!date) {
    errors.push(`missing date field`);
  } else if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    errors.push(`malformed date: '${date}' (expected YYYY-MM-DD)`);
  }

  // tags — recommended
  const tags = meta.tags;
  if (!tags) {
    warnings.push(`missing tags field (recommended)`);
  } else if (!Array.isArray(tags) && typeof tags !== "string") {
    warnings.push(`tags should be an array or comma-separated string`);
  }

  // source — legacy field, should be migrated to type
  if (meta.source) {
    warnings.push(`legacy 'source' field present (should be migrated to 'type')`);
  }

  // subject:xxx in tags — legacy encoding, should be removed
  if (tags) {
    const tagList = Array.isArray(tags) ? tags : String(tags).split(",");
    if (tagList.some((t: string) => t.trim().startsWith("subject:"))) {
      warnings.push(`legacy 'subject:' encoding in tags (subject is now in 'type' field)`);
    }
    if (tagList.some((t: string) => t.trim().startsWith("memory-type:"))) {
      warnings.push(`legacy 'memory-type:' encoding in tags`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check if a memory entry should be marked stale.
 * Reference entries not updated in 30 days → stale.
 */
export function isStale(meta: Record<string, unknown>, maxAgeDays = 30): boolean {
  const type = (meta.type as string | undefined)?.toLowerCase();
  const dateStr = meta.date as string | undefined;

  if (type !== "reference" && type !== "note" && type !== "research") {
    return false;
  }

  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > maxAgeDays;
}
