/**
 * Verify the worth-remembering prompt against live Ollama.
 * Not part of `npm test` — integration, needs Ollama with the configured model.
 *
 * Usage:
 *   npm run verify-worth-remembering --workspace=packages/core
 *   PI_MIND_LLM_MODEL=qwen3:4b npx tsx scripts/verify-worth-remembering.ts
 *
 * Model selection:
 *   - default qwen2.5:1.5b: fast but overeager (~5/7 on current test set)
 *   - qwen3:4b: slower but accurate (7/7 on current test set) — production default
 *
 * What it tests:
 *   - Prompt produces valid JSON
 *   - "Should remember" inputs hit (feedback / new facts / decisions)
 *   - "Skip" inputs don't hit (status updates / casual chat / one-off Q&A)
 *   - Type classification on a sample (best-effort)
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
// Match production's env-var convention; default to qwen2.5:1.5b for parity.
const LLM_MODEL = process.env.PI_MIND_LLM_MODEL || "qwen2.5:1.5b";
const VALID_TYPES = ["user", "project", "agent-feedback", "reference"] as const;
type Subject = typeof VALID_TYPES[number];

interface TestCase {
  name: string;
  userPrompt: string;
  agentMessagesText?: string;
  expectRemember: boolean;
  /** If set, expected type; null/undefined = don't check type */
  expectType?: Subject | null;
}

const CASES: TestCase[] = [
  // Feedback cases (formerly the feedback-llm domain)
  {
    name: "user correction",
    userPrompt: "不对吧，应该用 git revert",
    agentMessagesText: "[assistant] 你可以用 git reset --hard 撤销",
    expectRemember: true,
  },
  {
    name: "user preference",
    userPrompt: "我更喜欢用 ripgrep 而不是 grep",
    expectRemember: true,
    expectType: "user",
  },
  {
    name: "user self-admission",
    userPrompt: "抱歉，我刚才说错了",
    expectRemember: true,
  },

  // New "agent learned" cases (no toolResults — we rely on agent's own summary
  // since tools' raw output is intentionally not captured)
  {
    name: "agent fetched a substantive fact",
    userPrompt: "帮我读一下这篇文章",
    agentMessagesText: "[assistant] 文章总结：Rust 的所有权模型通过编译期借用检查保证内存安全，无需 GC。",
    expectRemember: true,
  },

  // Should-skip cases
  {
    name: "normal Q&A",
    userPrompt: "帮我查一下今天天气",
    agentMessagesText: "[assistant] 北京今天 22 度，晴。",
    expectRemember: false,
  },
  {
    name: "status update",
    userPrompt: "跑完了吗",
    agentMessagesText: "[assistant] 已经跑完了，全部通过。",
    expectRemember: false,
  },
  {
    name: "casual chat",
    userPrompt: "今天天气不错",
    expectRemember: false,
  },
];

interface LlmResult {
  shouldRemember: boolean;
  type: Subject;
  primary: string;
  tier: "L1" | "L2";
  suggestedTags: string[];
  raw: string;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n...[truncated]";
}

async function detectWorthRemembering(input: {
  userPrompt: string;
  agentMessagesText: string;
}): Promise<LlmResult | { error: string }> {
  const prompt = [
    "判断这一轮交互里有没有值得长期记忆的内容。",
    "",
    "===== 应该 remember 的（true）=====",
    "",
    "A. 用户偏好 / 纠错 / 抱怨（type=user）",
    "  例：「我更喜欢 ripgrep」「不对，应该用 git revert」「抱歉我刚才说错了」",
    "  → true",
    "",
    "B. 工具拿回新事实，跨会话有复用价值（type=reference）",
    "  例：agent 读了一篇文章，要点是「Rust 借用检查在编译期保证内存安全」",
    "  → true",
    "",
    "C. agent 自己做了非显然决策 / 反思（type=agent-feedback 或 project）",
    "  例：「决定用 polling 而不是 webhook，因为 webhook 需要公网 IP」",
    "  → true",
    "",
    "===== 一律 false =====",
    "",
    "D. 状态汇报 / 进度更新",
    "  例：「跑完了」「已经通过」「OK 我去做」「我已经把测试都跑通了」",
    "  → false",
    "",
    "E. 一次性查询的答案",
    "  例：「今天天气如何」 + 「北京 22 度」 → false（明天就不准了）",
    "  例：「现在几点」、「这个变量是什么类型」 → false",
    "",
    "F. 闲聊 / 寒暄",
    "  例：「今天天气不错」「你好」「谢谢」 → false",
    "",
    "G. 普通工作流（用户给任务 + agent 完成，没新规则没新事实）",
    "  例：「帮我把这个函数改名」 + agent 改了 → false",
    "",
    "type 取值: user | project | agent-feedback | reference",
    "tier 取值: L1（仅持久用户偏好，保守用）| L2（其他默认）",
    "",
    `=== user prompt ===\n${truncate(input.userPrompt, 800)}`,
    "",
    `=== agent messages ===\n${truncate(input.agentMessagesText, 3000)}`,
    "",
    '输出 JSON（且仅 JSON）: {"shouldRemember": true/false, "type": "user|project|agent-feedback|reference", "primary": "一句话自包含浓缩", "tier": "L1|L2", "suggestedTags": ["1-3个topic词"]}',
  ].join("\n");

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        format: "json",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        keep_alive: "30m",
      }),
    });
    if (!resp.ok) return { error: `Ollama HTTP ${resp.status}` };
    const data = (await resp.json()) as { message?: { content?: string } };
    const raw = (data.message?.content ?? "").trim();

    try {
      const json = JSON.parse(raw);
      const shouldRemember = json.shouldRemember === true;
      const type = (VALID_TYPES as readonly string[]).includes(json.type) ? (json.type as Subject) : "reference";
      const tier = json.tier === "L1" ? "L1" : "L2";
      const primary = typeof json.primary === "string" ? json.primary : "";
      const suggestedTags = Array.isArray(json.suggestedTags)
        ? json.suggestedTags.filter((t: unknown) => typeof t === "string").slice(0, 3)
        : [];
      return { shouldRemember, type, primary, tier, suggestedTags, raw };
    } catch {
      return { error: `JSON parse failed; raw=${raw.slice(0, 200)}` };
    }
  } catch (e) {
    return { error: `fetch failed: ${(e as Error).message}` };
  }
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  let errored = 0;

  for (const tc of CASES) {
    const result = await detectWorthRemembering({
      userPrompt: tc.userPrompt,
      agentMessagesText: tc.agentMessagesText ?? "",
    });

    if ("error" in result) {
      console.log(`  ! ${tc.name}: ${result.error}`);
      errored++;
      continue;
    }

    const rememberOk = result.shouldRemember === tc.expectRemember;
    const typeOk = !tc.expectType || result.type === tc.expectType;
    const ok = rememberOk && typeOk;

    if (ok) {
      pass++;
      const summary = result.shouldRemember
        ? `[${result.type}/${result.tier}] tags=${result.suggestedTags.join(",")} primary="${result.primary.slice(0, 60)}"`
        : "(skip)";
      console.log(`  ✓ ${tc.name}  ${summary}`);
    } else {
      fail++;
      console.log(`  ✗ ${tc.name}`);
      console.log(`    expected: shouldRemember=${tc.expectRemember}${tc.expectType ? ` type=${tc.expectType}` : ""}`);
      console.log(`    got:      shouldRemember=${result.shouldRemember} type=${result.type} tier=${result.tier}`);
      console.log(`    primary:  ${result.primary}`);
      console.log(`    raw:      ${result.raw.slice(0, 200)}`);
    }
  }

  console.log(`\n${pass}/${pass + fail + errored} passed (${fail} failed, ${errored} errored)`);
  if (errored > 0) {
    console.log("(errored cases indicate Ollama is down / model missing / network issue)");
  }
  process.exit(fail > 0 || errored > 0 ? 1 : 0);
}

/**
 * Note on non-determinism:
 *   Any local model has boundary noise; the suggested-tag set and primary
 *   wording will vary between runs. Primary goal: recall (shouldRemember).
 *   Type/tier are secondary signals.
 */
main().catch((err) => {
  console.error("verifier crashed:", (err as Error).message);
  process.exit(2);
});
