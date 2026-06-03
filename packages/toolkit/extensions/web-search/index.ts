/**
 * pi-mind Web Search Extension
 *
 * Provides web search via mmx search CLI.
 */

import * as fs from "fs";
import * as path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MMX = "mmx";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

/** Reads MINIMAX_API_KEY: env var preferred, fallback to disk */
function getMinimaxKey(): string | undefined {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  if (process.env.MINIMAX_CN_API_KEY) return process.env.MINIMAX_CN_API_KEY;
  const mmxConfig = path.join(process.env.HOME || "", ".mmx", "config.json");
  if (fs.existsSync(mmxConfig)) {
    try { return JSON.parse(fs.readFileSync(mmxConfig, "utf-8")).api_key; } catch {}
  }
  return undefined;
}

function execMmx(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = getMinimaxKey();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (key) env.MINIMAX_API_KEY = key;
    // detached: true + manual timeout (instead of spawn's built-in `timeout`
    // option) so we can kill the whole process group on timeout. Node's
    // built-in timeout sends SIGTERM to the child pid only; if mmx forks
    // grandchildren they leak and keep pipe FDs open, hanging 'close'.
    const proc = spawn(MMX, args, { env, detached: true });
    let stdout = "";
    let stderr = "";

    const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      if (proc.pid === undefined) return;
      try { process.kill(-proc.pid, signal); } catch { /* gone */ }
    };
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 500);
    }, timeoutMs);

    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `mmx exited with code ${code}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(e);
    });
  });
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  max_results: Type.Optional(Type.Number({ description: "Maximum number of results (default: 5)" })),
});

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web. Returns titles, URLs, and snippets.",
    parameters: SearchParams,
    async execute(_toolCallId: string, params: Static<typeof SearchParams>) {
      try {
        const args = [
          "search", "query",
          "--q", params.query,
          "--output", "json",
        ];
        const output = await execMmx(args);
        let text = output.trim();
        try {
          const json = JSON.parse(text);
          // mmx returns {organic: [...]} — also handle plain arrays and results wrappers
          const results: Array<{ title?: string; url?: string; snippet?: string; link?: string; description?: string }> =
            Array.isArray(json) ? json : (json.organic || json.results || json.data || []);
          if (results.length > 0) {
            text = results
              .slice(0, params.max_results ?? 5)
              .map((r, i) =>
                `${i + 1}. ${r.title || ""}\n   ${r.url || r.link || ""}\n   ${r.snippet || r.description || ""}`
              )
              .join("\n\n");
          } else {
            text = typeof json === "string" ? json : JSON.stringify(json, null, 2);
          }
        } catch {
          // output is plain text
        }
        return ok(text);
      } catch (e) {
        return err(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}