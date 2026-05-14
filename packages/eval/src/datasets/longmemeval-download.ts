/**
 * LongMemEval downloader — fetches dataset JSON from HuggingFace into a
 * persistent cache, so subsequent runs are offline.
 *
 * Three splits:
 *   - oracle (15MB):  minimal evidence sessions per question. Best for "does it work at all" baseline.
 *   - s     (277MB):  short history (~50 sessions/question). Realistic memory test.
 *   - m     (2.7GB):  medium history (~500 sessions/question). Long-context stress test.
 *
 * Cache location: $LONGMEMEVAL_CACHE_DIR or ~/.cache/pi-mind-eval/longmemeval/
 * Files are downloaded once and never re-validated (HuggingFace LFS blobs are
 * immutable per oid; if the upstream changes, delete the cache to force refresh).
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export type LongMemEvalSplit = "oracle" | "s" | "m";

const FILES: Record<LongMemEvalSplit, { filename: string; sizeBytes: number }> = {
  oracle: { filename: "longmemeval_oracle.json",    sizeBytes:    15_388_478 },
  s:      { filename: "longmemeval_s_cleaned.json", sizeBytes:   277_383_467 },
  m:      { filename: "longmemeval_m_cleaned.json", sizeBytes: 2_737_100_077 },
};

const HF_BASE = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main";

export function getCacheDir(): string {
  return process.env.LONGMEMEVAL_CACHE_DIR ?? join(homedir(), ".cache", "pi-mind-eval", "longmemeval");
}

export function getCachedPath(split: LongMemEvalSplit): string {
  return join(getCacheDir(), FILES[split].filename);
}

/**
 * Ensure the given split is cached locally. Downloads if missing.
 * Returns the absolute path to the cached file.
 *
 * For large splits ('s', 'm'), this can take a while — caller should expose
 * a progress signal if running interactively.
 */
export async function ensureCached(split: LongMemEvalSplit, opts?: { onProgress?: (bytes: number, total: number) => void }): Promise<string> {
  const path = getCachedPath(split);
  if (existsSync(path)) {
    // Sanity check: file size roughly matches expected. Allow ±5% (HF metadata can drift slightly).
    const actual = statSync(path).size;
    const expected = FILES[split].sizeBytes;
    if (Math.abs(actual - expected) / expected < 0.05) return path;
    console.warn(`[longmemeval] cached ${path} size ${actual} differs from expected ${expected}; re-downloading`);
  }

  mkdirSync(dirname(path), { recursive: true });
  const url = `${HF_BASE}/${FILES[split].filename}`;
  console.log(`[longmemeval] downloading ${url} → ${path}`);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length") ?? FILES[split].sizeBytes);

  let received = 0;
  const monitored = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
    received += chunk.length;
    opts?.onProgress?.(received, total);
  });

  await pipeline(monitored, createWriteStream(path));
  return path;
}
