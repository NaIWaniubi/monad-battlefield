# REUSE · 参与证明引擎提取声明(Proof-of-Presence Engine)

> 定位:对标往届交接文档"半衰期 BE-HANDOFF"(后端交接卡),但这里交接的不是一个活动后端,而是一个**通用参与证明引擎**:任何人点一格 → 服务端代付 → 一笔可查链上交易 → 事件即凭证。半衰期是"给下一届的活动代码",本引擎是"给任何需要『到场/参与/留名且可被第三方验真』场景的协议件"。
> 铁律:引擎=合约语义+事件中继+客户端契约三层,不绑定"战场"皮肤;换 id 域和 color 语义即可复用。

## 1. claim(id, color) 语义(引擎的全部链上面)

合约 `contracts/Battlefield.sol`(已部署 `0xd525ef7ee4072e80765fd61633d80322040afd9d`,Monad Testnet chainId 10143,部署块 79333331):

```solidity
function claim(uint16 id, uint8 color) external {
    if (id >= CELLS) revert BadId();
    Cell storage c = cells[id];   // 每格独占 1 个 storage slot
    c.owner = msg.sender;         // last-write-wins
    c.color = color;
    uint32 h; unchecked { h = c.heat + 1; }
    c.heat = h;                   // 只数"被点过几次",不是全局状态
    emit Claim(id, msg.sender, color, h);
}
```

提取后的抽象语义:
- **id** = 参与位点(格子/票位/签名位/座位),定义域 `uint16`(改 `CELLS` 即换规模);
- **color** = 参与属性(阵营/品牌色/选项),`uint8` 预留 256 种;
- **msg.sender** = 到场人(中继模式下是代付 key,谁真正参与由事件中继侧的署名映射补足,见 §3 tags);
- **heat** = 该位点的累计冲击次数,**每格私有**,无全局计数器(README.md:24-38;"不要加 totalClaims++"是合约头注释 Battlefield.sol:5 的明文纪律)。

并行性质:任意两笔 `claim(id1≠id2)` 写集零重叠 → 乐观并行执行器零重执行税(README.md:43)。这是引擎选 Monad 的唯一理由,复用时可替换为任何"独立付款车道 × 零重叠状态"平台。

## 2. Claim 事件流(引擎的对外接口)

```
event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat);
```

- `id`、`who` 均 `indexed` → 可按格/按人过滤(公共 RPC 友好);
- **所有统计(TPS/占领数/阵营占比/heat)一律从事件链下推导**,合约不提供读接口(README.md:24-43, server/index.mjs:631-701 的 getLogs 滚动窗口即推导器);
- 消费方注意实测硬限制:Monad 测试网公共 RPC 的 `eth_getLogs` 窗口上限实测 **100 块**(span=120 被拒;server/index.mjs:423-433),深历史不可回放,响应必须带 `complete:false` 如实声明(README.md:204)。

## 3. eth_sendRawTransactionSync 客户端契约(观众"当场自证"通道)

Monad 节点支持 `eth_sendRawTransactionSync`:交易塞进块、同步带回回执。中继对该方法的使用契约(server/index.mjs:857-1000):

1. 仅观众单次点击走同步(请求体 `sync:true`);静默墙/蜂群/按住连点一律异步,吞吐路径零改动(index.mjs:1640-1644)。
2. 各节点返回结构不统一 → 解析器 `parseSyncReceipt` 为永不抛的纯函数,任何输入得中性结果(index.mjs:905-940;单测 tests/sync-claim.test.ts)。
3. **confirmed 口径是硬的**:回执里有区块号或状态字段才 `confirmed:true`;裸哈希=节点收了没给回执=前端绝不许写"已上链"(index.mjs:899-904)。
4. 任何同步失败(不支持/超时/看不懂)自动降级回普通发送,`confirmed:false`——同步只是加料,不是新故障面(index.mjs:966-999)。
5. 客户端超时建议 15 s(index.mjs 注释对应 join.ts:515-527 的 `sync ? 15_000 : 8_000`)。
6. tap→链上确认延迟仅统计 sync 成功笔,滚动窗口 100,无样本显示"—"不许编 0(index.mjs:348-376)。

## 4. relay HTTP 协议(实际路由,经核实 server/index.mjs:1760-1791)

**没有 `/api/stream`**——本中继无 WebSocket/SSE 推送;大屏/观众页/导演台全靠 HTTP 轮询(2 s 版图刷新 index.mjs:1247-1250)。路由全集:

| Method | Path | 用途 | 行号 |
|---|---|---|---|
| GET | `/api/config` | 合约地址/chainId/rpc/**joinUrl**(二维码唯一真源)+ 未部署时 `error:"not_deployed"` | 1769 |
| POST | `/api/claim` | 代付上链;请求 `{cell,faction,clientId,nick?,sync?}`;详见 docs/API.md | 1773 |
| GET | `/api/stats` | 队列/发送/失败/tps/dryKeys/确认延迟 P50/P95/cooldownMode | 1777 |
| GET | `/api/state` | 全局版图快照(只发非零格 `[id,color,heat,age?]` + tags + complete/historyFrom),`cache-control: public, max-age=2` | 1778 |
| GET/POST | `/api/director` | 跨设备控场中转:POST 入队(留最近 64 条)或 `type:"burst"` 直接点火;GET `?since=seq` 拉增量 | 1779 |
| GET | `/health` | `{ok,block,rpc,occupied}` | 1784 |
| GET/HEAD | 其余路径 | dist/ 静态三端(index/join/director.html 缺一不发) | 1788 |

字段级请求/响应/错误码表在 **docs/API.md**(唯一协议约定文档),本文不重复。

## 5. 可直接复制的文件清单(含依赖面)

依赖面(package.json:19-22):**运行时只有 `viem ^2.21.45` + `qrcode ^1.5.4` 两个包**;devDependencies(solc/tsx/typescript/vite/vitest)只在构建与门禁需要。复制引擎=复制以下 8 个文件:

| 文件 | 带走什么 | 外部依赖 |
|---|---|---|
| `contracts/Battlefield.sol` | claim/Claim/Cell 全部链上语义(38 行) | 无 |
| `scripts/build.ts` + `scripts/deploy.ts` | solc-js 编译与部署,免 Foundry | solc(dev) + viem |
| `server/index.mjs` | 引擎服务端:N-key 轮转 + 每 key nonce 队列 + sync 回执 + 版图缓存 + 双限频 + burst | 仅 node: 内置 + viem(index.mjs:17 "不许 npm install") |
| `scripts/keys.ts` / `scripts/fund.ts` | 车道(独立 EOA)的生成与注资,含余额可见防抖 | viem |
| `scripts/budget.mjs` | 上台前"够演多久"算术(读真实余额×0.0066) | viem |
| `scripts/gate.mjs` + `scripts/check-secrets.mjs` | 六道验收门禁 + 密钥防泄露扫描 | node 内置 |
| `web/src/main.ts` 中 `:700-701` 的 qrcode 动态导入模式 | 前端出码(大屏用 `qrcode`,观众页 join.ts 不签名零链依赖) | qrcode |
| `tests/sync-claim.test.ts` / `tests/cooldown.test.ts` / `tests/e-fixes-server.test.ts` | 把 §3/§4 契约钉死的回归测试 | vitest(dev) |

复用改造点:① 换 `CELLS/SIDE` 改位点规模;② 换 `color` 语义与 `FACTION_NAMES`(index.mjs:1539);③ 若不需要"人肉车道/静默墙",删 `requestBurst` 段(index.mjs:526-547)即可,claim 主路径不动;④ 换链只改 `RPC_URL/CHAIN_ID` 与 sync 方法支持度(`parseSyncReceipt` 已保证降级安全)。

---

来源核对:contracts/Battlefield.sol:4-38;README.md:24-43,98-108,204;server/index.mjs:17,23,423-433,631-701,857-1000,1539,1640-1644,1760-1791,1247-1251,348-376;package.json:19-22;docs/API.md(本包内);web/src/join.ts:515-555;web/src/main.ts:700-701;docs/RUNBOOK.md:103(对标交接卡形态)。
