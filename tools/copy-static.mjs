#!/usr/bin/env node
/**
 * Copy non-TypeScript static files from source tree into dist/.
 *
 * tsc only emits .js + .d.ts from .ts source. Each pi-mind extension lives in
 * extensions/<name>/ with both index.ts AND package.json. After tsc,
 * dist/extensions/<name>/ has only index.js — the package.json gets left
 * behind. pi loads extensions via the dist tree, so it needs the package.json
 * there too (for `main` / deps metadata).
 *
 * This script handles that: copy any matching file into dist/ at the same
 * relative path.
 *
 * Invoked from each package's build script:
 *   node ../../tools/copy-static.mjs 'extensions/**\/package.json'
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { glob } from "node:fs/promises";

const pattern = process.argv[2];
const distDir = process.argv[3] ?? "dist";

if (!pattern) {
  console.error("Usage: copy-static.mjs <glob-pattern> [dist-dir]");
  process.exit(1);
}

let copied = 0;
for await (const src of glob(pattern)) {
  if (!existsSync(src)) continue;
  const dest = join(distDir, src);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}

console.log(`copied ${copied} file(s) matching '${pattern}' → ${distDir}/`);
