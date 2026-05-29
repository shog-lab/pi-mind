# posts/

pi-mind 项目相关的长文。主要面向**公众号 + GitHub readers**，话题聚焦：

- pi / pi-mind / pi-coding-agent 的设计哲学
- agent 编排 / multi-agent 的判断
- 工程纪律：dogfooding / no-dual-write / e2e-before-publish 这些原则的故事
- 项目演化中的 framing-level 决策（删 ralph、memory passive、bus 设计等）

## 文件约定

```
posts/
├── README.md                    本文件
├── YYYY-MM-DD-slug.md           一篇文章
└── images/                      （仅在有配图时创建）
```

文件名：日期前缀 + kebab-case slug，例：
- `2026-05-29-claude-workflows-vs-glass-box.md`
- `2026-05-28-ralph-removal.md`

## Frontmatter

每篇文章开头：

```yaml
---
title: "文章标题"
date: 2026-05-29
status: draft           # draft | scheduled | published | archived
tags: [agent, philosophy]
wechat_id: ""           # 发布后填入文章 ID（用于回溯 / 反链）
---
```

`status` 流转：
- `draft` — 写作中，公开 commit（参见下文"为什么 drafts 也公开"）
- `scheduled` — 内容定了，等节奏发布
- `published` — 已发公众号，`wechat_id` 已填
- `archived` — 已发但已下线 / 失效，留档不删

## 为什么 drafts 也 commit 公开

跟 pi-mind 自身的 design principle 一脉：**glass-box over black-box**。

写作过程公开有几个收益：
1. **Dogfood 自己的哲学** — 我们写"agent 应该 in-the-loop 透明"的文章，自己写作过程也透明
2. **草稿迭代可追溯** — 一篇文章从初稿到发布，git log 能看见演化
3. **诚实定价** — 不假装"灵感乍现写出完美文章"，承认写作是反复修改的工程

不适合公开的内容（NDA / 个人隐私 / 涉及未公开数据）—— **不要写在这**。换别处。

## 发布工作流（人工，repo 外）

发布工具（公众号 API / markdown→wechat 格式转换 / 配图上传等）**不在 repo 里**。
原因：
- 涉及 token / 个人 auth，不该提交
- 工具栈可能变（今天用 A，明天换 B）
- 跟内容耦合弱

发布流程大致：
1. 在这里写 / 修，`status: draft`
2. 自审 + 终稿
3. 用外部脚本格式转换 + 上传公众号
4. 发布后回来改 `status: published` + 填 `wechat_id`
5. commit

## 主题边界

写**这里**：
- ✅ 关于 pi / pi-mind / pi-coding-agent 的设计与故事
- ✅ 由 pi-mind 经验衍生的 agent 设计思考
- ✅ 跟 pi 生态相关的行业观察

**不**写这里（属于"另一个 repo / 另一个事"）：
- ❌ 通用 AI 行业新闻评论
- ❌ 个人生活 / 不相关技术
- ❌ 跟 pi-mind 完全无关的客户工作

边界模糊的内容（比如"Claude Code 动态" — 跟 pi 比较的角度可以写；纯产品发布评论别写），自己拿捏。

## 索引

（按时间倒序，最新在上；published 单独标记。手动维护即可，文章不多。）

| 日期 | 标题 | Status |
|---|---|---|
| 2026-05-29 | [Claude shipped agent workflows the week I deleted mine](2026-05-29-claude-workflows-vs-glass-box.md) | draft |
