# Proposal: `spawn_subagent` 增加 `claude` backend

**状态:** 已设计，**暂缓实施**（2026-06-01 决定先不做，避免过早增加复杂度）。
**动机:** 担心本地模型（MiniMax 等）能力不足时，让 pi 能把“复杂临时任务”外包给 Claude Code CLI（`claude -p`）。Claude 在这里是一个 **fire-and-forget 的可调用执行器**（语义同 `spawn_subagent`），不是 bus 上的常驻 peer，也不是又一个 pi 窗口。
**当前决议:** optional `backend`，默认 `pi`；`claude` 分支用 `spawnProcess` + `stdin: "devnull"` + 内置 `personaPrompt`；不返回 tokens；不直接写 memory/skill 等持久状态；semver 属 minor。

## 核心洞察

`spawn_subagent` 本质是“spawn 一个 CLI 执行器”。pi 是一种 backend，claude 可以是另一种。所以这不是新做一个工具，而是给现有工具加一个 `backend` 开关：

```ts
spawn_subagent({ cwd, prompt, backend: "pi" })      // 默认，现状
spawn_subagent({ cwd, prompt, backend: "claude" })  // 新增，spawn `claude -p`
```

默认仍是 `backend: "pi"`，旧参数和旧返回行为不变，因此这是 **minor** 级增量。只有改默认 backend、移除/改名现有参数，或改变 pi backend 的既有行为，才是 major / breaking。

## 已验证的前置事实（probe，2026-06-01）

- `claude` 在 PATH 上（`/Applications/cmux.app/.../bin/claude`，v2.1.157）。
- `claude -p "..."` 能跑通，无需额外鉴权（已登录），简单问题约 4.5s。
- ⚠️ **关键坑：`claude -p` 不给 stdin 时会傻等 3s 并把一行 `Warning: no stdin data received...` 混进输出。** 必须显式接 `/dev/null`，这是把它当工具调用的必需姿势，否则每次 +3s 延迟且污染返回内容。
- `claude --help` 确认支持 `-p` / `--append-system-prompt`（接文本或文件）/ `--model`。它**不认** pi 的 `--mode json` / `--no-extensions` / `-e`。

实施前还需补 probe：

- 验证并记录 Node `spawn(..., { stdio: ["ignore", ...] })` 与显式 `openSync("/dev/null", "r")` 的行为差异；无论平台实现是否等价，claude backend 都使用显式 `devnull` 模式。
- 验证 `claude -p <prompt> --append-system-prompt <built-in personaPrompt>` 的真实语义：system prompt 是否被注入、是否与 `-p` 的 prompt 重复或冲突。

## 设计决议

### D1. `backend` 是 optional，默认 `pi`

`SubAgentParams` 增加：

```ts
backend?: "pi" | "claude"
```

默认值为 `"pi"`，确保现有调用方无感。

### D2. claude backend 暂不提供 token 统计

pi backend 仍可能在 tool result details 里返回：

```ts
{ tokens: PiTokens }
```

claude backend 只返回纯文本结果，**不返回 tokens**。`details.tokens` 保持 optional；测试和 E2E probe 必须显式断言 claude 分支 `tokens` absent / `undefined`。

暂不采用 `claude -p --output-format json`：这会引入第二套 JSON 解析和错误处理，超出本 proposal 的最小增量目标。

### D3. `spawnProcess` 单独成文件

新增 `packages/utils/src/spawn-process.ts`，承接通用 subprocess 能力；`spawn-pi.ts` 保留 pi 专属逻辑（`--mode json`、event stream 解析、token 提取）。

`packages/utils/src/index.ts` export `spawnProcess`，供 `pi-subagent` 的 claude backend 使用。

### D4. stdin 模式命名为 `devnull`

不用 `stdin: "null"`，避免和 JavaScript `null` / Node stdio 习惯混淆。

```ts
stdin?: "ignore" | "inherit" | "pipe" | "devnull";
```

两者实现语义必须分清：

- `"ignore"`：使用 Node stdio 的 `"ignore"`，用于保持现有 `spawnPi` 行为不变。
- `"devnull"`：显式 `openSync("/dev/null", "r")`，把该 fd 作为 child stdin；这是 claude backend 的强制模式。

即使某些平台上 Node `"ignore"` 最终也可能接到 `/dev/null`，代码层仍保留 `"devnull"` 这个显式模式，避免把“保持旧 pi 行为”和“为 claude 消除 stdin warning 的工具调用姿势”混成一个语义。

### D5. claude prompt 拼接不重复 task

claude 分支参数拼接拍板为：

```ts
const args = ["-p"];
if (model) args.push("--model", model);
args.push("--append-system-prompt", personaPrompt);
args.push(params.prompt);
```

规则：

- `personaPrompt` 由工具内置构造，不是 `SubAgentParams` 暴露给调用方的新参数。
- 实现层仍通过 Claude CLI 的 `--append-system-prompt <personaPrompt>` 传入 persona / rules；表格里的 `<built-in personaPrompt>` 指的是这个内置字符串。
- 用户任务只放 `-p` 的 prompt 参数。
- 不把 `Task: ${params.prompt}` 同时塞进 system prompt，避免 prompt 重复。
- 不传 pi 专属参数：`--mode json`、`--no-extensions`、`-e`。

### D6. stderr 是公共结果的一部分

`spawnProcess` 必须同时收集 stdout 和 stderr：

```ts
type SpawnProcessResult = {
  pid: number;
  code: number | null;
  killed: boolean;
  rawStdout: string;
  rawStderr: string;
  /** Present for spawn-level failures such as ENOENT/EACCES. */
  error?: string;
};
```

claude backend 错误处理：

- timeout / killed：返回 tool error `Sub-agent timed out after ${timeoutSec}s`。
- `code === 0`：返回 `rawStdout.trim() || "Done."`。
- `code !== 0`：返回 tool error，内容优先级为 `rawStderr || rawStdout || Sub-agent exited with code ...`。
- spawn-level error（例如 `ENOENT` / `EACCES`）：返回 tool error，内容优先级为 `error || rawStderr || rawStdout || Failed to spawn ...`。
- `CLAUDE_BIN` 不存在 / 不可执行必须产生可诊断错误，不应只表现为空输出、generic killed，或被误报为 timeout。

## 实施方案

### 第 1 步：`packages/utils` — 剥出通用 spawn 层

新增 `spawnProcess`（`packages/utils/src/spawn-process.ts`）：把现 `spawnPi` 里“纯 spawn + 进程组收口 + timeout + stdout/stderr 收集 + stdoutFile”的逻辑抽成不认识 pi 的通用函数。

它只负责：

- `child_process.spawn`
- `detached: true`
- `process.kill(-pid, signal)` 进程组 kill
- SIGTERM 后 SIGKILL backup
- timeout
- stdout/stderr 行或 chunk 收集
- 可选 `stdoutFile`
- stdin 模式（尤其是 `devnull`）

大致签名：

```ts
spawnProcess(opts: {
  bin: string;            // "pi" | "claude" | custom executable
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: "ignore" | "inherit" | "pipe" | "devnull";
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  stdoutFile?: string;
  timeoutMs?: number;
}): Promise<{
  pid: number;
  code: number | null;
  killed: boolean;
  rawStdout: string;
  rawStderr: string;
  error?: string;
}>;
```

`spawnPi` 改成薄封装（**公开签名/行为不变**）：

- 内部调用 `spawnProcess({ bin: PI_BIN, args: withJsonMode(...), stdin: "ignore" })`。
- 对 `rawStdout` 跑 `extractTokensFromStream` / `processEventLine`。
- 继续保证 `onStdout` 只收到 pi assistant text delta，而不是 raw JSON。
- 继续保证 `SpawnPiResult.tokens` 只来自 pi `agent_end` usage。

### 第 2 步：`packages/subagent` — 加 backend 分叉

`SubAgentParams` 加可选 `backend: "pi" | "claude"`（默认 `"pi"`）。`execute` 按 backend 分叉：

| | `pi`（默认，现状） | `claude`（新增） |
|---|---|---|
| bin | `pi`（`PI_BIN`） | `claude`（`CLAUDE_BIN` env，默认 `"claude"`） |
| 参数 | `-p --no-extensions [--model] -e web-search --append-system-prompt <persona+task> <prompt>` | `-p [--model] --append-system-prompt <built-in personaPrompt> <prompt>` |
| stdin | `ignore`（保持现状） | **`devnull`**（显式 `/dev/null`） |
| 输出 | pi JSON event stream → text delta + optional tokens | 纯文本 stdout → trim；无 tokens |
| stderr | 透传给 error path | 非 0 时优先作为 error message |

claude 分支**必须用 `spawnProcess` 而非 `spawnPi`**，因为 Claude Code CLI 不认 `--mode json` / `--no-extensions` / `-e`。

### 第 3 步：测试

#### utils: `spawnProcess` 直测

建议新建 `packages/utils/src/spawn-process.test.ts`（不要塞进 `spawn-pi.test.ts`，避免 pi 专属语义和通用 spawn 语义混在一起）：

- stdout / stderr 同时收集并返回 `rawStdout` / `rawStderr`。
- `stdin: "devnull"` 确实接 `/dev/null`（fake binary 可检测 stdin 立即 EOF）。
- timeout 时 kill 整个进程组。
- spawn error（binary 不存在 / 不可执行）返回可诊断结果：`error` 包含 ENOENT/EACCES 等信息，且不被误判为 timeout。

#### subagent: fake-claude

加 fake-claude 脚本，通过 `CLAUDE_BIN` override 验证：

1. `backend: "claude"` 调的是 claude，不是 pi。
2. 不传 pi 专属参数（`--mode json`、`--no-extensions`、`-e`）。
3. 传 `--append-system-prompt <built-in personaPrompt>` 和单独 task prompt，且 task 不重复塞进 persona；`personaPrompt` 不是调用方参数。
4. stdin 使用 `devnull`，不会触发 fake warning。
5. stdout 当纯文本返回。
6. 非 0 exit code 时 stderr 进入 tool error。
7. `details.tokens` absent / `undefined`。

现有 pi 分支测试应全部不变照过，作为剥离未破坏旧路径的回归保证。

#### fake tests 的边界

fake-claude 可以验证参数、输出、错误、stdin 行为，但**不足以证明 Claude Code 内部嵌套子进程能被进程组收掉**。嵌套收口必须放到真实 E2E probe 验证。

### 第 4 步：E2E probe（铁律 [[e2e-before-publish]]）

发布前写 `.tmp-verify-claude-backend.mjs`，import `dist/`，走真实集成路径，而不是直接测 helper。

必须验证：

- 真调一次 `claude -p`，返回干净文本。
- `stdin: "devnull"` 真消掉 3s warning，stdout 不混 `Warning: no stdin data received...`。
- `--append-system-prompt` 的 persona 语义符合预期，且 task 没被重复注入。
- claude 分支 `details.tokens` absent / `undefined`。
- timeout 时 Claude Code 及其内部子进程被进程组收掉，无残留进程。
- `CLAUDE_BIN` 不存在 / 不可执行时，错误信息可诊断。

## 改动文件清单

| 文件 | 动作 |
|---|---|
| `packages/utils/src/spawn-process.ts` | 新增通用 spawn 层：进程组 kill、timeout、stdout/stderr、stdin devnull |
| `packages/utils/src/spawn-pi.ts` | 改为 `spawnProcess` 的 pi 专属薄封装；公开签名/行为不变 |
| `packages/utils/src/index.ts` | export `spawnProcess` |
| `packages/utils/src/spawn-process.test.ts` | 通用 spawn 直测（stdout/stderr、stdin devnull、收口、spawn error） |
| `packages/subagent/extensions/subagent/index.ts` | 加 `backend` 参数 + claude 分叉（spawnProcess + stdin devnull） |
| `packages/subagent/tests/subagent.test.ts` | fake-claude 测试 + pi 回归测试 |
| `.tmp-verify-claude-backend.mjs`（临时） | 真 claude E2E probe；发布前运行，之后删除或不提交 |
| README / AGENTS.md 相关描述 | 将 `pi-subagent` 描述从“child pi only”扩展为“focused sub-agent/executor backend”，并说明默认仍是 pi |

## Non-goals / Boundaries

- **不把 Claude 变成 bus peer。** 这里的 Claude 是一次性 CLI backend，不是常驻 reviewer / keeper。
- **不让 Claude backend 直接写 memory、skill 或其他持久状态。** 它只返回建议/执行结果。调用方不得给 claude backend 下发“修改 `.pi-mind/` / `.pi/skills/`”之类任务；如需文件级实验，应优先使用 worktree / sandbox。
- **不绕过 ask-first gate。** 如果 parent pi 要根据 Claude 建议写 skill，仍必须先向用户展示草案并等待明确同意。
- **不绕过 memory 的可见写入原则。** 如果 parent pi 在 user-originated 的可见 turn 中根据 Claude 建议调用 `remember_this`，这是合法的；但 Claude 输出不得自动触发后台写入。
- **不把状态写入审批塞进 subagent。** 如果未来要让 Claude 参与“是否允许写状态”的判断，应走 `pi-bus` 的 keeper/reviewer 模式，而不是 `spawn_subagent backend:"claude"`。
- **不保证 claude backend 与 pi backend 拥有同样工具/权限模型。** pi backend 可通过 `-e` 加载受控 extension；claude backend 是 Claude Code CLI 自身能力边界。
- **本轮不做 Claude token 统计。** 如未来需要，可另开 proposal 评估 `--output-format json`。

## Open Questions

暂无必须在实施前继续拍板的问题。当前版本已将 tokens、spawnProcess 位置、stdin 命名、prompt 拼接、semver、Principle 4 边界全部拍板。

未来若要继续扩展，需另开问题：

1. 是否支持 Claude token / cost 统计？若支持，是否采用 `--output-format json`，以及如何避免和 pi JSON event stream 混淆？
2. 是否支持调用方自定义 claude persona？如果支持，应先定义参数形状和安全边界，避免让工具调用方绕过默认约束。
3. 是否要支持除 pi / claude 以外的 executor backend？如果支持，`pi-subagent` 是否应更名或拆包？

## 相关约束

- [[subprocess-group-kill]] — 所有 spawn 必须 `detached: true` + `process.kill(-pid)` 杀整个进程组，并带 SIGTERM→SIGKILL backup；否则 grandchildren 可能继承 pipe fd，导致 Node `'close'` 永远不触发。Claude Code 内部可能再 spawn 子进程，所以更要在 E2E probe 里验收口。
- [[e2e-before-publish]] — 发布前必须 import `dist/` 跑真实集成路径，不能只靠 fake-binary 单测；primitive-level probe 不够，必须测工具 wiring。
- AGENTS.md Design Principles：
  - 行为改变型自治必须 inline gate。
  - memory 是 passive storage，写入来自可见 turn。
  - bus 是 keeper/reviewer 等 graduated autonomy 的 substrate。
  - trigger chain 必须 originate from user action。
