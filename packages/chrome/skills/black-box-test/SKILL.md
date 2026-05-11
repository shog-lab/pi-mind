---
name: black-box-test
description: Run a structured black-box test against a web page. Verify expected text appears, capture failures with stderr context. Use when the user asks to test a page, verify a deployment, or smoke-check a URL.
---

# black-box-test

Run a structured smoke test against a URL. Backed by the `test_page` tool which
composes navigation, snapshot, and verification into a single retry-aware flow.

## When to use

- User asks "test this page" / "verify staging is up" / "smoke check"
- You need a clear pass/fail report on whether expected content rendered
- You want retry + timeout discipline without writing the loop yourself

For richer scenarios (login flows, multi-page journeys, form submission)
prefer the dedicated tools or compose multiple `test_page` calls.

## Tool: test_page

```
test_page(url: string, expects?: string[], timeoutMs?: number)
```

- `url` — target URL
- `expects` — substrings that must appear in the page snapshot (page text + a11y tree)
- `timeoutMs` — total task budget, default 30000ms

Returns JSON:

```json
{
  "url": "https://example.com",
  "passed": true,
  "missing": [],
  "exitCode": 0
}
```

When `passed` is false, the result is returned as an error. The `missing` array
lists strings from `expects` that did not appear in the snapshot.

## Pattern: smoke test a deployment

```
1. Identify URL and expected content (homepage title, key CTA text, etc.)
2. Call test_page with those expectations.
3. If passed: report "smoke test passed" with the expectations covered.
4. If failed: report missing strings + exitCode + stderrTail; suggest manual inspection.
```

## Pattern: multi-page check

For a list of URLs, call `test_page` per URL. Aggregate results into a summary
table before responding to the user. Don't parallelize unless the user explicitly
asks — sequential keeps logs readable and respects rate limits.

## Notes on retry behavior

`test_page` already retries twice with exponential backoff before giving up.
Don't wrap it in your own retry loop unless you have a reason — that'd produce
4-6 retries per URL.

## Reporting

Write the structured result back to the user. If pi-mind is installed and
`$PI_MIND_DIR/episodic/browser/` exists, also save a markdown record there
for daily-audit to surface later. Format:

```markdown
---
date: <ISO>
type: project
tier: L2
tags: [black-box-test, <site>]
source: pi-chrome
---

# black-box test — <url>

- passed: <bool>
- missing: <list>
- exitCode: <n>
```

Skip the file write if pi-mind isn't installed.
