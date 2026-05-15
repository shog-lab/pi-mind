/**
 * LongMemEval judge — TS port of the official scoring methodology.
 *
 * Prompts are copied VERBATIM from the official evaluator at:
 *   https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
 *   (function get_anscheck_prompt, lines ~25-50, last synced 2026-05-14)
 *
 * Do NOT modify these prompt strings. If LongMemEval upstream updates them,
 * re-sync rather than tweaking — the whole point is methodology compatibility.
 *
 * Differences from the official Python evaluator (intentional, narrow):
 *   - Judge model is configurable (official defaults to gpt-4o; we let caller pick).
 *     For cross-system comparability, run all systems through the SAME judge model
 *     here — absolute numbers won't match the paper, but relative rankings are valid.
 *   - We invoke the model via spawnPi (so any provider pi supports works) instead of
 *     the openai SDK. The model itself does the same yes/no judgment task.
 *
 * Everything else is identical:
 *   - Abstention detection: question_id ends with "_abs"
 *   - Yes/no parsing: case-insensitive "yes" substring → 1, else 0
 *   - Temperature 0, max 10 output tokens
 *   - Per-question-type prompt selection
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPi, type PiTokens } from "@shoglab/pi-utils";
import type { EvalQuestion } from "../types.js";

export interface JudgeOptions {
  /** Model to pass to pi as --model. If omitted, uses pi's default. */
  model?: string;
  /** Per-judge-call timeout (ms). Default 60s — judging is short. */
  timeoutMs?: number;
}

export interface JudgeResult {
  /** 0 or 1 (LongMemEval is binary). NaN if the judge call failed entirely. */
  score: number;
  /** Raw judge reply for debugging — store this to audit borderline cases later. */
  rawReply: string;
  /** Tokens spent on this judge call. */
  tokens?: PiTokens;
}

/**
 * Score one (question, response) pair using LongMemEval's official methodology.
 */
export async function judgeQuestion(
  question: EvalQuestion,
  response: string,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, response);

  const tmp = mkdtempSync(join(tmpdir(), "pi-judge-"));
  try {
    const args = ["-p", "--no-extensions"];
    if (opts.model) args.push("--model", opts.model);
    args.push(prompt);

    const chunks: string[] = [];
    const result = await spawnPi({
      cwd: tmp,
      args,
      onStdout: (t) => chunks.push(t),
      timeoutMs: opts.timeoutMs ?? 60_000,
    });

    if (result.killed || result.code !== 0) {
      return { score: NaN, rawReply: "", tokens: result.tokens };
    }
    const rawReply = chunks.join("").trim();
    return {
      score: parseYesNo(rawReply),
      rawReply,
      tokens: result.tokens,
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Pick the right official prompt template based on question type + abstention flag.
 *
 * Abstention detection mirrors the official evaluator: any question whose ID
 * contains "_abs" is treated as an unanswerable question, regardless of category.
 */
function buildJudgePrompt(question: EvalQuestion, response: string): string {
  const isAbstention = question.id.includes("_abs");
  const category = (question.metadata?.category ?? "") as string;
  const q = question.question;
  const a = question.groundTruth;
  const r = response;

  if (isAbstention) {
    // Verbatim from evaluate_qa.py (abstention branch)
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q}\n\nExplanation: ${a}\n\nModel Response: ${r}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }

  if (category === "single-session-user" || category === "single-session-assistant" || category === "multi-session") {
    // Verbatim — standard factual recall
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  }

  if (category === "temporal-reasoning") {
    // Verbatim — same as standard, plus off-by-one tolerance for time counts
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  }

  if (category === "knowledge-update") {
    // Verbatim — accepts responses containing both old and updated info
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  }

  if (category === "single-session-preference") {
    // Verbatim — preference is rubric-based, response judged on whether it
    // recalls and applies the user's stored preferences (the "Rubric" field
    // is the upstream "answer" — a description of desired personalized response).
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q}\n\nRubric: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  }

  // Unknown category — the official evaluator throws. We treat it as a hard
  // judging error (NaN downstream) rather than guessing.
  throw new Error(`unknown question category for judge prompt selection: ${category}`);
}

/**
 * Mirror official parsing: case-insensitive substring match for "yes" → 1, else 0.
 *
 *   eval_response = completion.choices[0].message.content.strip()
 *   label = 'yes' in eval_response.lower()
 *
 * This means "yes." / "Yes" / "Yes, the response is correct" all → 1.
 * Empty replies, "no", "I am not sure" → 0.
 */
function parseYesNo(reply: string): number {
  return reply.toLowerCase().includes("yes") ? 1 : 0;
}
