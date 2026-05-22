/**
 * pi-mind Image Understanding Extension
 *
 * Provides image understanding via mmx vision CLI.
 * Also intercepts base64 images in prompts and saves them to temp files,
 * so the agent can reference them when MiniMax doesn't receive images directly.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Type, type Static } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MMX = "mmx";

/** Tracks temp image files created by this extension (path -> true) */
const tempFiles = new Map<string, boolean>();

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

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

function execMmx(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = getMinimaxKey();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (key) env.MINIMAX_API_KEY = key;
    // detached + manual timeout so timeout kills the whole process group
    // (mmx + any grandchildren). Node's built-in `timeout` option only signals
    // the top-level pid, which leaves grandchildren orphaned holding pipe FDs.
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

function resolveImageToPath(imageInput: string): string {
  // URL or absolute path — use as-is
  if (imageInput.startsWith("http://") || imageInput.startsWith("https://") || imageInput.startsWith("/")) {
    return imageInput;
  }
  // Base64 data URL: data:image/png;base64,xxxx
  if (imageInput.startsWith("data:")) {
    const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error(`Invalid base64 data URL`);
    const mimeType = match[1];
    const data = match[2];
    const ext = mimeType.split("/")[1] || "png";
    const tmpFile = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(data, "base64"));
    tempFiles.set(tmpFile, true);
    return tmpFile;
  }
  // Plain base64 (no prefix) — treat as PNG
  const tmpFile = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageInput, "base64"));
  tempFiles.set(tmpFile, true);
  return tmpFile;
}

const UnderstandImageParams = Type.Object({
  image: Type.String({ description: "Image file path, URL, or base64 data URL (data:image/png;base64,...)" }),
  prompt: Type.Optional(Type.String({ description: "Question about the image (default: 'Describe the image.')" })),
});

export default function imageUnderstandingExtension(pi: ExtensionAPI) {
  // Intercept base64 images before LLM call — save to temp files
  // so the agent can use understand_image with file paths
  pi.on("before_agent_start", async (event) => {
    if (!event.images || event.images.length === 0) return;

    const imageDescs: string[] = [];
    for (const img of event.images) {
      if (img.type === "image" && img.data) {
        try {
          const filePath = resolveImageToPath(img.data);
          imageDescs.push(`[图片已保存: ${filePath}]`);
        } catch {
          // ignore resolve errors
        }
      }
    }

    if (imageDescs.length > 0) {
      const note = `\n\n${imageDescs.join("\n")}`;
      return {
        message: {
          customType: "image_attachments",
          content: `你收到了 ${imageDescs.length} 张图片，已保存为临时文件。你可以使用 understand_image 工具分析这些图片。${note}`,
          display: false,
        },
      };
    }
  });

  pi.registerTool({
    name: "understand_image",
    label: "Understand Image",
    description: "Understand and analyze images. Supports local file paths, URLs, and base64 data URLs.",
    parameters: UnderstandImageParams,
    async execute(_toolCallId: string, params: Static<typeof UnderstandImageParams>) {
      let tmpFile: string | undefined;
      try {
        const imagePath = resolveImageToPath(params.image);
        tmpFile = imagePath.startsWith(os.tmpdir()) ? imagePath : undefined;

        const args = [
          "vision", "describe",
          "--image", imagePath,
          "--output", "json",
        ];
        if (params.prompt) {
          args.push("--prompt", params.prompt);
        }
        const output = await execMmx(args);
        let text = output.trim();
        try {
          const json = JSON.parse(text);
          text = typeof json === "string" ? json : JSON.stringify(json, null, 2);
        } catch {
          // output is plain text
        }
        return ok(text);
      } catch (e) {
        return err(`understand_image failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (tmpFile && fs.existsSync(tmpFile) && tempFiles.has(tmpFile)) {
          fs.unlinkSync(tmpFile);
          tempFiles.delete(tmpFile);
        }
      }
    },
  });
}
