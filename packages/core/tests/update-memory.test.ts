/**
 * Tests for the `update_memory` tool \u2014 patch-style correction of a
 * single knowledge/*.md file via exact-match replace.
 *
 * Scenarios:
 *   - Tool registered in extension surface
 *   - Happy path: unique old_text, body patched, frontmatter updated,
 *     syncIndex runs (FTS + KG reflect the change)
 *   - old_text 0 match / >1 match \u2192 isError, file unchanged
 *   - Path escape: raw/, sessions/, compaction/, ../, symlink \u2192 isError
 *   - Frontmatter preservation: triples, tags, source, image survive
 *   - KG preservation: existing triples still in KG after the patch
 *   - dist E2E: from dist/ extension, the tool is registered and works
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { MemoryCore, serializeFrontmatter } =
  (await import("../extensions/memory/core.js")) as typeof import("../extensions/memory/core.js");

let tmpDir: string;
let mc: InstanceType<typeof MemoryCore>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mind-update-mem-test-"));
  fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "raw"), { recursive: true });
  mc = new MemoryCore({
    groupDir: tmpDir,
    dbPath: path.join(tmpDir, ".pi-mind-index.db"),
    freshDb: true,
  });
});

afterEach(() => {
  try { mc.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeKnowledge(name: string, body: string, meta: Record<string, unknown> = {}) {
  const fullMeta: Record<string, unknown> = { date: "2026-05-01T00:00:00Z", tier: "L2", ...meta };
  // Pre-stringify the `triples` field, matching what saveMemory writes.
  // Without this, serializeFrontmatter would flatten the nested array
  // via Array.join() and produce a malformed triples line.
  if (Array.isArray(fullMeta.triples)) {
    fullMeta.triples = JSON.stringify(fullMeta.triples);
  }
  const raw = serializeFrontmatter(fullMeta as any, body);
  const fp = path.join(tmpDir, "knowledge", name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, raw);
  return fp;
}

// =============================================================================
// Core: updateMemory method
// =============================================================================

describe("MemoryCore.updateMemory \u2014 happy path", () => {
  it("patches body content with exact-match old_text \u2192 new_text", async () => {
    const fp = writeKnowledge(
      "alice.md",
      "Alice lives in Berlin and works at the bakery.",
    );
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "lives in Berlin",
      newText: "lives in Munich",
      reason: "moved cities",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("lives in Munich");
    expect(body).not.toContain("lives in Berlin");
  });

  it("adds `updated: <ISO>` and `update_reason: <reason>` to frontmatter", async () => {
    const fp = writeKnowledge("a.md", "Body here.");
    const before = Date.now();
    await mc.updateMemory({
      filePath: fp,
      oldText: "Body here.",
      newText: "Body now updated.",
      reason: "test reason",
    });
    const after = Date.now();
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
    expect(body).toMatch(/update_reason: test reason/);
    // `updated` timestamp should be between before and after
    const m = body.match(/updated: (.+)/);
    expect(m).toBeTruthy();
    const ts = Date.parse(m![1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it("adds `updated` even when reason is omitted", async () => {
    const fp = writeKnowledge("a.md", "Body here.");
    await mc.updateMemory({ filePath: fp, oldText: "Body here.", newText: "Body updated." });
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toMatch(/updated: /);
    expect(body).not.toMatch(/update_reason: /);
  });

  it("preserves existing frontmatter (triples, tags, source, image)", async () => {
    const fp = writeKnowledge(
      "rich.md",
      "Body about alice alice-preserve-marker.",
      {
        type: "project",
        tags: ["important", "team"],
        source: "explicit",
        image: "raw/images/abc.png",
        triples: [["alice-preserve", "owns", "x"]],
      },
    );
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "alice-preserve-marker",
      newText: "updated-marker",
      reason: "test",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("type: project");
    expect(body).toContain("tags: [important, team]");
    expect(body).toContain("source: explicit");
    expect(body).toContain("image: raw/images/abc.png");
    expect(body).toContain('triples: [["alice-preserve","owns","x"]]');
    expect(body).toContain("updated:");
    expect(body).toContain("update_reason: test");
  });
});

describe("MemoryCore.updateMemory \u2014 syncIndex visibility", () => {
  it("after patch, buildContext sees new_text and not old_text", async () => {
    // Use single-word markers (no dashes) because FTS5's unicode61
    // tokenizer does NOT split on hyphens — a single token would not
    // match a multi-term FTS query. Also "new" is a stopword, so use
    // unambiguous words. The body marker must be UNIQUE in the file —
    // it can't appear in the triples frontmatter (or the patch fails
    // with "matches 2 times"). Keep triples' object name distinct
    // from the body marker.
    const fp = writeKnowledge(
      "ctx.md",
      "Bob works on the project BANANA-marker.",
      { type: "project", triples: [["bob", "works_on", "date-fruit-entity"]] },
    );
    await mc.syncIndex();
    // Pre-patch: FTS finds the file via the "BANANA" token.
    const before = await mc.buildContext("BANANA");
    expect(before).toContain("BANANA-marker");

    // Patch: replace BANANA-marker with CHERRY-marker.
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "BANANA-marker",
      newText: "CHERRY-marker",
    });
    expect(r.ok).toBe(true);
    // Post-patch: buildContext sees CHERRY (the new token), not BANANA.
    const after = await mc.buildContext("CHERRY");
    expect(after).toContain("CHERRY-marker");
    expect(after).not.toContain("BANANA-marker");
  });

  it("KG is rebuilt from frontmatter after the patch \u2014 existing triples survive", async () => {
    // File has two triples: one will be patched (its body content mentions
    // the subject), the other should survive untouched in the KG.
    const fp = writeKnowledge(
      "kg.md",
      "Alice owns the kg-marker entity.",
      {
        type: "project",
        triples: [
          ["alice-kg", "owns", "kg-marker-entity"],
          ["bob-kg", "manages", "kg-marker-entity"],
        ],
      },
    );
    await mc.syncIndex();
    expect(mc.kg.queryEntity("alice-kg").length).toBeGreaterThan(0);
    expect(mc.kg.queryEntity("bob-kg").length).toBeGreaterThan(0);

    // Patch body but keep the same triples.
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "Alice owns the kg-marker entity.",
      newText: "Alice still owns the kg-marker entity (corrected).",
    });
    expect(r.ok).toBe(true);
    // Both triples still present in KG (rebuild re-derives from frontmatter).
    expect(mc.kg.queryEntity("alice-kg").length).toBeGreaterThan(0);
    expect(mc.kg.queryEntity("bob-kg").length).toBeGreaterThan(0);
  });
});

describe("MemoryCore.updateMemory \u2014 old_text uniqueness", () => {
  it("returns isError when old_text matches 0 times (file unchanged)", async () => {
    const fp = writeKnowledge("nomatch.md", "Body content here.");
    const before = fs.readFileSync(fp, "utf-8");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "this text does not exist",
      newText: "irrelevant",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/0 matches/);
    const after = fs.readFileSync(fp, "utf-8");
    expect(after).toBe(before);
  });

  it("returns isError when old_text matches more than once (file unchanged)", async () => {
    const fp = writeKnowledge("dup.md", "alice appears here and alice appears again.");
    const before = fs.readFileSync(fp, "utf-8");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "alice",
      newText: "bob",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/2 times/);
    const after = fs.readFileSync(fp, "utf-8");
    expect(after).toBe(before);
  });

  it("rejects empty old_text (would loop infinitely on indexOf)", async () => {
    const fp = writeKnowledge("a.md", "Body here.");
    const r = await mc.updateMemory({ filePath: fp, oldText: "", newText: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-empty/);
  });
});

describe("MemoryCore.updateMemory \u2014 path safety", () => {
  it("rejects paths under raw/ (event stream, not knowledge)", async () => {
    const rawFile = path.join(tmpDir, "raw", "compaction", "x.md");
    fs.mkdirSync(path.dirname(rawFile), { recursive: true });
    fs.writeFileSync(rawFile, "Body.");
    const r = await mc.updateMemory({
      filePath: rawFile,
      oldText: "Body.",
      newText: "Body updated.",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/knowledgeDir|escape/);
  });

  it("rejects absolute paths outside PI_MIND_DIR (e.g. /etc/passwd)", async () => {
    const r = await mc.updateMemory({
      filePath: "/etc/passwd",
      oldText: "root",
      newText: "evil",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not exist|escape/);
  });

  it("rejects ../ escape from knowledgeDir", async () => {
    // knowledgeDir/../package.json would resolve to <PI_MIND_DIR>/../package.json
    const escapePath = path.join(tmpDir, "knowledge", "..", "..", "package.json");
    const r = await mc.updateMemory({
      filePath: escapePath,
      oldText: "name",
      newText: "evil",
    });
    expect(r.ok).toBe(false);
    // Either the file doesn't exist (does not exist error) or the
    // post-canonicalize path is outside knowledgeDir.
    expect(r.error).toBeTruthy();
  });

  it("rejects a symlink inside knowledge/ that points outside (symlink escape)", async () => {
    // Create a real file outside knowledge/, then a symlink inside.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const outsideFile = path.join(outsideDir, "secret.md");
    fs.writeFileSync(outsideFile, "Secret body symlink-marker.");
    const linkPath = path.join(tmpDir, "knowledge", "linked.md");
    try { fs.unlinkSync(linkPath); } catch {}
    fs.symlinkSync(outsideFile, linkPath);

    const r = await mc.updateMemory({
      filePath: linkPath,
      oldText: "symlink-marker",
      newText: "evil",
    });
    expect(r.ok).toBe(false);
    // realpathSync follows the symlink, the resolved path is outside
    // knowledgeDir, containment check fails.
    expect(r.error).toMatch(/escapes knowledgeDir/);
    // The outside file must NOT have been modified.
    const outsideBody = fs.readFileSync(outsideFile, "utf-8");
    expect(outsideBody).toBe("Secret body symlink-marker.");
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("accepts a relative path under knowledgeDir (anchored to knowledgeDir)", async () => {
    const fp = writeKnowledge("rel.md", "Body rel-marker.");
    const r = await mc.updateMemory({
      filePath: "rel.md", // knowledgeDir-relative — resolves to knowledgeDir/rel.md
      oldText: "rel-marker",
      newText: "rel-updated",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("rel-updated");
  });

  it("rejects non-.md files (e.g. .txt)", async () => {
    const txtFile = path.join(tmpDir, "knowledge", "notes.txt");
    fs.writeFileSync(txtFile, "Body.");
    const r = await mc.updateMemory({
      filePath: txtFile,
      oldText: "Body.",
      newText: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a \.md file/);
  });
});

describe("MemoryCore.updateMemory — 3 path anchors (absolute / PI_MIND_DIR-relative / knowledgeDir-relative)", () => {
  it("PI_MIND_DIR-relative 'knowledge/foo.md' resolves to knowledgeDir/foo.md", async () => {
    // User's mental model: the path they'd see in their repo, relative
    // to the project root. Resolver anchors to groupDir (PI_MIND_DIR), so
    // "knowledge/foo.md" → <PI_MIND_DIR>/knowledge/foo.md → knowledgeDir/foo.md.
    const fp = writeKnowledge("pimrel.md", "Body pimrel-marker.");
    const rel = path.relative(tmpDir, fp);
    expect(rel).toBe("knowledge/pimrel.md");
    const r = await mc.updateMemory({
      filePath: rel,
      oldText: "pimrel-marker",
      newText: "pimrel-updated",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("pimrel-updated");
  });

  it("PI_MIND_DIR-relative '.pi-mind/knowledge/foo.md' (cwd-style) resolves correctly", async () => {
    // Simulate the user calling the tool with a full path as it appears
    // in their repo: ".pi-mind/knowledge/foo.md". To make this resolve
    // cleanly without depending on the test's actual tmp dir name, we
    // build a sandbox where the "host root" is the parent of `.pi-mind/`,
    // and groupDir = `<hostRoot>/.pi-mind`, knowledgeDir = `…/knowledge`.
    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "host-"));
    const piMindDir = path.join(hostRoot, ".pi-mind");
    const knowledgeDir = path.join(piMindDir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const fp = path.join(knowledgeDir, "cwdstyle.md");
    fs.writeFileSync(fp, "Body cwdstyle-marker.\n");

    // Build a fresh MemoryCore rooted at this synthetic host.
    const localMc = new MemoryCore({
      groupDir: piMindDir,
      dbPath: path.join(piMindDir, ".pi-mind-index.db"),
      freshDb: true,
    });
    try {
      // The user calls the tool with a path relative to the host root
      // (their mental model: "what I see in my repo").
      const userPath = ".pi-mind/knowledge/cwdstyle.md";
      const r = await localMc.updateMemory({
        filePath: userPath,
        oldText: "cwdstyle-marker",
        newText: "cwdstyle-updated",
      });
      expect(r.ok).toBe(true);
      const body = fs.readFileSync(fp, "utf-8");
      expect(body).toContain("cwdstyle-updated");
    } finally {
      localMc.close();
      fs.rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it("absolute path inside knowledgeDir resolves correctly", async () => {
    const fp = writeKnowledge("abs.md", "Body abs-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "abs-marker",
      newText: "abs-updated",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("abs-updated");
  });

  it("rejects a relative path that lands outside knowledgeDir under ALL 3 anchors", async () => {
    // "../package.json" relative to any of the 3 anchors resolves
    // outside knowledgeDir. The resolver tries all 3 and rejects.
    const r = await mc.updateMemory({
      filePath: "../package.json",
      oldText: "name",
      newText: "evil",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes knowledgeDir/);
  });
});

describe("MemoryCore.updateMemory — reason sanitization", () => {
  it("folds newlines and tabs in reason to single spaces", async () => {
    const fp = writeKnowledge("a.md", "Body reason-newline-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "reason-newline-marker",
      newText: "reason-newline-PATCHED",
      reason: "line1\nline2\tline3",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    const reasonLine = body.split("\n").find((l) => l.startsWith("update_reason:"));
    expect(reasonLine).toBeDefined();
    expect(reasonLine).not.toMatch(/[\n\r]/);
    expect(reasonLine).toBe("update_reason: line1 line2 line3");
  });

  it("trims leading/trailing whitespace in reason", async () => {
    const fp = writeKnowledge("a.md", "Body reason-trim-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "reason-trim-marker",
      newText: "reason-trim-PATCHED",
      reason: "   spaces-around-me   ",
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    const reasonLine = body.split("\n").find((l) => l.startsWith("update_reason:"));
    expect(reasonLine).toBe("update_reason: spaces-around-me");
  });

  it("rejects reason containing '---' (frontmatter delimiter)", async () => {
    const fp = writeKnowledge("a.md", "Body reason-delim-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "reason-delim-marker",
      newText: "reason-delim-PATCHED",
      reason: "this contains --- a delimiter",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/frontmatter delimiter/);
    // File unchanged.
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("reason-delim-marker");
    expect(body).not.toContain("reason-delim-PATCHED");
  });

  it("caps reason length at 200 characters (truncates, does not error)", async () => {
    const fp = writeKnowledge("a.md", "Body reason-cap-marker.");
    const longReason = "x".repeat(500);
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "reason-cap-marker",
      newText: "reason-cap-PATCHED",
      reason: longReason,
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    const reasonLine = body.split("\n").find((l) => l.startsWith("update_reason:"));
    expect(reasonLine).toBeDefined();
    // "update_reason: " (15 chars) + 200 x's = 215 chars total.
    expect(reasonLine!.length).toBe(15 + 200);
  });

  it("treats sanitized-empty reason as 'not provided' (omits update_reason)", async () => {
    const fp = writeKnowledge("a.md", "Body reason-empty-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "reason-empty-marker",
      newText: "reason-empty-PATCHED",
      reason: "   \n  \t  ", // pure whitespace — sanitizes to empty
    });
    expect(r.ok).toBe(true);
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("updated:");
    expect(body).not.toContain("update_reason:");
  });
});

describe("MemoryCore.updateMemory — no-op patch rejection", () => {
  it("rejects new_text === old_text (no-op)", async () => {
    const fp = writeKnowledge("a.md", "Body noop-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "noop-marker",
      newText: "noop-marker", // identical to oldText
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/identical to old_text/);
    // File must be unchanged.
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("noop-marker");
  });
});

describe("update_memory tool \u2014 sanitized reason in result / message / log", () => {
  it("MemoryCore.updateMemory returns sanitizedReason that matches what's on disk", async () => {
    const fp = writeKnowledge("a.md", "Body r1-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "r1-marker",
      newText: "r1-PATCHED",
      reason: "  line1\nline2\tline3  ", // leading/trailing spaces + newline + tab
    });
    expect(r.ok).toBe(true);
    expect(r.sanitizedReason).toBe("line1 line2 line3");
    // And the on-disk frontmatter has the same sanitized value.
    const body = fs.readFileSync(fp, "utf-8");
    expect(body).toContain("update_reason: line1 line2 line3");
  });

  it("returns sanitizedReason: undefined when no reason was provided", async () => {
    const fp = writeKnowledge("a.md", "Body nor-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "nor-marker",
      newText: "nor-PATCHED",
    });
    expect(r.ok).toBe(true);
    expect(r.sanitizedReason).toBeUndefined();
  });

  it("returns sanitizedReason: undefined when reason sanitizes to empty (pure whitespace)", async () => {
    const fp = writeKnowledge("a.md", "Body emp-marker.");
    const r = await mc.updateMemory({
      filePath: fp,
      oldText: "emp-marker",
      newText: "emp-PATCHED",
      reason: "   \n  \t  ",
    });
    expect(r.ok).toBe(true);
    expect(r.sanitizedReason).toBeUndefined();
  });

  it("tool success message uses the SANITIZED reason (newlines folded), not raw input", async () => {
    // Use the extension surface so we go through the tool's execute().
    vi.resetModules();
    process.env.PI_MIND_DIR = tmpDir;
    try {
      const mod = (await import("../extensions/memory/index.js")) as {
        default: (pi: any) => void;
      };
      const fp = writeKnowledge("tool-msg.md", "Body tool-msg-marker.");
      const tools = new Map<string, any>();
      const pi = {
        tools,
        hooks: new Map(),
        injectContext: vi.fn(),
        registerTool: (t: any) => tools.set(t.name, t),
        on: vi.fn(),
      };
      mod.default(pi);
      const tool = tools.get("update_memory")!;

      const r = await tool.execute("t1", {
        file_path: fp,
        old_text: "tool-msg-marker",
        new_text: "tool-msg-PATCHED",
        reason: "first line\nsecond line\twith tab",
      });
      expect(r.isError).toBeFalsy();
      // The displayed reason is the sanitized one, NOT the raw input.
      expect(r.content[0].text).toContain("(reason: first line second line with tab)");
      expect(r.content[0].text).not.toContain("\n");
      // The details also carry the sanitized reason (machine-readable).
      expect(r.details.reason).toBe("first line second line with tab");
    } finally {
      delete process.env.PI_MIND_DIR;
    }
  });

  it("tool success message OMITS '(reason: ...)' when sanitized reason is empty", async () => {
    vi.resetModules();
    process.env.PI_MIND_DIR = tmpDir;
    try {
      const mod = (await import("../extensions/memory/index.js")) as {
        default: (pi: any) => void;
      };
      const fp = writeKnowledge("tool-msg-empty.md", "Body tm-empty-marker.");
      const tools = new Map<string, any>();
      const pi = {
        tools,
        hooks: new Map(),
        injectContext: vi.fn(),
        registerTool: (t: any) => tools.set(t.name, t),
        on: vi.fn(),
      };
      mod.default(pi);
      const tool = tools.get("update_memory")!;

      // Pure whitespace → sanitized to empty → no (reason: ...) clause.
      const r1 = await tool.execute("t1", {
        file_path: fp,
        old_text: "tm-empty-marker",
        new_text: "tm-empty-P1",
        reason: "   \n  \t  ",
      });
      expect(r1.isError).toBeFalsy();
      expect(r1.content[0].text).not.toMatch(/reason:/);
      expect(r1.details.reason).toBeUndefined();

      // No reason at all → also no (reason: ...) clause.
      const r2 = await tool.execute("t2", {
        file_path: fp,
        old_text: "tm-empty-P1",
        new_text: "tm-empty-P2",
      });
      expect(r2.isError).toBeFalsy();
      expect(r2.content[0].text).not.toMatch(/reason:/);
      expect(r2.details.reason).toBeUndefined();
    } finally {
      delete process.env.PI_MIND_DIR;
    }
  });
});

describe("update_memory tool \u2014 extension surface", () => {
  it("registers the update_memory tool", async () => {
    // The extension captures PI_MIND_DIR at module load, so reset modules
    // + re-import with PI_MIND_DIR pointed at our tmp.
    vi.resetModules();
    process.env.PI_MIND_DIR = tmpDir;
    const mod = (await import("../extensions/memory/index.js")) as {
      default: (pi: any) => void;
    };
    const tools = new Map<string, any>();
    const pi = {
      tools,
      hooks: new Map(),
      injectContext: vi.fn(),
      registerTool: (t: any) => tools.set(t.name, t),
      on: vi.fn(),
    };
    mod.default(pi);
    expect(tools.has("update_memory")).toBe(true);
    const t = tools.get("update_memory")!;
    expect(t.label).toBe("Update Memory");
    // The tool description should mention "patch" or "old_text" so the
    // agent knows the exact-match contract.
    expect(t.description).toMatch(/patch|old_text|exact/);
    expect(t.description).toMatch(/raw|sessions|compaction/);
    delete process.env.PI_MIND_DIR;
  });
});
