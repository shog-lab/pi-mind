---
name: knowledge-lint
description: Memory hygiene — schema validation, auto-fix, duplicate detection, stale flagging, age-based prune.
---

# knowledge-lint

Maintain the quality of `$PI_MIND_DIR/knowledge/` and the rest of the pi-mind store. Uses `scripts/knowledge-lint.ts` for scan / auto-fix / prune.

(Previously named `wiki-lint`; renamed in 0.3.0 because the project's knowledge store is no longer called "wiki" — the dir is `knowledge/` and the package is `memory`.)

## Frontmatter schema

```yaml
---
date: 2026-05-08T00:00:00.000Z
type: user|project|agent-feedback|reference|compaction
tier: L1|L2
tags: [topic1, topic2]
---
```

**`type`** — subject axis: who/what is this memory about?
- `user` — user preferences, requests, constraints
- `project` — project code, architecture, decisions
- `agent-feedback` — agent's own suggestions, decisions, reflections
- `reference` — external knowledge, docs, research
- `compaction` — system-generated (don't write manually)

**`tier`** — recall axis: how is it retrieved?
- `L1` — always injected (high-priority preferences/decisions)
- `L2` — retrieved by relevance (default)

## Commands

### Scan only
```bash
npx pi-mind-lint
```

### Preview fixes
```bash
npx pi-mind-lint --dry-run --fix
```

### Apply fixes
```bash
npx pi-mind-lint --fix
# then re-scan to verify
npx pi-mind-lint
```

## When to run

- Periodically (e.g. nightly via cron)
- After schema migrations (type/tier changes)
- After bursts of memory growth

## Auto-fix scope (--fix)

- Missing `tier` → inferred from `type` (legacy L1 types fact/preference/decision → L1, else L2)
- Missing `type` + has `source` → migrate from source, normalize to valid subject
- Missing `type` + no `source` → default to `reference`
- Stale `source` field present → remove (already migrated to type)
- `subject:` or `memory-type:` encodings in tags → strip (subject lives in type field now)

**Not auto-fixed (requires judgment):**
- Invalid subject values (e.g. `type: todo`) → human review
- Duplicate entries → keep newest, archive others manually
- Stale flags → add `tags: [stale]` selectively

## Output legend

| Marker | Meaning |
|---|---|
| ❌ ERRORS | Missing required field or invalid type value (schema fails) |
| ⚠️  WARNINGS | Legacy fields/tags or recommended-field gaps |
| ℹ️  INFO | Reference entries past staleness threshold |
| 🔄 DUPLICATES | Identical-content files |
| 📊 Type distribution | Current subject mix |

## After fixing

Re-run lint and confirm errors hit zero. Remaining warnings, in priority order:

1. Wrong `type` value → manually pick the correct subject
2. Missing `tags` → add topic keywords
3. Stale references → mark `stale` or delete
