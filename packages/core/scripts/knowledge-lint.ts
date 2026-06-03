#!/usr/bin/env npx tsx
/**
 * Memory lint — validates frontmatter schema, detects duplicates, marks stale entries.
 * With --fix: auto-migrates legacy fields to new schema (type + tier).
 *
 * Run:
 *   npx pi-mind-lint                       # validate $PI_MIND_DIR/knowledge
 *   npx pi-mind-lint --fix                 # auto-fix
 *   npx pi-mind-lint --dry-run --fix       # preview fixes
 *   npx pi-mind-lint --dir <abs-path>      # validate a custom dir
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VALID_SUBJECTS, VALID_TIERS, LEGACY_L1_TYPES, LEGACY_TYPE_MAP, normalizeSubject } from "../lib/schema.js";
import { forgetOldMemories, resetForgetCounter, type ForgetResult } from "../lib/forget.js";

// --- Frontmatter parser ---

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const meta: Record<string, unknown> = {};
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
      meta[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = rawValue;
    }
  }
  return { meta, body };
}

function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const quoted = value.map((v) => `"${v}"`).join(", ");
      lines.push(`${key}: [${quoted}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

// --- Validation ---

interface Issue {
  file: string;
  severity: "error" | "warning" | "info";
  message: string;
}

function validateFile(filePath: string, content: string): Issue[] {
  const issues: Issue[] = [];
  const { meta, body } = parseFrontmatter(content);
  const fileName = path.basename(filePath);

  const type = meta.type as string | undefined;
  if (!type) {
    issues.push({ file: fileName, severity: "error", message: `missing 'type' field` });
  } else if (!(VALID_SUBJECTS as Set<string>).has(type) && !Object.hasOwn(LEGACY_TYPE_MAP, type.toLowerCase())) {
    issues.push({
      file: fileName,
      severity: "error",
      message: `invalid type '${type}' (expected: ${[...VALID_SUBJECTS].join(", ")})`,
    });
  }

  const tier = meta.tier as string | undefined;
  if (!tier) {
    issues.push({ file: fileName, severity: "error", message: `missing 'tier' field` });
  } else if (!(VALID_TIERS as Set<string>).has(tier)) {
    issues.push({ file: fileName, severity: "error", message: `invalid tier '${tier}' (expected: L1 or L2)` });
  }

  const date = meta.date as string | undefined;
  if (!date) {
    issues.push({ file: fileName, severity: "error", message: `missing 'date' field` });
  } else if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    issues.push({ file: fileName, severity: "error", message: `malformed date '${date}'` });
  }

  const tags = meta.tags;
  if (!tags) {
    issues.push({ file: fileName, severity: "warning", message: `missing 'tags' field` });
  }

  if (meta.source) {
    // 'source' is a legitimate optional metadata field written by saveMemory
    // (e.g. "explicit", "compaction", "observe") — informational, not schema.
    // No warning. See README "Frontmatter schema" table.
  }

  if (tags) {
    const tagList: string[] = Array.isArray(tags) ? tags : String(tags).split(",");
    if (tagList.some((t) => t.trim().startsWith("subject:"))) {
      issues.push({ file: fileName, severity: "warning", message: `legacy 'subject:' encoding in tags` });
    }
    if (tagList.some((t) => t.trim().startsWith("memory-type:"))) {
      issues.push({ file: fileName, severity: "warning", message: `legacy 'memory-type:' encoding in tags` });
    }
  }

  // Stale reference check (> 30 days)
  const typeLower = (type ?? "").toLowerCase();
  if (
    (typeLower === "reference" || typeLower === "note" || typeLower === "research") &&
    date
  ) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      const ageDays = (Date.now() - d.getTime()) / 86400000;
      const tagList: string[] = tags
        ? Array.isArray(tags) ? tags : String(tags).split(",")
        : [];
      if (ageDays > 30 && !tagList.includes("stale")) {
        issues.push({
          file: fileName,
          severity: "info",
          message: `reference type not updated in ${Math.round(ageDays)} days`,
        });
      }
    }
  }

  if (body.trim().length < 20) {
    issues.push({ file: fileName, severity: "warning", message: `body very short (${body.trim().length} chars)` });
  }

  return issues;
}

// --- Auto-fix ---

/**
 * Migrate a file to the new schema (type + tier).
 * Returns array of change descriptions.
 */
function fixFile(filePath: string): string[] {
  const changes: string[] = [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);
  let modified = false;

  // Migrate legacy source → type
  if (!meta.type && meta.source) {
    const normalized = normalizeSubject(meta.source as string);
    if (normalized) {
      meta.type = normalized;
      changes.push(`type←source: '${meta.source}' → '${normalized}'`);
    }
    delete meta.source;
    modified = true;
  }

  // Missing type: default to reference
  if (!meta.type) {
    meta.type = "reference";
    changes.push(`type: (missing) → 'reference'`);
    modified = true;
  }

  // Normalize legacy type values to valid subjects
  const currentType = (meta.type as string).toLowerCase();
  if (!(VALID_SUBJECTS as Set<string>).has(currentType) && Object.hasOwn(LEGACY_TYPE_MAP, currentType)) {
    const newType = LEGACY_TYPE_MAP[currentType];
    meta.type = newType;
    changes.push(`type: '${meta.type}' → '${newType}' (normalized from legacy)`);
    modified = true;
  }

  // Missing tier: LEGACY_L1_TYPES → L1 (for pre-migration files), else L2
  if (!meta.tier) {
    const typeLower = (meta.type as string).toLowerCase();
    meta.tier = LEGACY_L1_TYPES.has(typeLower) ? "L1" : "L2";
    changes.push(`tier: (missing) → '${meta.tier}'`);
    modified = true;
  }

  // Note: 'source' is now legitimate metadata (informational: which writer
  // produced the entry — "explicit" / "compaction" / "observe" / etc.).
  // We no longer auto-remove it. The migration-from-legacy case above
  // (type missing + source looks like a subject) still handles pre-0.6 data.

  // Clean legacy tags
  const tags = meta.tags;
  if (tags) {
    const tagList: string[] = Array.isArray(tags) ? [...tags] : String(tags).split(",").map((t) => t.trim());
    const cleaned = tagList.filter(
      (t) => !t.startsWith("subject:") && !t.startsWith("memory-type:"),
    );
    if (cleaned.length < tagList.length) {
      meta.tags = cleaned.length > 0 ? cleaned : undefined;
      changes.push(`tags: removed legacy subject:/memory-type: encoding`);
      modified = true;
    }
  }

  if (!modified) return changes;

  const newRaw = serializeFrontmatter(meta, body);
  fs.writeFileSync(filePath, newRaw, "utf-8");
  return changes;
}

// --- Duplicate detection ---

interface FileEntry {
  path: string;
  hash: string;
  date: string;
  type: string;
}

function findDuplicates(entries: FileEntry[]): [FileEntry, FileEntry][] {
  const byHash = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const existing = byHash.get(entry.hash) ?? [];
    existing.push(entry);
    byHash.set(entry.hash, existing);
  }
  const dupes: [FileEntry, FileEntry][] = [];
  for (const [, group] of byHash) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    for (let i = 1; i < group.length; i++) {
      dupes.push([group[i], group[0]]);
    }
  }
  return dupes;
}

// --- Main ---

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function runLint(knowledgeDir: string, fixMode: boolean, dryRun: boolean): void {
  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  // Skip auto-generated index.md (system file, not a knowledge entry)
  const files = collectFiles(knowledgeDir).filter((f) => !f.endsWith("/index.md") && !f.endsWith("index.md"));
  console.log(`\nMemory Lint — ${files.length} files${fixMode ? (dryRun ? " (dry-run)" : " (fix mode)") : ""}\n`);
  console.log("=".repeat(60));

  const allIssues: Issue[] = [];
  const entries: FileEntry[] = [];
  let fixed = 0;

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const relPath = path.relative(knowledgeDir, filePath);

    allIssues.push(...validateFile(relPath, raw).map((i) => ({ ...i, file: relPath })));

    if (fixMode) {
      const changes = fixFile(filePath);
      if (changes.length > 0) {
        fixed++;
        const tag = dryRun ? "DRY-RUN would fix" : "FIXED";
        console.log(`\n${tag}: ${relPath}`);
        for (const c of changes) console.log(`  + ${c}`);
      }
    }

    const hash = createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
    entries.push({
      path: relPath,
      hash,
      date: (meta.date as string) ?? "",
      type: (meta.type as string) ?? "unknown",
    });
  }

  if (!fixMode) {
    const errors = allIssues.filter((i) => i.severity === "error");
    const warnings = allIssues.filter((i) => i.severity === "warning");
    const infos = allIssues.filter((i) => i.severity === "info");

    if (errors.length > 0) {
      console.log(`\n❌ ERRORS (${errors.length})`);
      for (const issue of errors) console.log(`  [${issue.file}] ${issue.message}`);
    } else {
      console.log(`\n✅ No errors`);
    }

    if (warnings.length > 0) {
      console.log(`\n⚠️  WARNINGS (${warnings.length})`);
      for (const issue of warnings) console.log(`  [${issue.file}] ${issue.message}`);
    }

    if (infos.length > 0) {
      console.log(`\nℹ️  INFO (${infos.length})`);
      for (const issue of infos) console.log(`  [${issue.file}] ${issue.message}`);
    }

    const typeCounts = new Map<string, number>();
    for (const e of entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    console.log(`\n📊 Type distribution:`);
    for (const [t, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${t}: ${count}`);
    }

    const dupes = findDuplicates(entries);
    if (dupes.length > 0) {
      console.log(`\n🔄 DUPLICATES (${dupes.length} pairs):`);
      for (const [older, newer] of dupes) {
        console.log(`    '${older.path}' → '${newer.path}' (same content)`);
      }
    } else {
      console.log(`\n✅ No duplicates detected`);
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Summary: ${errors.length} errors, ${warnings.length} warnings, ${dupes.length} duplicates`);
    console.log(`Run with --fix to auto-migrate schema, --dry-run --fix to preview`);
  } else if (dryRun) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Dry run: ${fixed} files would be modified`);
  } else {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fixed ${fixed} files. Re-run lint to verify.`);
  }
}

// --- CLI ---

const args = process.argv.slice(2);
const FIX_MODE = args.includes("--fix");
const DRY_RUN = args.includes("--dry-run");
const PRUNE_MODE = args.includes("--prune");
const APPLY = args.includes("--apply");

if (args.includes("--help") || args.includes("-h")) {
  console.error("Usage:");
  console.error("  npx pi-mind-lint                       # validate $PI_MIND_DIR/knowledge");
  console.error("  npx pi-mind-lint --fix                 # auto-fix schema");
  console.error("  npx pi-mind-lint --dry-run --fix       # preview fixes");
  console.error("  npx pi-mind-lint --prune               # show what would be deleted (dry-run by default)");
  console.error("  npx pi-mind-lint --prune --apply       # really delete stale memories + raw files");
  console.error("  npx pi-mind-lint --dir <abs-path>      # validate a custom dir");
  process.exit(0);
}

// Resolve $PI_MIND_DIR once; used by both lint (knowledge subdir) and prune (whole dir).
const piMindDir = process.env.PI_MIND_DIR ?? path.join(process.cwd(), ".pi-mind");

if (PRUNE_MODE) {
  runPrune(piMindDir, !APPLY);
  process.exit(0);
}

// --dir <path> overrides default
let knowledgeDir: string;
const dirIdx = args.indexOf("--dir");
if (dirIdx >= 0 && args[dirIdx + 1]) {
  knowledgeDir = path.resolve(args[dirIdx + 1]);
} else {
  knowledgeDir = path.join(piMindDir, "knowledge");
}

runLint(knowledgeDir, FIX_MODE, DRY_RUN);

function runPrune(piMindDir: string, dryRun: boolean): void {
  const label = dryRun ? "DRY-RUN" : "APPLY";
  console.log(`pi-mind-lint --prune (${label})  PI_MIND_DIR=${piMindDir}`);
  const result: ForgetResult = forgetOldMemories(piMindDir, { dryRun });

  console.log("");
  console.log(`Would delete ${result.deletedCount} file(s):`);
  console.log(`  knowledge/         : ${result.byCategory.knowledge}`);
  console.log(`  raw/compaction/    : ${result.byCategory.rawCompaction}`);
  console.log(`  raw/sessions/      : ${result.byCategory.rawSessions}`);
  console.log(`  raw/maintenance-log: ${result.byCategory.rawMaintenanceLog}`);
  console.log(`  raw/images/ orphans: ${result.byCategory.rawImages}`);

  if (result.deletedCount > 0 && dryRun) {
    console.log("");
    console.log("Files (first 20):");
    for (const f of result.files.slice(0, 20)) console.log(`  ${f}`);
    if (result.files.length > 20) console.log(`  ... and ${result.files.length - 20} more`);
    console.log("");
    console.log("Re-run with --apply to actually delete.");
  } else if (!dryRun) {
    console.log("");
    console.log(`Deleted ${result.deletedCount} file(s).`);
    // Reset hook-internal counter so saveMemory's auto-forget doesn't re-fire shortly.
    resetForgetCounter(piMindDir, result.deletedCount);
  }
}
