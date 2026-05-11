# pi-mind monorepo

This repo houses two independent npm packages that compose into a self-evolving agent platform on top of [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent):

| Package | Published as | Role |
|---|---|---|
| [`packages/memory`](packages/memory/) | `pi-mind` | Persistent memory + self-evolution (episodic / knowledge / graph layers) |
| [`packages/toolkit`](packages/toolkit/) | `pi-toolkit` | Common pi tools — image generation (Jimeng), web search and image understanding (mmx), browser automation (agent-browser) |

Each package versions independently. Compose freely: install only what you need.

## Why monorepo

Both packages share design philosophy (drop-in pi extensions, file-based cross-package coordination) and benefit from shared tooling (TypeScript base config, build pipeline). Keeping them in one repo avoids cross-repo coordination overhead while letting each ship on its own cadence.

## Quickstart

```bash
cd ~/my-repo
npm i -D pi-mind pi-toolkit
pi   # all extensions and skills loaded automatically
```

Or pick one:

```bash
npm i -D pi-mind                # memory + self-evolution only
npm i -D pi-mind pi-toolkit     # plus image gen, web search, image understanding, browser CLI
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
npm run build -w pi-mind          # build memory only
npm test -w pi-mind               # test memory only
npm publish -w pi-toolkit         # publish toolkit only
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
