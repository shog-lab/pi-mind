#!/usr/bin/env node
/**
 * pi-mind-cron — emit recommended crontab snippets for the current repo.
 *
 * Doesn't write to crontab automatically. The user runs `crontab -e` and pastes.
 *
 * Usage:
 *   npx pi-mind-cron               # print snippets
 *   npx pi-mind-cron --skill foo   # snippet for a specific skill (default: daily-audit)
 */

import { resolve } from "node:path";

const repo = process.cwd();
const args = process.argv.slice(2);

let skill = "daily-audit";
const skillIdx = args.indexOf("--skill");
if (skillIdx >= 0 && args[skillIdx + 1]) skill = args[skillIdx + 1];

const cwd = resolve(repo);
const logPath = `${cwd}/.pi-mind/cron.log`;

const snippets = {
  "daily-audit": [
    `# pi-mind: daily memory audit at 22:00`,
    `0 22 * * * cd ${cwd} && pi -p "use ${skill} skill" >> ${logPath} 2>&1`,
  ],
  "wiki-lint": [
    `# pi-mind: nightly memory lint at 02:00 (auto-fix)`,
    `0 2 * * * cd ${cwd} && npx pi-mind-lint --fix >> ${logPath} 2>&1`,
  ],
};

const lines = snippets[skill] ?? snippets["daily-audit"];

console.log("");
console.log("# Add this to your crontab — run: crontab -e");
console.log("");
console.log(lines.join("\n"));
console.log("");
console.log("# Other available skills:");
for (const name of Object.keys(snippets)) {
  if (name !== skill) console.log(`#   npx pi-mind-cron --skill ${name}`);
}
console.log("");
