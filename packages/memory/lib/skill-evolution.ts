/**
 * Skill evolution — agent-authored SKILL.md files.
 *
 * 0.6.0 split the single `write_skill` tool into `create_skill` + `update_skill`
 * (one fails if the skill exists, the other fails if it doesn't). The split
 * forces deliberate intent at the call site and lets the user-confirmation
 * prompt be more specific ("Create new skill 'X'?" vs "Update existing 'Y'?").
 *
 * The underlying file write (with .bak.<ts> backup on overwrite) is identical
 * for both; only the existence pre-check differs.
 *
 * Per the "Behavior-changing autonomy requires inline gate" principle, the
 * tool descriptions instruct agents to propose the skill name + description +
 * body in chat FIRST and only call this after explicit user approval. The
 * file write itself is unguarded — the gate lives in the tool description +
 * (optionally) pi's per-tool permission "ask" mode.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VALID_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type WriteSkillResult =
  | { ok: true; path: string; backedUpTo?: string }
  | { ok: false; reason: "invalid-name" | "package-conflict" | "io-error" | "already-exists" | "not-found"; detail: string };

export interface WriteSkillInput {
  name: string;
  description: string;
  body: string;
  /** Host repo root (parent of .pi-mind). Required to locate .pi/skills/. */
  hostRoot: string;
  /** Override for tests; defaults to new Date(). */
  now?: Date;
}

function skillPathOf(hostRoot: string, name: string): { dir: string; path: string } {
  const dir = join(hostRoot, ".pi", "skills", name);
  return { dir, path: join(dir, "SKILL.md") };
}

/** Create a NEW skill. Fails if a skill with the same name already exists. */
export function createSkill(input: WriteSkillInput): WriteSkillResult {
  if (!VALID_NAME_RE.test(input.name)) return invalidName(input.name);
  const { path } = skillPathOf(input.hostRoot, input.name);
  if (existsSync(path)) {
    return {
      ok: false,
      reason: "already-exists",
      detail: `Skill "${input.name}" already exists at ${path}. Use update_skill to modify it.`,
    };
  }
  return writeSkillFile(input);
}

/** Update an EXISTING skill. Fails if the skill doesn't already exist.
 *  Previous content is backed up to a same-dir SKILL.md.bak.<timestamp>. */
export function updateSkill(input: WriteSkillInput): WriteSkillResult {
  if (!VALID_NAME_RE.test(input.name)) return invalidName(input.name);
  const { path } = skillPathOf(input.hostRoot, input.name);
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: "not-found",
      detail: `Skill "${input.name}" does not exist at ${path}. Use create_skill to author a new one.`,
    };
  }
  return writeSkillFile(input);
}

function invalidName(name: string): WriteSkillResult {
  return {
    ok: false,
    reason: "invalid-name",
    detail: `name must match ${VALID_NAME_RE.source} (lowercase letters/digits/hyphens, start with a letter, ≤64 chars). Got: ${JSON.stringify(name)}`,
  };
}

function writeSkillFile(input: WriteSkillInput): WriteSkillResult {
  const { dir: skillDir, path: skillPath } = skillPathOf(input.hostRoot, input.name);

  // Refuse to overwrite a symlink — those come from npm-installed packages
  // (memory's daily-audit, etc.) and the user must pick a different name or
  // remove the symlink manually.
  try {
    if (lstatSync(skillDir).isSymbolicLink()) {
      return {
        ok: false,
        reason: "package-conflict",
        detail: `.pi/skills/${input.name} is a symlink from an installed package; choose a different skill name`,
      };
    }
  } catch {
    // skillDir doesn't exist yet — fine, mkdir below will create it.
  }

  let backedUpTo: string | undefined;
  if (existsSync(skillPath)) {
    const now = input.now ?? new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    backedUpTo = join(skillDir, `SKILL.md.bak.${ts}`);
    try {
      copyFileSync(skillPath, backedUpTo);
    } catch (e) {
      return { ok: false, reason: "io-error", detail: `backup write failed: ${String(e)}` };
    }
  }

  try {
    mkdirSync(skillDir, { recursive: true });
    const content = renderSkillMarkdown(input.name, input.description, input.body);
    writeFileSync(skillPath, content);
  } catch (e) {
    return { ok: false, reason: "io-error", detail: `skill write failed: ${String(e)}` };
  }

  return { ok: true, path: skillPath, backedUpTo };
}

function renderSkillMarkdown(name: string, description: string, body: string): string {
  // YAML-escape description if it contains characters that would break flow scalar.
  // Safest is to JSON-quote always.
  const escapedDesc = JSON.stringify(description);
  const trimmedBody = body.trimEnd();
  return `---\nname: ${name}\ndescription: ${escapedDesc}\n---\n\n${trimmedBody}\n`;
}
