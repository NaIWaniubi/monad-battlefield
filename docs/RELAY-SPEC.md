# RELAY-SPEC — 中继 nonce 队列的正式规格

> 对象：`server/index.mjs` 里 8 条 relayer key 的独立 nonce 队列。
> 纯实现：`server/nonce-queue.mjs`（本规格与性质测试的被测对象）。
> 性质测试：`tests/nonce-queue.prop.test.ts`（seeded PRNG，本文件末尾有覆盖量）。
>
> **接线状态（重要且诚实）**：`server/index.mjs` **未改动**。把 `k.pending` / `k.nextNonce` /
> `k.nonceInit` / `k.resyncNeeded` 迁进模块需要同时改 `pickRelayer`（按 pending 选最闲）、
> `totalPending`、`/health` 与 `/api/stats` 的状态输出、`resyncTimer` 守卫等至少 6 处，
> 超出「≤40 行且语义等价」的安全门槛，故只交付「提炼模块 + 形式化规格 + 并发性质测试」。
> 模块与现实现逐条对应（见 §1 映射表），后续接线时按 §1 替换即可。

---

## 0. 为什么需要这份规格

一条 EOA 的 nonce 必须严格串行且连续。中继在 0.5s 出块的链上追求吞吐，**不等 receipt**，
所以「本地占号」与「节点实际接收」之间存在时间差；失败、乱序上链、池中空洞都会让
链上 `eth_getTransactionCount(pending)` 与本地计数短暂不一致。队列的全部复杂度都来自
一件事：**在不阻塞发送的前提下，让 8 条独立的 nonce 序列各自保持可自愈的连续前缀**。

---

## 1. 与现实现的映射

| `server/nonce-queue.mjs` | `server/index.mjs` 原实现 | 语义 |
|---|---|---|
| `ensure(keyId)` | `ensureNonce(key)` | 懒加载链上 nonce；并发共享同一个 promise；只在本地未初始化时采用链上值；失败后 `init` 复位可重试 |
| `retain(keyId)` | `relayClaim` 开头的 `key.pending++` | **先占位再 await**，否则并发请求在 `await ensureNonce` 期间看到 `pending=0`，round-robin 失效 |
| `acquire(keyId)` | `const nonce = key.nextNonce; key.nextNonce = nonce + 1n` | 同步占号；读改写之间无 `await`；未初始化时抛 `nonce_queue_uninitialized` |
| `release(keyId)` | `finally { key.pending-- }` | 释放占位；下溢抛 `nonce_queue_pending_underflow`（计数不可能变负） |
| `markResyncNeeded` / `resyncNeededOf` | `key.resyncNeeded` | 发送侧判定「这个 key 需要回链对账」 |
| `resync(keyId, chainNonce, allowRollback)` | `resyncNonce(key, allowRewind)` | `pending>0` 时跳过；`true` 完全信任链上值（允许回退）；`false` 只许前进；`true` 时清 `resyncNeeded` |
| `pendingCount([keyId])` | `key.pending` / `totalPending()` | 已占位、未结算的笔数 |
| `nextNonceOf(keyId)` | `key.nextNonce` | 下一个将分配的 nonce（`null` = 未初始化） |

刻意**不**进模块：`failStreak`、`cooldownUntil`、`funded`、`sent/failed` —— 这些是健康度/统计，
不是 nonce 状态；`resync` 也不重置 `failStreak`（原实现会重置，属调用方职责）。

---

## 2. 状态机

单 key 视角。`pending` 是计数（可 >1，并发占号），其余状态由 `nextNonce` 与 `resyncNeeded` 承载。

```
                 retain()                 ensure() 完成                acquire()
   ┌────────┐  pending++   ┌────────────┐  nextNonce=链上值   ┌────────────┐  nextNonce++
   │  Idle  │─────────────▶│ Acquiring  │────────────────────▶│  Inflight  │──────────┐
   │pending=0│              │ pending>0  │                     │ pending>0  │          │
   └────────┘              └────────────┘                     └────────────┘          │
       ▲                         │                                   │                │
       │                         │ ensure 失败                        │ release()      │
       │                         ▼                                   ▼                │
       │                    ┌─────────┐                      ┌────────────┐           │
       │                    │ Failed  │                      │  Settled   │◀──────────┘
       │                    │可重试   │                      │ pending--  │
       │                    └─────────┘                      └────────────┘
       │                                                            │
       │        pending==0 且 resyncNeeded                          │ pending==0 且 resyncNeeded
       │              ┌─────────────────────────────────────────────┘
       │              ▼
       │        ┌────────────┐  chainNonce 覆盖 nextNonce（allowRollback=true）
       └────────│   Resync   │  或 nextNonce=max(nextNonce, chainNonce)（false）
                │ pending==0 │  清 resyncNeeded（仅 true）
                └────────────┘
```

关键点：

1. **Acquiring 也计入 pending**：`retain` 发生在 `await ensure` 之前。整个 claim 生命周期
   （等初始化 → 占号 → 发送 → 结算）都算「在途」。
2. **Resync 只在 `pending==0` 生效**：有在途交易时绝不改号，否则会覆盖已经在飞的 nonce。
3. **回退是一个「纪元」边界**：回退后 `nextNonce` 从链上最小未上链号重新开始，
   新纪元内的分配仍严格 +1。
4. 空闲期例行对账（`IDLE_RESYNC_MS=5s`）用 `allowRollback=false`：只前进，
   防止「交易已广播但还没进节点 pending 视图」时把号退回去、与在飞交易撞车。

---

## 3. 四条不变式

记号：`Q_k` 为 key `k` 的队列；`C_k` 为链上 `eth_getTransactionCount(k, "pending")`；
`P_k` 为 `pendingCount(k)`；`A_k` 为已分配但未结算的 nonce 集合（在途）；
`E` 为一个纪元（两次回退 `resync` 之间的分配段）。

### I1（P1）纪元内严格递增、并发无重复

- `E` 内相邻两次 `acquire` 满足 `nonce_{i+1} = nonce_i + 1`；
- 任意时刻 `|A_k| = P_k`，且 `A_k` 内无重复 nonce。

**依据**：`acquire` 的读 `nextNonce` → 写 `nextNonce+1` 之间没有 `await`；JS 单线程事件循环
不会在同步段内切换，因此两个并发 claim 不可能读到同一个值。
**范围说明**：跨纪元允许复用**未上链**的号（回退补洞的定义）；「全局永不重复」在回退语义下
不成立，不能作为断言。已上链的号若因链上跳变被再次分配，节点以 `nonce too low` 拒绝，
由 I2/I4 收敛（见 §5 尖锐边角 S1）。

### I2（P2）对账收敛

- `P_k == 0` 时调用 `resync(k, C_k, true)` ⇒ `nextNonceOf(k) == C_k`（精确相等，可回退）；
- `P_k > 0` 时调用 `resync(...)` ⇒ 不改变任何状态（`applied=false, reason="pending"`）；
- `allowRollback=false` ⇒ `nextNonce` 单调不减；若 `C_k > nextNonce` 则取 `C_k`，否则保持不变。

**依据**：`resync` 是纯赋值；`C_k` 由调用方在调用时查询。回退只在队列静默（`P_k==0`）时发生，
避免覆盖在飞交易。

### I3（P3）pending 守恒

- 任意时刻 `pendingCount(k) >= 0`；
- `pendingCount(k) == |A_k|`（`retain` 与 `acquire`/结算配对，`release` 下溢抛错）；
- `pendingCount() == 0` ⇔ 全局无在途；全局计数等于各 key 之和。

**依据**：`release` 在 `pending<=0` 时抛 `nonce_queue_pending_underflow`，计数不可能变负；
`retain` 只在 claim 开始时调用一次，`release` 只在 `finally` 调用一次。

### I4（P4）无永久空洞

任意失败/乱序结算序列，只要最终把在途全部结算（成功或失败）并执行一次
`resync(k, C_k, true)`，则：

- `nextNonceOf(k) == C_k`；
- 下一次 `acquire(k) == C_k`（最小未上链号，恰好补上第一个空洞）；
- `resyncNeededOf(k) == false`。

即：失败只会造成**临时**空洞；空洞由回退对账重新占用，绝不会被永久跳过。
（池中已接收的高位号不丢：它们仍在节点 mempool，等低位补上后连续上链。）

---

## 4. 与 Monad 语义的关系

1. **每个 EOA 一条严格串行序列**。Monad 与 EVM 一致：同一 sender 的 nonce 必须从
   `pending` 前缀开始连续；缺号会让该 sender 之后的交易全部卡在池里。因此 8 个 key
   是 8 条互不影响的「车道」，单 key 故障不阻塞其他 key。
2. **Monad 的 reserve balance / 限速**。交易进池时节点按 `gasLimit × gasPrice` 预扣
   （reserve）发送方余额；余额不足或费用低于当前 base fee 的交易会被拒/逐出。
   这带来两个直接后果：
   - 本地 `nextNonce` 前进不代表交易一定进池（可能因 reserve/underpriced 被拒），
     所以失败路径必须把号退回（`resync(true)`）；
   - `gasPrice` 需要周期性刷新（`GAS_PRICE_TTL_MS=15s`，取不到时用 110 gwei 兜底），
     否则整批交易 underprice 被逐出，表现为「号占了但链上没动」。
3. **pending nonce 的可见性延迟**。交易刚广播时，`getTransactionCount(pending)` 可能
   短暂落后于本地计数。因此**空闲对账只许前进**；只有明确的发送错误才允许回退。
4. **不等 receipt 是吞吐的前提**。0.5s 出块下等 receipt 会把 8 条车道压成串行；
   同步回执（`eth_sendRawTransactionSync`）只用于观众单次点击，失败自动降级为异步发送，
   不改变 nonce 语义。
5. **幂等性**。节点对重复广播同一 nonce 的交易返回 `already known`；实现按成功计
   （不占新号、不触发回退）。这是回退补洞后「高位号被复用」不致命的原因之一。

---

## 5. 失败模式表

判定顺序即 `sendClaim` 的 catch 顺序；`errText` 会拼接 `shortMessage/details/message/cause`。

| 失败类 | 识别（正则） | 动作 | nonce 影响 | 恢复 |
|---|---|---|---|---|
| `nonce too low` / `nonce has already been used` / `old nonce` | `NONCE_ERR` | 立即停止重试，`resyncNeeded=true`，抛错 | 该号大概率已被消费；`pending==0` 时 `resync(true)` 回退到链上值 | 下一笔从 `C_k` 重新开始；若号其实进池了，重发会命中 `already known` |
| `nonce too high` | `NONCE_ERR` | 同上（保守：不猜，直接对账） | 回退/前进都由链上值决定 | 同上 |
| `underpriced` / `fee too low` / `less than block base fee` | `UNDERPRICE_ERR` | 立即停止重试，`resyncNeeded=true` | 交易未进池，号可安全退回 | `resync(true)`；15s 后 gasPrice 刷新，下一笔用新价 |
| `insufficient funds/balance` / `exceeds balance` | `NOGAS_ERR` | `markUnfunded`：`funded=false`，冷却 30s，从选路中剔除 | 号可能未消费；`pending==0` 时回退 | 20s 探活余额；补 gas 自动恢复；`resync(true)` 补齐 |
| HTTP 429 / 超时 / 其他瞬态 | 不匹配以上任一类 | 最多 `MAX_SEND_ATTEMPTS=3` 次，退避 `150ms × attempt`；仍失败则 `resyncNeeded=true` + `recordFailed` | 若节点已接收但响应丢失，本地号已前进；回退依据链上 pending nonce | `resync(true)`；重发同号命中 `already known` 按成功计 |
| `already known` / `known transaction` / `already imported` | `KNOWN_ERR` | 按成功计（`sent++`，不抛错） | 号已被消费，保持前进 | 无需恢复 |
| `eth_sendRawTransactionSync` 不支持/超时/回执不可解析 | 同步路径内部 catch | 原样降级到 `sendClaim`（异步） | 同一 `nonce` 重走一次发送 | 与异步路径一致；观众回复语义不变 |
| 全局在途 ≥ `MAX_PENDING=4000` | `totalPending() >= MAX_PENDING` | 抛 `queue_full`（HTTP 503 类） | 不占号 | 队列自然排空即可 |
| 所有 key 都没 gas / 都不可用 | `pickRelayer()` 返回 null | 抛 `relayer_unfunded` / `no_relayer_available` | 不占号 | 补 gas / 等冷却 |

补充：连续失败 ≥3 次会把该 key 冷却 `min(15s, 1.5s × failStreak)`，避免打爆公共 RPC。

---

## 6. 尖锐边角（已知且被测试覆盖/记录）

- **S1 回退后的链上跳变**：回退到空洞号后，池中高位号可能瞬间连通，`C_k` 从空洞值跳到
  高位值，而本地 `nextNonce` 还停在空洞+1。下一次（或几次并发）分配会拿到 `< C_k` 的号，
  节点必然以 `nonce too low` 拒绝；失败路径标记 `resyncNeeded`，队列排空后回退到 `C_k`。
  代价是最多「并发在途数」笔无效发送，不是永久错误。性质测试用 `staleAssign` 计数观测
  （200 种子 × 120 事件中 36 次），并断言这些号不会被节点接收。
- **S2 高位号复用**：回退后重新分配到「已进池但尚未上链」的号，会重复广播同一 nonce。
  命中 `already known` 按成功计；若内容不同则一笔成功、一笔 `nonce too low`。
  这是回退补洞的固有代价，换来的是不会永久卡死。
- **S3 进程重启**：内存计数丢失，首次 `ensure` 从链上 pending nonce 重新开始。
  上一个进程已广播但未上链的交易仍可能落地；之后若撞号，按 `nonce too low` 路径自愈。
- **S4 跨 key 无序**：8 条队列互不协调，`relayer`/`nonce` 只在单个 key 内有意义；
  统计与排障必须按 key 归因。
- **S5 模块未接线**：生产路径仍是 `server/index.mjs` 原实现；本规格的所有性质是对
  提炼出的等价模块的验证，接线前不能声称生产代码已被这些测试直接覆盖。

---

## 7. 性质测试与覆盖量

命令：

```bash
node --check server/nonce-queue.mjs
npx vitest run tests/nonce-queue.prop.test.ts
```

模型：3 个 key；每次 `ensure` 返回模型当前链上值；事件按 seeded PRNG（mulberry32）交错：
占号 50% / 结算 30%（80% 节点接收、20% 失败；`nonce < chain` 强制按 `nonce too low` 失败）/
对账 12% / 幂等 `ensure` 8%。每条性质跑 **200 个种子 × 120 事件**（要求 ≥50 个种子）。

| 性质 | 断言 | 200 种子累计观测（一次运行） |
|---|---|---|
| P1 | 纪元内 +1；在途集合无重复 | `acquires=12136` |
| P2 | 回退精确等于链上值；只前进不下退；有在途必跳过 | `rollbackResync=510`、`forwardResync=192`、`skippedResync=2530` |
| P3 | `pending>=0`；`pendingCount(k)==在途数`；全局归零 ⇔ 无在途 | 每事件后检查，覆盖全部 24000 个事件 |
| P4 | 排空 + 回退后 `nextNonce==chain`、下一次 `acquire==chain`、`resyncNeeded` 清空 | 每序列末对 3 个 key 各检查一次 |

另含 7 条契约边角（未初始化 acquire 抛错、并发 ensure 只问链一次、ensure 失败可重试、
release 下溢抛错、pending>0 跳过对账、只前进不下退、`resyncNeeded` 清除条件），共 11 个测试。
