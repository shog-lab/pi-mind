---
title: "Claude shipped agent workflows the week I deleted mine"
date: 2026-05-29
status: draft
tags: [agent, ralph, philosophy, multi-agent, transparency]
wechat_id: ""
---

> 草稿 / 骨架。本文未写完。

## 一句话

主流平台拥抱 agent swarm 的同一周，我删了自己的 swarm 包。理由不是"他们错了"，是 **"同样的能力，相反的透明度姿态 —— glass-box 不该跟 black-box 抢同样的位置"**。

## 故事线（待铺开）

### 1. 时间线巧合

- 2026-05-28：我 deprecate + 删了 `@shog-lab/pi-goals` —— pi-coding-agent 的 ralph-style autonomous loop 扩展包
- 2026-05-29：Claude Code 发更新，其中一项是 **agent teams + dynamic workflows**，从平台层提供 fan-out N 个 task、每个 task 内含 implementer + multiple verifiers + fixer 的自动编排

我删的东西，被对面平台做成了 first-class feature。这看起来像我赌错了，但实际不是。

### 2. 我为什么删 ralph（简短回顾）

- 跟 snarktank 原版对比，我们 ralph 越长越胖：SQLite + 7-state machine + 4 tools
- 简化到 0.5.0（-61% LoC）后还是觉得多余 —— pi-bus + pi-subagent + git worktree 完全能组合出同样的 workflow
- 删整包，文章后面会展开"为什么 primitive 比 packaged workflow 更对得起 our audience"

### 3. Claude Code 的 dynamic workflow 长啥样

[这里贴那张图 / 描述结构：root → N tasks → implementer + verifiers + fixer → fan-in]

可以注意的几个工程选择：
- **multiple verifiers per task**（不是单 verifier）—— 解决 self-verify 不可信问题
- **dedicated fixer**（不是 "verifier 报错就 retry"）—— 失败有专门 remediation 步骤
- **N 可以 in the 100s** —— 押算力规模
- **运行过程对用户透明吗？** —— 我猜是"进度 + 最终结果"风格，中间步骤不强制看见

### 4. 同样的 workflow，在我 stack 里长啥样

不需要新包，bus + subagent + 一个 coordinator agent prompt 就够：

```
你 → coordinator agent: "对这 N 个 story 各开 implementer + 2 verifier"
coordinator:
  for story:
    impl = spawn_subagent(...)
    v1 = spawn_subagent("verify angle 1: " + impl)
    v2 = spawn_subagent("verify angle 2: " + impl)
    if (!v1.passes || !v2.passes):
      fix = spawn_subagent("fix: ..." + ...)
```

每个 spawn 是一次 tool call，你看见。每个 sub-pi 的 token / error / output 流回 coordinator 的输出。你想 Ctrl+C / 改 prompt / 跳过任何一步都可以。

### 5. 真正的差异 —— 不在 capability，在 transparency posture

| | Claude Code | pi-mind primitives |
|---|---|---|
| 编排逻辑 | 平台内嵌 | agent 在 visible turn 里写 |
| 中间步骤 | 进度条 / log | 每个 spawn 是 tool call |
| 失败 | 自动 fixer 介入 | 错误返回，agent 决定 |
| 心智模型 | 魔法 | unix pipe |

**Same capability surface, opposite transparency posture.**

### 6. 谁对，看 audience

[展开两类用户：type-prompt-walk-away vs in-the-loop deeply]

不是"我对他错"。是**两个平台为两类用户在做不同的赌注**。

### 7. 为啥我们这一层（extension）适合 glass-box

[展开：为啥 application infra vs platform infra 在这点上选择不同]

- 平台 owners 有运营 verifier 的 budget；extension 没有
- 平台需要服务 majority；extension 可以服务 minority
- 平台输给"用户被打扰"；extension 输给"用户失去控制"
- **平台 → 减少摩擦；extension → 提供 leverage**

### 8. 结尾

[关于"how to know whether you're building primitives or trying to build a platform"]

…

---

## 写作 TODO

- [ ] 把 Claude Code 那张图 embed / 转图
- [ ] 把删 ralph 的 commit hash + diff 数据塞进去（d0454e1 / -1352 LoC）
- [ ] 取舍：要不要点 Mario 名字 —— 倾向不点（让论点 self-stand）
- [ ] 结尾召唤性：用 pi-mind 真实用户的好处不是"少卷功能"是"看见每一步"
- [ ] 字数控制：公众号 ~2500-3500 字最佳，本文目前会偏长，狠剪
- [ ] 配图：那张 Claude Code workflow diagram 是必须的；可能也要一张我们 bus+subagent compose 的对比图

## 参考

- Claude Code release notes（待补 URL）
- pi-mind v0.5.1-final-pi-goals tag
- pi-mind commits: 9ad6446（design principles）/ d0454e1（ralph 删）/ 1010345（memory-audit rename）/ 7c8d7aa（reframe ralph row）
- snarktank/ralph repo
