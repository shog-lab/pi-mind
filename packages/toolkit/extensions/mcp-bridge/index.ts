/**
 * pi-toolkit MCP Bridge — connect pi to any MCP server.
 *
 * Reads `mcp-servers.json` from the host repo (or `.pi/mcp-servers.json`),
 * spawns each declared server, discovers its tools via the MCP protocol,
 * and re-registers each as a pi tool prefixed with the server name to
 * avoid collisions.
 *
 * Config example:
 *
 *   {
 *     "figma": {
 *       "command": "npx",
 *       "args": ["-y", "figma-developer-mcp", "--stdio"],
 *       "env": { "FIGMA_API_KEY": "..." }
 *     },
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"]
 *     }
 *   }
 *
 * Pi sees tools like `figma_get_file`, `figma_get_node`, etc.
 *
 * No config file → silent no-op. Bridge is opt-in per repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpClient, type McpServerConfig, type McpTool } from "./mcp-client.js";

const CONFIG_FILENAMES = [
  ".pi/mcp-servers.json",
  "mcp-servers.json",
];

interface BridgeConfig {
  [serverName: string]: McpServerConfig;
}

function loadConfig(): BridgeConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const path = join(process.cwd(), filename);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as BridgeConfig;
      }
    } catch (e) {
      console.warn(`[mcp-bridge] failed to parse ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return null;
}

function registerMcpTool(pi: ExtensionAPI, client: McpClient, tool: McpTool): void {
  const piToolName = `${client.serverName}_${tool.name}`;
  pi.registerTool({
    name: piToolName,
    label: `${client.serverName}: ${tool.name}`,
    description: tool.description || `MCP tool ${tool.name} from ${client.serverName}`,
    parameters: tool.inputSchema,
    async execute(_id: string, args: Record<string, unknown>) {
      try {
        const result = await client.callTool(tool.name, args ?? {});
        const text = (result.content ?? [])
          .map((c) => {
            if (c.type === "text") return c.text ?? "";
            if (c.type === "image") return `[image ${c.mimeType ?? ""}]`;
            if (c.type === "resource") return `[resource]`;
            return `[${c.type}]`;
          })
          .filter(Boolean)
          .join("\n");
        return {
          content: [{ type: "text" as const, text: text || "(empty result)" }],
          details: {},
          isError: result.isError ?? false,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `MCP call failed: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}

async function connectAndRegister(
  pi: ExtensionAPI,
  serverName: string,
  serverConfig: McpServerConfig,
): Promise<McpClient | null> {
  const client = new McpClient(serverName, serverConfig);
  try {
    const tools = await client.listTools();
    for (const tool of tools) {
      registerMcpTool(pi, client, tool);
    }
    console.log(`[mcp-bridge] connected to "${serverName}" — registered ${tools.length} tool(s)`);
    return client;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[mcp-bridge] failed to connect to "${serverName}": ${msg}`);
    client.close();
    return null;
  }
}

const activeClients: McpClient[] = [];

function attachCleanupHandlers(): void {
  const cleanup = (): void => {
    for (const client of activeClients) {
      try { client.close(); } catch { /* ignore */ }
    }
    activeClients.length = 0;
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });
}

export default function mcpBridgeExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  if (!config || Object.keys(config).length === 0) {
    // No config or empty config — bridge does nothing
    return;
  }

  attachCleanupHandlers();

  // Fire-and-forget connect each server. Tools register asynchronously as each handshake completes.
  // Pi's tool registry is mutable at runtime, so late additions are fine — they appear on the next agent turn.
  for (const [serverName, serverConfig] of Object.entries(config)) {
    connectAndRegister(pi, serverName, serverConfig)
      .then((client) => {
        if (client) activeClients.push(client);
      })
      .catch((e) => {
        console.warn(`[mcp-bridge] unexpected error for "${serverName}":`, e);
      });
  }
}
