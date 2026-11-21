# MOJO-DESCRIPTION · 最终提交框文案(中英双语)

> 用途:直接贴进 mojo.devnads.com/events/18 的提交描述框。口径与 docs/SUBMISSION.md 完全一致:实测峰值 16 tx/s@17 道、真落块 373 笔、80 tx/s 仅为配置目标。以顶栏与链上为准,不夸大。

---

## 中文版

**一句话**:我们没写一行平行代码,只是把状态切成 2500 个互不相干的格子,让 Monad 的并行 EVM 去跑它们——屏幕上每一次变色、每一声,都是一笔真实链上交易。

**你抢到的格子 = 你的到场证明,区块浏览器可查。** 每一次点击都由中继服务端代付成为一笔真实交易:有哈希、有区块号、有 `Claim(id, who, color, heat)` 事件。观众全程不碰私钥——无钱包、无 gas、无种子短语,手机只负责"点一下",签名与付费在 throwaway 测试网中继钱包侧完成(sponsor UX),事后任何人都能在 MonadScan/MonadVision 按格子编号反查那笔交易。

**现场长什么样(90 秒脚本一句话版)**:每次变色每声 = 链上交易 → 指顶栏 TPS 照念(实测峰值 16 tx/s@17 条独立钱包,压在 reserve 物理线 0.83×17≈14.2 上)→ 评委扫码抢格 → 切浏览器指真实哈希 → 静默 5 秒 240 笔齐发(0.42s 提交窗口、随后几块落链)→ "以太坊每秒 80 笔的交互体验不可能:gas 价格 × 确认等待" → 收:"我们没写一行平行代码,只是把状态切成 2500 个互不相干的格子。"

**链上证据(chainId 10143,均可复核)**:合约 `0xd525ef7ee4072e80765fd61633d80322040afd9d` @ 部署块 `79333331`;并行执行直接物证 = 区块 **#81474005** 一个 ~1 秒块内 **17 笔 claim 来自 17 个独立 EOA** 全部落块(docs/EVIDENCE.md 一条 curl 可复现);观众端到端回执 tx `0x36f2c5ea…8536`(SUCCESS,block 79578040,`Claim(cell=1873)`);真落块 **373 笔** = 蜂群 362 + 冒烟 1 + 观众 sync 10;单笔成本 **0.0066 MON**(60,000 gas × 110 gwei);**80 tx/s 是配置目标非实测**(40 道 × 2 tps,需每道 ≥10 MON、约 400 MON 储备)。

**与往届 #363 千人像素战争的三点区别(口径见 docs/recon-progress/C4-redteam.done 与 RUNBOOK §4)**:
1. **执行模型**:#363 类画板的状态彼此热竞争;本合约每格独占一个 storage slot、写集零重叠——零重执行税,车道数(独立付款 EOA)线性决定吞吐,且有同块 17 发送方的链上物证。
2. **被拒点击的成本**:#363 把冷却写进合约——被拒的点击照样上链执行、gas 照扣(Monad 按 gasLimit 计费、revert 也付费);本项目的 3 秒同格冷却开关(`COOLDOWN_MODE=1`)放在**服务端代持层**,拒绝发生在发交易之前,一克 gas 都不烧。
3. **交付物性质**:不是玩具,是对并行 EVM 的 workload characterization 实测报告——reserve-balance 限速墙(0.83 tx/s/道)、60k gas 硬下限(50k→0/3)、公共 RPC 100 块日志窗,每条都是量出来的,六道门禁一键复验。

**三张复用卡(这个引擎可以怎么被再用)**

| 谁复用 | 剧本 | 一场成本(0.0066 MON/笔) | 为什么必须并行 EVM |
|---|---|---|---|
| **主办方**(黑客松/发布会) | 开场 90 秒:全员扫码抢格 → 静默墙 240 笔齐发作集体揭幕 | 78 人各 1 笔 + 240 笔静默墙 ≈ **2.1 MON**;含 10 分钟中速蜂群 ≈ 4~11 MON | 参与证明必须当场可查:串行链的"点了要等 12 秒 + 排队"没有集体仪式,并行 EVM 才有"一人一块砖、同块齐落"的场面 |
| **品牌方**(快闪/展览) | "每人点亮一格留名":N 个顾客各抢一格,昵称上大屏(署名墙),展后格子永久留名 | 1,000 人 = **6.6 MON**;10,000 人 = **66 MON**;另有每道 0.83 tx/s 的速率墙,大流量需多车道+储备 | 品牌要的是"你的哈希",不是 H5 动画:每格带交易哈希可被顾客自己验真;高并发同时点击只有零重叠写集 + 多独立付款道扛得住 |
| **教育者**(课堂/工作坊) | "40 个学生每人一格讲区块链":课前 40 次点击当签到,课中用同块多发送方讲 nonce/车道/reorg | 40 人 1 笔/人 = **0.26 MON**;含演示蜂群 5 分钟 @10 tx/s ≈ 20 MON | 教学要拆给新手看的是 EVM 本体机制:claim 只追加不改余额、链重组不改最终格子归属;单车道串行链演示不了"并行"这个课题本身 |

**观众全程不碰私钥**:中继 8 个 throwaway 测试网 key 轮转代签代付,每 key 独立 nonce 队列、不 await receipt;这是刻意的托管式取舍,代价与边界在 README/docs/SECURITY.md 如实写明。

**栈**:solc-js + viem + Canvas + WebAudio + node:http,零新依赖、无 Foundry。

---

## English

**One-liner**: We did not write a single line of parallel code. We partitioned state into 2,500 cells that share nothing, and let Monad's parallel EVM run them — every colour change and every note on screen is one real on-chain transaction.

**The cell you grabbed is your proof of attendance — checkable on the block explorer.** Every tap becomes a real transaction sponsored server-side by the relay: a hash, a block number, and a `Claim(id, who, color, heat)` event. The audience never touches a private key — no wallet, no gas, no seed phrase; signing and paying happen in throwaway testnet relay wallets (sponsor UX), and any cell can be traced back on-chain by its id.

**What the room sees (90-second script, one line)**: every change is a transaction → read the TPS off the top bar (measured peak 16 tx/s across 17 independent wallets, sitting on the reserve-balance line 0.83×17≈14.2) → judges scan and grab a cell → switch to the explorer and point at a hash → 5 s of silence, 240 tx submitted in one 0.42 s window, landing over the next blocks → "80 taps-per-second interactivity is impossible on Ethereum — fee market × confirmation wait" → close: "we wrote no parallel code — we cut state into 2,500 cells that share nothing."

**On-chain evidence (chainId 10143)**: contract `0xd525ef7ee4072e80765fd61633d80322040afd9d` @ deploy block `79333331`; direct parallel-execution proof = block **#81474005**, **17 claims from 17 distinct EOAs in one ~1 s block**, all landed (one-curl reproducible in docs/EVIDENCE.md); end-to-end audience receipt tx `0x36f2c5ea…8536` (SUCCESS, block 79578040, `Claim(cell=1873)`); **373 true landed claims** = 362 swarm + 1 smoke + 10 audience sync; cost per claim **0.0066 MON** (60,000 gas × 110 gwei); **80 tx/s is a configuration target, not a measurement** (40 lanes × 2 tx/s, needing ≥ 10 MON per lane, ~400 MON of balance).

**How this differs from last edition's #363 pixel war** (per docs/recon-progress/C4-redteam.done and RUNBOOK §4): (1) execution model — every cell owns one storage slot, disjoint write sets, zero re-execution tax, linear in independent payers, with same-block 17-sender evidence; (2) cost of a rejected tap — #363 put its cooldown in the contract, so rejected clicks still landed and still paid (Monad bills gasLimit, revert included), while our `COOLDOWN_MODE=1` rejects with an HTTP 429 **before** any tx is sent — zero gas burned; (3) deliverable — a measured workload-characterization report of a parallel EVM (reserve wall 0.83 tx/s/lane, 60k gas floor, 100-block RPC log window), not a toy.

**Three reuse cards (organizer / brand / educator)**: full 90-second opening ≈ 2.1 MON (78 taps + 240-tx burst wall); a 1,000-customer pop-up leaving named cells ≈ 6.6 MON; a 40-student class where each tap is both attendance and lesson ≈ 0.26 MON. All three need a parallel EVM for the same reason: proof-of-attendance must be on-chain and instant-feeling at concurrency, and only zero-overlap state with one funded wallet per lane delivers that.

**Stack**: solc-js + viem + Canvas + WebAudio + node:http. Zero new dependencies, no Foundry.

---

来源核对:docs/SUBMISSION.md:12-22(口径与 90 秒脚本)、README.md:41(#81474005 17 EOA)、README.md:55-62(0.0066 MON/16 tx/s/373/80=目标)、docs/EVIDENCE.md:8-14(同块证据)、docs/RUNBOOK.md:74,97,103-105,137,175(成本/预算/注资)、docs/recon-progress/C4-redteam.done:5-11(杀1/杀2 答法)、server/index.mjs:72-79,1617-1619(#363 差异与 cooldown_3s)、README.md:106-108(托管取舍)。
