---
name: web-scrape
description: Extract structured fields from a web page by accessibility role and name. Supports multi-match (collect all) and pagination (follow a "next" link across pages). Use when the user asks to pull values off a URL and wants the @eN refs back for follow-up actions.
---

# web-scrape

Open a URL, snapshot the accessibility tree, and pluck named fields by
`role` + `name` predicate. Each matched field returns its `@eN` ref so you
can chain into `agent-browser click`, `type`, etc. without re-snapshotting.

## When to use

- Pull named values off a page (title, price, CTA label) — single or list
- Want the `@eN` refs preserved for follow-up interaction
- Need to walk a paginated list (search results, comment thread)
- Want retry / timeout / cancel discipline

For multi-page journeys with branching (login → dashboard → form), use
`scrape` for read-only extraction, then `fill_form` for actions. For ad-hoc
exploration, fall back to `agent-browser` CLI directly.

## Tool: scrape

```
scrape(
  url: string,
  fields: Record<string, {
    role: string,
    name?: string,
    nameMatches?: string,
    multi?: boolean
  }>,
  paginate?: {
    next: { role, name?, nameMatches? },
    maxPages?: number,    // default 10
    waitMs?: number       // default 500, between click-next and next snapshot
  },
  timeoutMs?: number      // default 30000
)
```

Returns JSON:

```json
{
  "url": "...",
  "fields": {
    "title": { "ref": "@e1", "value": "Example Domain", "role": "heading" },
    "prices": [
      { "ref": "@e7", "value": "$19", "role": "text" },
      { "ref": "@e8", "value": "$29", "role": "text" }
    ]
  },
  "missing": [],
  "pages": 1,
  "exitCode": 0
}
```

- Single fields (no `multi`) → `MatchedField | null`. Value is taken from page 1.
- Multi fields (`multi: true`) → `MatchedField[]`, accumulated across all pages visited.
- A field with zero matches at the end of the run is listed in `missing`.
- When `missing` is non-empty, the result is returned as an error.

## Pattern: smoke a key landmark (single field)

```
scrape("https://shop/x", { title: { role: "heading" } })
→ { title: { ref: "@e1", value: "Widget" }, ... }
```

## Pattern: collect a list (multi)

```
scrape("https://shop/search", {
  prices: { role: "text", nameMatches: "^\\$", multi: true }
})
→ { prices: [{ref, value:"$19"}, {ref, value:"$29"}, ...] }
```

## Pattern: paginate a search result

```
scrape("https://shop/search?q=widget", {
  titles: { role: "heading", multi: true }
}, {
  paginate: { next: { role: "link", nameMatches: "(?i)^next" }, maxPages: 5 }
})
→ aggregates titles across up to 5 pages
```

## Pattern: scrape then act

```
1. scrape(url, { buyBtn: { role: "button", name: "Buy now" } })
2. fill_form({ url, fields: {}, submit: result.fields.buyBtn.ref })
   // or: agent-browser click @<ref>
```

## v2 limitations (intentional)

- **No grouping.** Each field is independent; multi-match is flat. To get
  `[{title, price}, {title, price}, ...]` for a product grid, scrape titles
  and prices as two parallel arrays and zip on the caller side. Real grouping
  needs the indented-tree parser (planned for v3) or CSS-scoped snapshots.
- No level/attribute filtering. The snapshot's `refs` dict carries only
  `name` + `role`, so you can't ask for "h1 specifically" — every heading
  matches `role: "heading"`.
- No href extraction. For URLs, use the CLI:
  `agent-browser snapshot --urls --json` or `agent-browser get attr href @eN`.
- Pagination clicks the first `next` match it finds; if the page has
  multiple "Next" links, narrow with a more specific `name` / `nameMatches`.

## Reporting

If pi-mind is installed and `$PI_MIND_DIR/episodic/browser/` exists, save:

```markdown
---
date: <ISO>
type: project
tier: L2
tags: [scrape, <site>]
source: pi-chrome
---

# scrape — <url>

- pages: <n>
- fields: <name → ref/value, or count for multi>
- missing: <list>
```

Skip the file write if pi-mind isn't installed.
