---
name: form-fill
description: Fill a form by @eN refs and optionally submit + wait. Use after `scrape` has located the field refs. The agent supplies refs and values; the tool sequences the underlying CLI calls and stops on the first failure.
---

# form-fill

Fill out a form on a target page. The tool takes a map of `@eN` ref → value,
optionally clicks a submit ref, and optionally waits for a confirmation
selector. It short-circuits on the first failing step and returns per-step
status.

## When to use

- You already know the field refs (typically from a prior `scrape` call)
- You want a single tool call to fill many fields, submit, and wait for success
- You want retry / total-timeout / cancel discipline

For interactive flows that need to read-then-decide between fills, fall back
to direct CLI: `scrape` → inspect → `agent-browser fill/click/wait`.

## Tool: fill_form

```
fill_form(
  url: string,
  fields: Record<string, string>,   // @eN ref → value, executed in insertion order
  submit?: string,                  // @eN ref to click after fields
  waitFor?: string,                 // selector or @eN ref to wait for after submit
  timeoutMs?: number                // default 60000
)
```

Returns JSON:

```json
{
  "url": "https://example.com/login",
  "passed": true,
  "steps": [
    { "kind": "open",  "target": "https://example.com/login", "ok": true, "exitCode": 0 },
    { "kind": "fill",  "target": "@e7", "ok": true, "exitCode": 0 },
    { "kind": "fill",  "target": "@e8", "ok": true, "exitCode": 0 },
    { "kind": "click", "target": "@e9", "ok": true, "exitCode": 0 },
    { "kind": "wait",  "target": "#welcome", "ok": true, "exitCode": 0 }
  ],
  "exitCode": 0
}
```

When any step fails, `passed: false`, `failedAt` is the step index, and only
steps up to and including the failing one are present (subsequent steps are
not attempted). The result is returned as an error.

## Pattern: scrape then fill

```
1. scrape(url, {
     email:  { role: "textbox", nameMatches: "(?i)email" },
     pw:     { role: "textbox", nameMatches: "(?i)password" },
     submit: { role: "button",  nameMatches: "(?i)log\\s*in" }
   })
2. fill_form({
     url,
     fields: { [r.fields.email.ref]: "user@example.com",
               [r.fields.pw.ref]:    "secret" },
     submit: r.fields.submit.ref,
     waitFor: "#dashboard"
   })
```

## v1 limitations (intentional)

- No label → ref auto-resolution. Use `scrape` first; the tool takes refs only.
- No validation-error retry-and-correct loop. If a field is rejected, the
  whole step fails and `fill_form` returns. Caller decides the next move.
- `waitFor` is selector-or-ref, not free text. To wait for "Welcome, Steve",
  point at an element that contains it (e.g. `h1` or a known testid).
- Field order = insertion order in the `fields` object. JavaScript preserves
  string-key insertion order, so this is well-defined.

## Reporting

If pi-mind is installed and `$PI_MIND_DIR/episodic/browser/` exists, save:

```markdown
---
date: <ISO>
type: project
tier: L2
tags: [form-fill, <site>]
source: pi-chrome
---

# fill_form — <url>

- passed: <bool>
- steps: <count>
- failedAt: <index|null>
- last step: <kind/target/exitCode>
```
