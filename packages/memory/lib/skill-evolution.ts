/**
 * Skill evolution — agent-authored SKILL.md files.
 *
 * The agent writes skills via the write_skill tool, which calls into here.
 * Skills land directly in <host-repo>/.pi/skills/<name>/SKILL.md so pi
 * loads them on next startup. Existing skill content (if any) is preserved
 * in a same-dir timestamped .bak file before being overwritten, so rollback
 * is just a `cp` away.
 *
 * No draft/promote pattern, no separate evolution-state directory: skill
 * generation is only triggered by explicit user request in the same
 * conversation turn, so the user can verify the result immediately.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VALID_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type WriteSkillResult =
  | { ok: true; path: string; backedUpTo?: string }
  | { ok: false; reason: "invalid-name" | "package-conflict" | "io-error"; detail: string };

export interface WriteSkillInput {
  name: string;
  description: string;
  body: string;
  /** Host repo root (parent of .pi-mind). Required to locate .pi/skills/. */
  hostRoot: string;
  /** Override for tests; defaults to new Date(). */
  now?: Date;
}

export function writeSkill(input: WriteSkillInput): WriteSkillResult {
  if (!VALID_NAME_RE.test(input.name)) {
    return {
      ok: false,
      reason: "invalid-name",
      detail: `name must match ${VALID_NAME_RE.source} (lowercase letters/digits/hyphens, start with a letter, ≤64 chars). Got: ${JSON.stringify(input.name)}`,
    };
  }

  const skillDir = join(input.hostRoot, ".pi", "skills", input.name);
  const skillPath = join(skillDir, "SKILL.md");

  // Refuse to overwrite a symlink — those come from npm-installed packages
  // (memory's daily-audit, ralph's prd-compile, etc.) and the user must
  // pick a different name or remove the symlink manually.
  if (existsSync(skillDir)) {
    try {
      const lstat = require("node:fs").lstatSync(skillDir);
      if (lstat.isSymbolicLink()) {
        return {
          ok: false,
          reason: "package-conflict",
          detail: `.pi/skills/${input.name} is a symlink from an installed package; choose a different skill name`,
        };
      }
    } catch { /* fall through; mkdir will handle it */ }
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
  // For now, the safest move is to quote always — agents are likely to include
  // colons, commas, etc.
  const escapedDesc = JSON.stringify(description);
  const trimmedBody = body.trimEnd();
  return `---\nname: ${name}\ndescription: ${escapedDesc}\n---\n\n${trimmedBody}\n`;
}

/** Convenience for tests / probes. */
export function hostRootFromPiMindDir(piMindDir: string): string {
  return dirname(piMindDir);
}
