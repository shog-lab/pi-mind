/**
 * pi-goals Extension — registers /goal command and goal management tools.
 * 
 * Provides:
 *   - /goal command: start a goal loop (Ralph-style with PRD)
 *   - update_goal: mark goal complete / pause / resume
 *   - list_goals: show all goals
 *   - get_goal: show goal status
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalStore, resolveGoalsDir } from "./store.js";
import { GoalSchema, GoalState, PRDDBSchema, DEFAULT_CONFIG, type GoalsConfig } from "./schema.js";
import { runGoalLoop, type LoopResult } from "./loop.js";
import { withGroupLock } from "./mutex.js";

// --- Tool parameter types ---

const GoalParams = Type.Object({
  objective: Type.Optional(Type.String({ description: "Goal description (if not using --from)" })),
  from: Type.Optional(Type.String({ description: "Path to prd.json file" })),
  branch: Type.Optional(Type.String({ description: "Git branch name (default: ralph/<slug>)" })),
  maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 10)" })),
  tokenBudget: Type.Optional(Type.Number({ description: "Token budget for this goal" })),
});

const UpdateGoalParams = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal("complete"),
    Type.Literal("pause"),
    Type.Literal("resume"),
  ]),
  reason: Type.Optional(Type.String()),
});

const GetGoalParams = Type.Object({
  id: Type.String(),
});

const ListGoalsParams = Type.Object({});

const EmptyParams = Type.Object({});

// --- Helpers ---

function generateGoalId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function resolvePRD(prdPath: string): { userStories: Static<typeof PRDDBSchema>["userStories"]; branchName: string; project: string } | null {
  if (!existsSync(prdPath)) {
    return null;
  }
  try {
    const raw = readFileSync(prdPath, "utf-8");
    const prd = JSON.parse(raw);
    return {
      userStories: prd.userStories,
      branchName: prd.branchName,
      project: prd.project,
    };
  } catch {
    return null;
  }
}

// --- Extension ---

export default function goalsExtension(pi: ExtensionAPI) {
  const store = new GoalStore();
  const config: GoalsConfig = store.loadConfig();

  // --- /goal command ---
  // User types: /goal "实现用户登录功能" or /goal --from prd.json

  pi.registerTool({
    name: "goal",
    label: "Start Goal (Ralph)",
    description:
      "Start a Ralph-style autonomous goal loop. " +
      "Provide either --objective or --from prd.json. " +
      "The loop executes stories in priority order with isolated verification. " +
      "Use /goal pause to pause, /goal resume to resume. " +
      "Requires: pi-mind installed as peer dependency.",
    parameters: GoalParams,
    async execute(_toolCallId: string, params: Static<typeof GoalParams>) {
      const {
        objective,
        from: prdPath,
        branch: branchName,
        maxIterations,
        tokenBudget,
      } = params;

      if (!objective && !prdPath) {
        return {
          content: [{ type: "text" as const, text: "Error: Provide --objective or --from <prd.json>" }],
          details: {},
          isError: true,
        };
      }

      const cwd = process.cwd();
      const goalId = generateGoalId();

      // --- Resolve PRD if provided ---
      let userStories: Static<typeof GoalSchema>["userStories"] = undefined;
      let resolvedBranchName = branchName || "ralph/default";

      if (prdPath) {
        const prd = resolvePRD(prdPath);
        if (!prd) {
          return {
            content: [{ type: "text" as const, text: `Error: Cannot read prd.json at ${prdPath}` }],
            details: {},
            isError: true,
          };
        }
        userStories = prd.userStories.map((s: { id: string; title: string; description: string; acceptanceCriteria: string[]; priority: number; passes: boolean; notes: string }) => ({
          ...s,
          passes: false,
        }));
        resolvedBranchName = prd.branchName;
      } else if (objective) {
        // No PRD — create a single story from the objective
        const storyId = `US-${Date.now().toString(36).toUpperCase()}`;
        userStories = [{
          id: storyId,
          title: objective.slice(0, 80),
          description: objective,
          acceptanceCriteria: [
            "Implementation completes without errors",
            "Quality checks pass (typecheck, tests)",
          ],
          priority: 1,
          passes: false,
          notes: "",
        }];
        resolvedBranchName = branchName || `ralph/${slugify(objective)}`;
      }

      const goal: Static<typeof GoalSchema> = {
        id: goalId,
        state: "created",
        objective: objective || `PRD: ${prdPath}`,
        branchName: resolvedBranchName,
        cwd,
        prdFile: prdPath || undefined,
        tokensUsed: 0,
        tokenBudget: tokenBudget || config.defaultTokenBudget,
        maxIterations: maxIterations || config.defaultMaxIterations,
        currentIteration: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories,
      };

      // Save to store
      await withGroupLock(cwd, async () => {
        store.createGoal(goal);
      });

      // Run the loop
      const result = await runGoalLoop(goal, store, config);

      // Build output
      const lines = [
        `## Goal ${result.completed ? "Completed" : "Ended"}: ${goal.objective}`,
        `Iterations: ${result.iterationsRun}`,
        `Final state: ${result.finalState}`,
      ];

      if (result.reason) {
        lines.push(`Reason: ${result.reason}`);
      }

      if (goal.userStories) {
        lines.push("\n### Stories");
        for (const story of goal.userStories) {
          lines.push(`- ${story.id}: ${story.title} — ${story.passes ? "PASSED" : "FAILED"}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { ...result },
      };
    },
  });

  // --- update_goal tool ---

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal Status",
    description:
      "Update a goal's status: complete (mark done), pause (suspend loop), resume (continue). " +
      "Called by the goal loop itself or by user to manually control goal state.",
    parameters: UpdateGoalParams,
    async execute(_toolCallId: string, params: Static<typeof UpdateGoalParams>) {
      const { id, status, reason } = params;
      const goal = store.getGoal(id);

      if (!goal) {
        return {
          content: [{ type: "text" as const, text: `Error: Goal ${id} not found` }],
          details: {},
          isError: true,
        };
      }

      let newState: GoalState;
      switch (status) {
        case "complete":
          newState = "completed";
          break;
        case "pause":
          newState = "paused";
          break;
        case "resume":
          newState = "active";
          break;
      }

      store.transitionTo(id, newState);

      return {
        content: [{ type: "text" as const, text: `Goal ${id} transitioned to ${newState}${reason ? ` (${reason})` : ""}` }],
        details: {},
      };
    },
  });

  // --- list_goals tool ---

  pi.registerTool({
    name: "list_goals",
    label: "List Goals",
    description: "List all goals in the current PI_GOALS_DIR.",
    parameters: ListGoalsParams,
    async execute(_toolCallId: string, _params: Static<typeof ListGoalsParams>) {
      const goalsDir = resolveGoalsDir();
      return {
        content: [{ type: "text" as const, text: `Goals directory: ${goalsDir}\nUse get_goal to see details.` }],
        details: {},
      };
    },
  });

  // --- get_goal tool ---

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal Status",
    description: "Get detailed status of a specific goal.",
    parameters: GetGoalParams,
    async execute(_toolCallId: string, params: Static<typeof GetGoalParams>) {
      const goal = store.getGoal(params.id);

      if (!goal) {
        return {
          content: [{ type: "text" as const, text: `Goal ${params.id} not found` }],
          details: {},
          isError: true,
        };
      }

      const lines = [
        `## Goal: ${goal.objective}`,
        `ID: ${goal.id}`,
        `State: ${goal.state}`,
        `Branch: ${goal.branchName}`,
        `Iterations: ${goal.currentIteration}/${goal.maxIterations}`,
      ];

      if (goal.userStories) {
        lines.push("\n### Stories");
        for (const story of goal.userStories) {
          lines.push(`- ${story.id}: ${story.title} — ${story.passes ? "PASSED" : "FAILED"}`);
        }
      }

      const iterations = store.getIterations(goal.id);
      if (iterations.length > 0) {
        lines.push(`\n### Iterations (${iterations.length})`);
        for (const iter of iterations) {
          lines.push(`- ${iter.iteration}: ${iter.storyId || "no story"} — ${iter.verificationResult?.passes ? "PASSED" : "FAILED"}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { goal } as unknown as { goal?: never },
      };
    },
  });
}
