/**
 * Co-pilot primitive tools.
 *
 * Thin wrappers around `agent-browser` CLI subcommands that operate on the
 * **active tab** (no `open <url>` first). The caller is expected to be
 * driving an already-attached Chrome (either agent-browser's own or the
 * user's, via `--cdp <port>` / `--auto-connect`). These primitives are the
 * Codex-style "look, then act, then look again" loop:
 *
 *   look()                  → current tab's a11y snapshot
 *   current_url()           → current tab's URL
 *   nav(url)                → navigate current tab
 *   click(@ref)             → click by ref from a recent snapshot
 *   fill(@ref, value)       → clear + type into element
 *
 * No retry by default: a stale ref or failed click is the agent's signal to
 * re-look, not the runtime's signal to retry.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { firstValueFrom } from "rxjs";
import { map, takeUntil } from "rxjs/operators";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runAgentBrowser, type CliResult } from "../../../lib/cli-adapter.js";
import { withWatchdog } from "../../../lib/operators.js";
import { cancel$ } from "../runtime/cancel.js";
import { emit } from "../runtime/event-bus.js";
import { tickActivity } from "../runtime/watchdog.js";

const DEFAULT_TIMEOUT_MS = 15000;

interface ToolDef<P extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  buildArgs: (params: Static<P>) => string[];
  shape: (cli: CliResult, params: Static<P>) => Record<string, unknown>;
  emitName: string;
  defaultTimeoutMs?: number;
}

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: {} };
}
function fail(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
    isError: true as const,
  };
}

function registerSingleShot<P extends TSchema>(pi: ExtensionAPI, def: ToolDef<P>): void {
  pi.registerTool({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id: string, params: Static<P>) {
      const totalTimeout = (params as { timeoutMs?: number })?.timeoutMs
        ?? def.defaultTimeoutMs
        ?? DEFAULT_TIMEOUT_MS;
      emit({ type: `${def.emitName}.start`, data: params as unknown });

      const flow$ = runAgentBrowser(def.buildArgs(params)).pipe(
        map((cli) => {
          tickActivity();
          const passed = cli.code === 0;
          const data = {
            ...def.shape(cli, params),
            passed,
            exitCode: cli.code,
            stderrTail: cli.stderr.slice(-500) || undefined,
          };
          emit({ type: `${def.emitName}.result`, data });
          return { passed, data };
        }),
        withWatchdog(totalTimeout, def.name),
        takeUntil(cancel$),
      );

      try {
        const { passed, data } = await firstValueFrom(flow$);
        return passed ? ok(data) : fail(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: `${def.emitName}.error`, data: { params, message: msg } });
        return fail({ error: msg });
      }
    },
  });
}

// ── look ────────────────────────────────────────────────────────────────────

const LookParams = Type.Object({
  interactive: Type.Optional(Type.Boolean({
    description: "If true (default), only include interactive elements.",
  })),
  selector: Type.Optional(Type.String({
    description: "Optional CSS selector to scope the snapshot.",
  })),
  timeoutMs: Type.Optional(Type.Number()),
});

export function registerLook(pi: ExtensionAPI): void {
  registerSingleShot(pi, {
    name: "look",
    label: "Look",
    description:
      "Snapshot the accessibility tree of the currently active tab. Returns the indented " +
      "tree with @eN refs you can pass to `click` / `fill`. No URL needed — operates on " +
      "whatever tab agent-browser is currently focused on. Use this as the first step in any " +
      "co-pilot interaction (look → act → re-look).",
    parameters: LookParams,
    emitName: "look",
    buildArgs: (p) => {
      const args = ["snapshot"];
      if (p.interactive !== false) args.push("-i");
      if (p.selector) args.push("-s", p.selector);
      return args;
    },
    shape: (cli) => ({ snapshot: cli.stdout }),
  });
}

// ── current_url ─────────────────────────────────────────────────────────────

const CurrentUrlParams = Type.Object({
  timeoutMs: Type.Optional(Type.Number()),
});

export function registerCurrentUrl(pi: ExtensionAPI): void {
  registerSingleShot(pi, {
    name: "current_url",
    label: "Current URL",
    description: "Return the URL of the currently active tab. No side effects.",
    parameters: CurrentUrlParams,
    emitName: "current_url",
    defaultTimeoutMs: 5000,
    buildArgs: () => ["get", "url"],
    shape: (cli) => ({ url: cli.stdout.trim() }),
  });
}

// ── nav ─────────────────────────────────────────────────────────────────────

const NavParams = Type.Object({
  url: Type.String({ description: "URL to navigate the current tab to." }),
  timeoutMs: Type.Optional(Type.Number()),
});

export function registerNav(pi: ExtensionAPI): void {
  registerSingleShot(pi, {
    name: "nav",
    label: "Navigate",
    description:
      "Navigate the active tab to a new URL. Does NOT open a new tab — replaces current. " +
      "Returns the page title. After nav, refs from prior snapshots are stale; call `look` again.",
    parameters: NavParams,
    emitName: "nav",
    defaultTimeoutMs: 30000,
    buildArgs: (p) => ["open", p.url],
    shape: (cli, p) => ({ url: p.url, output: cli.stdout.trim() }),
  });
}

// ── click ───────────────────────────────────────────────────────────────────

const ClickParams = Type.Object({
  ref: Type.String({ description: "@eN ref from a recent snapshot, or a CSS selector." }),
  timeoutMs: Type.Optional(Type.Number()),
});

export function registerClick(pi: ExtensionAPI): void {
  registerSingleShot(pi, {
    name: "click",
    label: "Click",
    description:
      "Click an element by @eN ref (from a recent `look`) or CSS selector. Refs become stale " +
      "after navigations or dynamic updates — re-`look` if a click fails with a not-found error.",
    parameters: ClickParams,
    emitName: "click",
    buildArgs: (p) => ["click", p.ref],
    shape: (cli, p) => ({ ref: p.ref, output: cli.stdout.trim() }),
  });
}

// ── fill ────────────────────────────────────────────────────────────────────

const FillParams = Type.Object({
  ref: Type.String({ description: "@eN ref from a recent snapshot, or a CSS selector." }),
  value: Type.String({ description: "Text to write into the field. Existing content is cleared first." }),
  timeoutMs: Type.Optional(Type.Number()),
});

export function registerFill(pi: ExtensionAPI): void {
  registerSingleShot(pi, {
    name: "fill",
    label: "Fill",
    description:
      "Clear an input/textarea and type a value. By @eN ref or CSS selector. For " +
      "type-without-clear, use the underlying `agent-browser type` CLI directly.",
    parameters: FillParams,
    emitName: "fill",
    buildArgs: (p) => ["fill", p.ref, p.value],
    shape: (cli, p) => ({ ref: p.ref, value: p.value, output: cli.stdout.trim() }),
  });
}

export function registerCoPilotPrimitives(pi: ExtensionAPI): void {
  registerLook(pi);
  registerCurrentUrl(pi);
  registerNav(pi);
  registerClick(pi);
  registerFill(pi);
}
