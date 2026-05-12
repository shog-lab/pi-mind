/**
 * Minimal MCP (Model Context Protocol) stdio JSON-RPC client.
 *
 * Spawns an MCP server as a child process, performs the initialize handshake,
 * and exposes tools/list + tools/call.
 *
 * MCP spec: https://spec.modelcontextprotocol.io/
 */

import { spawn, type ChildProcess } from "node:child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = 10000;
const TOOL_CALL_TIMEOUT_MS = 60000;

export class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private stdoutBuffer = "";
  private initialized = false;
  private closed = false;
  private initializePromise: Promise<void> | null = null;
  public readonly serverName: string;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      // MCP servers commonly use stderr for logs — surface as warnings, don't fail
      const line = chunk.toString().trim();
      if (line) console.warn(`[mcp:${this.serverName}] ${line}`);
    });
    this.proc.on("error", (err) => this.failAll(err));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`MCP server "${this.serverName}" exited (code=${code}, signal=${signal})`));
    });

    this.proc.unref(); // don't keep event loop alive on our own
  }

  /** Run the MCP initialize handshake. Idempotent — multiple callers share one in-flight promise. */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      await this.send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-toolkit-mcp-bridge", version: "0.1.0" },
      }, HANDSHAKE_TIMEOUT_MS);
      this.notify("notifications/initialized");
      this.initialized = true;
    })();
    return this.initializePromise;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.send<{ tools: McpTool[] }>("tools/list", undefined, HANDSHAKE_TIMEOUT_MS);
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.initialize();
    const result = await this.send<McpToolResult>("tools/call", { name, arguments: args }, TOOL_CALL_TIMEOUT_MS);
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.proc.killed) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.failAll(new Error(`MCP client "${this.serverName}" closed`));
  }

  // --- internals ---

  private send<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`MCP client "${this.serverName}" closed`));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.serverName}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.proc.stdin?.write(JSON.stringify(req) + "\n");
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.proc.stdin?.write(JSON.stringify(req) + "\n");
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[mcp:${this.serverName}] non-JSON output: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.id === undefined) continue; // notification from server, ignore for now

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(new Error(`MCP "${this.serverName}" error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}
