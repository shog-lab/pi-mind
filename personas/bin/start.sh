#!/usr/bin/env bash
#
# personas/bin/start.sh — launch a persona agent (alice | bob | carol).
#
# Usage:
#   personas/bin/start.sh alice [extra pi args...]
#   personas/bin/start.sh bob   [extra pi args...]
#   personas/bin/start.sh carol [extra pi args...]
#
# What it does:
#   1. Resolves repo root (this script lives at <repo>/personas/bin/start.sh).
#   2. Validates the persona name + that the prompt file exists.
#   3. Sets PI_AGENT_NAME to the persona, but ONLY if the caller hasn't
#      already set it (so an explicit env var wins).
#   4. Invokes `pi` with `--append-system-prompt <persona.md>` so the
#      runtime persona instructions are injected.
#   5. For bob/carol, also enforces `--exclude-tools remember_this,observe`
#      (memory-write tools are Alice-only — the prompt says so, but a weak
#      model may ignore prose; this makes it impossible, not just discouraged).
#   6. Does NOT hardcode a model. Pass `--model ...` after the persona arg
#      (or set PI_MODEL) and pi will use it.
#
# Verified against pi 0.79.0: `pi --append-system-prompt <file>` accepts a
# file path directly (the flag description: "Append text or file contents
# to the system prompt").

set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat >&2 <<EOF
Usage: $0 <alice|bob|carol> [extra pi args...]

Launches pi with the matching persona prompt loaded via
--append-system-prompt. Examples:
  $0 alice
  $0 bob --model openai/gpt-4o-mini -p "what's the test status?"
  $0 carol -p "review commit abcd1234"

Environment:
  PI_AGENT_NAME  Set by this script unless already exported by the caller.
  PI_MODEL       Optional — pi reads its model from --model or its own env.
EOF
  exit 2
fi

PERSONA="$1"
shift

case "$PERSONA" in
  alice|bob|carol) ;;
  *)
    echo "start.sh: unknown persona '$PERSONA' (expected: alice | bob | carol)" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$REPO_ROOT/personas/prompts/$PERSONA.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "start.sh: persona prompt file not found: $PROMPT_FILE" >&2
  echo "         (expected at <repo>/personas/prompts/$PERSONA.md)" >&2
  exit 3
fi

# Set PI_AGENT_NAME only if not already set by the caller.
export PI_AGENT_NAME="${PI_AGENT_NAME:-$PERSONA}"

cd "$REPO_ROOT"

# Build pi arg list. Use an array to keep quoting safe for any prompt path.
PI_ARGS=(--append-system-prompt "$PROMPT_FILE")

case "$PERSONA" in
  bob|carol)
    # HARD constraint: exclude memory-write tools. Centralized on Alice.
    # `recall_memory` (READ) and `agent_send` (report) are intentionally
    # NOT excluded — only the WRITE side is locked down.
    PI_ARGS+=(--exclude-tools remember_this,observe)
    ;;
esac

exec pi "${PI_ARGS[@]}" "$@"