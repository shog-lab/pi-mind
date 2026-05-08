/**
 * Verify feedback detection prompt quality.
 * Runs against live Ollama — not part of `npm test` (integration, needs network).
 *
 * Usage (run via CLI inside container):
 *   echo "node scripts/verify-feedback.ts" | npx tsx scripts/cli.ts <group>
 *
 * Or from host with localhost Ollama:
 *   OLLAMA_URL=http://localhost:11434 npx tsx scripts/verify-feedback.ts
 *
 * Note: Defaults to localhost; override via OLLAMA_URL env if Ollama lives elsewhere.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LLM_MODEL = "qwen2.5:1.5b";
const VALID_TYPES = ["correction", "complaint", "preference", "self-admission"] as const;
type FeedbackType = typeof VALID_TYPES[number];

interface TestCase {
  input: string;
  expectRemember: boolean;
  expectType: FeedbackType | null;
}

const CASES: TestCase[] = [
  { input: "不对吧，应该用 git revert", expectRemember: true, expectType: "correction" },
  { input: "太差了，完全不对", expectRemember: true, expectType: "complaint" },
  { input: "我觉得应该加个日志", expectRemember: true, expectType: "preference" },
  { input: "抱歉，我刚才说错了", expectRemember: true, expectType: "self-admission" },
  { input: "今天天气不错", expectRemember: false, expectType: null },
  { input: "帮我查一下这个bug", expectRemember: false, expectType: null },
];

interface LlmResult {
  shouldRemember: boolean;
  subType: FeedbackType;
  raw: string;
}

async function detectFeedbackWithLLM(text: string): Promise<LlmResult> {
  const prompt = [
    "判断用户输入是否值得记忆为反馈，并分类。",
    "",
    "值得记忆（answer=是）：",
    "  - 纠正 agent 错误（不对、应该是、你搞错了）",
    "  - 抱怨或不满（太差了、垃圾、根本不行）",
    "  - 透露偏好或建议（我觉得应该、我更喜欢）",
    "  - 承认自己错误或收回（抱歉我错了、我收回刚才说的）",
    "",
    "不值得记忆（answer=否）：",
    "  - 正常提问和请求（帮我查一下、告诉我怎么做）",
    "  - 无情绪的闲聊（今天天气不错）",
    "",
    "分类（只在answer=是时填写）：",
    "  correction: 纠正 agent 的错误",
    "  complaint: 抱怨或不满",
    "  preference: 透露偏好或建议",
    "  self-admission: 承认自己错误或收回之前的话",
    "",
    `用户输入：${text}`,
    "",
    '回复格式：{"answer": "是"或"否", "type": "correction"|"complaint"|"preference"|"self-admission"}',
  ].join("\n");

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      format: "json",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = (await resp.json()) as { message?: { content?: string } };
  const raw = (data.message?.content ?? "").trim();

  let shouldRemember = false;
  let subType: FeedbackType = "preference";
  try {
    const json = JSON.parse(raw) as { answer?: string; type?: string };
    if (json.answer === "是") shouldRemember = true;
    if (VALID_TYPES.includes(json.type as FeedbackType)) {
      subType = json.type as FeedbackType;
    }
  } catch {
    // parse failure → miss
  }
  return { shouldRemember, subType, raw };
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;

  for (const tc of CASES) {
    const result = await detectFeedbackWithLLM(tc.input);
    const rememberOk = result.shouldRemember === tc.expectRemember;
    const typeOk = tc.expectType === null || result.subType === tc.expectType;
    const ok = rememberOk && typeOk;

    if (ok) {
      pass++;
      console.log(`  ✓ [${result.subType}] "${tc.input}"`);
    } else {
      fail++;
      console.log(`  ✗ "${tc.input}"`);
      console.log(`    got:      shouldRemember=${result.shouldRemember}, type=${result.subType}`);
      console.log(`    expected: shouldRemember=${tc.expectRemember}, type=${tc.expectType ?? "—"}`);
      console.log(`    raw: ${result.raw}`);
    }
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

/**
 * Note on non-determinism:
 * qwen2.5:1.5b can produce inconsistent sub-types for borderline inputs
 * (e.g. "太差了" sometimes → 是, sometimes → 否). This is expected for 1.5B models.
 * Primary goal: recall (是否值得记). Sub-type is secondary.
 * If strict consistency is needed, upgrade to qwen3:4b or larger.
 */
main().catch((err) => {
  console.error("Ollama unreachable:", (err as Error).message);
  process.exit(2);
});
