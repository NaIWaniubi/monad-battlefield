# CI · 分支保护与徽章（E0-1 配套文档）

工作流定义在 `.github/workflows/ci.yml`。本文回答三个问题：CI 跑什么、
怎么把 main 锁成「CI 不绿不许进」、绿徽章贴哪。

## 1. CI 跑什么（以及刻意不跑什么）

`build-test` job（矩阵 node **24**，push + PR 全触发），顺序即门禁强度：

| 步骤 | 命令 | 失败含义 |
|---|---|---|
| 装依赖 | `npm ci` | lock 与 package.json 不一致；公共 runner 无凭据也能装 —— 已核 `package-lock.json` 173/173 条 `resolved` 全指 `registry.npmjs.org`，无 `@org` 私包 |
| 类型 | `npx tsc --noEmit` | scripts/** 与 web/src/** 的类型回归 |
| 契约编译 | `npm run build:contract` | solc-js（solc 0.8.28）编不过 Battlefield.sol |
| 单测 | `npx vitest run` | 行为回归（tests/ 全量） |
| 前端构建 | `npm run build:web` | vite 生产构建挂掉 |
| 密钥扫描 | `node scripts/check-secrets.mjs` | 已跟踪文件里出现私钥形状内容 |

**没有 forge 步骤**：本仓库契约验证走 solc-js 路线（README 已如实写明
foundry 未装），CI 与本地一致，不引入没人验证过的命令。

`evidence` job：仅 main 的 push，needs build-test；跑
`node scripts/evidence.mjs`（零 npm 依赖，直连公共 RPC），把产物
`docs/EVIDENCE.auto.md` 以 github-actions[bot] 身份回写提交。整条 job 标了
`continue-on-error` —— **链上证据生成失败（RPC 抽风、公共节点限流）绝不弄红 CI**，
文件头部自带「链上证据自动生成于 <时间戳>」口径，失败时时间戳停在上一次成功，
读者一眼可辨新鲜度。

## 2. 分支保护：把 `build-test (24)` 设成必过

前提：**先让 workflow 至少跑过一次**（推个空 commit 即可），GitHub 才认识
这个 check 名字。命令（需要仓库 admin 的 `gh` 登录态）：

```bash
gh api -X PUT repos/NaIWaniubi/monad-battlefield/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build-test (24)"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

参数逐条为什么这么选：

- `contexts: ["build-test (24)"]`：矩阵 job 的 check 名 = `<job id> (<矩阵值>)`，
  与 ci.yml 对齐；将来矩阵扩到多版本，这里要同步加 `build-test (22)` 等。
- `strict: true`：合入前分支必须先 rebase 到最新 main —— 防「各自绿、合起来红」。
- `required_pull_request_reviews: null`：**故意的**，main 允许直接 push。
  evidence bot 的回写提交走的就是直接 push；若这里改成「必须 PR」，
  证据自动化会被保护规则拒于门外（届时要么在规则里给
  `apps/github-actions` 开绕过，要么把回写改成 bot 开 PR —— 两者都不如现状轻）。
- `enforce_admins: false`：给主控留紧急直推的后门，别把自己锁死在 flaky 外网上。
- `allow_force_pushes/deletions: false`：公开仓库历史不可改写 —— 本项目
  真金白银的教训是密钥进过暂存区，历史就是证据链，禁止覆盖。

查询当前保护配置 / 拆除：

```bash
gh api repos/NaIWaniubi/monad-battlefield/branches/main/protection
gh api -X DELETE repos/NaIWaniubi/monad-battlefield/branches/main/protection
```

## 3. README 绿徽章

把这行插到 README **一级标题（`# …`）正下方**（主控合并时注入，本切片不碰 README）：

```markdown
[![CI](https://github.com/NaIWaniubi/monad-battlefield/actions/workflows/ci.yml/badge.svg)](https://github.com/NaIWaniubi/monad-battlefield/actions/workflows/ci.yml)
```

badge 默认反映默认分支（main）最近一次 run；点开直达 workflow 运行列表。

## 4. 写这份文档时发现的口径备忘（给主控/相关同学）

- `docs/EVIDENCE.md` 的复现 curl 用了 `0x4db8035`，它其实是 **81494069** 块；
  表格指名的 17-claim 块 81474005 的 hex 是 `0x4db31d5`。已在真实 RPC 上核对：
  81474005 确实有 17 条 Claim（事件口径与区块口径一致），结论不受影响，
  但复现命令改一个字才自洽。
- `tests/budget-watch.test.ts`（他人在途切片）本机满载下 50ms 轮询用例
  1–3 红不等、单独文件可绿；进 main 前请该切片负责人确认 CI 可承受，
  否则 build-test 会红在 vitest 步（按设计如实红，不放水）。
- evidence 的「抽样互证」口径：claim 集中在演示时段爆发，24 个等距 100 块窗口
  （覆盖率 ~0.1%）大多数时段抽到 0 —— 产物里把这点连同 **Σheat 精确总口径**
  （531 @ 2026-11-21，读合约存储，不依赖日志索引）一并写明，引用总数请用后者。
