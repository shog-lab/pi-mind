/**
 * pi-mind Sub-Agent Extension
 *
 * Provides spawn_subagent tool for an agent to spawn a focused sub-agent in a
 * target directory. Sub-agents have minimal context: no memory access, no parent
 * skills, no system prompt — just the task and web_search.
 *
 * Use cases:
 *   - Classify a compaction summary without bias from existing memory
 *   - Run tests / read code in an isolated context
 *   - Generate a SKILL.md from raw observations
 *
 * Uses shared spawnPi helper — see lib/spawn-pi.ts for stdio invariants.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnPi } from "../../lib/spawn-pi.js";

const SubAgentParams = Type.Object({
  cwd: Type.String({ description: "Absolute path to the working directory for the sub-agent (typically a repo or a subdirectory)." }),
  prompt: Type.String({ description: "Task instruction for the sub-agent. Be specific about what to do and what to return." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300, max: 600)" })),
});

/** Resolve the pi-mind package extensions directory regardless of symlink chain. */
function getExtensionsDir(): string {
  const here = realpathSync(fileURLToPath(import.meta.url));
  // index.ts is at <pkg-root>/extensions/subagent/index.ts → up two levels = extensions/
  return join(dirname(here), "..");
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

function resolveExtensionPath(name: string): string | null {
  const p = join(getExtensionsDir(), name);
  for (const entry of ["dist/index.js", "index.ts", "index.js"]) {
    if (existsSync(join(p, entry))) return join(p, entry);
  }
  return null;
}

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Sub-Agent",
    description:
      "Spawn a focused sub-agent in a target directory to execute a specific task. " +
      "The sub-agent has minimal context: no memory access, no parent skills, no system prompt. " +
      "Use this for isolated tasks like running tests, reading code, classifying content.",
    parameters: SubAgentParams,
    async execute(_toolCallId: string, params: Static<typeof SubAgentParams>) {
      const normalized = resolve(normalize(params.cwd));
      if (!existsSync(normalized)) {
        return err(`Working directory does not exist: ${params.cwd}`);
      }

      const timeoutSec = Math.min(params.timeout ?? 300, 600);
      const timeoutMs = timeoutSec * 1000;

      const args = [
        "-p",
        "--no-extensions",
      ];
      if (process.env.MODEL) {
        args.push("--model", process.env.MODEL);
      }

      // Load basic work tools — explicitly excludes memory (sub-agents must not touch parent memory).
      // Browser automation belongs in pi-chrome, not pi-mind, so it isn't loaded here;
      // a sub-agent that needs the browser should be spawned from a pi-chrome-aware caller.
      const basicExts = ["web_search"];
      for (const ext of basicExts) {
        const extPath = resolveExtensionPath(ext);
        if (extPath) args.push("-e", extPath);
      }

      const systemPrompt = [
        "You are a sub-agent executing a focused task.",
        "Rules:",
        "- Read code, run tests, verify behavior — report findings as plain text",
        "- Do not write code unless the task explicitly requires it",
        "- Do not access memory, parent skills, or persistent state",
        "- Do not modify files unless the task explicitly requires it",
        "- Return findings, results, or errors as plain text",
        "",
        `Task: ${params.prompt}`,
      ].join("\n");
      args.push("--append-system-prompt", systemPrompt);
      args.push(params.prompt);

      let stdout = "";
      let stderr = "";

      const result = await spawnPi({
        cwd: normalized,
        args,
        onStdout: (d) => { stdout += d; },
        onStderr: (d) => { stderr += d; },
        timeoutMs,
      });

      if (result.killed) {
        return err(`Sub-agent timed out after ${timeoutSec}s`);
      } else if (result.code === 0) {
        const text = stdout
          .replace(/^\*\*Output:\*\*\n?/s, "")
          .replace(/^.*?---\n/s, "")
          .replace(/^\*\*\(.+\)\*\*\n?/s, "")
          .trim() || "Done.";
        return ok(text);
      } else {
        return err(stderr || stdout || `Sub-agent exited with code ${result.code}`);
      }
    },
  });
}
