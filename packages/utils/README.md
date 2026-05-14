# pi-utils

Internal infrastructure shared by pi-mind packages (memory, ralph, eval).

**Private workspace** — not published. If a published package (memory, ralph)
ever needs to ship to npm, this becomes a transitive concern; flip `private:
false` then.

## What's in here

- `spawnPi(opts)` — programmatic pi-coding-agent spawn with `--mode json`,
  text streaming, and token usage extraction. Wraps node:child_process.
- `resolvePiMindDir(cwd?)` — resolve `.pi-mind` directory location, respecting
  `$PI_MIND_DIR` env var and git worktree boundaries (`git rev-parse
  --git-common-dir`).

## Why a separate package

Memory, ralph, and eval all drive pi programmatically and need a shared
spawn helper + path resolver. Previously these lived inside `packages/memory/lib/`,
which forced ralph and eval to depend on the entire memory package just to
get a 200-line utility. Extracting to its own workspace keeps dependencies
honest: ralph/eval depend on `pi-utils`, not `pi-mind`.

This package has no agent-facing tools — it's not loaded as a pi extension.
For agent-facing shared tools (jimeng, web_search, MCP bridge), see `pi-toolkit`.
