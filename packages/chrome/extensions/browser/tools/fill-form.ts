/**
 * fill_form tool — open a URL, fill fields by ref, optionally submit + wait.
 *
 * Low-level primitive: caller already knows the @eN refs (typically from a
 * prior `scrape` call). Tool sequences `fill`/`click`/`wait` CLI invocations
 * and short-circuits on the first failing step.
 *
 * v1 shape:
 *   - `fields`: ref → value, executed in insertion order via `agent-browser fill`
 *   - `submit`: optional ref to `click` after all fields succeed
 *   - `waitFor`: optional selector to `wait` for after submit
 *
 * Limitations:
 *   - no auto-resolution of labels → refs (use `scrape` first)
 *   - no validation-error retry-and-correct loop
 *   - `waitFor` is selector/ref-based, not free text (use a selector that
 *     resolves to the success element)
 */

import { Type, type Static } from "@sinclair/typebox";
import { firstValueFrom, from } from "rxjs";
import { concatMap, map, takeUntil, takeWhile, toArray } from "rxjs/operators";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runAgentBrowser } from "../../../lib/cli-adapter.js";
import { retryWithBackoff, withWatchdog } from "../../../lib/operators.js";
import { cancel$ } from "../runtime/cancel.js";
import { emit } from "../runtime/event-bus.js";
import { tickActivity } from "../runtime/watchdog.js";

const FillFormParams = Type.Object({
  url: Type.String({ description: "URL to open before filling." }),
  fields: Type.Record(Type.String(), Type.String(), {
    description: "Map of @eN ref → value. Executed in insertion order.",
  }),
  submit: Type.Optional(Type.String({
    description: "@eN ref of the submit element to click after all fields.",
  })),
  waitFor: Type.Optional(Type.String({
    description: "Selector or @eN ref to wait for after submit (signal of success).",
  })),
  timeoutMs: Type.Optional(Type.Number({
    description: "Total task timeout in milliseconds (default 60000).",
  })),
});

type StepKind = "open" | "fill" | "click" | "wait";

interface StepResult {
  kind: StepKind;
  target: string;
  ok: boolean;
  exitCode: number | null;
  stderrTail?: string;
}

interface FillFormResult {
  url: string;
  passed: boolean;
  steps: StepResult[];
  failedAt?: number;
  exitCode: number | null;
}

interface PlannedStep {
  kind: StepKind;
  args: string[];
  target: string;
}

function planSteps(p: Static<typeof FillFormParams>): PlannedStep[] {
  const plan: PlannedStep[] = [
    { kind: "open", args: ["open", p.url], target: p.url },
  ];
  for (const [ref, value] of Object.entries(p.fields)) {
    plan.push({ kind: "fill", args: ["fill", ref, value], target: ref });
  }
  if (p.submit) plan.push({ kind: "click", args: ["click", p.submit], target: p.submit });
  if (p.waitFor) plan.push({ kind: "wait", args: ["wait", p.waitFor], target: p.waitFor });
  return plan;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

export function registerFillForm(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fill_form",
    label: "Fill Form",
    description:
      "Open a URL, fill fields by @eN ref (use `scrape` first to find them), optionally " +
      "click a submit ref and wait for a confirmation selector. Stops on the first failing " +
      "step. Returns per-step status. v1 limitations: no label→ref resolution, no validation " +
      "retry, waitFor is selector/ref-based (not free text).",
    parameters: FillFormParams,
    async execute(_id: string, params: Static<typeof FillFormParams>) {
      const totalTimeout = params.timeoutMs ?? 60000;
      const plan = planSteps(params);

      emit({
        type: "fill_form.start",
        data: { url: params.url, kinds: plan.map((s) => s.kind) },
      });

      const flow$ = from(plan).pipe(
        concatMap((step) =>
          runAgentBrowser(step.args).pipe(
            map((cli) => {
              tickActivity();
              const result: StepResult = {
                kind: step.kind,
                target: step.target,
                ok: cli.code === 0,
                exitCode: cli.code,
                stderrTail: cli.stderr.slice(-200) || undefined,
              };
              return result;
            }),
          ),
        ),
        takeWhile((s) => s.ok, true),
        toArray(),
        map((steps) => {
          const failedAt = steps.findIndex((s) => !s.ok);
          const passed = failedAt === -1;
          const exitCode = passed
            ? steps[steps.length - 1]?.exitCode ?? 0
            : steps[failedAt].exitCode;
          const result: FillFormResult = {
            url: params.url,
            passed,
            steps,
            failedAt: passed ? undefined : failedAt,
            exitCode,
          };
          emit({ type: "fill_form.result", data: result });
          return result;
        }),
        retryWithBackoff({ count: 1, initialDelayMs: 1000 }),
        withWatchdog(totalTimeout, "fill_form"),
        takeUntil(cancel$),
      );

      try {
        const result = await firstValueFrom(flow$);
        const text = JSON.stringify(result, null, 2);
        return result.passed ? ok(text) : fail(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "fill_form.error", data: { url: params.url, message: msg } });
        return fail(`fill_form failed: ${msg}`);
      }
    },
  });
}
