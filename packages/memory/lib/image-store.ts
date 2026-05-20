/**
 * Image storage for memory entries.
 *
 * Used by the remember_this tool when the agent passes an image_path: copy
 * the file (compressed if large) into <PI_MIND_DIR>/raw/images/ under a
 * content-addressed name, so two saves of the same image dedup and the
 * image is portable inside the .pi-mind store (the agent's source path is
 * typically transient — /tmp, a session-scoped dir, etc.).
 *
 * No vision / description logic lives here. The agent is responsible for
 * describing the image (via toolkit's understand_image or otherwise) before
 * calling remember_this, so memory has no dependency on a vision model.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import sharp from "sharp";

const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Files larger than this (bytes) are compressed before storage. */
const COMPRESS_OVER_BYTES = 2 * 1024 * 1024; // 2 MB
/** Hard cap — files above this are rejected even before attempting compression. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB
/** Longest-edge resize target for compressed images. */
const RESIZE_MAX_EDGE = 2048;
/** JPEG quality used when re-encoding non-PNG images. */
const JPEG_QUALITY = 85;

export type StoreImageOk = {
  ok: true;
  /** Path relative to PI_MIND_DIR (e.g. "raw/images/abc123.png"). */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  /** sha256 of the stored (post-compression) bytes, first 16 hex chars. */
  hash: string;
  /** Final file size in bytes. */
  bytes: number;
  /** True if the file was reduced from the source. */
  compressed: boolean;
};

export type StoreImageErr = {
  ok: false;
  reason: "not-found" | "not-readable" | "bad-ext" | "too-large" | "compress-failed";
  detail: string;
};

export type StoreImageResult = StoreImageOk | StoreImageErr;

/**
 * Validate and copy an image into <piMindDir>/raw/images/<hash>.<ext>.
 *
 * - Rejects paths that don't exist, aren't readable, have a non-image
 *   extension, or exceed MAX_INPUT_BYTES.
 * - Files over COMPRESS_OVER_BYTES are resized (longest edge ≤ RESIZE_MAX_EDGE)
 *   and re-encoded; PNG stays PNG (to keep transparency), others go JPEG @ Q85.
 * - Content addressing uses the sha256 of the *stored* bytes, so two saves
 *   of the same source dedupe to the same file even after compression.
 */
export async function storeImage(srcPath: string, piMindDir: string): Promise<StoreImageResult> {
  if (!existsSync(srcPath)) {
    return { ok: false, reason: "not-found", detail: `no file at ${srcPath}` };
  }
  let st;
  try {
    st = statSync(srcPath);
  } catch (e) {
    return { ok: false, reason: "not-readable", detail: String(e) };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "not-readable", detail: "path is not a regular file" };
  }
  if (st.size > MAX_INPUT_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      detail: `${st.size} bytes exceeds ${MAX_INPUT_BYTES} byte hard limit`,
    };
  }

  const ext = extname(srcPath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, reason: "bad-ext", detail: `extension '${ext}' not in ${[...ALLOWED_EXTS].join(",")}` };
  }

  let outBytes: Buffer;
  let outExt = ext;
  let compressed = false;
  try {
    if (st.size > COMPRESS_OVER_BYTES) {
      const isPng = ext === ".png";
      const pipeline = sharp(srcPath).resize({
        width: RESIZE_MAX_EDGE,
        height: RESIZE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
      if (isPng) {
        outBytes = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      } else {
        outBytes = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
        outExt = ".jpg";
      }
      compressed = true;
    } else {
      outBytes = readFileSync(srcPath);
    }
  } catch (e) {
    return { ok: false, reason: "compress-failed", detail: String(e) };
  }

  const hash = createHash("sha256").update(outBytes).digest("hex").slice(0, 16);
  const fileName = `${hash}${outExt}`;
  const destDir = join(piMindDir, "raw", "images");
  const absPath = join(destDir, fileName);
  const relPath = join("raw", "images", fileName);

  if (existsSync(absPath)) {
    // Already stored — dedup hit. Skip the write but report success.
    return { ok: true, relPath, absPath, hash, bytes: outBytes.length, compressed };
  }

  try {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(absPath, outBytes);
  } catch (e) {
    return { ok: false, reason: "compress-failed", detail: `write failed: ${String(e)}` };
  }

  return { ok: true, relPath, absPath, hash, bytes: outBytes.length, compressed };
}
