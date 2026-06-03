/**
 * Tests for McpClient.
 *
 * Drives the client against a fake MCP server (a tiny Node script written
 * to a tmpfile). The fake server speaks just enough JSON-RPC over stdin/
 * stdout to exercise initialize / tools/list / tools/call paths.
 *
 * Why a real subprocess instead of mocking: McpClient's job IS to spawn a
 * process and speak line-delimited JSON-RPC at it. Mocking out child_process
 * would replace exactly the code we want to test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./mcp-client.js";

const FAKE_SERVER_OK = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const TOOLS = [
  { name: "echo", description: "Echo back the input.", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  { name: "fail", description: "Always errors.", inputSchema: { type: "object" } },
];
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0.0.0" } } });
  } else if (msg.method === "notifications/initialized") {
    // no response for notifications
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + (args && args.msg ? args.msg : "") }] } });
    } else if (name === "fail") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "intentional failure" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
    }
  }
});
`;

const FAKE_SERVER_CRASH = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", () => { process.exit(1); });
`;

describe("McpClient", () => {
  let tmp: string;
  let activeClients: McpClient[];

  function installFakeServer(content: string): string {
    const path = join(tmp, "fake-mcp.js");
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
    activeClients = [];
  });

  afterEach(() => {
    for (const c of activeClients) { try { c.close(); } catch { /* ignore */ } }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("performs initialize handshake and lists tools", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_OK);
    const client = new McpClient("fake", { command: "node", args: [serverPath] });
    activeClients.push(client);

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("echo");
    expect(tools[1].name).toBe("fail");
  });

  it("callTool returns content for a successful call", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_OK);
    const client = new McpClient("fake", { command: "node", args: [serverPath] });
    activeClients.push(client);

    const result = await client.callTool("echo", { msg: "hello" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("echo: hello");
  });

  it("callTool rejects on server-returned JSON-RPC error", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_OK);
    const client = new McpClient("fake", { command: "node", args: [serverPath] });
    activeClients.push(client);

    await expect(client.callTool("fail", {})).rejects.toThrow(/intentional failure/);
  });

  it("initialize is idempotent — multiple concurrent calls reuse one handshake", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_OK);
    const client = new McpClient("fake", { command: "node", args: [serverPath] });
    activeClients.push(client);

    // Trigger multiple in-flight initializes concurrently
    const [t1, t2, t3] = await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
    expect(t1).toEqual(t2);
    expect(t2).toEqual(t3);
  });

  it("rejects pending calls when the server process exits unexpectedly", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_CRASH);
    const client = new McpClient("fake-crash", { command: "node", args: [serverPath] });
    activeClients.push(client);

    // Server crashes on first message. initialize() will be the first send → should reject.
    await expect(client.listTools()).rejects.toThrow(/exited|closed/i);
  });

  it("close() kills the server and rejects subsequent calls", async () => {
    const serverPath = installFakeServer(FAKE_SERVER_OK);
    const client = new McpClient("fake", { command: "node", args: [serverPath] });
    activeClients.push(client);
    await client.listTools(); // ensure initialized

    client.close();
    await expect(client.callTool("echo", { msg: "x" })).rejects.toThrow(/closed/);
  });
});
