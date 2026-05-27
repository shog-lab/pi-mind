# @shog-lab/pi-subagent

**Spawn focused sub-pi processes from inside pi.**

Registers a single `spawn_subagent` tool. Your agent calls it with a `cwd` + `prompt`; pi-subagent spawns a clean child pi (no extensions, no inherited context), waits for it to finish, returns the response.

Useful for: isolated code analysis, parallel exploration, "classify this content without bias from my loaded context", running a focused sub-task in a different directory.

## Install

```bash
npm i -D @shog-lab/pi-subagent
```

`postinstall` symlinks `dist/extensions/subagent/` into the host repo's `.pi/extensions/`, so pi auto-discovers on next launch.

## Tool

| Tool | Args | Purpose |
|---|---|---|
| `spawn_subagent` | `cwd: string`, `prompt: string`, `timeout?: number` (seconds, default 300, max 600) | Spawn a child pi at `cwd` with `prompt`, return its response text and token usage |

The child pi runs with `--no-extensions` (no memory, no other extensions loaded) and no system prompt — it's a clean slate that only sees your prompt.

## Why a separate package

`spawn_subagent` is infrastructure (child-process spawning helper), not a leaf tool like `web_search` or `understand_image`. Previously bundled in `@shog-lab/pi-toolkit` for historical reasons; extracted in toolkit 0.3.0 so it can evolve independently and so users who want JUST subagent capability don't have to pull in mmx CLI / agent-browser deps.

## Migration from @shog-lab/pi-toolkit < 0.3.0

If you previously got `spawn_subagent` via toolkit:

```bash
npm i -D @shog-lab/pi-subagent
# now both packages contribute: toolkit gives web_search / understand_image / mcp-bridge,
# pi-subagent gives spawn_subagent
```

No code change needed in your agent prompts — the tool name (`spawn_subagent`) is unchanged.

## Dependencies

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0"
  },
  "dependencies": {
    "@shog-lab/pi-utils": "*",
    "@sinclair/typebox": "^0.34.0"
  }
}
```

## License

MIT
