> **交付状态（2026-11-21 17:05）**：离线验证完成 —— vitest **26/26 全绿** + 真实链上事件树
> （8000 块 / 8 笔 Claim / 3 贡献者，root 已复算自检）。**链上部署待 gas**：deployer 0.033691 MON
> 低于单次部署预估 0.034375 MON，详见 §6。未发任何链上交易，本文不填假地址/假 tx。

# Merkle 分账结算：从「服务端转账」到「合约验证领取」

> 一句话：贡献由链上事件统计 → 生成 Merkle 根 → 根和奖池上链 → 每个参与者拿 proof 自己 claim。
> 服务端从「决定谁拿多少并打款」降级为「发布一个任何人可复算的承诺」。

## 1. 信任模型对比

| 维度 | 服务端转账（旧） | MerkleDistributor（新） |
|---|---|---|
| 分配决定权 | 运营数据库 + 热钱包私钥 | root 发布者（同样可信），但分配结果公开可审计 |
| 参与者如何验证 | 只能相信后台截图/流水 | 本地重算 leaf/root；任何人可用公开事件独立复现 |
| 打款执行 | 服务器批量转账，可能漏发、重发、停机 | 合约按 proof 支付；任何人可代发，不依赖服务在线 |
| 防重领 | 链下数据库唯一键 | 链上 `mapping(root => mapping(index => bool))`，重复 claim revert |
| 可追溯 | 内部流水，外部不可查 | `root` / `total` / `Claimed` 事件永久可查 |
| 钱能进谁的口袋 | 私钥持有者可任意转 | 只能进 `leaf.account`，代发者摸不到钱 |
| 失败模式 | 服务停 = 不结算 | 合约在即可领取；owner 下线不影响已发布根的领取 |
| 篡改成本 | 改数据库无痕 | 改任一 amount/account 都会让 root 对不上，proof 当场失效 |

## 2. 机制（四步）

1. **统计**：扫 `Battlefield.Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)`，窗口内按 `who` 计数。
2. **建树**：`leaf = keccak256(abi.encode(uint256 index, address account, uint256 amount))`；
   内部节点 `keccak256(sorted(a,b))`；按地址升序定 `index`；金额 = `pool × 贡献 / 总贡献`，余数给 `index 0`，保证 `sum(amount) === pool`。
3. **上链**：`setRoot(bytes32 root, uint256 total) payable`（owner-only，`msg.value` 即奖池），事件 `RootSet`。
4. **领取**：`claim(index, account, amount, proof)` —— 验证 leaf 上卷等于 root → 标记 `(root,index)` 已领 → 转账给 `account` → 事件 `Claimed`。

奇数节点不复制而是原样晋升（OZ 同款），因此 1/2/3/5/8/32 片叶子都能自证；排序拼接消除了
`hash(a,b) == hash(b,a)` 的顺序歧义。

## 3. 为什么它是原语，不只是脚本

- **输入是任意可观测贡献流**：本项目的 `Claim` 事件、GitHub commit、链上 swap、游戏击杀，都能喂进同一个建树器。
- **输出是自包含结算凭据**：`root + (index, account, amount, proof)`，不依赖本项目后端；把 JSON 贴给任何人，他都能独立验证。
- **合约接口最小、无业务耦合**：只有 root / total / claim / isClaimed；root 可轮换，历史根已领状态按 root 隔离。
- **可被第三方复算**：事件公开 → 统计规则公开 → 树可重算。root 对不上即可公开质疑发布者。
- **可组合**：多轮结算、跨合约读 root、把 proof 当空投/返佣/退款凭证，都不需要改合约。

## 4. 链上可查清单

`root()`、`total()`、`isClaimed(root, index)`、`RootSet` / `Claimed` 事件、合约余额。
合约不提供 `withdraw`：钱只有「按 root 匹配的 proof 领取」一条出口。

## 5. 安全边界（诚实版）

- root 发布者仍被信任「选对了贡献集与比例」——合约无法验证链下统计是否符合事实。但一旦发布：
  分配不可篡改、不可重复、不可截留；且 root 与事件数据都公开可复算。
- 无人认领的份额留在合约，owner 无提款函数；下一轮 `setRoot` 换根不影响旧根已领记录。
- 本次演示按贡献取前 32 名入树（本窗口只有 3 名贡献者），奖池只在入树者间分配；
  规则写进 `docs/merkle.json` 的 `scan.note`，不藏在脚本里。
- 抢跑/代发无利可图：钱只进 `leaf.account`，`index` 防重领。

## 6. 本仓库产物与真实数据

| 文件 | 作用 |
|---|---|
| `contracts/MerkleDistributor.sol` | 67 行合约，手写 merkle 验证，无 OZ 依赖 |
| `scripts/merkle-core.mjs` | 叶子/内部哈希、建树、proof、按贡献分配（链下与合约逐字节一致） |
| `scripts/merkle-build.mjs` | 扫真实 Claim 事件 → `docs/merkle.json` |
| `scripts/merkle-deploy.mjs` | solc-js 编译 + 部署；`--set-root` 校验 JSON 可复算后注入奖池 |
| `scripts/merkle-claim.mjs` | `--proof-index N` 领取；`--dry` 只验 proof + 编码 calldata |
| `tests/merkle.test.ts` | 26 条性质测试（见 §8） |

**本次真实扫链结果**（2026-11-21 16:57，Monad Testnet 10143）：

- 窗口块 `81,527,319 → 81,535,318`（8000 块），`eth_getLogs` 100 块/片 ×80 片
- 命中 `Claim` 事件 8 笔，贡献者 3 个（`0x3470…ecb8` 3 笔、`0x41B8…E392` 2 笔、`0xf447…695C` 3 笔）
- 奖池 0.01 MON → 0.00375 / 0.0025 / 0.00375 MON
- root `0x5aa5cf34a951bd1e3674fd7a542239a42f67709207341567ad1c0b3faf881b9c`
- `docs/merkle.json` 写盘前已自检：重算 root 一致 + 每条 proof 可验 + 金额和 === 奖池

**部署状态：阻塞（gas 余额不足），非代码问题。**

| 项 | 数值 |
|---|---|
| deployer | `0x17FF85c1D82AEDd1da887406a307d087C5Cda61e` |
| 16:50 余额 | 0.0735 MON |
| 16:53 被并行切片 A2-settle 消耗 | 0.0398 MON（3 笔真实结算） |
| 当前余额 | 0.033691 MON |
| 单次部署预估（实测 estimateGas） | 337,014 gas @102 gwei = **0.034375 MON** |
| 完整演示需要（部署+奖池 0.01+2 笔 claim） | ≈ 0.0554 MON |
| 缺口 | ≈ 0.0217 MON |

`deployments-merkle.json` 以 `status: "blocked_no_gas"` 记录真实原因与恢复命令。
补足 ≥0.025 MON 后按顺序执行即可完成真部署与两笔领取：

```bash
node scripts/merkle-deploy.mjs           # 部署，写地址/gas/成本
node scripts/merkle-deploy.mjs --set-root # 校验 root 可复算 → setRoot 注入 0.01
node scripts/merkle-claim.mjs --proof-index 0
node scripts/merkle-claim.mjs --proof-index 1
```

## 7. 复现

```bash
npx vitest run tests/merkle.test.ts     # 26 passed
node scripts/merkle-build.mjs --window 8000 --top 32   # 重建 docs/merkle.json（纯读链）
node scripts/merkle-claim.mjs --proof-index 0 --dry    # 本地验 proof + calldata（不发交易）
```

## 8. 测试覆盖（26 条，全绿）

- 叶子数 1 / 2 / 3 / 5 / 8 / 32：每片叶子的 proof 都能验证到同一 root
- 单叶 root === leaf，proof 为空；8 叶 proof 长度恒为 3；越界 index 抛错
- 篡改 amount / account / index / root：验证必失败（index 参与叶子哈希，不只是下标）
- 截断 proof、加长 proof、拿别人的 proof 冒领：必失败
- 分配：金额和恒等于奖池、按贡献比例向下取整、输入乱序不影响 root、每条 proof 可验、空表得零根
- 出货产物 `docs/merkle.json`：从 leaves 重算 root === 文件 root、每条 proof 可验、金额守恒
- 编码一致性：`leafHash` 与手写 pad32(index)+pad32(address)+pad32(amount) 的 keccak 逐字节相同；`hashPair` 交换参数结果不变
