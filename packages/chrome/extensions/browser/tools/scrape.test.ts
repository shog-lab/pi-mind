import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerScrape } from "./scrape.js";
import { clearMockEnv, makeMockBinary, type MockBinary } from "./__test-helpers__/mock-binary.js";

const SAMPLE_SNAPSHOT = JSON.stringify({
  success: true,
  data: {
    origin: "https://example.com/",
    refs: {
      e1: { name: "Example Domain", role: "heading" },
      e2: { name: "Learn more", role: "link" },
      e3: { name: "Buy now", role: "button" },
    },
    snapshot: "...",
  },
  error: null,
});

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: true;
  }>;
}

function makeTool(): CapturedTool {
  let captured: CapturedTool | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi: any = { registerTool: (o: CapturedTool) => { captured = o; } };
  registerScrape(pi);
  if (!captured) throw new Error("registerScrape did not register a tool");
  return captured;
}

function parseResult(res: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("scrape", () => {
  let bin: MockBinary;

  beforeAll(() => { bin = makeMockBinary(); });
  afterAll(() => bin.cleanup());

  beforeEach(() => {
    process.env.AGENT_BROWSER_BIN = bin.path;
  });
  afterEach(() => clearMockEnv());

  it("extracts fields by role and exact name", async () => {
    process.env.MOCK_SNAPSHOT_JSON = SAMPLE_SNAPSHOT;
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: {
        title: { role: "heading", name: "Example Domain" },
        cta: { role: "link", name: "Learn more" },
      },
    });

    expect(res.isError).toBeUndefined();
    const data = parseResult(res);
    expect(data.url).toBe("https://example.com");
    expect(data.missing).toEqual([]);
    expect(data.fields.title).toEqual({ ref: "@e1", value: "Example Domain", role: "heading" });
    expect(data.fields.cta).toEqual({ ref: "@e2", value: "Learn more", role: "link" });
    expect(data.exitCode).toBe(0);
  });

  it("matches by regex via nameMatches", async () => {
    process.env.MOCK_SNAPSHOT_JSON = SAMPLE_SNAPSHOT;
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { learn: { role: "link", nameMatches: "^Learn" } },
    });

    const data = parseResult(res);
    expect(data.fields.learn.ref).toBe("@e2");
  });

  it("reports missing fields and flags result as error", async () => {
    process.env.MOCK_SNAPSHOT_JSON = SAMPLE_SNAPSHOT;
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: {
        title: { role: "heading", name: "Example Domain" },
        ghost: { role: "checkbox", name: "Subscribe" },
      },
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.missing).toEqual(["ghost"]);
    expect(data.fields.title).not.toBeNull();
    expect(data.fields.ghost).toBeNull();
  });

  it("returns all fields missing when open fails", async () => {
    process.env.MOCK_OPEN_EXIT = "1";
    process.env.MOCK_SNAPSHOT_JSON = SAMPLE_SNAPSHOT;
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://broken.example",
      fields: { title: { role: "heading" } },
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.missing).toEqual(["title"]);
    expect(data.fields.title).toBeNull();
    expect(data.exitCode).toBe(1);
  }, 10000);

  it("returns all fields missing when snapshot returns invalid JSON", async () => {
    process.env.MOCK_SNAPSHOT_JSON = "not-json{{{";
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { title: { role: "heading" } },
    });

    expect(res.isError).toBe(true);
    const data = parseResult(res);
    expect(data.missing).toEqual(["title"]);
    expect(data.fields.title).toBeNull();
  }, 10000);

  it("first matching ref wins when multiple candidates share role", async () => {
    process.env.MOCK_SNAPSHOT_JSON = JSON.stringify({
      success: true,
      data: {
        refs: {
          e1: { name: "First", role: "heading" },
          e2: { name: "Second", role: "heading" },
        },
      },
    });
    const tool = makeTool();

    const res = await tool.execute("1", {
      url: "https://example.com",
      fields: { h: { role: "heading" } },
    });

    const data = parseResult(res);
    expect(data.fields.h.ref).toBe("@e1");
    expect(data.fields.h.value).toBe("First");
    expect(data.pages).toBe(1);
  });

  describe("multi-match", () => {
    it("returns all matches as an array when multi: true", async () => {
      process.env.MOCK_SNAPSHOT_JSON = JSON.stringify({
        success: true,
        data: {
          refs: {
            e1: { name: "$10", role: "text" },
            e2: { name: "Title", role: "heading" },
            e3: { name: "$20", role: "text" },
            e4: { name: "$30", role: "text" },
          },
        },
      });
      const tool = makeTool();

      const res = await tool.execute("1", {
        url: "https://shop.example",
        fields: {
          prices: { role: "text", nameMatches: "^\\$", multi: true },
        },
      });

      expect(res.isError).toBeUndefined();
      const data = parseResult(res);
      expect(data.fields.prices).toHaveLength(3);
      expect(data.fields.prices.map((m: { value: string }) => m.value)).toEqual(["$10", "$20", "$30"]);
      expect(data.missing).toEqual([]);
    });

    it("returns empty array and lists in missing when no multi matches", async () => {
      process.env.MOCK_SNAPSHOT_JSON = JSON.stringify({
        success: true,
        data: { refs: { e1: { name: "Title", role: "heading" } } },
      });
      const tool = makeTool();

      const res = await tool.execute("1", {
        url: "https://example.com",
        fields: {
          links: { role: "link", multi: true },
        },
      });

      expect(res.isError).toBe(true);
      const data = parseResult(res);
      expect(data.fields.links).toEqual([]);
      expect(data.missing).toEqual(["links"]);
    });
  });

  describe("pagination", () => {
    let seqDir: string;
    beforeEach(() => {
      seqDir = mkdtempSync(join(tmpdir(), "pi-chrome-seq-"));
      process.env.MOCK_SNAPSHOT_SEQ = seqDir;
    });
    afterEach(() => {
      rmSync(seqDir, { recursive: true, force: true });
    });

    function writePage(idx: number, snapshot: object) {
      writeFileSync(join(seqDir, `${idx}.json`), JSON.stringify(snapshot));
    }

    function pageWithNext(items: string[], nextRef: string | null) {
      const refs: Record<string, { name: string; role: string }> = {};
      let i = 1;
      for (const v of items) {
        refs[`e${i++}`] = { name: v, role: "text" };
      }
      if (nextRef) refs[nextRef.replace(/^@/, "")] = { name: "Next", role: "link" };
      return { success: true, data: { refs } };
    }

    it("follows next ref across pages and accumulates multi fields", async () => {
      writePage(0, pageWithNext(["a", "b"], "@e99"));
      writePage(1, pageWithNext(["c", "d"], "@e99"));
      writePage(2, pageWithNext(["e"], null));

      const tool = makeTool();
      const logPath = join(seqDir, "calls.log");
      process.env.MOCK_LOG = logPath;

      const res = await tool.execute("1", {
        url: "https://list.example",
        fields: { items: { role: "text", multi: true } },
        paginate: { next: { role: "link", name: "Next" }, waitMs: 5 },
      });

      expect(res.isError).toBeUndefined();
      const data = parseResult(res);
      expect(data.pages).toBe(3);
      expect(data.fields.items.map((m: { value: string }) => m.value)).toEqual(["a", "b", "c", "d", "e"]);

      const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const kinds = calls.map((c: string[]) => c[0]);
      expect(kinds).toEqual(["open", "snapshot", "click", "snapshot", "click", "snapshot"]);
    });

    it("stops at maxPages even if next is still present", async () => {
      writePage(0, pageWithNext(["a"], "@e99"));
      writePage(1, pageWithNext(["b"], "@e99"));
      writePage(2, pageWithNext(["c"], "@e99")); // never reached
      const tool = makeTool();

      const res = await tool.execute("1", {
        url: "https://list.example",
        fields: { items: { role: "text", multi: true } },
        paginate: { next: { role: "link", name: "Next" }, maxPages: 2, waitMs: 5 },
      });

      const data = parseResult(res);
      expect(data.pages).toBe(2);
      expect(data.fields.items.map((m: { value: string }) => m.value)).toEqual(["a", "b"]);
    });

    it("single (non-multi) field takes value from page 1 only", async () => {
      writePage(0, {
        success: true,
        data: {
          refs: {
            e1: { name: "First Title", role: "heading" },
            e2: { name: "a", role: "text" },
            e99: { name: "Next", role: "link" },
          },
        },
      });
      writePage(1, {
        success: true,
        data: {
          refs: {
            e1: { name: "Second Title", role: "heading" },
            e2: { name: "b", role: "text" },
          },
        },
      });
      const tool = makeTool();

      const res = await tool.execute("1", {
        url: "https://list.example",
        fields: {
          title: { role: "heading" },
          items: { role: "text", multi: true },
        },
        paginate: { next: { role: "link", name: "Next" }, waitMs: 5 },
      });

      const data = parseResult(res);
      expect(data.fields.title.value).toBe("First Title");
      expect(data.fields.items.map((m: { value: string }) => m.value)).toEqual(["a", "b"]);
      expect(data.pages).toBe(2);
    });
  });
});
