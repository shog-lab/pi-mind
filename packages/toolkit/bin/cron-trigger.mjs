#!/usr/bin/env node
/**
 * cron-trigger — OS scheduler stub that drops a message into a pi-agent inbox.
 *
 * Launched by launchd plists created by the `schedule_cron` tool. Uses the
 * bus deliver API (findByName / writeInboxMessage) to target the agent whose
 * name matches --target.
 *
 * If the target agent is not online, the write fails silently (the session
 * directory doesn't exist) and the script exits 0 — no backlog, no retry.
 *
 * Usage:
 *   node cron-trigger.mjs --target <agent-name> --message "<text>"
 */

import { findByName, writeInboxMessage, generateMsgId } from "@shog-lab/pi-bus/lib/deliver";

function parseArgs() {
  const argv = process.argv.slice(2);
  const target = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : null;
  const message = argv.includes("--message") ? argv[argv.indexOf("--message") + 1] : null;
  if (!target || !message) {
    process.stderr.write("Usage: cron-trigger.mjs --target <agent-name> --message <text>\n");
    process.exit(2);
  }
  return { target, message };
}

const { target, message } = parseArgs();

const found = findByName(target);
if ("error" in found) {
  // Agent not online — silently drop.
  process.exit(0);
}

// Escape special chars in message for JSON string embedding
// (the message lands in a JSON file read by the bus extension).
try {
  writeInboxMessage(found.id, {
    id: generateMsgId(),
    from: "cron",
    body: message,
    sentAt: new Date().toISOString(),
  });
} catch {
  // inbox write failed (session dir gone mid-race, etc.) — drop.
}

process.exit(0);
