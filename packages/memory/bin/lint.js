#!/usr/bin/env node
/**
 * pi-mind-lint — runs scripts/wiki-lint.ts via tsx.
 * Forwards all CLI args.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const here = realpathSync(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(dirname(here), "..");
const script = join(PKG_ROOT, "scripts", "wiki-lint.ts");

const result = spawnSync("npx", ["-y", "tsx", script, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
