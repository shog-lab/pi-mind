# pi-mind monorepo

Self-evolving agent platform built on top of [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent). All packages publish under the `@shog-lab` scope.

## Packages

### [`@shog-lab/pi-mind-core`](packages/core/) — the core
Persistent memory + self-evolution. Three-layer model: **raw/** (event stream), **knowledge/** (compiled facts as markdown), **graph/** (entity-relationship triples). FTS5 + vector + KG retrieval. Daily-audit loop, subject classification, schema linting.

### [`@shog-lab/pi-toolkit`](packages/toolkit/) — agent-facing tools
Drop-in extensions the LLM calls at runtime: **web_search** + **understand_image** (via mmx CLI — fill MiniMax's missing search/vision capabilities), **mcp-bridge** (proxy any MCP server as pi tools), **subagent** (spawn focused child pi processes).

### [`@shog-lab/pi-goals`](packages/ralph/) — autonomous goal loop
Ralph-style execution: pick story → execution sub-agent → isolated verification sub-agent → repeat. State lives in `prd.json` (no DB). Per-PRD git-worktree isolation (`<repo>/.ralph-worktrees/<key>/`). Single `goal` tool. Resume = re-run same command. Real token reporting per iteration.

### [`@shog-lab/pi-utils`](packages/utils/) — internal infrastructure
Shared by the above: `spawnPi()` (programmatic pi spawn with `--mode json` + token extraction) and `resolvePiMindDir()` (repo-rooted `.pi-mind` path that survives git worktree teardown). Not loaded as a pi extension.

### [`@shog-lab/pi-eval`](packages/eval/) — evaluation harness (private)
Runs pi-mind against [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and scores with the benchmark's official 5-prompt methodology (verbatim port). Outputs `hypothesis.jsonl` compatible with the upstream Python evaluator. Private workspace until methodology is stable enough for public claims.

## Quickstart

```bash
cd ~/my-repo
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-toolkit
pi   # extensions + skills auto-loaded
```

Pick what you need:

```bash
npm i -D @shog-lab/pi-mind-core                            # memory + self-evolution only
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-toolkit       # + image gen, web search, MCP bridge, sub-agent
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-goals         # + ralph (autonomous goal loop)
```

See each package's README for details.

## Develop

```bash
git clone https://github.com/shog-lab/pi-mind.git
cd pi-mind
npm install   # installs all workspaces + runs each postinstall → .pi/ symlinks
npm run build
npm test      # 162 tests across all packages
```

Per-package:

```bash
npm run build -w @shog-lab/pi-mind-core      # build memory only
npm test -w @shog-lab/pi-toolkit             # test toolkit only
npm publish -w @shog-lab/pi-utils            # publish utils only
```

## Dogfooding pi-mind in this repo

The monorepo's own `.pi/extensions/` is symlinked into `packages/*/dist/` via each postinstall. Running `pi` here loads memory, toolkit, ralph — letting the agent work on its own codebase.

```bash
npx tsc -w -p packages/core   # watch + rebuild memory; pi picks up dist/ changes on next invocation
```

## History

`packages/chrome` (a Chrome runtime built on `agent-browser` + RxJS) lived here briefly during a hedge into deeper browser automation. It was removed in favor of the simpler `pi-toolkit` approach: ship `agent-browser` CLI as a dependency and let the agent compose via Bash. The git history retains the work for reference.

## License

MIT
