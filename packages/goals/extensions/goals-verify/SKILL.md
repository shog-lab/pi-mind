---
name: goals-verify
description: Restricted tool set for verification sub-agents — Read, Bash, Grep, Find only. No write/edit.
---

# Goals Verification Extension

This extension provides a restricted tool set for verification sub-agents. It is injected into sub-agents spawned for verification tasks only (not execution tasks).

## Allowed Tools

- `Bash` — run tests, typecheck, git status
- `Read` — read source files to verify implementation
- `Grep` / `Find` — search code for patterns
- `understand_image` — verify UI screenshots
- `agent-browser` — verify in-browser behavior

## Disallowed Tools

- `Write` / `Edit` — verification should NOT modify code
- `spawn_subagent` — no nested sub-agents
- Memory tools

## Usage

This extension is not registered by default. It is injected via `--append-system-prompt` when spawning verification sub-agents in `lib/loop.ts`.