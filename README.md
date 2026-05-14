# pi-mind monorepo

Self-evolving agent platform on top of [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent). All packages publish under the `@shog-lab` scope.

| Directory | npm name | Role |
|---|---|---|
| [`packages/memory`](packages/memory/) | `@shog-lab/pi-mind-core` | Persistent memory + self-evolution (raw / knowledge / graph layers). The core of pi-mind. |
| [`packages/utils`](packages/utils/) | `@shog-lab/pi-utils` | Internal infrastructure (spawnPi, .pi-mind path resolution). Used by memory / ralph / eval. |
| [`packages/toolkit`](packages/toolkit/) | `@shog-lab/pi-toolkit` | Agent-facing tools — image generation (Jimeng), web search, image understanding (mmx), MCP bridge, sub-agent spawn |
| [`packages/ralph`](packages/ralph/) | `@shog-lab/pi-goals` | Ralph-style autonomous goal execution loop with self-verification |
| [`packages/eval`](packages/eval/) | `@shog-lab/pi-eval` | LongMemEval evaluation harness (private workspace) |

Each package versions independently. Compose freely: install only what you need.

## Why monorepo

All packages share design philosophy (drop-in pi extensions, file-based cross-package coordination) and benefit from shared tooling (TypeScript base config, build pipeline). Keeping them in one repo avoids cross-repo coordination overhead while letting each ship on its own cadence.

## Quickstart

```bash
cd ~/my-repo
npm i -D @shog-lab/pi-mind-core @shog-lab/pi-toolkit
pi   # all extensions and skills loaded automatically
```

Or pick one:

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
npm install                # installs all workspace deps + builds dist/
npm run build              # rebuild all packages
npm test                   # run all tests
```

Per-package work:

```bash
npm run build -w @shog-lab/pi-mind-core      # build memory only
npm test -w @shog-lab/pi-mind-core           # test memory only
npm publish -w @shog-lab/pi-toolkit          # publish toolkit only
```

## Dogfooding pi-mind in this repo

```bash
npm install     # postinstall sets up .pi/ symlinks pointing into packages/*/dist/
pi              # the agent loads memory, browser CLI, jimeng, etc., from this monorepo
```

Watch mode for active development on a single package:

```bash
npx tsc -w -p packages/memory     # rebuild memory's dist/ on every .ts edit
# pi picks up changes on next invocation (dist/ is what gets symlinked)
```

## History

`packages/chrome` (a Chrome runtime built on `agent-browser` + RxJS) lived here briefly during a hedge into deeper browser automation. It was removed in favor of the simpler `pi-toolkit` approach: ship `agent-browser` CLI as a dependency and let the agent compose via Bash. The git history retains the work for reference.

## License

MIT
