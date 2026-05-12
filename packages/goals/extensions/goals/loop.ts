/**
 * Goal Loop — Ralph-style autonomous execution with self-verification.
 * 
 * Architecture:
 *   Main pi (goals extension) owns state machine
 *   Execution sub-agent: implements the story (full tools)
 *   Verification sub-agent: checks evidence against criteria (restricted tools)
 * 
 * Isolation: Both sub-agents run with --no-extensions and a minimal tool set.
 * The goals extension injects the goal context via --append-system-prompt.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnPi } from "pi-mind/dist/lib/spawn-pi.js";
import { GoalStore, resolveGoalsDir } from "./store.js";
import { Goal, GoalState, UserStory, type GoalsConfig } from "./schema.js";
import { withGroupLock } from "./mutex.js";

// --- Prompt templates ---

const EXECUTION_PROMPT_TEMPLATE = `
You are Ralph, an autonomous coding agent working on a software project.

## Your Task
Pick the highest priority story where \`passes: false\` from the PRD below and implement it.

## Progress Log (learnings from previous iterations)
{progressLog}

## Current Story
{storyJson}

## Quality Requirements
- ALL commits must pass your project's quality checks (typecheck, lint, test)
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Browser Testing (Required for Frontend Stories)
For any story that changes UI, you MUST verify it works in the browser using the agent-browser skill.

## Implementation Steps
1. Read the story's acceptance criteria carefully
2. Implement ONE story (do NOT attempt multiple stories)
3. Run quality checks
4. If checks pass, commit with message: \`feat: [Story ID] - [Story Title]\`
5. Report: changed files, commit hash, what was done

## Output Format
Report in this format:
\`\`\`
## Implementation
- Changed files: [...]
- Commit: <hash or "not committed">
- What was done: <brief description>

## Learnings (for future iterations)
- <any patterns, gotchas, or context discovered>
\`\`\`

Current directory: {cwd}
PRD file: {prdFile}
`;

const VERIFICATION_PROMPT_TEMPLATE = `
You are a verification agent. Your ONLY job is to verify whether a story is truly complete.

## Rules (CRITICAL)
- You MUST verify against ACTUAL EVIDENCE, not assumptions
- You MUST NOT implement anything — only verify
- You MUST run actual commands to verify (tests, typecheck, etc.)
- You MUST read actual source files to verify implementation
- You CANNOT trust the execution agent's self-assessment

## Story to Verify
{storyJson}

## Changed Files (from execution agent)
{changedFiles}

## Your Verification Tasks
1. Read each changed file's source code
2. Verify implementation matches acceptance criteria
3. Run project's typecheck (if available)
4. Run project's tests (if available)
5. For UI stories: use agent-browser skill to verify in browser

## Acceptance Criteria (must ALL be satisfied)
{acceptanceCriteriaFormatted}

## Output Format
Return ONLY a JSON object:
\`\`\`json
{{
  "passes": true/false,
  "evidence": {{
    "criteria_name": "actual evidence found (file contents, command output, etc.)"
  }},
  "incompleteReasons": ["list of reasons why this does NOT pass"]
}}
\`\`\`

Do NOT return anything else. Only the JSON object.

Current directory: {cwd}
`;

const BUDGET_LIMITED_PROMPT = `
The active thread goal has reached its token budget.

The objective: {objective}

Budget exhausted. Wrap up this turn:
- Summarize useful progress made
- Identify remaining work or blockers
- Leave the user with a clear next step

Do NOT start new substantive work.
`;

const CONTINUATION_PROMPT = `
Continue working toward the active thread goal.

Objective: {objective}

Current iteration: {currentIteration}/{maxIterations}

{progressLog}

## Instructions
- Pick up where the previous iteration left off
- Verify the goal is still not complete
- Make concrete progress toward the requested end state
- Do NOT redefine success around a smaller or easier task

If all stories now have \`passes: true\`, output:
<promise>COMPLETE</promise>

Current directory: {cwd}
`;

// --- Progress log helpers ---

function loadProgressLog(goal: Goal): string {
  const logPath = join(resolveGoalsDir(), "progress.txt");
  if (existsSync(logPath)) {
    try {
      return readFileSync(logPath, "utf-8");
    } catch {}
  }
  return "# Progress Log\n\nNo previous iterations.\n";
}

function appendProgress(goal: Goal, entry: string): void {
  const logPath = join(resolveGoalsDir(), "progress.txt");
  appendFileSync(logPath, `\n${entry}\n---\n`);
}

// --- Sub-agent spawn helpers ---

interface SubAgentResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/**
 * Spawn a sub-agent with goals-specific context injection.
 * 
 * @param cwd Working directory
 * @param systemPrompt Additional system prompt to inject
 * @param userPrompt The user prompt
 * @param restrictedTools If true, only inject restricted verification tools
 */
async function spawnGoalsSubagent(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  options: { timeoutMs?: number; restrictedTools?: boolean } = {}
): Promise<SubAgentResult> {
  const args = [
    "-p",
    "--no-extensions",          // No extensions loaded
    "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
    "--append-system-prompt", systemPrompt,
    userPrompt,
  ];

  const { timeoutMs = 300_000 } = options;

  let stdout = "";
  let stderr = "";

  const result = await spawnPi({
    cwd,
    args,
    onStdout: (d) => { stdout += d; },
    onStderr: (d) => { stderr += d; },
    timeoutMs,
  });

  return { stdout, stderr, code: result.code ?? -1, killed: result.killed };
}

// --- Execution & Verification ---

async function executeStory(
  goal: Goal,
  story: UserStory,
  config: GoalsConfig
): Promise<{ changedFiles: string[]; output: string }> {
  const progressLog = loadProgressLog(goal);
  const systemPrompt = [
    "You are Ralph, an autonomous coding agent.",
    "Work on ONE story per iteration.",
    "Commit after each story if quality checks pass.",
    "Read progress.txt for learnings from previous iterations.",
    "",
    `PRD file: ${goal.prdFile || "no prd file"}`,
    "Branch: " + goal.branchName,
  ].join("\n");

  const prompt = EXECUTION_PROMPT_TEMPLATE
    .replace("{progressLog}", progressLog)
    .replace("{storyJson}", JSON.stringify(story, null, 2))
    .replace("{cwd}", goal.cwd)
    .replace("{prdFile}", goal.prdFile || "no prd file");

  const result = await spawnGoalsSubagent(goal.cwd, systemPrompt, prompt);

  // Parse output for changed files
  const changedFiles = parseChangedFiles(result.stdout);

  return { changedFiles, output: result.stdout };
}

async function verifyStory(
  goal: Goal,
  story: UserStory,
  changedFiles: string[],
  config: GoalsConfig
): Promise<{ passes: boolean; evidence: Record<string, string>; incompleteReasons: string[] }> {
  const systemPrompt = [
    "You are a verification agent.",
    "Your ONLY job is to verify completion.",
    "You CANNOT modify any files.",
    "You MUST check actual evidence.",
    "Tools available: Read, Bash, Grep, Find, understand_image, agent-browser.",
    "",
    `Changed files: ${changedFiles.join(", ") || "none"}`,
  ].join("\n");

  const prompt = VERIFICATION_PROMPT_TEMPLATE
    .replace("{storyJson}", JSON.stringify(story, null, 2))
    .replace("{changedFiles}", changedFiles.join(", ") || "none")
    .replace("{acceptanceCriteriaFormatted}", story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"))
    .replace("{cwd}", goal.cwd);

  const result = await spawnGoalsSubagent(goal.cwd, systemPrompt, prompt, { restrictedTools: true });

  try {
    // Extract JSON from output (might be wrapped in markdown)
    const jsonMatch = result.stdout.match(/\{[\s\S]*"passes"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passes: !!parsed.passes,
        evidence: parsed.evidence || {},
        incompleteReasons: parsed.incompleteReasons || [],
      };
    }
  } catch {}

  // Fallback: assume verification failed if we can't parse
  return {
    passes: false,
    evidence: { parseError: result.stdout.slice(0, 500) },
    incompleteReasons: ["Could not parse verification output"],
  };
}

// --- Parsing helpers ---

function parseChangedFiles(output: string): string[] {
  const match = output.match(/Changed files:\s*\[(.*?)\]/);
  if (!match) return [];
  const files = match[1].split(",").map((f) => f.trim()).filter(Boolean);
  return files;
}

function parseCompletionSignal(output: string): boolean {
  return output.includes("<promise>COMPLETE</promise>");
}

// --- Main loop ---

export interface LoopResult {
  goalId: string;
  completed: boolean;
  finalState: GoalState;
  iterationsRun: number;
  reason?: string;
}

/**
 * Run the goal loop until completion or max iterations.
 * 
 * This is called by the goals extension when /goal is invoked.
 * The main pi process runs this loop synchronously.
 */
export async function runGoalLoop(
  goal: Goal,
  store: GoalStore,
  config: GoalsConfig
): Promise<LoopResult> {
  const startedAt = new Date().toISOString();

  // Ensure we're active
  store.transitionTo(goal.id, "active");

  try {
    return await withGroupLock<LoopResult>(goal.cwd, async () => {
      return await runLoopInternal(goal, store, config);
    });
  } catch (err) {
    store.transitionTo(goal.id, "failed");
    return {
      goalId: goal.id,
      completed: false,
      finalState: "failed",
      iterationsRun: goal.currentIteration,
      reason: String(err),
    };
  }
}

async function runLoopInternal(
  goal: Goal,
  store: GoalStore,
  config: GoalsConfig
): Promise<LoopResult> {
  const episodicDir = join(resolveGoalsDir(), "episodic", "ralph");
  mkdirSync(episodicDir, { recursive: true });

  while (goal.currentIteration < goal.maxIterations) {
    goal.currentIteration++;
    store.updateGoal(goal.id, { currentIteration: goal.currentIteration });

    // --- Select next story ---
    let story: UserStory | null = null;
    if (goal.userStories) {
      story = goal.userStories.find((s) => !s.passes) || null;
    } else if (goal.prdFile) {
      story = store.getNextStory(goal.id);
    }

    if (!story) {
      // No more stories — goal complete
      store.transitionTo(goal.id, "completed");
      return {
        goalId: goal.id,
        completed: true,
        finalState: "completed",
        iterationsRun: goal.currentIteration,
      };
    }

    const iterationStartedAt = new Date().toISOString();
    let executionOutput = "";
    let changedFiles: string[] = [];
    let verificationResult: { passes: boolean; evidence: Record<string, string>; incompleteReasons: string[] } | null = null;

    // --- Execution ---
    try {
      const execResult = await executeStory(goal, story, config);
      executionOutput = execResult.output;
      changedFiles = execResult.changedFiles;
    } catch (err) {
      console.error(`[goals] Execution failed for ${story.id}:`, err);
    }

    // --- Verification (isolated sub-agent) ---
    if (changedFiles.length > 0) {
      try {
        verificationResult = await verifyStory(goal, story, changedFiles, config);
      } catch (err) {
        console.error(`[goals] Verification failed for ${story.id}:`, err);
        verificationResult = {
          passes: false,
          evidence: { error: String(err) },
          incompleteReasons: ["Verification sub-agent crashed"],
        };
      }
    }

    // --- Update PRD / Store ---
    const passes = verificationResult?.passes ?? false;
    if (goal.userStories) {
      const storyIndex = goal.userStories.findIndex((s) => s.id === story!.id);
      if (storyIndex !== -1) {
        goal.userStories[storyIndex].passes = passes;
      }
    }
    store.updateStoryPasses(goal.id, story.id, passes);

    // --- Log iteration ---
    const logEntry = {
      goalId: goal.id,
      iteration: goal.currentIteration,
      storyId: story.id,
      startedAt: iterationStartedAt,
      completedAt: new Date().toISOString(),
      executionOutput: executionOutput.slice(0, 5000),
      verificationResult: verificationResult ?? undefined,
      changedFiles,
    };
    store.insertIteration(logEntry);

    // Write episodic log
    const episodicLogPath = join(episodicDir, `iteration-${String(goal.currentIteration).padStart(3, "0")}.jsonl`);
    writeFileSync(episodicLogPath, JSON.stringify(logEntry) + "\n");

    // Append progress
    const progressEntry = `
## Iteration ${goal.currentIteration} - ${story.id}
${passes ? "✅ PASSED" : "❌ FAILED"}
${!passes && verificationResult ? `Reason: ${verificationResult.incompleteReasons.join(", ")}` : ""}
${!passes && verificationResult ? `Evidence: ${JSON.stringify(verificationResult.evidence)}` : ""}
`;
    appendProgress(goal, progressEntry);

    // --- Check completion ---
    const allComplete = goal.userStories
      ? goal.userStories.every((s) => s.passes)
      : store.allStoriesComplete(goal.id);

    if (allComplete) {
      store.transitionTo(goal.id, "completed");
      return {
        goalId: goal.id,
        completed: true,
        finalState: "completed",
        iterationsRun: goal.currentIteration,
      };
    }

    // --- Check budget ---
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      store.transitionTo(goal.id, "budget_limited");
      return {
        goalId: goal.id,
        completed: false,
        finalState: "budget_limited",
        iterationsRun: goal.currentIteration,
        reason: "Token budget exhausted",
      };
    }
  }

  // Max iterations reached
  return {
    goalId: goal.id,
    completed: false,
    finalState: "failed",
    iterationsRun: goal.currentIteration,
    reason: "Max iterations reached",
  };
}
