/**
 * Jimeng (即梦) Image Generation Extension for pi-coding-agent
 *
 * Registers a `jimeng_generate` tool that generates images via
 * Volcengine's Jimeng T2I API (text-to-image).
 *
 * Requires JIMENG_ACCESS_KEY and JIMENG_SECRET_KEY environment variables.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Signer } from "@volcengine/openapi";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API_HOST = "visual.volcengineapi.com";
const API_VERSION = "2022-08-31";
const MODEL_KEY = "jimeng_t2i_v40";
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 2000;

interface JimengTaskResponse {
  code: number;
  message?: string;
  data?: {
    task_id?: string;
    status?: string;
    image_urls?: string[];
  };
}

function signRequest(
  accessKey: string,
  secretKey: string,
  action: string,
  body: string,
): Record<string, string> {
  const requestData = {
    method: "POST",
    region: "cn-north-1",
    params: { Action: action, Version: API_VERSION },
    headers: {
      "Content-Type": "application/json",
      Host: API_HOST,
    } as Record<string, string>,
    body,
  };
  const signer = new Signer(requestData, "cv");
  signer.addAuthorization({ accessKeyId: accessKey, secretKey });
  return requestData.headers;
}

async function apiCall(
  accessKey: string,
  secretKey: string,
  action: string,
  body: string,
): Promise<JimengTaskResponse> {
  const headers = signRequest(accessKey, secretKey, action, body);
  const url = `https://${API_HOST}/?Action=${action}&Version=${API_VERSION}`;
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`Jimeng API error: ${res.status}`);
  return (await res.json()) as JimengTaskResponse;
}

export default function jimengExtension(pi: ExtensionAPI) {
  const accessKey = process.env.JIMENG_ACCESS_KEY;
  const secretKey = process.env.JIMENG_SECRET_KEY;

  if (!accessKey || !secretKey) {
    // Silently skip if not configured
    return;
  }

  pi.registerTool({
    name: "jimeng_generate",
    label: "Jimeng Image",
    description:
      "Generate an image from a text prompt using Jimeng (即梦) AI. Returns the file path of the generated image.",
    promptSnippet:
      "Generate AI images from text descriptions (Chinese prompts work best)",
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description (Chinese recommended for best results)" }),
      width: Type.Optional(Type.Number({ description: "Image width in pixels (default: 1024)" })),
      height: Type.Optional(Type.Number({ description: "Image height in pixels (default: 1024)" })),
      filename: Type.Optional(Type.String({ description: "Output filename (default: jimeng-{timestamp}.png)" })),
    }),

    async execute(_toolCallId: string, params: any, signal: any, onUpdate: any) {
      const width = params.width || 1024;
      const height = params.height || 1024;
      const filename = params.filename || `jimeng-${Date.now()}.png`;
      const outputPath = join(process.env.PI_MIND_DIR || (process.cwd() + "/.pi-mind"), filename);

      // Step 1: Submit task
      onUpdate?.({ content: [{ type: "text", text: "提交生成任务..." }] });

      const submitBody = JSON.stringify({
        req_key: MODEL_KEY,
        prompt: params.prompt,
        width,
        height,
        scale: 0.5,
        force_single: true,
      });

      const submitResult = await apiCall(accessKey, secretKey, "CVSync2AsyncSubmitTask", submitBody);
      if (submitResult.code !== 10000) {
        return { content: [{ type: "text", text: `生成失败: ${submitResult.message || "Unknown error"}` }] };
      }

      const taskId = submitResult.data?.task_id;
      if (!taskId) {
        return { content: [{ type: "text", text: "生成失败: 未返回 task_id" }] };
      }

      // Step 2: Poll for result
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "已取消" }] };
        }

        const queryBody = JSON.stringify({
          req_key: MODEL_KEY,
          task_id: taskId,
          req_json: JSON.stringify({ return_url: true, logo_info: { add_logo: false } }),
        });

        const result = await apiCall(accessKey, secretKey, "CVSync2AsyncGetResult", queryBody);

        if (result.code === 10000) {
          const status = result.data?.status;

          if (status === "done") {
            const urls = result.data?.image_urls;
            if (!urls?.length) {
              return { content: [{ type: "text", text: "生成完成但未返回图片 URL" }] };
            }

            // Step 3: Download image
            onUpdate?.({ content: [{ type: "text", text: "下载图片..." }] });

            const imgRes = await fetch(urls[0]);
            if (!imgRes.ok) {
              return { content: [{ type: "text", text: `图片下载失败: ${imgRes.status}` }] };
            }

            const buffer = Buffer.from(await imgRes.arrayBuffer());
            mkdirSync(dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, buffer);

            return {
              content: [{ type: "text", text: `图片已生成并保存到 ${outputPath} (${width}x${height}, ${buffer.length} bytes)。\n图片URL: ${urls[0]}\n请使用 send_image 工具将图片发送给用户。` }],
            };
          }

          if (status === "not_found" || status === "expired") {
            return { content: [{ type: "text", text: `生成失败: 任务 ${status}` }] };
          }

          // Still generating
          if (attempt % 5 === 0) {
            onUpdate?.({ content: [{ type: "text", text: `生成中... (${attempt * 2}s)` }] });
          }
        } else {
          return { content: [{ type: "text", text: `查询失败: ${result.message || "Unknown error"}` }] };
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      return { content: [{ type: "text", text: "生成超时（120s）" }] };
    },
  });
}
