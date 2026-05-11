/**
 * scrape tool — open a URL, snapshot the a11y tree, extract structured fields.
 *
 * Each field is matched against `data.refs` from `agent-browser snapshot --json`
 * by {role, name?, nameMatches?}. Single fields take the first match; multi
 * fields collect all matches. The `@eN` ref is preserved so the agent can use
 * it for follow-up actions.
 *
 * v2 adds:
 *   - field.multi: true → returns MatchedField[] across the run
 *   - paginate: { next, maxPages?, waitMs? } → after each snapshot, find a
 *     `next` ref and click it; loop until no more or maxPages reached.
 *
 * Limitations:
 *   - No grouping (each field is independent; no "container → child fields")
 *   - No level/attribute filtering (snapshot.refs only carries name+role)
 *   - No href extraction (use `--urls` or `get attr` separately)
 */

import { Type, type Static } from "@sinclair/typebox";
import { defer, firstValueFrom } from "rxjs";
import { takeUntil } from "rxjs/operators";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runAgentBrowser } from "../../../lib/cli-adapter.js";
import { retryWithBackoff, withWatchdog } from "../../../lib/operators.js";
import { abortControllerFromCancel, cancel$ } from "../runtime/cancel.js";
import { emit } from "../runtime/event-bus.js";
import { tickActivity } from "../runtime/watchdog.js";

const FieldSpec = Type.Object({
  role: Type.String({ description: "ARIA role (e.g. 'heading', 'link', 'button')." }),
  name: Type.Optional(Type.String({ description: "Exact name match (case-sensitive)." })),
  nameMatches: Type.Optional(Type.String({
    description: "Regex applied to the element's name. No flags.",
  })),
  multi: Type.Optional(Type.Boolean({
    description: "If true, return all matches across all visited pages instead of just the first.",
  })),
});

const PaginateSpec = Type.Object({
  next: Type.Object({
    role: Type.String(),
    name: Type.Optional(Type.String()),
    nameMatches: Type.Optional(Type.String()),
  }, { description: "How to find the 'next page' element on each page's snapshot." }),
  maxPages: Type.Optional(Type.Number({ description: "Cap on pages visited (default 10)." })),
  waitMs: Type.Optional(Type.Number({
    description: "Wait after clicking next, before snapshotting (default 500).",
  })),
});

const ScrapeParams = Type.Object({
  url: Type.String({ description: "URL to navigate to." }),
  fields: Type.Record(Type.String(), FieldSpec, {
    description: "Map of field name → a11y query.",
  }),
  paginate: Type.Optional(PaginateSpec),
  timeoutMs: Type.Optional(Type.Number({
    description: "Total task timeout in milliseconds (default 30000).",
  })),
});

interface MatchedField {
  ref: string;
  value: string;
  role: string;
}

type FieldValue = MatchedField | MatchedField[] | null;

interface ScrapeResult {
  url: string;
  fields: Record<string, FieldValue>;
  missing: string[];
  pages: number;
  exitCode: number | null;
  stderrTail?: string;
}

interface SnapshotJson {
  success?: boolean;
  data?: {
    origin?: string;
    refs?: Record<string, { name: string; role: string }>;
    snapshot?: string;
  };
  error?: unknown;
}

interface FieldQuery {
  role: string;
  name?: string;
  nameMatches?: string;
}

function compilePattern(spec: FieldQuery): RegExp | undefined | null {
  if (!spec.nameMatches) return undefined;
  try {
    return new RegExp(spec.nameMatches);
  } catch {
    return null; // sentinel: regex invalid → never matches
  }
}

function findMatches(
  refs: Record<string, { name: string; role: string }>,
  spec: FieldQuery,
  all: boolean,
): MatchedField[] {
  const pattern = compilePattern(spec);
  if (pattern === null) return [];
  const out: MatchedField[] = [];
  for (const [refKey, entry] of Object.entries(refs)) {
    if (entry.role !== spec.role) continue;
    if (spec.name !== undefined && entry.name !== spec.name) continue;
    if (pattern && !pattern.test(entry.name)) continue;
    out.push({ ref: `@${refKey}`, value: entry.name, role: entry.role });
    if (!all) break;
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

export function registerScrape(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "scrape",
    label: "Scrape",
    description:
      "Open a URL and extract structured fields from the accessibility tree. Each field is " +
      "matched by {role, name?, nameMatches?, multi?} against the snapshot's refs. Set " +
      "`multi: true` to collect all matches; pass `paginate: {next, maxPages?}` to follow a " +
      "'next page' element and aggregate. Returns @eN refs you can pass to fill_form / click.",
    parameters: ScrapeParams,
    async execute(_id: string, params: Static<typeof ScrapeParams>) {
      const totalTimeout = params.timeoutMs ?? 30000;
      const maxPages = params.paginate?.maxPages ?? 10;
      const waitMs = params.paginate?.waitMs ?? 500;
      const fieldNames = Object.keys(params.fields);

      emit({
        type: "scrape.start",
        data: { url: params.url, fields: fieldNames, paginate: !!params.paginate },
      });

      const flow$ = defer(async (): Promise<ScrapeResult> => {
        const ctrl = abortControllerFromCancel();
        const run = (args: string[]) =>
          firstValueFrom(runAgentBrowser(args, { signal: ctrl.signal }));

        const stderrChunks: string[] = [];
        const captureStderr = (s: string) => { if (s) stderrChunks.push(s); };

        const open = await run(["open", params.url]);
        tickActivity();
        captureStderr(open.stderr);
        if (open.code !== 0) {
          return blankResult(params, 0, open.code, joinStderr(stderrChunks));
        }

        const collected: Record<string, MatchedField[]> = {};
        for (const k of fieldNames) collected[k] = [];

        let pages = 0;
        let lastExit: number | null = 0;

        while (true) {
          pages++;
          const snap = await run(["snapshot", "--json"]);
          tickActivity();
          captureStderr(snap.stderr);
          lastExit = snap.code;
          if (snap.code !== 0) break;

          let parsed: SnapshotJson;
          try {
            parsed = JSON.parse(snap.stdout);
          } catch {
            lastExit = snap.code ?? -1;
            captureStderr("scrape: failed to parse snapshot JSON");
            break;
          }
          const refs = parsed.data?.refs ?? {};

          for (const [name, spec] of Object.entries(params.fields)) {
            if (!spec.multi && collected[name].length > 0) continue;
            const matches = findMatches(refs, spec, !!spec.multi);
            collected[name].push(...matches);
          }

          if (!params.paginate || pages >= maxPages) break;

          const nextMatches = findMatches(refs, params.paginate.next, false);
          if (nextMatches.length === 0) break;

          const click = await run(["click", nextMatches[0].ref]);
          tickActivity();
          captureStderr(click.stderr);
          if (click.code !== 0) {
            lastExit = click.code;
            break;
          }
          await sleep(waitMs);
        }

        const fields: Record<string, FieldValue> = {};
        const missing: string[] = [];
        for (const [name, spec] of Object.entries(params.fields)) {
          const list = collected[name];
          if (spec.multi) {
            fields[name] = list;
            if (list.length === 0) missing.push(name);
          } else {
            fields[name] = list[0] ?? null;
            if (!list[0]) missing.push(name);
          }
        }

        const result: ScrapeResult = {
          url: params.url,
          fields,
          missing,
          pages,
          exitCode: lastExit,
          stderrTail: joinStderr(stderrChunks),
        };
        emit({ type: "scrape.result", data: result });
        return result;
      }).pipe(
        retryWithBackoff({ count: 2, initialDelayMs: 1000 }),
        withWatchdog(totalTimeout, "scrape"),
        takeUntil(cancel$),
      );

      try {
        const result = await firstValueFrom(flow$);
        const text = JSON.stringify(result, null, 2);
        return result.missing.length === 0 ? ok(text) : fail(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "scrape.error", data: { url: params.url, message: msg } });
        return fail(`scrape failed: ${msg}`);
      }
    },
  });
}

function blankResult(
  params: Static<typeof ScrapeParams>,
  pages: number,
  exitCode: number | null,
  stderrTail: string | undefined,
): ScrapeResult {
  const fields: Record<string, FieldValue> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(params.fields)) {
    fields[name] = spec.multi ? [] : null;
    missing.push(name);
  }
  const result: ScrapeResult = { url: params.url, fields, missing, pages, exitCode, stderrTail };
  emit({ type: "scrape.result", data: result });
  return result;
}

function joinStderr(chunks: string[]): string | undefined {
  const joined = chunks.join("");
  return joined ? joined.slice(-500) : undefined;
}
