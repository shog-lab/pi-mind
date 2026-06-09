# Personas

`personas/` 是 pi-mind 项目的 **repo-local operational orchestration
layer**——一组定义"项目里跑哪几个 pi、各自干什么、互相怎么协作"
的源文件。它**不是**单纯的文档, `prompts/*.md` 是会被
`bin/start.sh` 实际加载到 pi 系统提示词里的人设源, `permissions.md`
是被启动脚本和 prompt 共同遵守的硬/软边界表。

> 本目录的存在目的: 让"派活 → 实现 → 审查 → 用户定夺"这条流水线有
> 明确的、可版本化的源, 而不是每次靠 pi session 里现编。如果发现
> 这里和实际工作方式漂移了, 更新这里的源; 反过来, 别在 session 里
> 临时发明新的人设或规则。

## 文件结构

```
personas/
├── README.md            本文件 — 入口、用法、不做什么
├── permissions.md       权限矩阵 + escalation + 上下文/成本预算
├── prompts/
│   ├── alice.md         Alice 的人设 prompt 源(planner / dispatcher / reviewer / writer / memory lead)
│   ├── bob.md           Bob 的人设 prompt 源(implementer)
│   └── carol.md         Carol 的人设 prompt 源(independent reviewer / methodology auditor)
└── bin/
    └── start.sh         统一启动入口: start.sh alice|bob|carol [extra pi args...]
```

## 启动

```bash
# 在 repo root
./personas/bin/start.sh alice
./personas/bin/start.sh bob
./personas/bin/start.sh carol

# 任何 persona 都可以追加 pi 的额外参数, 例如指定 model / -p 非交互:
./personas/bin/start.sh bob --model openai/gpt-4o-mini -p "what's failing in tests?"
```

`start.sh` 做的事:

1. 解析 persona 名, 校验存在对应 `prompts/<persona>.md`
2. 把 repo root 解析到脚本上两级目录(`personas/bin/` 的上两级)
3. `cd` 到 repo root
4. 设置 `PI_AGENT_NAME=<persona>` — **只在调用方未预先 export 时设置**
5. `exec pi --append-system-prompt <persona.md> [persona-specific excludes] [extra args...]`
6. 对于 bob/carol, 强制 `--exclude-tools remember_this,observe,update_memory,mark_memory_audit_complete,create_skill,update_skill`
   (记忆写入 / skill 演化工具只能 Alice 在用户 gate 下使用; 这是设计, 不是 bug)

`start.sh` **不硬编码 model**——传 `--model` 即可,或设置 pi 自己的环境变量。

## 层级

```
User (最终决定权)
  │
  └─ Alice  ←  planner / dispatcher / reviewer / writer / memory lead
      │
      ├─ Bob      implementer
      └─ Carol    independent reviewer
```

- **User** > **Alice** > **Bob / Carol**。Alice 是这个项目的 lead,
  Bob/Carol 接受 Alice 派活, 但最终所有 publish / deprecate / 破坏性
  操作要回到 User 拍板。
- Bob 和 Carol 之间允许**只限事实/证据/测试输出/复现步骤**的横向沟通;
  任务分派、方案变更、是否合入、是否发布仍然走 Alice。
- 详细边界与权限矩阵见 [`permissions.md`](permissions.md)。

## 三个人分别做什么

详细看各自 prompt: [`prompts/alice.md`](prompts/alice.md) ·
[`prompts/bob.md`](prompts/bob.md) ·
[`prompts/carol.md`](prompts/carol.md)。

要点速记:

- **Alice** — 规划、派活、审查、写长文、记忆主笔。她是"用户授权的代理人",
  所有破坏性操作的最终 gate。
- **Bob** — 执行者。改文件、跑测试、commit(被 Alice 明确派活时)。
  不写记忆、不 publish、不做大方案决定。回报必须贴真实命令输出和 commit hash。
- **Carol** — 独立审查者 + 方法学审计员。默认不改文件、不 commit、不 publish。
  产出 verdict: PASS / CONDITIONAL / BLOCK, 附 Blocking / Non-blocking /
  Evidence / Commands Reviewed / Recommendation。

## 吞吐量优化规则

这套 personas 不是为了让 Alice 永远等 Bob。默认优化如下:

- **低风险小改 Alice 直接做**: README/metadata/typo/config 这类 5 分钟内可完成、验收明确、低风险的改动, Alice 可以直接编辑、自测、汇报用户, 不必排队给 Bob。
- **执行重活给 Bob**: 涉及多文件实现、测试修复、重构、迁移、较长 grep 清理的任务仍派 Bob。
- **高风险任务先让 Carol 方案复审**: rename、publish、eval methodology、权限/persona 设计、公共 API/schema 变化, Alice 可以先让 Carol challenge 方案, 再派 Bob 执行。
- **长任务 checkpoint 化**: Bob 预计超过 10–15 分钟或跨多个子系统时, Alice 派活时要求阶段性 checkpoint(commit 或明确状态), 避免一次大包失败。
- **Alice 派活后不空等**: 派给 Bob 后, Alice 可以并行准备审查 checklist、grep 影响面、写 E2E probe 草稿、或让 Carol 做只读预审。

## 现在**不做**什么

本目录刻意保持简单。当前不做:

- **Global overlay** — permissions 是 repo-local。`browser-mono` 等其他
  仓库如果要复用这套结构, 需要各自建立自己的 `personas/`, 设定自己的边界。
- **Runtime ACL** — `start.sh` 里的 `--exclude-tools` 是唯一机器强制层,
  其他都靠 prompt 软约束。这是设计(`AGENTS.md` Design Principles 的一部分):
  过度工程化的权限系统反而模糊责任归属。
- **Persona DSL** — 没有 YAML / 新框架 / 新 runtime。三个 markdown prompt
  + 一个 shell 启动器 + 一张权限表。如果以后觉得不够, 先在 `AGENTS.md`
  讨论, 再扩展这里。

## 修改这里

- 改 persona 行为 → 改对应 `prompts/*.md`
- 改启动行为 / 强制 exclude → 改 `bin/start.sh`
- 改权限边界 / 升级预算 → 改 `permissions.md`, 在 commit message 里说清楚
- 改协作流程 / 层级 → 改这里和 `AGENTS.md`

`personas/` 是版本化的项目状态, 不再是 `.gitignore` 下的 per-developer
scratch。如果你从新 clone 拉走 repo 后看不到这个目录, 那就是 gitignore /
git add 出了问题, 报给 Alice。
