# pi-mind monorepo

This repo houses three independent npm packages that compose to form a self-evolving agent platform on top of [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent):

| Package | Published as | Role |
|---|---|---|
| [`packages/memory`](packages/memory/) | `pi-mind` | Persistent memory + self-evolution (episodic / knowledge / graph layers) |
| [`packages/toolkit`](packages/toolkit/) | `pi-toolkit` | Common pi tools — image generation, web search, image understanding |
| [`packages/chrome`](packages/chrome/) | `pi-chrome` | Chrome browser runtime — black-box testing, scraping, authenticated tasks |

Each package versions independently. Compose freely: install only what you need.

## Why monorepo

These three packages share design philosophy (drop-in pi extensions, RxJS-friendly composition, file-based cross-package coordination) and benefit from shared tooling (TypeScript base config, lint, test harness). Keeping them in one repo avoids cross-repo coordination overhead while letting each ship on its own cadence.

## Quickstart (combined)

```bash
cd ~/my-repo
npm i -D pi-mind pi-toolkit pi-chrome
pi   # all extensions and skills loaded automatically
```

Or pick one:

```bash
npm i -D pi-mind                # memory + self-evolution only
npm i -D pi-mind pi-toolkit     # plus jimeng / web_search / understand_image
```

See each package's README for details.

## Develop

```bash
git clone https://github.com/shog-lab/pi-mind.git
cd pi-mind
npm install                # installs all workspace deps
npm run build              # compiles all packages
npm test                   # runs all tests
```

Per-package work:

```bash
npm run build -w pi-mind          # build memory only
npm test -w pi-toolkit            # test toolkit only
npm publish -w pi-chrome          # publish chrome only
```

## License

MIT
