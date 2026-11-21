# PR-TEMPLATE · 三段模板(机制 / 实测数据 / 已知边界)

> 用法:复制下面整块进 PR 正文。三段都是**必填**,写"无"也要写。口径纪律(全项目通用):实测与配置目标分栏、数字带出处、被拒的点击说"提交"不说"落块"、顶栏显示什么台上讲什么(RUNBOOK.md:151,276)。

---

```markdown
## 机制(改了什么原理层的东西)

- 一句话:______
- 影响面:合约语义 / 中继协议 / 前端契约 / 运维脚本(勾,并在 docs/API.md 或 REUSE.md 同步口径)
- 是否动 `contracts/Battlefield.sol` 或其注释?☐ 是 ☐ 否 —— **选"是"需先读 docs/SUBMISSION.md FAQ**:
  注释进 metadata/cbor,重编译会破坏与已部署字节码 0xd525ef…fd9d 的一致性;默认答案是冻结不动。

## 实测数据(跑出来的,不是设计值)

| 指标 | 值 | 怎么测的(命令/日志/回执) |
|---|---|---|
| ______ | ______ | ______ |

规则:
- 实测/目标分列:配置算术(如 80 tx/s = 40 道×2 tps)永远不许落进本表,放"机制"或注明"目标";
- 每个数带复现入口(curl/日志行/tx hash);门禁必须全绿:`node scripts/gate.mjs` 退出码 0,贴末尾几行。

## 已知边界(没测的、测不动的、会被评委戳的)

- 未验证:______(参照 README.md "Not verified" 段的写法:触摸/投影/深历史一类)
- 环境依赖:______(如公共 RPC 100 块日志窗、reserve-balance 0.83 tx/s/道)
- 口径冲突自查:本 PR 数字与 README / SUBMISSION / docs/COST.md 是否一致?☐ 已对 ☐ 有差异(说明为什么)
```

---

## 填写范例(以 v3「静默墙」PR 为例,数据全真)

- 机制:director POST `type:"burst"` → 中继静默 5.2 s 后在 420 ms 内均匀提交 ≤600 笔(index.mjs:148-154,526-547);0.42 s 是**提交铺开窗口**,不是入块时间。
- 实测:蜂群窗口前 30 s 253 笔节点接受、0 失败,均值 8.4 tx/s、峰值 16 tx/s@17 道(swarm-live.log);真落块全场 373 = 362+1+10(README.md:59)。
- 边界:relay key 没 gas 时 burst 只出涟漪与音效、不上链(RUNBOOK.md:270);同块多 sender 直接物证当前锁定在 #81474005(17/17,EVIDENCE.md),更深的历史受 100 块窗口限制。

---

来源核对:docs/SUBMISSION.md:50-53(FAQ 冻结理由);docs/RUNBOOK.md:151,221,270,276,461-470;server/index.mjs:148-154,526-547;README.md:59,200-204;swarm-live.log:1688(sent=359 fail=6421);docs/EVIDENCE.md:8-14。
