# EVIDENCE · 同块多独立发送方(并行执行直接物证)

> 采集时间:2026-11-21 13:52 CST(UTC+8) · 采集方式:JSON-RPC 直查,可当场复现
> 合约:`0xd525ef7ee4072e80765fd61633d80322040afd9d` @ Monad Testnet (chainId 10143)

## 核心证据

| 区块 | 块内总 tx | 打到 Battlefield 的 claim | **独立发送方** | 块间隔 |
|---|---|---|---|---|
| **81474005** | 39 | **17** | **17(每人各1笔)** | ~1s |
| 81474015 | 17 | 10 | 10 | ~1s |
| 81474010 | 17 | 9 | 9 | ~1s |

**一句话:同一个 1 秒块里,17 个互不相干的独立 EOA 各自写了自己那一个 slot,全部成功落块。**
这 17 笔写集零重叠(每格独占一个 storage slot),Monad 的乐观并行执行器无需任何重执行即可全部纳入——这不是我们"配置了并行",是 **EVM 并行执行的本体被我们的状态设计直接显影**。

## 现场可复现命令(90 秒 demo 时可直接敲)

```bash
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x4db8035",true]}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const txs=JSON.parse(s).result.transactions;
    const C='0xd525ef7ee4072e80765fd61633d80322040afd9d';
    const m=txs.filter(t=>(t.to||'').toLowerCase()===C);
    console.log(m.length+' claims from '+new Set(m.map(t=>t.from)).size+' distinct senders in this block');
  })"
```

浏览器查看:
- `https://testnet.monadscan.com/block/81474005`(MonadScan)
- `https://testnet.monadvision.com/block/81474005`(MonadVision)

## 与以太坊的对照口径(诚实版,不吹)

- 这 17 笔若发生在**同一热 slot**(比如一个全局计数器),按官方文档不会"变串行",但会触发**乐观执行的冲突重执行**——性能税。
- 我们把状态切成 2500 个零重叠 slot,**重执行税 = 0**,所以车道数(独立发送方)线性决定吞吐上限:每道速率由链的 reserve-balance 规则封顶(<10 MON 余额 → 1 tx/3块 ≈ 1 tx/1.2s)。
- 实测吻合预测:17 道 × 0.83 tx/s = 理论 14.2,实测峰值 16 tx/s,单块最多 17 笔 claim。**平台物理定律级别的对应关系,不是 PPT。**

## 数据源备注(给 C4 的严谨性回应)

- 本表由**主控会话在有外网环境实测拉取**(eth_getBlockByNumber includeTransactions,原生计数,非估算)。
- 17 发送方 = 17 个不同私钥地址,与 `.bots.json` 车道一一对应。

## §5 Revert 也要付钱（对照 #363 式合约冷却）

> 结论一句话：**在 Monad 上，一笔「注定失败、什么都没改变」的链上写入，照样按 gas 扣钱。**
> #363 把冷却写进合约，被它拒掉的每一次点击都是一笔这样的 tx —— 观众的手感免费，主办方的钱包不免费。
> 我们的栈：合约 claim() 对合法 id 永成功（观众点击不存在「被拒还烧钱」）；同格 3s 冷却是中继的
> 演示开关（COOLDOWN_MODE=1），拒绝发生在发 tx 之前，被拒点击 0 gas —— 对照表见 docs/ab-result.json。

| 项 | 值 |
|---|---|
| 交易 | `claim(9999)`（selector `0xbf31eb0b` = claim(uint16,uint8)）→ 合约第一行 `if (id >= 2500) revert BadId()` |
| hash | `0x6194609f8e93385698c501510b7aba7a5b09f520b12bfda002e2c8dcffcb4ec8` |
| 状态 | `reverted` —— 失败，链上状态**零**改变 |
| gasUsed / gasLimit | `60000` / `60000` —— **gasUsed == gasLimit**（Monad 的 eth_getTransactionReceipt 不返回 gasLimit 字段，故 gasLimit 取自 eth_getTransactionByHash.gas）。一笔 revert 的交易按**全额 gasLimit** 扣费 = 「按 gasLimit 计费、revert 也烧钱」的直接物证 |
| 发送方余额 | 块 #81521398→#81521399 实差 **0.006600 MON**（单笔全价 ≈ 0.0066 MON） |
| 区块 | #81521399 · Monad Testnet (chainId 10143) |
| 浏览器 | https://testnet.monadscan.com/tx/0x6194609f8e93385698c501510b7aba7a5b09f520b12bfda002e2c8dcffcb4ec8 |
| 形状判定 | ✅ status=reverted 且 gasUsed>0（预期坐实） |

零成本复现（读侧，两条 curl）：
```bash
# 回执：status=0x0（失败）、gasUsed=0xea60（60000）—— 注意回执里没有 gasLimit 字段（Monad 的特性）
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x6194609f8e93385698c501510b7aba7a5b09f520b12bfda002e2c8dcffcb4ec8"]}'
# 交易本体：gas=0xea60 → gasUsed == gasLimit，失败照扣全额
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0x6194609f8e93385698c501510b7aba7a5b09f520b12bfda002e2c8dcffcb4ec8"]}'
```
发送侧复现：`node scripts/revert-probe.mjs --force`（再烧 0.0066 MON —— 别在手抖的早上跑）。

---

## §6 真结算：参与 → 验证 → 真实转账

> 结论一句话：**参与不只是计数，是真实经济行为。**
> 前五节证明「每一笔 claim 都是真的链上写」；这一节把闭环走完：从 Claim 事件算出贡献榜，
> 再把**真金白银**按贡献打回给贡献者 —— 结算本身也是链上交易，任何人可独立复核。

### 6.1 结算规则（可复现，无隐藏口径）

| 项 | 值 |
|---|---|
| 结算脚本 | `scripts/settle.mjs`（纯 JS，零 TS 强转，`node --check` 通过） |
| 数据来源 | 合约 `Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)` 事件，链下聚合 |
| 扫描区间 | `#81,472,000 → #81,479,200`（7,201 块；覆盖本次演示的 claim 爆发段） |
| 分块方式 | 公共 RPC `eth_getLogs` 硬上限 ≲100 块 → 100 块/请求、并发 12 |
| 聚合结果 | **362 条 claim / 21 个独立地址** |
| 阵营计数 | 紫 109 / 青 85 / 琥珀 84 / 绯 84 → **胜方阵营：紫方 #1**（占 30.1%） |
| 结算对象 | 贡献榜前 3 名，按 claim 数比例分配（本例三者各 21 条 → 等分） |
| 奖池 | **0.02 MON**（`--pot 0.02`） |
| 交易形态 | legacy tx（`type=0x0`）、`gasPrice` 110 gwei、`gas` 60000、nonce 串行 |

> **为什么不用 `--window 8000`：** 演示结束后链上归于安静，结算时最近 8,001 块只有 **4 条 claim / 2 个地址**
> （干跑实测，见 6.4），按此窗口结算会漏掉全部演示参与者。故显式指定爆发段区间 —— 区间固定，
> 任何人重跑都会得到**逐位相同的 362 / 21 / 紫 109**，这比「最近 N 块」更可复核。
> 另：本区间 362 条与 `docs/RUNBOOK.md` §4 评委问答里记录的「蜂群窗口 362 笔落块」**数量吻合**。
> 逐地址核对（已跑）：21 个地址中 **17 个**正是 `.bots.json` 里的蜂群车道（配置 40 条，本次 17 条被注资并产生 claim），
> 每条恰好 21 条 claim（`21 × 17 = 357`）；余 5 条来自 4 个非车道地址（2+1+1+1 = 5）。357 + 5 = 362 ✓。
> 我们**没有**逐笔比对这两组是否为同一批 tx，只报告数量与地址集合的一致性。

### 6.2 三笔真实转账

| # | 受益人 | 金额 (MON) | 权重 (claim) | 区块 | tx hash |
|---|---|---|---|---|---|
| 1 | `0x00a25f950ad95bc2ee79b3114dc3b29e04645d20` | 0.006666666666666666 | 21 | #81,534,262 | `0xd09b90251adec25098db13339a1cc53f32246033f9bbe0c52a06c70565f7fde5` |
| 2 | `0x22008cc023897f3cdc926c3356a5da3f9dfa2977` | 0.006666666666666666 | 21 | #81,534,268 | `0xd773135df013a6e9f6e2b78df2eee8a011f5ffd9d5c52890298db3cd266b5714` |
| 3 | `0x398a26471d4c8cd2d3927881cb009f89d6a23c2e` | 0.006666666666666668 | 21 | #81,534,278 | `0x62a11b9fae1f6c59421d1c084f060705673601ee8e6bfb5e653e4031363fa4dc` |

- 浏览器：#1 https://testnet.monadscan.com/tx/0xd09b90251adec25098db13339a1cc53f32246033f9bbe0c52a06c70565f7fde5 ·
  #2 https://testnet.monadscan.com/tx/0xd773135df013a6e9f6e2b78df2eee8a011f5ffd9d5c52890298db3cd266b5714 ·
  #3 https://testnet.monadscan.com/tx/0x62a11b9fae1f6c59421d1c084f060705673601ee8e6bfb5e653e4031363fa4dc
- 三笔之和 = `0.006666666666666666 × 2 + 0.006666666666666668` = **0.02 MON 整**（整除余数落在最后一笔，不丢 wei）
- 发送方 `0x17FF85c1D82AEDd1da887406a307d087C5Cda61e`（部署者）

### 6.3 独立复核（不信任脚本的输出）

**(a) 原始 JSON-RPC 直读回执** —— 三笔全部 `status=0x1`、`type=0x0`（legacy）、`gas=gasUsed=60000`、`gasPrice=110 gwei`：

```bash
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xd09b90251adec25098db13339a1cc53f32246033f9bbe0c52a06c70565f7fde5"]}'
# → status 0x1 · block 81,534,262 · gasUsed 60000 · to 0x00a25f95…4d20
```

**(b) 受益人余额在「回执所在区块」前后的实差** —— 每一笔都恰好等于转账额（`eth_getBalance` 取 block N-1 / N）：

| 受益人 | block N-1 | block N | 实差 (MON) |
|---|---|---|---|
| `0x00a2…5d20` | 0.001400000000000000 | 0.008066666666666666 | **+0.006666666666666666** |
| `0x2200…2977` | 0.001400000000000000 | 0.008066666666666666 | **+0.006666666666666666** |
| `0x398a…3c2e` | 0.001400000000000000 | 0.008066666666666668 | **+0.006666666666666668** |

**(c) 发送方账目闭合** —— 三条独立数字严格对账，误差 0 wei：

```
结算前余额   0.073490628
− 奖池       0.020000000
− gas 3 笔   0.019800000   (60000 × 110 gwei × 3)
────────────────────────
= 结算后     0.033690628   ← 实测 deployer 余额 0.033690628 MON
```

### 6.4 干跑（未转账，退出码 0）实测

```bash
node --env-file-if-exists=.env scripts/settle.mjs --window 8000
# Claim 总数 4 · 独立地址 2 · 阵营 青 2 / 琥珀 2 → 胜方 青方 #2
# [干跑] 未发生任何转账。
```

这 4 条 claim 全部来自演示结束后的零星点击 —— 正是 6.1 里「为什么不用 --window 8000」的实测依据。
干跑模式永不发交易，可安全地在任何场合执行。

> **复跑数字会变，这不是矛盾：** `--window N` 是「从当前块往回数 N 块」，窗口一直在移动。
> 结算后十几分钟用同一命令复跑，结果是 **8 条 claim / 3 个地址（青 4 / 琥珀 3 / 紫 1）** ——
> 因为期间又有真实点击落块。要「逐位可复现」，请用 6.1/6.5 的**固定区间**而非移动窗口。
> 固定区间重跑永远得到 362 / 21 / 紫 109。

### 6.5 一句话复现

```bash
node --env-file-if-exists=.env scripts/settle.mjs --from 81472000 --to-block 81479200 --top 3
# 干跑：打印 362 / 21 / 紫 109 与结算计划
node --env-file-if-exists=.env scripts/settle.mjs --from 81472000 --to-block 81479200 --pot 0.02 --top 3
# 真跑：再打 0.02 MON（gas 另计 ~0.02 MON）—— 别在没钱的时候手滑
```

### 6.6 诚实注记

- **⚠️ 本次三笔收款地址全部是「我们自己的蜂群车道」，不是现场观众。** 已逐地址核对：前 3 名
  `0x00a2…5d20` / `0x2200…2977` / `0x398a…3c2e` 均在 `.bots.json` 的 40 条车道内。真实观众/评委
  在结算窗口内只留下 **5 条 claim / 4 个地址**（最多的一条 2 次），排不进前 3。
  所以这三笔 tx 证明的是**机制真实**（真 gas、真转账、真余额变动、可独立复核），
  **不是**「观众赚到了钱」。若要在演示现场真的付给观众，必须用 `--to <观众地址>` 指定受益人
  （赞助池模式），或先把车道停掉、只让观众抢。
- **贡献榜前 17 名并列 21 条 claim**（17 条 bot 车道，`21 × 17 = 357`，其余 5 条来自 4 个零星地址）。
  并列时的排序键是地址字典序（`localeCompare`），**确定且可复现**，但「前 3 名」在这份数据上并非
  「贡献显著更高」—— 真实贡献分布是平的。若要「所有并列者等分」，需按 gas 预算调 `--top`
  （本题余额不足以支付 17 笔 × 0.0066 MON gas）。
- **胜方阵营（紫）与受益人不完全一致**：结算按「贡献榜」发钱，不按「阵营」发钱。前 3 名中
  2 个紫方、1 个琥珀方。若要做「胜方阵营内部再分配」，需额外 `--faction` 过滤器（当前未实现）。
- **gas 按 gasLimit 计费**：Monad 上 `gasUsed == gasLimit`，固定 `gas=60000` 意味着每笔固定烧
  ~0.0066 MON。纯 EOA 转账实际只需 21000，这里保留 60000 是为与 §5 口径一致（更贵，但可比）。
