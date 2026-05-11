---
name: agent-browser
description: Underlying browser automation CLI (Rust, Chrome via CDP). pi-chrome ships this as a dependency; load the actual workflow guide via `agent-browser skills get core`.
---

# agent-browser (via pi-chrome)

`agent-browser` is the CLI primitive layer pi-chrome builds on top of. It provides:

- Page navigation, click, fill, screenshot
- Accessibility-tree snapshots with `@eN` element refs
- Sessions, auth vault, state persistence
- Video recording

## Get the up-to-date guide from the CLI itself

Don't read this file as the canonical reference — it can drift across versions. Run:

```bash
agent-browser skills get core             # core workflows and command reference
agent-browser skills get core --full      # plus templates and full options
```

Specialized skills (load when relevant):

```bash
agent-browser skills get electron         # Electron desktop apps
agent-browser skills get slack            # Slack workspace automation
agent-browser skills get dogfood          # exploratory testing / QA
```

## When to use what

- **Direct CLI** (Bash) for one-off operations: `agent-browser nav https://example.com`
- **pi-chrome task tools** (`test_page`, `scrape`, `fill_form`) for structured multi-step flows that need retry / timeout / cancellation. See sibling skills under `skills/black-box-test/`, `skills/web-scrape/`, etc.

The pi-chrome tools handle the orchestration boilerplate (retry, watchdog, error reporting). For ad-hoc exploration, the CLI is fine.
