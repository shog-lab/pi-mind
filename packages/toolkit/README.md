# @shoglab/pi-toolkit

**Common [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extensions and CLI tools — plus an MCP server bridge.**

A drop-in package adding several commonly-used external tool integrations to any pi setup. Composes naturally with [`pi-mind`](https://github.com/shog-lab/pi-mind/tree/main/packages/memory) (memory).

## Extensions

| Extension | Tool name(s) | Backend | Required env |
|---|---|---|---|
| `jimeng` | `jimeng_generate` | Volcengine Jimeng T2I API | `JIMENG_ACCESS_KEY`, `JIMENG_SECRET_KEY` |
| `web_search` | `web_search` | mmx CLI | (mmx config) |
| `understand_image` | `understand_image` | mmx vision CLI | (mmx config) |
| `mcp-bridge` | `<server>_<tool>` per MCP server | Any MCP server | `mcp-servers.json` config |
| `subagent` | `spawn_subagent` | child pi process | (none) |

Each extension silently skips registration if its required env / config is missing — install pi-toolkit even if you only use some.

Plus `agent-browser` CLI is shipped as a dependency. Its SKILL.md is symlinked from upstream so the agent knows how to use it via Bash.

## Install

```bash
npm i -D @shoglab/pi-toolkit
```

`postinstall` symlinks `extensions/*/` into the host repo's `.pi/extensions/`, so pi auto-discovers them on next launch.

## Configure

### Jimeng (image generation)

```bash
export JIMENG_ACCESS_KEY="AKLT..."
export JIMENG_SECRET_KEY="..."
```

### MCP servers (figma, filesystem, etc.)

Create `mcp-servers.json` (or `.pi/mcp-servers.json`) at the host repo root:

```json
{
  "figma": {
    "command": "npx",
    "args": ["-y", "figma-developer-mcp", "--stdio"],
    "env": { "FIGMA_API_KEY": "your-key" }
  },
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/expose"]
  }
}
```

On next `pi` launch, `mcp-bridge`:
1. Spawns each declared server as a child process
2. Runs the MCP `initialize` handshake
3. Calls `tools/list` to discover tools
4. Registers each as a pi tool, prefixed with the server name: `figma_get_node`, `filesystem_read_file`, etc.

Failures (server not installed, bad config, missing env) log a warning and skip that server — they don't crash pi or other tools.

Find more MCP servers at <https://github.com/modelcontextprotocol/servers>.

## Use

```bash
cd ~/my-repo
pi   # all configured extensions/tools auto-loaded
```

## License

MIT
