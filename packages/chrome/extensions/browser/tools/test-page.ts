/**
 * test_page tool — open a URL and assert expected text appears.
 *
 * Reference implementation showing the pi-chrome composition pattern:
 *   1. CLI calls become Observables via lib/cli-adapter
 *   2. Pipeline composes navigate → snapshot → verify
 *   3. retryWithBackoff handles transient failures
 *   4. withWatchdog enforces a hard total timeout
 *   5. takeUntilCancel respects the runtime's global cancel signal
 *   6. Each step emits to event-bus for observability
 */

import { Type, type Static } from "@sinclair/typebox";
import { firstValueFrom, of } from "rxjs";
import { map, switchMap, takeUntil } from "rxjs/operators";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runAgentBrowser, type CliResult } from "../../../lib/cli-adapter.js";
import { retryWithBackoff, withWatchdog } from "../../../lib/operators.js";
import { cancel$ } from "../runtime/cancel.js";
import { emit } from "../runtime/event-bus.js";
import { tickActivity } from "../runtime/watchdog.js";

const TestPageParams = Type.Object({
  url: Type.String({ description: "URL to navigate to and test." }),
  expects: Type.Optional(Type.Array(Type.String(), {
    description: "List of substrings expected to appear in the page snapshot.",
  })),
  timeoutMs: Type.Optional(Type.Number({
    description: "Total task timeout in milliseconds (default 30000).",
  })),
});

interface TestResult {
  url: string;
  passed: boolean;
  missing: string[];
  exitCode: number | null;
  stderrTail?: string;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

export function registerTestPage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "test_page",
    label: "Test Page",
    description:
      "Open a URL via agent-browser and verify expected substrings appear in the page snapshot. " +
      "Returns a structured pass/fail report. Useful for black-box smoke tests.",
    parameters: TestPageParams,
    async execute(_id: string, params: Static<typeof TestPageParams>) {
      const totalTimeout = params.timeoutMs ?? 30000;
      const expects = params.expects ?? [];

      emit({ type: "test_page.start", data: { url: params.url } });

      const flow$ = runAgentBrowser(["open", params.url]).pipe(
        switchMap((open) => {
          tickActivity();
          if (open.code !== 0) return of({ open, snap: null as CliResult | null });
          return runAgentBrowser(["snapshot"]).pipe(
            map((snap) => ({ open, snap })),
          );
        }),
        map(({ open, snap }) => {
          tickActivity();
          const haystack = (snap?.stdout ?? "") + "\n" + open.stdout;
          const stderr = (open.stderr + (snap?.stderr ?? "")).slice(-500) || undefined;
          const exitCode = snap?.code ?? open.code;
          const missing = expects.filter((needle) => !haystack.includes(needle));
          const result: TestResult = {
            url: params.url,
            passed: open.code === 0 && snap?.code === 0 && missing.length === 0,
            missing,
            exitCode,
            stderrTail: stderr,
          };
          emit({ type: "test_page.result", data: result });
          return result;
        }),
        retryWithBackoff({ count: 2, initialDelayMs: 1000 }),
        withWatchdog(totalTimeout, "test_page"),
        takeUntil(cancel$),
      );

      try {
        const result = await firstValueFrom(flow$);
        const text = JSON.stringify(result, null, 2);
        return result.passed ? ok(text) : fail(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "test_page.error", data: { url: params.url, message: msg } });
        return fail(`test_page failed: ${msg}`);
      }
    },
  });
}
