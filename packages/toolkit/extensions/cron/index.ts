/**
 * pi-toolkit Cron Extension — OS-scheduled task delivery via bus inbox.
 *
 * Three tools:
 *   - schedule_cron:  register a cron task via launchd plist (inline-gate:
 *                      first call prompts for confirmation, second with
 *                      confirmed=true creates the plist).
 *   - list_cron:      list all registered cron jobs.
 *   - remove_cron:    remove a cron job (unload plist + delete file + drop
 *                      from registry).
 *
 * Storage: `.pi-mind/cron/jobs.json` — flat JSON array of job records.
 *
 * Scheduling: each job gets a macOS launchd plist under
 * `~/Library/LaunchAgents/`. The plist executes `node <bindir>/cron-trigger.mjs`
 * which imports from `@shog-lab/pi-bus/lib/deliver` and writes a message
 * into the target agent's bus inbox. If the target agent isn't online, the
 * session directory doesn't exist and the write fails silently.
 *
 * Cron expression parsing is intentionally minimal — handles common patterns
 * (specific time, weekday, day-of-month). Complex expressions that launchd
 * can't represent are rejected with a helpful error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiMindDir } from "@shog-lab/pi-utils";

// --- Paths ---

function cronJobsPath(): string {
  return join(resolvePiMindDir(), "cron", "jobs.json");
}

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function triggerScriptPath(): string {
  // Resolve the cron-trigger.mjs script relative to this extension's dist
  // location during development (inside the monorepo). In production the
  // script ships alongside the extension in the npm package, resolvable by
  // walking up from the extension's dist dir.
  //
  // Monorepo dev layout:
  //   packages/toolkit/dist/extensions/cron/index.js  <-- this file after build
  //   packages/toolkit/bin/cron-trigger.mjs
  //
  // We resolve from __dirname (the built extension dir) up to the package
  // root, then into bin/.  At runtime in the monorepo the extension is
  // symlinked from .pi/extensions/, but tsc outputs the real path, so
  // __dirname points into the monorepo's dist/ tree — the walk-up works.
  let dir = __dirname;
  // Walk up: extensions/cron -> extensions -> dist -> toolkit-root
  for (let i = 0; i < 3; i++) dir = join(dir, "..");
  // Default to monorepo layout; in npm installs the layout may differ.
  const candidate = join(dir, "bin", "cron-trigger.mjs");
  if (existsSync(candidate)) return candidate;
  // Fallback: assume the script is installed as a bin alongside pi-toolkit
  return join(join(__dirname, "..", "..", "..", ".."), "cron-trigger.mjs");
}

// --- Schemas ---

interface CronJob {
  id: string;
  created: string;
  cron_expr: string;
  message: string;
  description?: string;
  target: string;
  plist_path: string;
  enabled: boolean;
}

const ScheduleCronParams = Type.Object({
  cron_expr: Type.String({ description: "Standard cron expression, e.g. '0 9 * * *' for 9am daily. Simple patterns only — specific times, weekdays, day-of-month. */N (every N) not supported by macOS launchd; use multiple jobs instead." }),
  message: Type.String({ description: "Message text delivered to the target agent when the cron fires." }),
  description: Type.Optional(Type.String({ description: "Optional human-readable label for list_cron output." })),
  confirm: Type.Optional(Type.Boolean({ description: "Set to true after you've shown the confirmation prompt to the user and they approved." })),
});

const ListCronParams = Type.Object({});

const RemoveCronParams = Type.Object({
  id: Type.String({ description: "Job ID to remove (from list_cron output)." }),
});

// --- Jobs I/O ---

function readJobs(): CronJob[] {
  const p = cronJobsPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}

function writeJobs(jobs: CronJob[]): void {
  const p = cronJobsPath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic via tmp + rename.
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  renameSync(tmp, p);
}

function generateJobId(): string {
  return `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// --- Plist helpers ---

interface PlistCalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Weekday?: number;
  Month?: number;
}

/**
 * Parse a minimal subset of cron expressions into a launchd
 * StartCalendarInterval dict.  Rejects patterns that launchd can't
 * natively express (like step values or complex ranges).
 */
function parseCronExpr(expr: string): PlistCalendarInterval {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }

  const [minStr, hourStr, dayStr, monthStr, wdayStr] = fields;
  const interval: PlistCalendarInterval = {};

  function parseField(raw: string, label: string): number | "*" {
    if (raw === "*") return "*";
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
    throw new Error(`unsupported cron field "${label}": "${raw}". macOS launchd only supports specific numbers or *. No ranges, steps, or lists.`);
  }

  const minute = parseField(minStr, "minute");
  const hour = parseField(hourStr, "hour");
  const day = parseField(dayStr, "day-of-month");
  const month = parseField(monthStr, "month");
  const wday = parseField(wdayStr, "day-of-week");

  if (minute !== "*") interval.Minute = minute;
  else interval.Minute = 0; // launchd requires an explicit value if no interval

  if (hour !== "*") interval.Hour = hour;
  if (day !== "*") interval.Day = day;
  if (month !== "*") interval.Month = month;
  if (wday !== "*") interval.Weekday = wday;

  return interval;
}

function humanizeExpr(expr: string): string {
  const [min, hour, day, month, wday] = expr.split(/\s+/);

  const pad = (s: string) => s.padStart(2, "0");
  if (day === "*" && month === "*" && wday === "*") {
    if (min === "0" && hour === "*") return "every hour";
    return `every day at ${pad(hour)}:${pad(min)}`;
  }
  if (day === "*" && month === "*" && wday !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const d = days[Number(wday)] || wday;
    return `every ${d} at ${pad(hour)}:${pad(min)}`;
  }
  return expr;
}

function makePlist(label: string, nodeBin: string, scriptPath: string, repoRoot: string, target: string, message: string, interval: PlistCalendarInterval): string {
  const intervalEntries = Object.entries(interval)
    .map(([k, v]) => `    <key>${k}</key>\n    <integer>${v}</integer>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${scriptPath}</string>
    <string>--target</string>
    <string>${target}</string>
    <string>--message</string>
    <string>${escapeXml(message)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>StartCalendarInterval</key>
  <dict>
${intervalEntries}
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(repoRoot, ".pi-mind", "cron", "cron.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(repoRoot, ".pi-mind", "cron", "cron.log")}</string>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- Helpers ---

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

function findNodeBin(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

// --- Extension entry ---

export default function cronExtension(pi: ExtensionAPI) {
  const repoRoot = process.cwd();
  const target = process.env.PI_AGENT_NAME?.trim() || "pi";
  const nodeBin = findNodeBin();
  const scriptPath = triggerScriptPath();

  pi.registerTool({
    name: "schedule_cron",
    label: "Schedule Cron Task",
    description:
      "Register a timed task that delivers a message via bus inbox. " +
      "First call returns a confirmation prompt — the user must approve " +
      "before the plist is created. Call again with confirm=true after approval.",
    parameters: ScheduleCronParams,
    async execute(_id: string, params: Static<typeof ScheduleCronParams>) {
      const { cron_expr, message, description, confirm } = params;

      // --- Inline gate: first call prompts, second creates ---
      if (!confirm) {
        let interval: PlistCalendarInterval;
        try {
          interval = parseCronExpr(cron_expr);
        } catch (e) {
          return err(`Invalid cron expression: ${e instanceof Error ? e.message : String(e)}`);
        }

        return ok(
          `## Confirm scheduled task\n\n` +
          `- **When**: ${humanizeExpr(cron_expr)} (expression: \`${cron_expr}\`)\n` +
          `- **Message**: ${message}\n` +
          `- **Target**: ${target}\n` +
          `- **Description**: ${description || "(none)"}\n\n` +
          `This will create a macOS launchd plist at ` +
          `\`~/Library/LaunchAgents/com.pi-mind.cron.<id>.plist\` and activate ` +
          `it immediately.\n\n` +
          `Call \`schedule_cron\` again with the same parameters plus ` +
          `\`confirm: true\` to proceed, or change the parameters and re-confirm.`
        );
      }

      // --- Confirmed: create plist ---
      let interval: PlistCalendarInterval;
      try {
        interval = parseCronExpr(cron_expr);
      } catch (e) {
        return err(`Invalid cron expression: ${e instanceof Error ? e.message : String(e)}`);
      }

      const jobId = generateJobId();
      const label = `com.pi-mind.cron.${jobId}`;
      const plistPath = join(launchAgentsDir(), `${label}.plist`);

      mkdirSync(launchAgentsDir(), { recursive: true });

      try {
        writeFileSync(plistPath, makePlist(label, nodeBin, scriptPath, repoRoot, target, message, interval));
        execSync(`launchctl load "${plistPath}"`, { encoding: "utf-8" });
      } catch (e) {
        // If we wrote the plist but load failed, clean up.
        try { unlinkSync(plistPath); } catch { /* */ }
        return err(`Failed to create or load launchd plist: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Persist to registry.
      const job: CronJob = {
        id: jobId,
        created: new Date().toISOString(),
        cron_expr,
        message,
        description,
        target,
        plist_path: plistPath,
        enabled: true,
      };

      const jobs = readJobs();
      jobs.push(job);
      writeJobs(jobs);

      return ok(
        `## Cron job created ✅\n\n` +
        `- **ID**: ${jobId}\n` +
        `- **When**: ${humanizeExpr(cron_expr)}\n` +
        `- **Target**: ${target}\n` +
        `- **Plist**: \`${plistPath}\`\n\n` +
        `Use \`list_cron\` to see all jobs, \`remove_cron ${jobId}\` to remove.`
      );
    },
  });

  pi.registerTool({
    name: "list_cron",
    label: "List Cron Jobs",
    description: "List all registered cron jobs.",
    parameters: ListCronParams,
    async execute(_id: string, _params: Static<typeof ListCronParams>) {
      const jobs = readJobs();
      if (jobs.length === 0) {
        return ok("No cron jobs registered.");
      }
      const lines = jobs.map((j) => {
        const status = j.enabled ? "✅" : "⏸️";
        return [
          `### ${status} ${j.id}`,
          `  Cron: \`${j.cron_expr}\` → **${humanizeExpr(j.cron_expr)}**`,
          `  Message: ${j.message}`,
          j.description ? `  Description: ${j.description}` : "",
          `  Target: ${j.target}`,
          `  Plist: \`${j.plist_path}\``,
          `  Created: ${j.created}`,
        ].filter(Boolean).join("\n");
      });
      return ok(lines.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "remove_cron",
    label: "Remove Cron Job",
    description: "Remove a cron job by ID. Unloads the launchd plist, deletes the file, and drops the registry entry.",
    parameters: RemoveCronParams,
    async execute(_id: string, params: Static<typeof RemoveCronParams>) {
      const jobs = readJobs();
      const idx = jobs.findIndex((j) => j.id === params.id);
      if (idx === -1) {
        return err(`No cron job found with id "${params.id}". Use list_cron to see available jobs.`);
      }

      const job = jobs[idx];

      // Unload + delete plist.
      try { execSync(`launchctl unload "${job.plist_path}"`, { encoding: "utf-8" }); } catch { /* may already be unloaded */ }
      try { unlinkSync(job.plist_path); } catch { /* may already be deleted */ }

      // Remove from registry.
      jobs.splice(idx, 1);
      writeJobs(jobs);

      return ok(`Removed cron job ${job.id} ("${job.message}"). Plist deleted, launchd unloaded.`);
    },
  });
}
