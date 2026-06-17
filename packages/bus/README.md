# @shog-lab/pi-bus

**Atomic inter-pi messaging primitive.** Any pi window in the same git repo auto-joins. 3 tools. Incoming messages auto-trigger the recipient's agent — even when it's idle.

## What it gives you

- **Zero-config join.** Open pi, you're on the bus. Close pi, you leave. No flags, no env vars.
- **Per-repo scope.** Auto-discovers the main repo via `git rev-parse --git-common-dir`, so sessions in different repos don't see each other.
- **Push delivery.** When another agent sends you a message, your pi receives it as a user turn (via `pi.sendUserMessage(..., { deliverAs: "followUp" })`) — your agent starts working without you typing anything.
- **Fire-and-forget.** No request/response protocol, no hops counter, no routing. If you want a reply, ask the recipient to call `agent_send` back.

## Install

Pi-native install (recommended for pi users):

```bash
pi install npm:@shog-lab/pi-bus
```

Node/npm install (works well inside existing Node repos):

```bash
npm i -D @shog-lab/pi-bus
```

`postinstall` symlinks `dist/extensions/bus/` into the host repo's `.pi/extensions/` and packaged skills into `.pi/skills/`, so pi auto-discovers them on next launch.

### pnpm projects

pnpm may skip dependency lifecycle scripts unless the package is approved for builds (for example via `pnpm approve-builds` / `onlyBuiltDependencies`). If `.pi/extensions/bus` was not created after install, run the init command manually from your repo root:

```bash
INIT_CWD="$PWD" pnpm exec pi-bus-init
```

Fallback if `pnpm exec` cannot resolve the bin:

```bash
INIT_CWD="$PWD" node node_modules/@shog-lab/pi-bus/bin/init.js
```

## Use

Three tools the LLM can call:

| Tool | Purpose |
|---|---|
| `agent_list` | Who else is live on this repo's bus right now |
| `agent_send <to> <body>` | Drop a message into another session's inbox |
| `agent_inbox [--consume]` | Read your own inbox (mostly unnecessary — see below) |

Open two terminals in the same git repo:

```bash
# Terminal 1
$ pi
[pi-bus] joined as "calm-fox-abc" (id=1234-7e1f…)
> ...

# Terminal 2
$ pi
[pi-bus] joined as "swift-owl-x2k" (id=5678-q3wa…)
> hey, ask calm-fox to write tests for src/auth.ts
[agent calls agent_list → sees calm-fox-abc]
[agent calls agent_send to=calm-fox-abc body="please write tests for src/auth.ts"]
Sent msg-1234-abc to calm-fox-abc (40 chars)
```

Then in Terminal 1, your agent (which was idle) will receive a message that appears as if you typed:

```
> [from swift-owl-x2k] please write tests for src/auth.ts
[agent starts reading src/auth.ts, writes tests, commits]
```

That's it. No coordination layer, no PM agent, no orchestration. Just: any pi can hand work off to any other live pi.

## Identity

Each session gets an auto-generated friendly name like `calm-fox-abc`. Override with the `PI_AGENT_NAME` env var:

```bash
PI_AGENT_NAME=developer pi
```

Same `PI_AGENT_NAME` from two terminals is technically allowed but `agent_send` to that name will fail ambiguously — assign unique names if you set them manually.

## Scoping

All sessions in the same git repo share one bus. Resolved via `git rev-parse --git-common-dir` (see `@shog-lab/pi-utils`), so worktrees of the same repo share a bus too.

Outside a git repo, falls back to `<cwd>/.pi-mind/bus/`. Two unrelated dirs = two independent buses.

Override with `PI_MIND_DIR` env if you want bus state somewhere specific.

## Delivery semantics

Incoming messages are injected via `pi.sendUserMessage(text, { deliverAs: "followUp" })`:

- **If pi is idle:** triggers a turn immediately
- **If pi is mid-stream:** queues until current tool calls finish, then injects
- **If real user is mid-conversation:** waits until agent fully idle before injecting (does NOT interrupt typing)

The recipient agent sees the message prefixed `[from <sender>]`. It can:
- Respond by calling `agent_send` back
- Take action (read code, run tests, etc.)
- Ignore it (just continue with its own work — the message is in chat history but no obligation)

## What's NOT included (deliberate)

- ❌ Request/response protocol — fire-and-forget only; reply = sender does another `agent_send`
- ❌ Broadcast tool — use `agent_list` + loop yourself
- ❌ Channels / topics / namespaces — one bus per repo, that's it
- ❌ Permissions / ACL — any agent on the bus can message any other
- ❌ Message persistence — inbox messages are deleted after delivery
- ❌ Cross-host messaging — bus is per-machine. If you need this, look at [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)'s `coms-net.ts`
- ❌ Roles / orchestration / PM agent — those are patterns you build ON TOP using these 3 atoms

## Composing with roles

The package includes a `build-personas` skill for scaffolding repo-local personas that coordinate through pi-bus. Use it when you want a planner / implementer / reviewer setup with prompts, launchers, permission policy, and a verification flow:

```text
/skill:build-personas
```

Or ask your agent: "Build repo-local personas for this project using pi-bus."

For a minimal manual setup, combine with pi's `--append-system-prompt <file>` (which accepts a file path) to spin up role-specific terminals:

```bash
# ~/.zshrc
alias pi-dev='pi --append-system-prompt ~/.pi/roles/developer.md'
alias pi-test='pi --append-system-prompt ~/.pi/roles/tester.md'
alias pi-growth='pi --append-system-prompt ~/.pi/roles/growth.md'
```

Then:
- Terminal 1: `pi-dev` → joins bus as e.g. `quiet-deer-xyz`, developer persona
- Terminal 2: `pi-test` → joins bus as e.g. `swift-owl-q3w`, tester persona
- They can `agent_send` each other for handoffs

The bus doesn't know about "roles" — they're just system prompts. Bus only sees opaque agent names.

## Avoiding ping-pong loops

If two agents auto-reply to each other on every incoming message, you get an infinite loop. Mitigations:

1. **System prompt discipline** — instruct agents "only respond to other-agent messages when a reply is genuinely needed; don't acknowledge for politeness"
2. **Don't auto-call agent_send in response to a `[from X]` message** unless the recipient explicitly asked a question
3. **Watch for it manually** — bus has no hops counter; you're trusted not to spam

## File layout

```
<repo>/.pi-mind/bus/sessions/<session-id>/
├── meta.json                    name, pid, cwd, joinedAt, heartbeatAt
└── inbox/
    └── <msg-id>.json            from, body, sentAt
```

Heartbeat updates every 30s. Sessions whose `heartbeatAt` is older than 90s are filtered out of `agent_list` and `agent_send` lookups (stale-detect for crashed pis).

On clean shutdown (SIGINT / SIGTERM / exit), pi-bus removes its session directory. Stale dirs from crashed pis are filtered (not actively cleaned — they sit in the registry until manually removed or the registry is wiped).

## License

MIT
