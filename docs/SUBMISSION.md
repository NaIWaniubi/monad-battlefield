# MONAD BATTLEFIELD · MOJO 提交文案 / Submission Copy

> 2026-11-21 广州 Monad Blitz · 可直接复制粘贴。链上数据于提交时经 `testnet-rpc.monad.xyz` 复核。
> 注：本文案所有数字均可在公开仓库与区块浏览器验证；蜂群笔数按 RUNBOOK 的"照顶栏说话"原则如实标注，不夸大。

---

## 中文（约 640 字）

**一句话**：我们没写一行并行代码，只是把状态切成 2500 个互不相干的格子，让 Monad 的并行 EVM 去跑它们——屏幕上每一次变色、每一声，都是一笔真实链上交易。

**为什么必须是 Monad**：合约只有一个 `Cell[2500]`，每格独占一个 storage slot，`claim` 只写自己那一格——没有全局计数器、没有共享余额、没有锁。并发 claim 之间写集零重叠：这正是并行 EVM 的用武之地。说清楚一点：若状态重叠（比如加个全局计数器），按官方语义不会"退化成串行队列"，而是触发乐观并行执行的**冲突重执行**——显著拖慢吞吐、把并行红利大部分吐回去；我们零重叠，所以零重执行税。真正的上限不是链，是独立付款地址数（一个 EOA 的交易被 nonce 严格串行），外加每道自己的物理限速：余额 <10 MON 的 EOA 被 Monad reserve-balance 规则限到 1 tx/3 块 ≈ 0.83 tx/s。

**现场长什么样**：投影上一块实时 TPS 的活格子；78 名观众扫一个码，无钱包、无 gas、不装任何东西，点自己那一格，大屏立刻变色并响一个音（四阵营 = 四声部，声音本身就是 TPS）。导演按一下，全场安静 5 秒，随后 240 笔在 0.42 秒内**全部提交发出**，再在接下来几个区块内落链（0.42s 是提交铺开窗口，不是入块时间——照屏幕说话）。

**技术 + 链上证据（均可查，chainId 10143）**：合约 `0xd525ef7ee4072e80765fd61633d80322040afd9d`，部署区块 `79333331`，字节码 creation 707 / deployed 676；单笔 claim 按 `gasLimit=60,000` 计费（Monad 按 gasLimit 计费，回执实测 `gasUsed==gasLimit`；硬下限 50k→0/3、60k→3/3）；车道统一走 legacy + 显式 gasPrice（我们的日志更稳，未存档 type-2 被拒的原始错误串，故不作强断言）；观众端到端真实回执 tx `0x36f2c5ea…8536`，status SUCCESS、区块 79578040、`Claim(cell=1873)`，手机经公网 HTTPS 隧道点击、服务端代签、上链、事件回显全程跑通。**并行执行的直接物证**：区块 #81474005 一个 ~1 秒块内 17 笔 claim 来自 **17 个不同 EOA**、全部落块（复现命令见 `docs/EVIDENCE.md`）。蜂群窗口：前 30 秒提交 253 笔全部被节点接受、0 失败（均值 8.4 tx/s），实测峰值 **16 tx/s**@17 条车道——正好压在 reserve 理论线 0.83×17≈14.2 上；253 笔后撞上限速墙，窗口内共 359 笔被节点接受、其余被链拒（fail=6421，即测试网 gas 耗尽，故 `budget.mjs` 是上台第 0 步）。全场**真落块 373 笔** = 蜂群窗口 362 + 冒烟 1 + 观众 sync 10。**80 tx/s 只是配置目标**（40 道 × 2 tps，需每道 ≥10 MON、约 400 MON 储备），从未以实测口径宣称。

**与同类工具的区别**：普通 benchmark 写同一变量，写集重叠会让乐观并行执行反复重执行冲突批次；AMM 压测共享同一资金池、被单地址 nonce 排队；像素画板根本不上链。我们四点都不同：格间零共享（零重执行税）、独立钱包即车道、每笔带链上哈希、观众无钱包亲手参战。

**已验证 / 现场演示**：已验证 = 上述合约、同块 17 发送方物证、观众回执、60k 计费口径、296 tests单测、六道门禁（密钥扫描/tsc/build/vitest/二维码解码/跨设备控场）。现场满屏密度与静默墙取决于当天预算：吞吐目标 80 tx/s 需每道 ≥10 MON（约 400 MON 储备）+ 足额 gas，够才可能接近它；不足则顶栏如实标 `DEMO+链上`，**每秒笔数只照顶栏念，不说记忆里的数**。

**90 秒演示（一句话版）**：每次变色每声 = 链上交易 → 指顶栏 TPS 照念、讲 17 条独立钱包与 reserve 物理线 → 评委扫码抢格 → 切浏览器指真实哈希 → 静默 5 秒 240 笔齐发（0.42s 提交窗口、随后几块落链）→ "以太坊每秒 80 笔的交互体验不可能：gas 价格 × 确认等待" → 收："我们没写一行并行代码，只是把状态切成 2500 个互不相干的格子。"

**栈**：solc-js + viem + Canvas + WebAudio + node:http，零新依赖、无 Foundry。

---

## English (~470 words)

**One-liner**: We did not write a single line of parallel code. We partitioned state into 2,500 cells that share nothing, and let Monad's parallel EVM run them — every colour change and every note on screen is one real on-chain transaction.

**Why it must be Monad**: The contract is just a `Cell[2500]`. Each cell packs into one storage slot, and `claim(id)` writes only to `cells[id]` — no global counter, no shared balance, no lock. Simultaneous claims have disjoint write sets, which is exactly the workload a parallel EVM exists for. Stated precisely, because this is the most-misquoted point about parallel EVMs: overlapping state (a global counter, say) would *not* turn execution into a serial queue — the optimistic parallel executor would **re-execute** the conflicting batch, a significant throughput tax that hands back most of the speed-up. Zero overlap means zero re-execution tax. The real ceilings are physical: one EOA's transactions are strictly nonce-ordered (so parallelism = number of independent payers), and any EOA holding less than 10 MON is throttled by Monad's reserve-balance rule to 1 tx per 3 blocks ≈ 0.83 tx/s.

**What it looks like live**: A 50×50 grid breathing at live TPS on the projector. 78 audience members scan one QR — no wallet, no gas, nothing to install — tap their cell, and the wall flips colour and plays a note (four factions = four voices; the sound *is* the throughput). One director button: the room goes silent for 5 seconds, then all 240 transactions are **submitted** inside a 0.42 s spread window and land over the following blocks (0.42 s is the submission schedule, not block inclusion — we describe what the screen does).

**Tech + on-chain receipts (all verifiable, chainId 10143)**: contract `0xd525ef7ee4072e80765fd61633d80322040afd9d`, deployed at block `79333331`, bytecode 707 B creation / 676 B deployed; one claim billed at `gasLimit = 60,000` (Monad bills gasLimit — receipts show `gasUsed == gasLimit`; hard floor 50k → 0/3, 60k → 3/3); every lane uses legacy txs + explicit `gasPrice` uniformly (stable in all our logs; no archived type-2 rejection error, so we assert no more); the full audience path verified on-chain — tx `0x36f2c5ea…8536`, status SUCCESS, block 79578040, `Claim(cell=1873)`, from a phone through a public HTTPS tunnel to a server-signed legacy tx to a block to an event. **Direct proof of parallel execution**: block #81474005 holds **17 claims from 17 distinct EOAs** in one ~1 s block, all landed (one-curl reproducible in `docs/EVIDENCE.md`). Swarm window: the first 30 s saw 253 txs accepted by the node with 0 failures (mean 8.4 tx/s); measured peak **16 tx/s** across 17 funded lanes — sitting on the reserve-balance prediction 0.83 × 17 ≈ 14.2; after the 253rd the lanes hit the throttle wall, 359 were node-accepted in the window and the rest were rejected on-chain (`fail = 6,421` — testnet gas exhaustion, which is exactly why `budget.mjs` is step zero before going on stage). **True landed claims for the session: 373** = 362 swarm window + 1 smoke test + 10 audience sync txs. **80 tx/s is a configuration target only** (40 lanes × 2 tx/s; needs ≥ 10 MON per lane, ~400 MON of balance) and has never been presented as a measurement.

**How it differs from comparable tools**: a generic benchmark writes the same variable, so overlapping write sets force the parallel executor to re-run conflicting batches; an AMM stress test shares one liquidity pool and is queued by a single sender's nonce; a pixel drawing board never touches the chain. We differ on all four axes: zero sharing across cells (zero re-execution tax), one funded wallet = one lane, every action carries a chain hash, and the audience participates hands-on without a wallet.

**Verified vs live-demo**: Verified = the contract, the 17-senders-in-one-block evidence, the audience receipt, the 60k billing figure, 296unit tests, and a six-gate check (secret scan / tsc / build / vitest / QR decoded / cross-device control). The full density wall and the silence burst depend on that day's budget: 80 tx/s is the configuration target and needs ≥ 10 MON in every one of 40 lanes (~400 MON of balance) plus gas; if funded, we can approach it and still read the TPS off the top bar; if not, the header honestly reads `DEMO+chain` and we describe what the screen shows, not what we remember.

**90-second demo (one line)**: every change is a transaction → read the TPS off the top bar, tell the 17-lane / reserve-wall story → judges scan and grab a cell → switch to the explorer and point at a hash → 5 s of silence, 240 tx submitted in one 0.42 s window, landing over the next blocks → "80 taps-per-second interactivity is impossible on Ethereum — fee market × confirmation wait" → close: "we wrote no parallel code — we cut state into 2,500 cells that share nothing."

**Stack**: solc-js + viem + Canvas + WebAudio + node:http. Zero new dependencies, no Foundry.

---

## FAQ · 维护者注记 / Maintainer notes

**Q：文档口径改了，为什么不去顺手改 `contracts/Battlefield.sol` 的注释？**
Because comments are **not** stripped from Solidity metadata: any comment edit can change the metadata/cbor hash, and the deployed code at `0xd525ef…fd9d` was built from the current source. Re-compiling after a comment edit would produce bytes that no longer match the on-chain bytecode, silently breaking the "every number is verifiable on-chain" promise. Contract source and its comments are therefore frozen as deployed; all wording corrections live in the docs layer.

**A：为什么不顺手改 `contracts/Battlefield.sol` 的注释？注释会进 Solidity 的 metadata/cbor，改动可能导致重新编译出的字节码与已部署代码对不上，破坏"链上可复核"承诺。合约源码与注释冻结在部署态，所有口径修正只落在文档层。**
