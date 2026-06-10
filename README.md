# pi-mind

**Give your coding agent a memory that survives across sessions — inspectable as plain markdown in your repo.**

> v0.14.2 · 345 tests passing · dogfooded on this repo · MIT

A monorepo of capability packages for [pi](https://github.com/earendil-works/pi) (the coding-agent runtime). pi-mind turns any repo into a persistent, inspectable knowledge store: the agent writes memories as markdown files with YAML frontmatter, retrieves them by relevance, and never changes future behavior without explicit user approval; memory writes happen as visible explicit tool calls.

## What you get

- **Persistent, inspectable memory.** Knowledge is just `.pi-mind/knowledge/*.md` files with frontmatter. `git diff` shows what your agent remembered. No opaque vector store you can't read.
- **Hybrid retrieval.** FTS5 keyword search + vector similarity (Ollama `nomic-embed-text`) + a SQLite-backed knowledge graph (entities and triples), merged per turn. The agent only sees what's relevant to the current task.
- **Passive by design.** No background curator, no autonomous LLM loops writing on your behalf. Every `remember_this` and `observe` is an explicit tool call in a visible turn. Memory-audit flags issues; humans fix them.
- **Ask-first skill authoring.** Agent proposes new skills with `create_skill`; you approve before the file is written. Skills change future behavior, so the agent proposes and you decide.
- **No required daemon.** Pure Node + SQLite. Ollama is optional for vector search; FTS5 keyword search works without it. No cron jobs required (an optional cron snippet is documented for scheduled audit).

## 30-second demo

```text
# Session 1
$ cd ~/my-repo && pi
pi> remember this: I prefer ripgrep over grep for code search
pi> /exit

# Session 2 (any day, same repo checkout — the agent reads from .pi-mind/)
$ cd ~/my-repo && pi
pi> what search tool do I prefer?
→ "ripgrep — see .pi-mind/knowledge/<date>-…md"
```

The "memory" is the same `.md` file you can `cat`, `grep`, and commit. No magic, no cloud lock-in.

## Quickstart

```bash
# 1. Install the pi runtime (one-time, global). GitHub: github.com/earendil-works/pi.
npm i -g @earendil-works/pi-coding-agent

# 2. Add memory + ask-first skills to your repo
cd ~/my-repo
npm i -D @shog-lab/pi-memory
```

Using pnpm? pnpm may skip dependency lifecycle scripts unless builds are approved. If `.pi/` or `.pi-mind/` was not created after install, run from your repo root:

```bash
INIT_CWD="$PWD" pnpm exec pi-mind-init
# if you also installed @shog-lab/pi-bus:
INIT_CWD="$PWD" pnpm exec pi-bus-init
```

Fallback:

```bash
INIT_CWD="$PWD" node node_modules/@shog-lab/pi-memory/bin/init.js
# if you also installed @shog-lab/pi-bus:
INIT_CWD="$PWD" node node_modules/@shog-lab/pi-bus/bin/init.js
```

Verify the loop:

```bash
# Launch pi, ask it to remember something, exit
pi
> remember this: I prefer ripgrep over grep
> /exit

# Relaunch and ask it back — same answer, no re-prompting
pi
> what search tool do I prefer?
```

## What's in this monorepo

**Main package — install this for the headline features:**

- [`@shog-lab/pi-memory`](packages/memory/) — persistent memory (FTS5 + vector + KG) and ask-first skill authoring. The one most users want.

**Optional add-ons (compose with core, install only what you need):**

- [`@shog-lab/pi-toolkit`](packages/toolkit/) — drop-in LLM tools: web search and an MCP server bridge.
- [`@shog-lab/pi-subagent`](packages/subagent/) — spawn focused child pi for scoped subtasks with a clean context.
- [`@shog-lab/pi-bus`](packages/bus/) — inter-pi messaging: open multiple `pi` windows on the same repo, they auto-join a shared bus.

**Internal (don't install directly):**

- [`@shog-lab/pi-utils`](packages/utils/) — shared helpers (process spawn, git-aware path resolution) depended on by the other packages.

Each package has its own README with install + usage details. All publish under the `@shog-lab` scope.

## Develop

```bash
git clone https://github.com/shog-lab/pi-mind.git
cd pi-mind
npm install   # installs all workspaces + postinstall → .pi/ symlinks
npm run build
npm test
```

The monorepo dogfoods itself: running `pi` here loads memory + toolkit + bus + subagent on the codebase that built them.

## Design

See [AGENTS.md](AGENTS.md#design-principles) for the human-in-the-loop autonomy principles that govern this monorepo (memory is passive; behavior changes propose-before-they-act; the trigger chain for any state mutation must originate with a user message).

## History

Older autonomous-loop (`pi-goals`) and browser-runtime (`packages/chrome`) packages were removed. Package READMEs and git history carry the migration details.

## License

MIT
