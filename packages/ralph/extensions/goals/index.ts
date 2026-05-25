/**
 * pi-goals extension — registers the `goal` tool.
 *
 * Just one tool. State lives in prd.json; inspect with `cat prd.json` or
 * `ls .ralph-worktrees/`. Pause via ctrl+C, resume by re-running /goal with
 * the same --from path.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGoalLoop } from "./loop.js";

const GoalParams = Type.Object({
  from: Type.String({ description: "Path to prd.json file (required)" }),
  branch: Type.Optional(Type.String({ description: "Override PRD's branchName" })),
  maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 10)" })),
});

export default function goalsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "goal",
    label: "Run Goal (Ralph)",
    description:
      "Run a Ralph-style autonomous goal loop against a prd.json file. " +
      "Each iteration picks the next story with passes:false, spawns an " +
      "execution sub-agent then an isolated verification sub-agent, and " +
      "flips passes:true on success. " +
      "Each goal gets a dedicated git worktree at <repo>/.ralph-worktrees/ " +
      "— the user's main checkout is never touched. " +
      "Re-running with the same --from resumes from prd.json's current state.",
    parameters: GoalParams,
    async execute(_toolCallId: string, params: Static<typeof GoalParams>) {
      const result = await runGoalLoop({
        prdPath: params.from,
        cwd: process.cwd(),
        branchName: params.branch,
        maxIterations: params.maxIterations,
      });

      const lines = [
        `## Goal ${result.completed ? "Completed" : "Halted"}`,
        `Iterations: ${result.iterationsRun}`,
        `Tokens: ${result.totalTokens.totalTokens} ($${result.totalTokens.costUsd.toFixed(4)})`,
      ];
      if (result.reason) lines.push(`Reason: ${result.reason}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { ...result },
      };
    },
  });
}
