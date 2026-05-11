# pi-toolkit

**Common [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extensions: image generation, web search, image understanding.**

A drop-in package adding three commonly-used external tool integrations to any pi setup. Composes naturally with [`pi-mind`](https://github.com/shog-lab/pi-mind/tree/main/packages/memory) (memory) and [`pi-chrome`](https://github.com/shog-lab/pi-mind/tree/main/packages/chrome) (browser).

## Extensions

| Extension | Tool | Backend | Required env |
|---|---|---|---|
| `jimeng` | `jimeng_generate` | Volcengine Jimeng T2I API | `JIMENG_ACCESS_KEY`, `JIMENG_SECRET_KEY` |
| `web_search` | `web_search` | mmx CLI | (mmx config) |
| `understand_image` | `understand_image` | mmx vision CLI | (mmx config) |

Each extension silently skips registration if its required env / CLI is missing — install pi-toolkit even if you only configure some of the keys.

## Install

```bash
npm i -D pi-toolkit
```

`postinstall` symlinks `extensions/*/` into the host repo's `.pi/extensions/`, so pi auto-discovers them on next launch.

## Use

```bash
cd ~/my-repo
pi   # extensions auto-loaded
```

Configure keys (e.g. for jimeng) in your shell:

```bash
export JIMENG_ACCESS_KEY="AKLT..."
export JIMENG_SECRET_KEY="..."
```

Then `pi` will register the `jimeng_generate` tool.

## License

MIT
