/**
 * CDP event stream wrapper.
 *
 * Connects to the Chrome DevTools Protocol WebSocket exposed by agent-browser
 * (`agent-browser get cdp-url`), attaches to the first page target, enables
 * a configurable set of CDP domains, and emits every incoming event on
 * `events$` as `{ method, params, sessionId }`.
 *
 * Designed for the co-pilot mode: tools that need to *react* to navigations,
 * network responses, DOM updates, or console output can subscribe rather than
 * poll. agent-browser's own RPC commands continue to work in parallel —
 * the CDP socket is a side channel, not a replacement.
 *
 * Usage:
 *   const client = await connectCdp();
 *   client.events$.pipe(filter(e => e.method === "Page.frameNavigated"))
 *     .subscribe(...);
 *   // ... later
 *   client.close();
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Observable, Subject } from "rxjs";

const execp = promisify(execFile);

export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

export interface CdpClient {
  events$: Observable<CdpEvent>;
  /** Send a CDP command. If sessionId is omitted, it's a browser-level command. */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  /** Active page session id from the auto-attach. Empty string if attachToFirstPage was false. */
  pageSessionId: string;
  close(): void;
  closed: boolean;
}

export interface ConnectOptions {
  /** Override; otherwise we run `agent-browser get cdp-url --json`. */
  cdpUrl?: string;
  /** Domains to enable on the page session. Default: Page, Network, Runtime, DOM, Log. */
  domains?: string[];
  /** Auto-attach to the first page target. Default true. */
  attachToFirstPage?: boolean;
  /** Handshake timeout. Default 5000ms. */
  handshakeTimeoutMs?: number;
  /** Path/name of the agent-browser binary. Default uses AGENT_BROWSER_BIN or "agent-browser". */
  agentBrowserBin?: string;
}

const DEFAULT_DOMAINS = ["Page", "Network", "Runtime", "DOM", "Log"];

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
  sessionId?: string;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export async function connectCdp(opts: ConnectOptions = {}): Promise<CdpClient> {
  const cdpUrl = opts.cdpUrl ?? (await discoverCdpUrl(opts.agentBrowserBin));
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
  const domains = opts.domains ?? DEFAULT_DOMAINS;
  const attachToFirstPage = opts.attachToFirstPage ?? true;

  const ws = new WebSocket(cdpUrl);
  const events$ = new Subject<CdpEvent>();
  const pending = new Map<number, PendingCall>();
  let nextId = 0;
  let closed = false;

  const send = (method: string, params: unknown = {}, sessionId?: string): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("cdp client is closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const { reject, method } of pending.values()) {
      reject(new Error(`cdp client closed before ${method} completed`));
    }
    pending.clear();
    events$.complete();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(1000, "client.close()"); } catch { /* ignore */ }
    }
  };

  ws.addEventListener("message", (e) => {
    let msg: RpcResponse;
    try {
      const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer));
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const call = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) call.reject(new Error(`CDP ${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      events$.next({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
    }
  });

  ws.addEventListener("close", () => {
    if (!closed) {
      closed = true;
      for (const { reject, method } of pending.values()) {
        reject(new Error(`cdp socket closed before ${method} completed`));
      }
      pending.clear();
      events$.complete();
    }
  });

  ws.addEventListener("error", () => {
    // The "close" event will follow; let it handle teardown. Don't double-reject.
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp handshake timed out (${handshakeTimeoutMs}ms)`)), handshakeTimeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`cdp websocket error connecting to ${cdpUrl}`)); }, { once: true });
  });

  let pageSessionId = "";
  if (attachToFirstPage) {
    const targetsResult = await send("Target.getTargets") as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const page = targetsResult.targetInfos.find((t) => t.type === "page");
    if (!page) {
      close();
      throw new Error("cdp: no page target found to attach to");
    }
    const attachResult = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId: string };
    pageSessionId = attachResult.sessionId;
    for (const domain of domains) {
      // Intentionally not awaiting individually — fire-and-forget enable batch.
      send(`${domain}.enable`, {}, pageSessionId).catch(() => { /* domain may not exist; ignore */ });
    }
  }

  return {
    events$: events$.asObservable(),
    send,
    close,
    get closed() { return closed; },
    pageSessionId,
  };
}

async function discoverCdpUrl(bin?: string): Promise<string> {
  const command = bin ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
  const { stdout } = await execp(command, ["get", "cdp-url", "--json"], { timeout: 8000 });
  const parsed = JSON.parse(stdout) as { success?: boolean; data?: { cdpUrl?: string }; error?: unknown };
  if (!parsed.success || !parsed.data?.cdpUrl) {
    throw new Error(`agent-browser get cdp-url did not return a url: ${stdout.slice(0, 200)}`);
  }
  return parsed.data.cdpUrl;
}
