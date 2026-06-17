# @shog-lab/pi-toolkit

**Common [pi](https://github.com/earendil-works/pi) extensions — web search, MCP bridge, and OS-scheduled bus triggers.**

A drop-in package adding several commonly-used external tool integrations to any pi setup. Composes naturally with [`pi-mind`](https://github.com/shog-lab/pi-mind/tree/main/packages/memory) (memory) and [`pi-bus`](https://github.com/shog-lab/pi-mind/tree/main/packages/bus) (multi-agent messaging).

## Extensions

| Extension (dir) | Tool name(s) | Backend | Required env |
|---|---|---|---|
| `web-search` | `web_search` | mmx CLI | (mmx config) |
| `mcp-bridge` | `<server>_<tool>` per MCP server | Any MCP server | `mcp-servers.json` config |
| `cron` | `schedule_cron`, `list_cron`, `remove_cron` | macOS launchd + pi-bus inbox | live bus target agent |

> **0.4.0 removed `understand-image`.** Modern models increasingly support native
> vision (e.g. MiniMax-M3), so a separate mmx-backed image-understanding tool is no
> longer worth the dependency. If your model has native vision, pass images directly;
> otherwise add a vision tool yourself.
>
> **0.3.0 removed `subagent`.** It lived here for historical reasons but is conceptually
> infrastructure (child-process spawning), not a tool. Extracted to its own package:
> `npm i -D @shog-lab/pi-subagent`. The tool name (`spawn_subagent`) is unchanged.

Dir names are kebab-case (matching the convention used by `pi-mind`'s extensions and skills). Tool names stay `snake_case` so the LLM-facing surface is stable across this rename.

`mcp-bridge` silently skips registration when no `mcp-servers.json` exists, so install pi-toolkit even if you only use some extensions.

Plus `agent-browser` CLI is shipped as a dependency. Its SKILL.md is symlinked from upstream so the agent knows how to use it via Bash.

## Install

Pi-native install (recommended for pi users):

```bash
pi install npm:@shog-lab/pi-toolkit
```

Node/npm install (works well inside existing Node repos):

```bash
npm i -D @shog-lab/pi-toolkit
```

`postinstall` symlinks `extensions/*/` into the host repo's `.pi/extensions/`, so pi auto-discovers them on next launch.

## Configure

### Cron scheduling

The `cron` extension registers OS-scheduled tasks that deliver messages to the current `PI_AGENT_NAME` through `pi-bus`. The first `schedule_cron` call only asks for confirmation; call again with `confirm=true` after the user approves.

Example use in pi:

```text
Schedule a weekday 9am reminder to Alice to run the memory audit.
```

The extension stores job metadata under `.pi-mind/cron/jobs.json` and creates macOS launchd plists under `~/Library/LaunchAgents/`. If the target agent is offline when the schedule fires, the trigger exits successfully and drops the message.

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
