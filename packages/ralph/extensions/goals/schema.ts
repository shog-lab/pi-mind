/**
 * pi-goals Schema — single source of truth for all goal-related types.
 * Used by extension, skills, and CLI.
 */

import { Type, type Static } from "@sinclair/typebox";

// --- Goal State Machine ---

export const GoalState = Type.Union([
  Type.Literal("created"),
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("budget_limited"),
]);

export type GoalState = Static<typeof GoalState>;

// --- Core Types ---

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

export const GoalSchema = Type.Object({
  id: Type.String(),
  state: GoalState,
  objective: Type.String(),                    // user-provided goal text
  branchName: Type.String(),
  cwd: Type.String(),                         // working directory
  prdFile: Type.Optional(Type.String()),      // path to prd.json (if from PRD)
  tokensUsed: Type.Number({ default: 0 }),
  tokenBudget: Type.Optional(Type.Number()),
  maxIterations: Type.Number({ default: 10 }),
  currentIteration: Type.Number({ default: 0 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  // PRD-based mode
  userStories: Type.Optional(Type.Array(UserStorySchema)),
});

export type Goal = Static<typeof GoalSchema>;

export const IterationLogSchema = Type.Object({
  goalId: Type.String(),
  iteration: Type.Number(),
  storyId: Type.Optional(Type.String()),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  executionOutput: Type.Optional(Type.String()),
  verificationResult: Type.Optional(Type.Object({
    passes: Type.Boolean(),
    evidence: Type.Optional(Type.Record(Type.String(), Type.String())),
    incompleteReasons: Type.Optional(Type.Array(Type.String())),
  })),
  changedFiles: Type.Array(Type.String()),
});

export type IterationLog = Static<typeof IterationLogSchema>;

// --- Config ---

// --- Config ---

// Tool allowlists for sub-agents.
// NOTE: Sub-agents run with --no-extensions, so only built-in pi tools are available.
// Do NOT list extension tools here (e.g., spawn_subagent is not available in sub-agents).

export const GoalsConfigSchema = Type.Object({
  defaultMaxIterations: Type.Number({ default: 10 }),
  defaultTokenBudget: Type.Optional(Type.Number()),
  verificationTools: Type.Array(Type.String(), {
    default: ["Bash", "Read", "Grep", "Find"],
    description: "Tools available to verification sub-agent (via --tools flag)"
  }),
  executionTools: Type.Array(Type.String(), {
    default: ["Bash", "Read", "Write", "Edit", "Grep", "Find"],
    description: "Tools available to execution sub-agent (via --tools flag)"
  }),
});

export type GoalsConfig = Static<typeof GoalsConfigSchema>;

export const DEFAULT_CONFIG: GoalsConfig = {
  defaultMaxIterations: 10,
  defaultTokenBudget: undefined,
  verificationTools: ["Bash", "Read", "Grep", "Find"],
  executionTools: ["Bash", "Read", "Write", "Edit", "Grep", "Find"],
};

// --- PRD.json structure (from Ralph) ---

export const PRDDBSchema = Type.Object({
  project: Type.String(),
  branchName: Type.String(),
  description: Type.String(),
  userStories: Type.Array(UserStorySchema),
});

export type PRDDBSchema = Static<typeof PRDDBSchema>;
