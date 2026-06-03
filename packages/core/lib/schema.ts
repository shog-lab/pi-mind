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
