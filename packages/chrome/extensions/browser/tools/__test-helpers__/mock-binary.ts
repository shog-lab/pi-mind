/**
 * Mock `agent-browser` binary for tool tests.
 *
 * Writes a small Node script to a temp dir; tests set AGENT_BROWSER_BIN to its
 * path and drive behavior through env vars:
 *
 *   MOCK_OPEN_EXIT          exit code for `open` (default 0)
 *   MOCK_SNAPSHOT_EXIT      exit code for `snapshot` (default 0)
 *   MOCK_SNAPSHOT_TEXT      stdout for plain `snapshot`
 *   MOCK_SNAPSHOT_JSON      stdout for `snapshot --json` (single-page mode)
 *   MOCK_SNAPSHOT_SEQ       directory containing 0.json, 1.json, ... — when set
 *                           and `snapshot --json` is called, the mock returns the
 *                           contents of <idx>.json and increments a counter file.
 *                           After running out of files, returns the last one.
 *   MOCK_FILL_EXIT          exit code for `fill` (default 0)
 *   MOCK_CLICK_EXIT         exit code for `click` (default 0)
 *   MOCK_TYPE_EXIT          exit code for `type` (default 0)
 *   MOCK_WAIT_EXIT          exit code for `wait` (default 0)
 *
 * The script also appends each invocation's argv (one line per call) to the
 * file at MOCK_LOG so tests can assert call ordering.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.MOCK_LOG) {
  try { fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + "\\n"); } catch {}
}
const cmd = args[0];
const exitFor = (k, fallback) => parseInt(process.env[k] || fallback, 10);
if (cmd === "open") {
  process.stdout.write("opened " + (args[1] || "") + "\\n");
  process.exit(exitFor("MOCK_OPEN_EXIT", "0"));
}
if (cmd === "snapshot") {
  const isJson = args.includes("--json");
  const seq = process.env.MOCK_SNAPSHOT_SEQ;
  if (isJson && seq) {
    const idxFile = path.join(seq, ".idx");
    let idx = 0;
    try { idx = parseInt(fs.readFileSync(idxFile, "utf8"), 10) || 0; } catch {}
    let body = "";
    let usedIdx = idx;
    while (usedIdx >= 0) {
      try {
        body = fs.readFileSync(path.join(seq, usedIdx + ".json"), "utf8");
        break;
      } catch { usedIdx--; }
    }
    fs.writeFileSync(idxFile, String(idx + 1));
    process.stdout.write(body);
  } else if (isJson) {
    if (process.env.MOCK_SNAPSHOT_JSON) process.stdout.write(process.env.MOCK_SNAPSHOT_JSON);
  } else {
    if (process.env.MOCK_SNAPSHOT_TEXT) process.stdout.write(process.env.MOCK_SNAPSHOT_TEXT);
  }
  process.exit(exitFor("MOCK_SNAPSHOT_EXIT", "0"));
}
if (cmd === "fill") {
  process.stdout.write("filled " + args[1] + "\\n");
  process.exit(exitFor("MOCK_FILL_EXIT", "0"));
}
if (cmd === "click") {
  process.stdout.write("clicked " + args[1] + "\\n");
  process.exit(exitFor("MOCK_CLICK_EXIT", "0"));
}
if (cmd === "type") {
  process.stdout.write("typed " + args[1] + "\\n");
  process.exit(exitFor("MOCK_TYPE_EXIT", "0"));
}
if (cmd === "wait") {
  process.stdout.write("waited " + args[1] + "\\n");
  process.exit(exitFor("MOCK_WAIT_EXIT", "0"));
}
if (cmd === "get") {
  const what = args[1];
  if (what === "url") {
    process.stdout.write((process.env.MOCK_GET_URL || "https://example.com/") + "\\n");
    process.exit(exitFor("MOCK_GET_EXIT", "0"));
  }
  if (what === "title") {
    process.stdout.write((process.env.MOCK_GET_TITLE || "Example") + "\\n");
    process.exit(exitFor("MOCK_GET_EXIT", "0"));
  }
  if (what === "cdp-url") {
    const u = process.env.MOCK_GET_CDP_URL || "ws://127.0.0.1:0/devtools/browser/mock";
    process.stdout.write(JSON.stringify({ success: true, data: { cdpUrl: u }, error: null }));
    process.exit(0);
  }
  process.stderr.write("mock: unknown get target " + what + "\\n");
  process.exit(98);
}
process.stderr.write("mock: unknown command " + cmd + "\\n");
process.exit(99);
`;

export interface MockBinary {
  path: string;
  cleanup(): void;
}

export function makeMockBinary(): MockBinary {
  const tmp = mkdtempSync(join(tmpdir(), "pi-chrome-mock-"));
  const path = join(tmp, "agent-browser-mock.cjs");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return {
    path,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

const MOCK_ENV_KEYS = [
  "AGENT_BROWSER_BIN",
  "MOCK_OPEN_EXIT",
  "MOCK_SNAPSHOT_EXIT",
  "MOCK_SNAPSHOT_TEXT",
  "MOCK_SNAPSHOT_JSON",
  "MOCK_SNAPSHOT_SEQ",
  "MOCK_FILL_EXIT",
  "MOCK_CLICK_EXIT",
  "MOCK_TYPE_EXIT",
  "MOCK_WAIT_EXIT",
  "MOCK_GET_EXIT",
  "MOCK_GET_URL",
  "MOCK_GET_TITLE",
  "MOCK_GET_CDP_URL",
  "MOCK_LOG",
];

export function clearMockEnv(): void {
  for (const k of MOCK_ENV_KEYS) delete process.env[k];
}
