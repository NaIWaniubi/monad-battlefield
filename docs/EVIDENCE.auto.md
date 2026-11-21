# EVIDENCE.auto · 链上证据（自动生成）

> **链上证据自动生成于 2026-11-21T07:42:48Z（UTC）/ 2026-11-21T15:42:48+08:00（北京时间）** ——
> 本文件由 CI 的 `evidence` job（main push）运行 `scripts/evidence.mjs` 生成，
> 手工修改会在下次跑 CI 时被覆盖。人工策展版证据见 `docs/EVIDENCE.md`。

## 口径与数据源

| 项 | 值 |
|---|---|
| RPC（JSON-RPC 直连，可当场复现） | `https://testnet-rpc.monad.xyz` |
| 链 | chainId 10143（Monad Testnet） |
| 合约（Battlefield） | `0xd525ef7ee4072e80765fd61633d80322040afd9d` |
| 部署块 startBlock | 79,333,331 |
| Claim 事件 topic0 | `0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9` |

公共 RPC 实测硬约束：`eth_getLogs` 单次窗口 ≲100 块（超限报
`block range too large`），因此下表由分窗口求和得出，非全史回放。

## 最新观测

| 指标 | 值 |
|---|---|
| 当前块高（采集时刻） | 81,521,331 |
| 最近 200 块内的 Claim（**精确计数**，eth_getLogs 分窗） | 0 |
| 79,333,331 → 81,521,331 累计 Claim 总数（**精确**，Σ cells[id].heat） | 531 |
| 同区间累计 Claim（抽样估计 · 互证口径，均匀假设外推） | ~0 |

累计精确口径的原理：Battlefield.sol 没有任何全局计数器，但每笔 claim 对
所写格子的 `heat` 严格 +1，所以 2500 个 slot 的 heat 之和 = 部署以来总
claim 数。本表用 `eth_getStorageAt`（分批 batch）直接读合约存储求和 ——
不依赖公共 RPC 的日志索引（索引有滞后），也不受 getLogs 窗口上限约束。

抽样互证细节：24 个 100 块等距窗口（失败 0 个），
合计采样 2,400 块、0 条 Claim，按密度外推。
**~0 建立在「claim 在全史均匀分布」假设上，只作量级参考。**
链上活动实际不均匀（演示/蜂群时段集中爆发，均匀采样常打不中），
引用总数请以上方 Σheat 精确值为准。

## 复现命令

```bash
# 1) 当前块高
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# 2) 一个 100 块窗口的 Claim 精确计数（改 hex 区间即可复核任意窗口）
curl -s -X POST https://testnet-rpc.monad.xyz -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
    "address":"0xd525ef7ee4072e80765fd61633d80322040afd9d",
    "topics":["0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9"],
    "fromBlock":"0x4dbea50",
    "toBlock":"0x4dbeab3"
  }]}' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).result.length+' claims in last 100 blocks'))"
```

浏览器抽查：`https://testnet.monadscan.com/address/0xd525ef7ee4072e80765fd61633d80322040afd9d`
