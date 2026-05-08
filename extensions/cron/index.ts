/**
 * pi-mind cron extension — agent-callable crontab CRUD.
 *
 * Registers three tools:
 *   - install_cron: append a new pi-mind-marked entry
 *   - list_cron:    list entries pi-mind has installed (never lists user-written ones)
 *   - remove_cron:  remove a single pi-mind-marked entry by description match
 *
 * All operations preserve user-written crontab content untouched.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildLine,
  isPiMindEntry,
  isValidCronExpression,
  parseEntries,
  readCrontab,
  writeCrontab,
} from "./lib.js";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

const InstallParams = Type.Object({
  cron_expression: Type.String({
    description: "5-field cron expression (e.g. '0 22 * * *' for daily at 22:00).",
  }),
  command: Type.String({
    description:
      "Shell command to run. Should typically include `cd <repo>` and redirect output (e.g. `>> .pi-mind/cron.log 2>&1`).",
  }),
  description: Type.String({
    description:
      "Short identifier for this entry (e.g. 'daily-audit', 'weekly-review'). Used for list/remove. Pick something unique among pi-mind entries.",
  }),
});

const ListParams = Type.Object({});

const RemoveParams = Type.Object({
  match: Type.String({
    description:
      "Substring matched against the description of pi-mind-installed entries. Match must be unique — if multiple entries match, none are removed.",
  }),
});

export default function cronExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "install_cron",
    label: "Install Cron Job",
    description:
      "Append a pi-mind-marked entry to the user's crontab. Always show the user the full line and get explicit confirmation BEFORE calling this tool — crontab edits are sensitive system changes. The entry is tagged with a pi-mind identity marker so list_cron and remove_cron only see pi-mind entries.",
    parameters: InstallParams,
    async execute(_id: string, params: Static<typeof InstallParams>) {
      if (!isValidCronExpression(params.cron_expression)) {
        return fail(
          `Invalid cron expression: '${params.cron_expression}'. Must be 5 fields (minute hour day-of-month month day-of-week).`,
        );
      }
      const newLine = buildLine(params.cron_expression, params.command, params.description);
      const current = readCrontab();
      if (current.includes(newLine)) {
        return ok(`Entry already present (idempotent — no change made):\n${newLine}`);
      }
      const next = current.trim() ? current.trim() + "\n" + newLine + "\n" : newLine + "\n";
      writeCrontab(next);
      const total = parseEntries(next).length;
      return ok(`Installed:\n${newLine}\n\n${total} pi-mind entries currently in crontab.`);
    },
  });

  pi.registerTool({
    name: "list_cron",
    label: "List Pi-Mind Cron Jobs",
    description:
      "List crontab entries installed by pi-mind. User-written crontab entries are never shown — only those carrying the pi-mind identity marker.",
    parameters: ListParams,
    async execute() {
      const entries = parseEntries(readCrontab());
      if (entries.length === 0) {
        return ok("No pi-mind cron entries installed.");
      }
      const lines = entries.map(
        (e, i) => `${i + 1}. [${e.description}]\n   ${e.cron}  ${e.command}`,
      );
      return ok(`${entries.length} pi-mind cron entr${entries.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n\n")}`);
    },
  });

  pi.registerTool({
    name: "remove_cron",
    label: "Remove Cron Job",
    description:
      "Remove a single pi-mind-installed entry whose description contains the given substring. If zero or multiple entries match, no change is made — be specific. Like install_cron, this is a sensitive system change; confirm with the user before calling.",
    parameters: RemoveParams,
    async execute(_id: string, params: Static<typeof RemoveParams>) {
      const current = readCrontab();
      const lines = current.split("\n");
      const piMindLines = lines.filter(isPiMindEntry);
      const matches = piMindLines.filter((l) => l.includes(params.match));

      if (matches.length === 0) {
        return fail(
          `No pi-mind entry matched '${params.match}'. Run list_cron to see installed entries.`,
        );
      }
      if (matches.length > 1) {
        const matchDescriptions = parseEntries(matches.join("\n")).map((e) => e.description);
        return fail(
          `Match '${params.match}' is ambiguous — found ${matches.length} entries: ${matchDescriptions.join(", ")}. Be more specific.`,
        );
      }

      const target = matches[0];
      const next = lines.filter((l) => l !== target).join("\n");
      writeCrontab(next);
      const remaining = parseEntries(next).length;
      return ok(`Removed:\n${target}\n\n${remaining} pi-mind entr${remaining === 1 ? "y" : "ies"} remain.`);
    },
  });
}
