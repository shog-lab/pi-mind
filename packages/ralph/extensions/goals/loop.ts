/**
 * Goal Loop — Ralph-style autonomous execution with self-verification.
 *
 * Architecture:
 *   Main pi (goals extension) owns state machine
 *   Execution sub-agent: implements the story (full tools)
 *   Verification sub-agent: checks evidence against criteria (restricted tools)
 *
 * Sub-agents run with --no-extensions and --tools allowlist.
 * The goals extension injects goal context via --append-system-prompt.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnPi, type PiTokens } from "@shog-lab/pi-utils";
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

// Default tool allowlists — names must be lowercase to match pi's tool registry.
// (Pi's --tools flag is case-sensitive: "Bash" does NOT match the built-in "bash".)
// grep/find aren't standalone pi tools — agents access them via the bash tool.
const DEFAULT_EXECUTION_TOOLS = ["bash", "read", "write", "edit"];
const DEFAULT_VERIFICATION_TOOLS = ["bash", "read"];

// --- Progress log helpers ---

// progress.txt is shared across ALL goals in the goals dir.
// For goal-specific logs, use episodic/ralph/iteration-*.jsonl instead.
// The loop writes to global progress.txt (for cross-goal learnings) and
// per-goal progress files (to avoid pollution). loadProgressLog only reads
// the global one if it exists (for backward compat when loading goals from DB).
function loadProgressLog(_goal: Goal): string {
  const logPath = join(resolveGoalsDir(), "progress.txt");
  if (existsSync(logPath)) {
    try {
      return readFileSync(logPath, "utf-8");
    } catch {}
  }
  return "# Progress Log\n\nNo previous iterations.\n";
}

function appendProgress(goal: Goal, entry: string): void {
  // Write to goal-specific progress file to avoid cross-goal pollution (issue #9)
  const progressPath = join(resolveGoalsDir(), "episodic", "ralph", `progress-${goal.id}.txt`);
  appendFileSync(progressPath, `\n${entry}\n---\n`);

  // Also append to global progress.txt for backward compat + cross-goal learnings
  const globalLogPath = join(resolveGoalsDir(), "progress.txt");
  appendFileSync(globalLogPath, `\n${entry}\n---\n`);
}

// --- Sub-agent spawn helpers ---

interface SubAgentResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  /** Token usage from pi's agent_end event. Undefined if pi didn't complete normally. */
  tokens?: PiTokens;
}

interface SubAgentOptions {
  timeoutMs?: number;
  /** Tool allowlist — passed as --tools flag */
  tools?: string[];
}

/**
 * Spawn a sub-agent with goals-specific context injection.
 *
 * @param cwd Working directory
 * @param systemPrompt Additional system prompt to inject
 * @param userPrompt The user prompt
 * @param options.tools If provided, restrict to this allowlist via --tools flag
 */
async function spawnGoalsSubagent(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  options: SubAgentOptions = {}
): Promise<SubAgentResult> {
  const args = [
    "-p",
    "--no-extensions",          // No extensions loaded
    "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
    "--append-system-prompt", systemPrompt,
  ];

  // Apply tool allowlist if specified (via --tools flag)
  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }

  args.push(userPrompt);

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

  return { stdout, stderr, code: result.code ?? -1, killed: result.killed, tokens: result.tokens };
}

// --- Execution & Verification ---

/**
 * Ensure the goal's working tree is on goal.branchName.
 * Creates the branch if it doesn't exist. Skips if branchName is empty or
 * the placeholder "ralph/default" (treated as "stay on whatever branch we're on").
 *
 * Done in the parent process — relying on the sub-agent to run git checkout
 * via prompt was fragile (sub-agent could ignore, fail, or run different commands).
 */
function ensureBranch(cwd: string, branchName: string | undefined): void {
  if (!branchName || branchName === "ralph/default") return;
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  };
  let exists = false;
  try {
    execSync(`git rev-parse --verify ${JSON.stringify(branchName)}`, opts);
    exists = true;
  } catch { /* branch missing */ }
  try {
    if (exists) {
      execSync(`git checkout ${JSON.stringify(branchName)}`, opts);
    } else {
      execSync(`git checkout -b ${JSON.stringify(branchName)}`, opts);
    }
  } catch (err) {
    console.warn(`[goals] failed to checkout branch "${branchName}":`, err instanceof Error ? err.message : err);
  }
}

async function executeStory(
  goal: Goal,
  story: UserStory,
  config: GoalsConfig
): Promise<{ changedFiles: string[]; output: string; commitHash?: string; tokens?: PiTokens }> {
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

  // Pass execution tools via --tools flag (from config) — issue #2 fix
  const execTools = config.executionTools ?? DEFAULT_EXECUTION_TOOLS;
  const result = await spawnGoalsSubagent(goal.cwd, systemPrompt, prompt, {
    tools: execTools,
  });

  // Parse output for changed files and commit hash
  const changedFiles = parseChangedFilesFromGit(result.stdout, goal.cwd);
  const commitHash = parseCommitHash(result.stdout);

  return { changedFiles, output: result.stdout, commitHash, tokens: result.tokens };
}

/**
 * Parse changed files using git diff --name-only (robust, issue #5 fix).
 * Falls back to regex parsing if git fails.
 */
function parseChangedFilesFromGit(stdout: string, cwd: string): string[] {
  // First try the git diff approach (reliable)
  try {
    const files = (execSync("git diff --name-only", {
      cwd,
      encoding: "utf-8" as const,
      timeout: 5000,
    } as ExecSyncOptionsWithStringEncoding) as string)
      .split("\n")
      .map((f: string) => f.trim())
      .filter(Boolean);
    if (files.length > 0) return files;
  } catch {}

  // Fallback to regex parsing (fragile but better than nothing)
  return parseChangedFilesFallback(stdout);
}

/**
 * Last-resort regex parser for `Changed files: [...]` lines in agent output.
 * Called by parseChangedFilesFromGit() when `git diff --name-only` returned
 * nothing — no working tree, no git binary, or git failed. Fragile (only
 * catches one specific format the execution sub-agent emits) but better
 * than reporting zero changes when files actually changed.
 *
 * (Was tagged @deprecated, but that was misleading: the primary path still
 * delegates here on git failure, so the function is intentionally kept.)
 */
function parseChangedFilesFallback(output: string): string[] {
  const match = output.match(/Changed files:\s*\[(.*?)\]/);
  if (!match) return [];
  return match[1].split(",").map((f: string) => f.trim()).filter(Boolean);
}

function parseCommitHash(output: string): string | undefined {
  const match = output.match(/Commit:\s*([a-f0-9]+)/i);
  return match ? match[1] : undefined;
}

async function verifyStory(
  goal: Goal,
  story: UserStory,
  changedFiles: string[],
  config: GoalsConfig
): Promise<{ passes: boolean; evidence: Record<string, string>; incompleteReasons: string[]; tokens?: PiTokens }> {
  // Verification tools are restricted to read-only + browser inspection (issue #1 fix)
  const verifyTools = config.verificationTools ?? DEFAULT_VERIFICATION_TOOLS;

  // For verification, always re-discover changed files via git diff (issue #6 fix)
  // Don't trust the execution agent's reported file list
  let verifiedFiles: string[];
  try {
    verifiedFiles = (execSync("git diff --name-only", {
      cwd: goal.cwd,
      encoding: "utf-8" as const,
      timeout: 5000,
    } as ExecSyncOptionsWithStringEncoding) as string)
      .split("\n")
      .map((f: string) => f.trim())
      .filter(Boolean);
  } catch {
    verifiedFiles = changedFiles; // fallback to reported list if git fails
  }

  const systemPrompt = [
    "You are a verification agent.",
    "Your ONLY job is to verify completion.",
    "You CANNOT modify any files.",
    "You MUST check actual evidence.",
    `Tools available: ${verifyTools.join(", ")}.`,
    "",
    `Changed files (from git diff): ${verifiedFiles.join(", ") || "none"}`,
  ].join("\n");

  const prompt = VERIFICATION_PROMPT_TEMPLATE
    .replace("{storyJson}", JSON.stringify(story, null, 2))
    .replace("{changedFiles}", verifiedFiles.join(", ") || "none")
    .replace("{acceptanceCriteriaFormatted}", story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"))
    .replace("{cwd}", goal.cwd);

  const result = await spawnGoalsSubagent(goal.cwd, systemPrompt, prompt, {
    tools: verifyTools,
  });

  try {
    // Extract JSON from output (might be wrapped in markdown)
    const jsonMatch = result.stdout.match(/\{[\s\S]*"passes"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passes: !!parsed.passes,
        evidence: parsed.evidence || {},
        incompleteReasons: parsed.incompleteReasons || [],
        tokens: result.tokens,
      };
    }
  } catch {}

  // Fallback: assume verification failed if we can't parse
  return {
    passes: false,
    evidence: { parseError: result.stdout.slice(0, 500) },
    incompleteReasons: ["Could not parse verification output"],
    tokens: result.tokens,
  };
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
 * This is called by the goals extension when goal tool is invoked.
 * The main pi process runs this loop synchronously (issue #7 — async but blocking).
 */
export async function runGoalLoop(
  goal: Goal,
  store: GoalStore,
  config: GoalsConfig
): Promise<LoopResult> {
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

  // Ensure the working tree is on goal.branchName before any iteration runs.
  // (issue #3 — previously delegated to sub-agent via prompt, which was unreliable.)
  ensureBranch(goal.cwd, goal.branchName);

  while (goal.currentIteration < goal.maxIterations) {
    goal.currentIteration++;
    store.updateGoal(goal.id, { currentIteration: goal.currentIteration });

    // --- Check pause state (issue #10 fix) ---
    const currentGoal = store.getGoal(goal.id);
    if (currentGoal && currentGoal.state === "paused") {
      return {
        goalId: goal.id,
        completed: false,
        finalState: "paused",
        iterationsRun: goal.currentIteration,
        reason: "Goal paused by user",
      };
    }

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
    let verificationResult: { passes: boolean; evidence: Record<string, string>; incompleteReasons: string[]; tokens?: PiTokens } | null = null;
    let executionTokens: PiTokens | undefined;

    // --- Execution ---
    try {
      const execResult = await executeStory(goal, story, config);
      executionOutput = execResult.output;
      changedFiles = execResult.changedFiles;
      executionTokens = execResult.tokens;
    } catch (err) {
      console.error(`[goals] Execution failed for ${story.id}:`, err);
    }

    // --- Token budget accounting ---
    // Real per-call usage from pi's agent_end event (via spawn-pi).
    // If pi crashed mid-call (no agent_end), tokens is undefined → we add 0
    // and continue. Budget enforcement still works on subsequent successful calls.
    if (executionTokens) {
      goal.tokensUsed += executionTokens.totalTokens;
      goal.costUsd = (goal.costUsd ?? 0) + executionTokens.costUsd;
      store.updateGoal(goal.id, { tokensUsed: goal.tokensUsed, costUsd: goal.costUsd });
    }

    // --- Check budget before proceeding to verification ---
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      store.transitionTo(goal.id, "budget_limited");
      return {
        goalId: goal.id,
        completed: false,
        finalState: "budget_limited",
        iterationsRun: goal.currentIteration,
        reason: `Token budget exhausted (used ${goal.tokensUsed} of ${goal.tokenBudget})`,
      };
    }

    // --- Verification (isolated sub-agent) ---
    // Issue #5 fix: If changedFiles is empty (git diff returned nothing),
    // verification is impossible — skip and mark failed.
    if (changedFiles.length === 0) {
      verificationResult = {
        passes: false,
        evidence: { noFilesFound: "No changed files detected via git diff" },
        incompleteReasons: ["No changed files found — story may not have been implemented"],
      };
    } else {
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

    // --- Accumulate verification tokens too ---
    if (verificationResult?.tokens) {
      goal.tokensUsed += verificationResult.tokens.totalTokens;
      goal.costUsd = (goal.costUsd ?? 0) + verificationResult.tokens.costUsd;
      store.updateGoal(goal.id, { tokensUsed: goal.tokensUsed, costUsd: goal.costUsd });
    }

    // --- Re-check budget after verification (allow this iteration to finish, halt next) ---
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      store.transitionTo(goal.id, "budget_limited");
      // Don't return yet — fall through to log iteration outcome, then halt below
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

    // Append progress (goal-specific + global)
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

    // --- Halt if budget was hit during verification (deferred from earlier check) ---
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      return {
        goalId: goal.id,
        completed: false,
        finalState: "budget_limited",
        iterationsRun: goal.currentIteration,
        reason: `Token budget exhausted (used ${goal.tokensUsed} of ${goal.tokenBudget})`,
      };
    }

    // --- Check pause state (before next iteration, issue #10 fix) ---
    const recheckGoal = store.getGoal(goal.id);
    if (recheckGoal && recheckGoal.state === "paused") {
      return {
        goalId: goal.id,
        completed: false,
        finalState: "paused",
        iterationsRun: goal.currentIteration,
        reason: "Goal paused by user during iteration",
      };
    }
  }

  // Max iterations reached — terminal state must be persisted to DB, not only returned.
  store.transitionTo(goal.id, "failed");
  return {
    goalId: goal.id,
    completed: false,
    finalState: "failed",
    iterationsRun: goal.currentIteration,
    reason: "Max iterations reached",
  };
}