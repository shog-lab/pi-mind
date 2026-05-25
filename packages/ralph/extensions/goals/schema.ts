/**
 * pi-goals schema — minimal types for the simplified Ralph loop.
 *
 * State of a goal lives entirely in its prd.json file (story.passes flips
 * true→false). No DB, no state machine — the file IS the state.
 */

import { Type, type Static } from "@sinclair/typebox";

// --- PRD types (user-authored, file-based) ---

export const UserStorySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  acceptanceCriteria: Type.Array(Type.String()),
  priority: Type.Number(),
  passes: Type.Boolean({ default: false }),
  notes: Type.String({ default: "" }),
});

export type UserStory = Static<typeof UserStorySchema>;

export const PRDSchema = Type.Object({
  project: Type.String(),
  branchName: Type.String(),
  description: Type.String(),
  userStories: Type.Array(UserStorySchema),
});

export type PRD = Static<typeof PRDSchema>;

// --- Verification contract (sub-agent output) ---

/**
 * Shape the verification sub-agent MUST return as JSON in its final message.
 * Anything failing this schema is treated as a verification failure with a
 * parse-error reason — sub-agent can't squeeze malformed output past us
 * (e.g. `{"passes": "yes"}` → was truthy → falsely "passed").
 */
export const VerificationResultSchema = Type.Object({
  passes: Type.Boolean(),
  evidence: Type.Optional(Type.Record(Type.String(), Type.String())),
  incompleteReasons: Type.Optional(Type.Array(Type.String())),
});

export type VerificationResult = Static<typeof VerificationResultSchema>;

// --- Tool allowlists for sub-agents ---
//
// Sub-agents run with --no-extensions; only built-in pi tools are reachable.
// Names are lowercase to match pi's tool registry (pi's --tools flag is case-
// sensitive: "Bash" does NOT match the built-in "bash").
// grep/find aren't standalone tools — agents reach them via bash.

export const EXECUTION_TOOLS = ["bash", "read", "write", "edit"] as const;
export const VERIFICATION_TOOLS = ["bash", "read"] as const;

export const DEFAULT_MAX_ITERATIONS = 10;
