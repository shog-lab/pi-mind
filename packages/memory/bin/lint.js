#!/usr/bin/env node
/**
 * pi-mind-lint — runs the compiled wiki-lint script.
 * Forwards all CLI args.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const here = realpathSync(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(dirname(here), "..");
const script = join(PKG_ROOT, "dist", "scripts", "wiki-lint.js");

const result = spawnSync("node", [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
