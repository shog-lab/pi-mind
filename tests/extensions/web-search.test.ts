/**
 * Tests for web_search extension: mmx invocation and result formatting.
 * Verifies: result parsing from JSON, error handling, max_results slicing.
 */

import { describe, it, expect } from 'vitest';

// Simulate the result parsing logic from web_search extension
function parseSearchResult(output: string, maxResults?: number): string {
  const text = output.trim();
  try {
    const json = JSON.parse(text);
    // mmx returns {organic: [...]} — also handle plain arrays and results wrappers
    const results: Array<{ title?: string; url?: string; snippet?: string; link?: string; description?: string }> =
      Array.isArray(json) ? json : (json.organic || json.results || json.data || []);
    if (results.length > 0) {
      return results
        .slice(0, maxResults ?? 5)
        .map((r, i) =>
          `${i + 1}. ${r.title || ""}\n   ${r.url || r.link || ""}\n   ${r.snippet || r.description || ""}`
        )
        .join("\n\n");
    }
    return typeof json === "string" ? json : JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

describe('parseSearchResult', () => {
  it('formats array result with numbering', () => {
    const mmxOutput = JSON.stringify({
      organic: [
        {
          title: "MiniMax M2.7 发布",
          url: "https://minimax.io/news/m2.7",
          snippet: "M2.7 是新一代 Agent 旗舰大模型",
        },
        {
          title: "MiniMax 开放平台",
          url: "https://platform.minimaxi.com",
          snippet: "官方 API 平台",
        },
      ],
    });

    const result = parseSearchResult(mmxOutput);
    expect(result).toContain('1. MiniMax M2.7 发布');
    expect(result).toContain('https://minimax.io/news/m2.7');
    expect(result).toContain('M2.7 是新一代 Agent 旗舰大模型');
    expect(result).toContain('2. MiniMax 开放平台');
  });

  it('respects max_results limit', () => {
    const mmxOutput = JSON.stringify({
      organic: [
        { title: "Result 1", url: "http://1", snippet: "s1" },
        { title: "Result 2", url: "http://2", snippet: "s2" },
        { title: "Result 3", url: "http://3", snippet: "s3" },
      ],
    });

    const result = parseSearchResult(mmxOutput, 2);
    expect(result).toContain('1. Result 1');
    expect(result).toContain('2. Result 2');
    expect(result).not.toContain('Result 3');
  });

  it('returns JSON for empty organic array (not empty string)', () => {
    const result = parseSearchResult(JSON.stringify({ organic: [] }));
    // When results is empty, the full JSON is returned (preserves structure)
    expect(result).toContain('organic');
  });

  it('falls back to plain text on invalid JSON', () => {
    const plainText = 'No results found';
    expect(parseSearchResult(plainText)).toBe(plainText);
  });

  it('falls back to plain text on JSON parse error', () => {
    const broken = '{ not json }';
    expect(parseSearchResult(broken)).toBe(broken);
  });

  it('handles missing fields in result items', () => {
    const mmxOutput = JSON.stringify({
      organic: [
        { title: "Only Title" },
        { url: "http://only/url" },
        {},
      ],
    });

    const result = parseSearchResult(mmxOutput);
    expect(result).toContain('1. Only Title');
    expect(result).toContain('2. ');
    expect(result).toContain('http://only/url');
  });

  it('handles non-organic top-level response', () => {
    // Some mmx outputs are just arrays directly
    const arrayOutput = JSON.stringify([
      { title: "Direct Array", url: "http://x", snippet: "y" },
    ]);
    const result = parseSearchResult(arrayOutput);
    expect(result).toContain('Direct Array');
  });

  it('stringifies non-array objects that are not errors', () => {
    const objectOutput = JSON.stringify({ error: false, data: "something" });
    const result = parseSearchResult(objectOutput);
    expect(result).toContain('error');
    expect(result).toContain('data');
  });

  it('respects default max_results of 5', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `http://${i + 1}`,
      snippet: `s${i + 1}`,
    }));
    const result = parseSearchResult(JSON.stringify({ organic: items }));
    expect(result).toContain('Result 1');
    expect(result).toContain('Result 5');
    expect(result).not.toContain('Result 6');
  });
});