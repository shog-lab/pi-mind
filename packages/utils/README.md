# @shog-lab/pi-utils

Internal infrastructure shared by pi-mind packages (pi-mind-core, pi-toolkit, pi-bus, pi-subagent).

## What's in here

- `spawnPi(opts)` — programmatic pi-coding-agent spawn with `--mode json`,
  text streaming, and token usage extraction. Wraps node:child_process.
- `resolvePiMindDir(cwd?)` — resolve `.pi-mind` directory location, respecting
  `$PI_MIND_DIR` env var and git worktree boundaries (`git rev-parse
  --git-common-dir`).

## Why a separate package

pi-mind-core, pi-toolkit, pi-bus, pi-subagent, and the internal pi-eval
harness all drive pi programmatically and need a shared spawn helper +
path resolver.
Previously these lived inside the memory package, which forced everyone
else to depend on the entire memory package just to get a small utility.
Extracting to its own workspace keeps dependencies honest: everyone
depends on `pi-utils`, not on each other.

This package has no agent-facing tools — it's not loaded as a pi extension.
For agent-facing shared tools (web_search, mcp-bridge, spawn_subagent),
see `pi-toolkit` / `pi-subagent`.
