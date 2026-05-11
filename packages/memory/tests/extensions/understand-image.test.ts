/**
 * Tests for understand_image extension: base64 path resolution and temp cleanup.
 * Verifies: data URL parsing, base64 decode, temp file lifecycle, path passthrough.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Replicate the resolveImageToPath logic from the extension
function resolveImageToPath(imageInput: string): string {
  if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
    return imageInput;
  }
  if (imageInput.startsWith('/')) {
    return imageInput;
  }
  if (imageInput.startsWith('data:')) {
    const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error(`Invalid base64 data URL`);
    const mimeType = match[1];
    const data = match[2];
    const extRaw = mimeType.split('/')[1] || 'png';
    const ext = extRaw === 'jpeg' ? 'jpg' : extRaw;
    const tmpFile = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(data, 'base64'));
    return tmpFile;
  }
  // Plain base64
  const tmpFile = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageInput, 'base64'));
  return tmpFile;
}

// Replicate the temp file tracking and cleanup logic
const tempFiles = new Set<string>();

function resolveImageToPathWithTracking(imageInput: string): string {
  const filePath = resolveImageToPath(imageInput);
  if (filePath.startsWith(os.tmpdir())) {
    tempFiles.add(filePath);
  }
  return filePath;
}

function cleanupTemp(filePath: string) {
  if (tempFiles.has(filePath)) {
    fs.unlinkSync(filePath);
    tempFiles.delete(filePath);
  }
}

describe('resolveImageToPath', () => {
  afterEach(() => {
    // Clean up any leftover temp files
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    tempFiles.clear();
  });

  describe('passthrough for URLs and absolute paths', () => {
    it('returns https URL as-is', () => {
      const url = 'https://example.com/image.png';
      expect(resolveImageToPath(url)).toBe(url);
    });

    it('returns http URL as-is', () => {
      const url = 'http://example.com/image.png';
      expect(resolveImageToPath(url)).toBe(url);
    });

    it('returns absolute path as-is', () => {
      const absPath = '/var/folders/tmp/image.jpg';
      expect(resolveImageToPath(absPath)).toBe(absPath);
    });
  });

  describe('base64 data URL parsing', () => {
    it('parses data:image/png;base64', () => {
      const pngBase64 = Buffer.from('PNG').toString('base64');
      const dataUrl = `data:image/png;base64,${pngBase64}`;
      const result = resolveImageToPath(dataUrl);

      expect(result).toMatch(/^\/var\/folders\/.*\.png$/);
      expect(fs.existsSync(result)).toBe(true);
      expect(fs.readFileSync(result)).toEqual(Buffer.from('PNG'));

      fs.unlinkSync(result);
    });

    it('parses data:image/jpeg;base64 as .jpg', () => {
      const jpegBase64 = Buffer.from('JPEG').toString('base64');
      const dataUrl = `data:image/jpeg;base64,${jpegBase64}`;
      const result = resolveImageToPath(dataUrl);

      expect(result).toMatch(/\.jpg$/);
      expect(fs.readFileSync(result)).toEqual(Buffer.from('JPEG'));
      fs.unlinkSync(result);
    });

    it('throws on malformed data URL', () => {
      expect(() => resolveImageToPath('data:not-valid')).toThrow('Invalid base64 data URL');
      expect(() => resolveImageToPath('data:image/png;not-base64')).toThrow('Invalid base64 data URL');
    });
  });

  describe('plain base64 (no prefix)', () => {
    it('treats plain base64 as PNG', () => {
      const plain = Buffer.from('PLAIN').toString('base64');
      const result = resolveImageToPath(plain);

      expect(result).toMatch(/\.png$/);
      expect(fs.readFileSync(result)).toEqual(Buffer.from('PLAIN'));
      fs.unlinkSync(result);
    });
  });

  describe('temp file cleanup', () => {
    it('tracks temp files created from data URLs', () => {
      const pngBase64 = Buffer.from('TRACK').toString('base64');
      const dataUrl = `data:image/png;base64,${pngBase64}`;
      const result = resolveImageToPathWithTracking(dataUrl);

      expect(tempFiles.has(result)).toBe(true);
      expect(fs.existsSync(result)).toBe(true);

      cleanupTemp(result);
      expect(fs.existsSync(result)).toBe(false);
    });

    it('does not track non-temp paths', () => {
      resolveImageToPathWithTracking('https://example.com/image.png');
      expect(tempFiles.size).toBe(0);

      resolveImageToPathWithTracking('/tmp/existing.png');
      expect(tempFiles.size).toBe(0);
    });

    it('cleanup only removes tracked files', () => {
      const pngBase64 = Buffer.from('CLEAN').toString('base64');
      const dataUrl = `data:image/png;base64,${pngBase64}`;
      const result = resolveImageToPathWithTracking(dataUrl);

      // Trying to cleanup a non-tracked file should be no-op
      expect(() => cleanupTemp('/tmp/nonexistent.png')).not.toThrow();
      expect(fs.existsSync(result)).toBe(true); // still exists, just not tracked

      cleanupTemp(result);
      expect(fs.existsSync(result)).toBe(false);
    });
  });
});