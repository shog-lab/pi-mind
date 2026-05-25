/**
 * Goal Loop — simplified Ralph-style autonomous execution.
 *
 * State lives in prd.json. Each iteration: pick next !passes story, spawn an
 * execution sub-pi, spawn a verification sub-pi, flip passes:true if verified,
 * write prd.json back to disk. Loop until all stories pass or maxIterations hit.
 *
 * No DB, no state machine, no global lock. Per-goal worktree gives physical
 * isolation; prd.json being the source of truth gives free pause/resume
 * (ctrl+C, re-run /goal --from prd.json — loop picks up where it left off).
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnPi, type PiTokens } from "@shog-lab/pi-utils";
import { Value } from "@sinclair/typebox/value";
import {
  PRD, PRDSchema, UserStory, VerificationResultSchema,
  EXECUTION_TOOLS, VERIFICATION_TOOLS, DEFAULT_MAX_ITERATIONS,
} from "./schema.js";

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
    "criterion_name": "actual evidence found (file contents, command output, etc.)"
  }},
  "incompleteReasons": ["list of reasons why this does NOT pass"]
}}
\`\`\`

Do NOT return anything else. Only the JSON object.

Current directory: {cwd}
`;

// --- PRD I/O ---

/**
 * Read prd.json and schema-validate. Returns null on any failure (missing,
 * malformed JSON, wrong shape) — caller surfaces a useful error.
 */
export function loadPRD(prdPath: string): PRD | { error: string } {
  if (!existsSync(prdPath)) return { error: `PRD not found: ${prdPath}` };
  let raw: string;
  try { raw = readFileSync(prdPath, "utf-8"); }
  catch (e) { return { error: `failed to read PRD: ${e instanceof Error ? e.message : String(e)}` }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { error: `PRD is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!Value.Check(PRDSchema, parsed)) {
    const errors = [...Value.Errors(PRDSchema, parsed)].slice(0, 5)
      .map((err) => `${err.path || "(root)"}: ${err.message}`).join("; ");
    return { error: `PRD schema mismatch: ${errors}` };
  }
  return parsed;
}

/** Atomically write prd.json back (write to .tmp then rename). */
function savePRD(prdPath: string, prd: PRD): void {
  const tmpPath = `${prdPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(prd, null, 2) + "\n");
  // Same-dir rename is atomic on POSIX — readers see either old or new file,
  // never a half-written intermediate.
  execSync(`mv ${JSON.stringify(tmpPath)} ${JSON.stringify(prdPath)}`);
}

// --- Worktree ---

/**
 * Materialize a per-goal git worktree at `<repo>/.ralph-worktrees/<key>/` on
 * the given branch, return its path. Returns null if cwd is not in a git repo
 * (caller falls back to operating in cwd directly).
 *
 * Worktree isolation gives ralph a clean physical sandbox per goal — the
 * user's main checkout is never touched, multiple goals can coexist on
 * different branches, and `.pi-mind/` + `.pi-goals/` still resolve to the
 * main repo root via `git rev-parse --git-common-dir` (pi-utils paths.ts).
 *
 * Idempotent: if a worktree is already registered at the path, reuse it
 * (resume path).
 */
export function ensureWorktree(
  cwd: string,
  key: string,
  branchName: string
): string | null {
  if (!branchName) return null;
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  };

  let repoRoot: string;
  try { repoRoot = execSync("git rev-parse --show-toplevel", opts).trim(); }
  catch { return null; }

  const worktreePath = join(repoRoot, ".ralph-worktrees", key);

  // Already-registered worktree at this path? Reuse.
  let alreadyRegistered = false;
  try {
    const listing = execSync("git worktree list --porcelain", opts);
    alreadyRegistered = listing.split("\n").some((line) =>
      line.startsWith("worktree ") && line.slice("worktree ".length).trim() === worktreePath
    );
  } catch { /* fall through */ }

  if (alreadyRegistered) {
    if (existsSync(worktreePath)) return worktreePath;
    // Registered but path missing — stale, prune and recreate.
    try { execSync("git worktree prune", opts); } catch { /* best-effort */ }
  }

  const parent = join(repoRoot, ".ralph-worktrees");
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
    console.warn(
      `[goals] created ${parent} — add ".ralph-worktrees/" to your .gitignore`
    );
  }

  let branchExists = false;
  try { execSync(`git rev-parse --verify ${JSON.stringify(branchName)}`, opts); branchExists = true; }
  catch { /* missing */ }

  try {
    if (branchExists) {
      execSync(`git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branchName)}`, opts);
    } else {
      execSync(`git worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)}`, opts);
    }
    return worktreePath;
  } catch (err) {
    console.warn(
      `[goals] failed to create worktree for "${branchName}" at ${worktreePath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// --- Sub-agent spawn ---

interface SubAgentResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  tokens?: PiTokens;
}

async function spawnSubagent(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  tools: readonly string[],
  timeoutMs: number,
): Promise<SubAgentResult> {
  const args = [
    "-p",
    "--no-extensions",
    "--model", process.env.MODEL ?? "minimax-cn/MiniMax-M2.7",
    "--append-system-prompt", systemPrompt,
    "--tools", tools.join(","),
    userPrompt,
  ];
  let stdout = "";
  let stderr = "";
  const result = await spawnPi({
    cwd, args,
    onStdout: (d) => { stdout += d; },
    onStderr: (d) => { stderr += d; },
    timeoutMs,
  });
  return { stdout, stderr, code: result.code ?? -1, killed: result.killed, tokens: result.tokens };
}

// --- Progress log (per-worktree) ---

function loadProgressLog(worktreePath: string): string {
  const p = join(worktreePath, "ralph-progress.txt");
  if (existsSync(p)) {
    try { return readFileSync(p, "utf-8"); } catch { /* ignore */ }
  }
  return "# Progress Log\n\nNo previous iterations.\n";
}

function appendProgress(worktreePath: string, entry: string): void {
  const p = join(worktreePath, "ralph-progress.txt");
  appendFileSync(p, `\n${entry}\n---\n`);
}

// --- Iteration steps ---

interface StoryExecutionResult {
  changedFiles: string[];
  output: string;
  tokens?: PiTokens;
}

async function executeStory(
  prdPath: string,
  workCwd: string,
  story: UserStory,
  timeoutMs: number,
): Promise<StoryExecutionResult> {
  const progressLog = loadProgressLog(workCwd);
  const systemPrompt = [
    "You are Ralph, an autonomous coding agent.",
    "Work on ONE story per iteration.",
    "Commit after each story if quality checks pass.",
  ].join("\n");

  const prompt = EXECUTION_PROMPT_TEMPLATE
    .replace("{progressLog}", progressLog)
    .replace("{storyJson}", JSON.stringify(story, null, 2))
    .replace("{cwd}", workCwd)
    .replace("{prdFile}", prdPath);

  const result = await spawnSubagent(workCwd, systemPrompt, prompt, EXECUTION_TOOLS, timeoutMs);

  // Prefer git's view of changed files over parsing agent's prose.
  let changedFiles: string[] = [];
  try {
    changedFiles = (execSync("git diff --name-only", {
      cwd: workCwd, encoding: "utf-8", timeout: 5000,
    } as ExecSyncOptionsWithStringEncoding) as string)
      .split("\n").map((f) => f.trim()).filter(Boolean);
  } catch { /* git failed; fall back to regex */ }
  if (changedFiles.length === 0) {
    const m = result.stdout.match(/Changed files:\s*\[(.*?)\]/);
    if (m) changedFiles = m[1].split(",").map((f) => f.trim()).filter(Boolean);
  }

  return { changedFiles, output: result.stdout, tokens: result.tokens };
}

interface VerificationOutcome {
  passes: boolean;
  evidence: Record<string, string>;
  incompleteReasons: string[];
  tokens?: PiTokens;
}

async function verifyStory(
  workCwd: string,
  story: UserStory,
  changedFiles: string[],
  timeoutMs: number,
): Promise<VerificationOutcome> {
  // Re-discover changed files from git in case execution agent's list was off.
  let verifiedFiles: string[];
  try {
    verifiedFiles = (execSync("git diff --name-only", {
      cwd: workCwd, encoding: "utf-8", timeout: 5000,
    } as ExecSyncOptionsWithStringEncoding) as string)
      .split("\n").map((f) => f.trim()).filter(Boolean);
  } catch { verifiedFiles = changedFiles; }

  const systemPrompt = [
    "You are a verification agent.",
    "Your ONLY job is to verify completion.",
    "You CANNOT modify any files.",
    "You MUST check actual evidence.",
    `Tools available: ${VERIFICATION_TOOLS.join(", ")}.`,
    `Changed files (from git diff): ${verifiedFiles.join(", ") || "none"}`,
  ].join("\n");

  const prompt = VERIFICATION_PROMPT_TEMPLATE
    .replace("{storyJson}", JSON.stringify(story, null, 2))
    .replace("{changedFiles}", verifiedFiles.join(", ") || "none")
    .replace("{acceptanceCriteriaFormatted}",
      story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"))
    .replace("{cwd}", workCwd);

  const result = await spawnSubagent(workCwd, systemPrompt, prompt, VERIFICATION_TOOLS, timeoutMs);

  // Schema-validate the JSON the verification agent emitted. This catches a
  // class of sub-agent regressions that loose coercion would miss:
  //   - {"passes": "yes"}     → was truthy → false-passed
  //   - {"passes": null}      → was falsy → false-failed
  //   - {"pass": true}        → typo → undefined → false-failed silently
  const jsonMatch = result.stdout.match(/\{[\s\S]*"passes"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Value.Check(VerificationResultSchema, parsed)) {
        return {
          passes: parsed.passes,
          evidence: parsed.evidence ?? {},
          incompleteReasons: parsed.incompleteReasons ?? [],
          tokens: result.tokens,
        };
      }
      const errors = [...Value.Errors(VerificationResultSchema, parsed)].slice(0, 3)
        .map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ");
      return {
        passes: false,
        evidence: { schemaError: errors, raw: jsonMatch[0].slice(0, 500) },
        incompleteReasons: [`Verification JSON did not match schema: ${errors}`],
        tokens: result.tokens,
      };
    } catch (e) {
      return {
        passes: false,
        evidence: { parseError: e instanceof Error ? e.message : String(e), raw: jsonMatch[0].slice(0, 500) },
        incompleteReasons: ["Could not parse verification output as JSON"],
        tokens: result.tokens,
      };
    }
  }

  return {
    passes: false,
    evidence: { parseError: "no JSON found in verification output", raw: result.stdout.slice(0, 500) },
    incompleteReasons: ["Verification sub-agent did not emit a JSON result block"],
    tokens: result.tokens,
  };
}

// --- Main loop ---

export interface LoopOptions {
  prdPath: string;
  cwd: string;
  branchName?: string;     // overrides PRD's branchName if set
  maxIterations?: number;
  /** Per-sub-agent timeout in ms (default: 5 min) */
  subAgentTimeoutMs?: number;
}

export interface LoopResult {
  completed: boolean;
  iterationsRun: number;
  totalTokens: PiTokens;
  reason?: string;
}

function emptyTokens(): PiTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
}

/** Mutates `into` in-place. */
function addTokens(into: PiTokens, b: PiTokens | undefined): void {
  if (!b) return;
  into.input += b.input;
  into.output += b.output;
  into.cacheRead += b.cacheRead;
  into.cacheWrite += b.cacheWrite;
  into.totalTokens += b.totalTokens;
  into.costUsd += b.costUsd;
}

/**
 * Run the goal loop on the PRD at prdPath. Loops until every story passes or
 * maxIterations is hit. Writes prd.json back after each iteration so re-runs
 * pick up where they left off (this IS the pause/resume mechanism).
 *
 * Returns aggregate tokens used and whether the goal completed.
 */
export async function runGoalLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    prdPath,
    cwd,
    branchName: branchOverride,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    subAgentTimeoutMs = 300_000,
  } = opts;

  const totalTokens = emptyTokens();

  // Load + validate PRD once at start. We don't reload on every iteration —
  // we hold the in-memory PRD and atomically persist updates back to disk.
  // If the user edits prd.json mid-loop, those edits are lost on next save
  // (acceptable: ctrl+C the loop if you want to hand-edit).
  const loaded = loadPRD(prdPath);
  if ("error" in loaded) {
    return { completed: false, iterationsRun: 0, totalTokens, reason: loaded.error };
  }
  const prd = loaded;

  const branchName = branchOverride || prd.branchName;
  // Goal-id key for the worktree dir. Reuse a stable slug derived from PRD
  // path + branchName so repeated /goal --from <same path> with the same
  // branch reuses the same worktree (resume path).
  const worktreeKey = `${prd.project.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${branchName.replace(/[^a-zA-Z0-9]+/g, "-")}`.replace(/^-+|-+$/g, "");

  const wt = ensureWorktree(cwd, worktreeKey, branchName);
  const workCwd = wt ?? cwd;
  if (!wt) {
    console.warn(`[goals] running without worktree isolation in ${cwd} — branch / git issue surfaced above`);
  }

  let iter = 0;
  while (iter < maxIterations) {
    const story = prd.userStories.find((s) => !s.passes);
    if (!story) {
      return { completed: true, iterationsRun: iter, totalTokens };
    }

    iter++;
    const startedAt = new Date().toISOString();
    console.log(`\n[goals] iter ${iter}/${maxIterations} — story ${story.id}: ${story.title}`);

    let exec: StoryExecutionResult;
    try {
      exec = await executeStory(prdPath, workCwd, story, subAgentTimeoutMs);
    } catch (err) {
      console.error(`[goals] execution crashed for ${story.id}:`, err);
      appendProgress(workCwd, `## Iteration ${iter} - ${story.id}\n❌ EXECUTION CRASHED\nError: ${String(err)}\n`);
      continue;
    }
    addTokens(totalTokens, exec.tokens);
    if (exec.tokens) {
      console.log(`[goals]   exec  tokens: ${exec.tokens.totalTokens} ($${exec.tokens.costUsd.toFixed(4)})`);
    }

    let verify: VerificationOutcome;
    if (exec.changedFiles.length === 0) {
      verify = {
        passes: false,
        evidence: { noFilesFound: "No changed files detected via git diff" },
        incompleteReasons: ["No changed files — story may not have been implemented"],
      };
    } else {
      try {
        verify = await verifyStory(workCwd, story, exec.changedFiles, subAgentTimeoutMs);
      } catch (err) {
        console.error(`[goals] verification crashed for ${story.id}:`, err);
        verify = {
          passes: false,
          evidence: { error: String(err) },
          incompleteReasons: ["Verification sub-agent crashed"],
        };
      }
    }
    addTokens(totalTokens, verify.tokens);
    if (verify.tokens) {
      console.log(`[goals]   verify tokens: ${verify.tokens.totalTokens} ($${verify.tokens.costUsd.toFixed(4)})`);
    }

    // Mutate PRD in-memory + persist atomically.
    story.passes = verify.passes;
    savePRD(prdPath, prd);

    const completedAt = new Date().toISOString();
    appendProgress(workCwd, [
      `## Iteration ${iter} - ${story.id}`,
      `${verify.passes ? "✅ PASSED" : "❌ FAILED"}`,
      verify.passes ? "" : `Reason: ${verify.incompleteReasons.join(", ")}`,
      verify.passes ? "" : `Evidence: ${JSON.stringify(verify.evidence).slice(0, 500)}`,
      `Changed: ${exec.changedFiles.join(", ") || "none"}`,
      `Started: ${startedAt}  Done: ${completedAt}`,
    ].filter(Boolean).join("\n"));
  }

  // Fell out of the while — check one more time whether the LAST iteration
  // happened to be the one that flipped the last story (in which case we're
  // actually completed, not halted by the iteration cap).
  if (!prd.userStories.find((s) => !s.passes)) {
    return { completed: true, iterationsRun: iter, totalTokens };
  }

  return {
    completed: false,
    iterationsRun: iter,
    totalTokens,
    reason: `Max iterations (${maxIterations}) reached with stories still incomplete. Re-run /goal --from ${prdPath} to continue.`,
  };
}
