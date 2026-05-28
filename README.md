# pi-mind monorepo

Self-evolving agent platform built on top of [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent). All packages publish under the `@shog-lab` scope.

## Packages

### [`@shog-lab/pi-mind-core`](packages/core/) — the core
Persistent memory + self-evolution. Three-layer model: **raw/** (event stream), **knowledge/** (compiled facts as markdown), **graph/** (entity-relationship triples). FTS5 + vector + KG retrieval. Daily-audit loop, subject classification, schema linting.

### [`@shog-lab/pi-toolkit`](packages/toolkit/) — agent-facing tools
Drop-in extensions the LLM calls at runtime: **web_search** + **understand_image** (via mmx CLI — fill MiniMax's missing search/vision capabilities), **mcp-bridge** (proxy any MCP server as pi tools). _0.3.0 removed `spawn_subagent` — see pi-subagent below._

### [`@shog-lab/pi-subagent`](packages/subagent/) — child-pi spawning primitive
Single `spawn_subagent` tool: agent passes `cwd` + `prompt`, gets back a clean child pi's response. Extracted from pi-toolkit in toolkit 0.3.0 because it's infrastructure (process spawning), not a leaf tool. Useful for scoped sub-tasks that need a fresh agent context.

### [`@shog-lab/pi-bus`](packages/bus/) — inter-pi messaging primitive
Atomic peer-to-peer messaging for pi sessions: open multiple pi windows in the same repo, they auto-join a shared bus. 3 tools (`agent_list` / `agent_send` / `agent_inbox`). Incoming messages auto-trigger the recipient's agent via `pi.sendUserMessage` — even when it's idle waiting for user input. Per-repo scoped, fire-and-forget, no orchestration.

### [`@shog-lab/pi-utils`](packages/utils/) — internal infrastructure
Shared by the above: `spawnPi()` (programmatic pi spawn with `--mode json` + token extraction) and `resolvePiMindDir()` (repo-rooted `.pi-mind` path that survives git worktree teardown). Not loaded as a pi extension.

_(Memory benchmark harness for LongMemEval lives at [`packages/core/eval/`](packages/core/eval/) — folded into pi-mind-core on 2026-05-27 since it's internal dev tooling that only ever measured memory.)_

## Quickstart

```bash
cd ~/my-repo
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-toolkit
pi   # extensions + skills auto-loaded
```

Pick what you need:

```bash
npm i -D @shog-lab/pi-mind-core                                       # memory + self-evolution only
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-toolkit                  # + web search, image, MCP bridge
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-bus @shog-lab/pi-subagent # + inter-pi messaging + child-pi spawning
```

> **Note:** `@shog-lab/pi-goals` (ralph) was deprecated and removed from this monorepo on 2026-05-28. The autonomous-loop pattern it implemented is out of scope for this ecosystem; compose `pi-bus` + `pi-subagent` + `git worktree` for human-in-the-loop alternatives. The package versions remain installable from npm if you depend on the old behavior — pin `@shog-lab/pi-goals@0.5.1`.

See each package's README for details.

## Develop

```bash
git clone https://github.com/shog-lab/pi-mind.git
cd pi-mind
npm install   # installs all workspaces + runs each postinstall → .pi/ symlinks
npm run build
npm test      # 168 tests across all packages (21 + 115 + 6 + 13 + 6 + 4 + 3)
```

Per-package:

```bash
npm run build -w @shog-lab/pi-mind-core      # build memory only
npm test -w @shog-lab/pi-toolkit             # test toolkit only
npm publish -w @shog-lab/pi-utils            # publish utils only
```

## Dogfooding pi-mind in this repo

The monorepo's own `.pi/extensions/` is symlinked into `packages/*/dist/` via each postinstall. Running `pi` here loads memory, toolkit, bus, subagent — letting the agent work on its own codebase.

```bash
npx tsc -w -p packages/core   # watch + rebuild memory; pi picks up dist/ changes on next invocation
```

## History

`packages/chrome` (a Chrome runtime built on `agent-browser` + RxJS) lived here briefly during a hedge into deeper browser automation. It was removed in favor of the simpler `pi-toolkit` approach: ship `agent-browser` CLI as a dependency and let the agent compose via Bash. The git history retains the work for reference.

## License

MIT
