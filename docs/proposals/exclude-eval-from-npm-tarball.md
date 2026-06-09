# Proposal: 把 eval/ 排除出 pi-mind-core 的 npm tarball

> **Note (2026-06-09):** `@shog-lab/pi-mind-core` was renamed to `@shog-lab/pi-memory` in 0.14.0; the on-disk path `packages/core/` became `packages/memory/`. The historical references to `pi-mind-core` / `packages/core` in this proposal are kept verbatim because they describe a 0.7.0 incident and the resolution already shipped in 0.7.x. The "renamed to pi-memory" annotation here is the only callout.

**状态:** 已解决(2026-06-08,迁到 root-level private workspace `eval/longmemeval/`)。
**优先级:** 低。纯发布卫生问题,无功能影响。

## 问题

AGENTS.md 第 17 行明确:LongMemEval harness(`eval/longmemeval/`,原 `packages/core/eval/`,再前 `packages/eval/`)是 **"Internal dev tooling; not published."**

但实际上它**被打进了已发布的 npm 包**:
- `tsconfig`(core)把 `eval/**` 编译进 `dist/eval/`(~19 个 .js + .d.ts 文件)
- `package.json` 的 `files` 白名单是 `dist/**`(通配),把 `dist/eval/` 一并收进 tarball

结果:`@shog-lab/pi-mind-core@0.7.0` 的 tarball 含 `dist/eval/**`(cli / runner / report / datasets / drivers / scoring 等),违反 "not published" 的本意。

**根因**:2026-05-27 把 `packages/eval/` 折进 `packages/core/eval/` 时,只搬了代码位置,没处理"它会被 core 的 build + files 通配顺带发出去"这个副作用。**已于 2026-06-08 解决**: harness 迁到 root-level private workspace `eval/longmemeval/`,`private: true`,不在 core 的 `files` 里,core 的 build/tsc 也不再触发它。

## 影响

小,**不是紧急 bug**:
- 多打 ~19 个文件,包体积略增(eval 部分几十 KB;0.7.0 整包 108KB)。
- 用户装了也不会执行到 eval(它是独立 CLI,不被 extension 入口引用)。
- 0.7.0 及之前所有版本都这样,**不是 regression**,行为一致。

## 修法（任选一,改完发 patch 0.7.1）

1. **tsconfig exclude**(最干净):core 的 tsconfig 加 `"exclude": ["eval/**"]`,让 eval 根本不进 dist。
   - ⚠️ 前置确认:eval 自己怎么跑?README 说 `node packages/core/dist/eval/cli.js …` —— 即 eval **依赖被编进 dist**。若 exclude,得改 eval 的运行方式(比如用 tsx 直接跑 eval/*.ts,不经 dist),否则 dev 跑 benchmark 会断。
2. **收窄 files 白名单**:`files` 从 `dist/**` 改成精确列 `dist/extensions`、`dist/lib`、`dist/scripts`(不含 `dist/eval`)。
   - 优点:不动 build,eval 仍编进 dist 供本地用,只是不发布。**更稳妥,推荐先试这个。**
   - 验证:改完 `npm publish --dry-run` 确认 tarball 不再含 `dist/eval/**`。

## 验收

- `npm publish --dry-run -w @shog-lab/pi-mind-core` 的 tarball 列表里**无 `dist/eval/**`**。
- 本地 `node packages/core/dist/eval/cli.js …`(或新跑法)仍能跑 benchmark。
- bump → 0.7.1,走 [[e2e-before-publish]] + 只读确认([[verify-irreversible-ops-readonly]])。

## 相关
- AGENTS.md:17(eval not published 的出处)
- [[publish-flow]] / [[e2e-before-publish]]
