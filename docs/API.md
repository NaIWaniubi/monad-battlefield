# API · 前端 ↔ 中继唯一协议约定

> 实现:`server/index.mjs`(路由总表 :1760-1791)。本文是**唯一**协议文档:所有 method/path/字段/错误码逐条对照代码写成,行号为 index.mjs 出处。前端三端(main.ts / join.ts / director.ts)与外部客户端都只应依赖本文。
> 通用头:CORS 全开(`Access-Control-Allow-Origin: *`,:1278-1283);所有 JSON 响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`(:1285-1295);`OPTIONS` 一律 204(:1764)。
> 无流式通道:**没有 /api/stream、没有 WebSocket/SSE**,实时性全靠轮询(/api/state 前端 3s、大屏版图 2s 刷、/api/director?since= 轮询)。

## 1. GET /api/config(:1769 → handleConfig :1542-1564)

响应 200:

```json
{ "contract": "0xd525…fd9d", "chainId": 10143, "rpc": "https://testnet-rpc.monad.xyz",
  "joinUrl": "https://<隧道>/join.html", "factionNames": ["紫","青","琥珀","绯"] }
```

- `joinUrl` 由中继推导(物理网卡优先、拒回环,:1356-1402),**二维码只许用它**——前端拿 localhost 自拼是已修事故(README.md:181)。
- 未部署:`contract` 为全 0 地址且带 `"error": "not_deployed"`(:1548-1555),前端据此显示"未部署"而非白屏。
- 非 GET/HEAD → 405 `method_not_allowed`(:1770)。

## 2. POST /api/claim(:1773 → handleClaim :1566-1887)

请求体(JSON,≤2 KB,:135 `BODY_LIMIT`):

```json
{ "cell": 0-2499(必填,整数), "faction": 1-4(必填,整数),
  "clientId": "localStorage 自报 id(≤64 字符)", "nick": "≤16 字符,可省", "sync": true|false(可省) }
```

校验顺序(顺序即优先级,不可调换):JSON 解析 → cell/faction 范围 → clientId 桶限频 → IP 桶限频 → cooldown_3s(仅 COOLDOWN_MODE=1)→ not_deployed → 发送。

成功 200:

```json
{ "ok": true, "txHash": "0x…|null", "queue": 12, "relayer": 3, "nonce": 118,
  "confirmed": true, "blockNumber": 81474005, "reverted": false, "confirmMs": 1240 }
```

- `confirmed/blockNumber` **仅在 sync 路径**返回(:1668-1672);`confirmed:true` 的口径是回执里出现了区块号或状态字段(:899-904)——写不出回执就不承诺上链。
- `reverted:true` = 同步回执显示这笔在链上失败,该格未变(:1111-1117,1672)。
- `txHash` 可为 `null`:节点回"already known"按已入池成功处理(:1037-1042)。
- `nick` 成功提交时写入该格标签,经 `/api/state.tags` 上大屏(:1657-1659,478-483)。
- 蜂群(swarm.ts)与静默墙(burst)不发 `sync`,吞吐路径响应形状不变(:1640-1644)。

### 错误码表(全部来自代码,未列出的码不存在)

| HTTP | error | 触发条件 | 出处 |
|---|---|---|---|
| 400 | `invalid_json` | 体不是 JSON | :1570-1574 |
| 400 | `invalid_body` | 体是合法 JSON 但非对象/是数组 | :1575-1577 |
| 400 | `invalid_cell` | cell 非整数或 <0 / >2499 | :1580-1584 |
| 400 | `invalid_faction` | faction 非整数或 <1 / >4 | :1585-1587 |
| 413 | `body_too_large` | 体 >2 KB | :1305-1320 |
| 429 | `rate_limited` | 每 clientId **6 笔/10 s**(`RL_LIMIT/RL_WINDOW_MS`,env 可调);带 `Retry-After` 头与 `retryAfterMs` 字段 | :1589-1600, :60-61 |
| 429 | `too_many` | 每出口 IP **30 笔/10 s**(`IP_RL_LIMIT/IP_RL_WINDOW_MS`)第二道闸——脚本随机 clientId 刷量才撞,真人点不到 | :1602-1615, :66-69 |
| 429 | `cooldown_3s` | 仅 `COOLDOWN_MODE=1`(或 `--cooldown`):同格 3 s 内重复点击,**拒绝发生在发 tx 之前,零 gas**(与 #363 合约冷却烧 gas 的对照面) | :1617-1633, :72-97 |
| 503 | `not_deployed` | deployments.json 缺失/地址无效 | :1635-1637 |
| 503 | `queue_full` | 全局在途 ≥ `MAX_PENDING`=4000 | :1070-1075, :1678 |
| 503 | `no_relayer_available` | 有 funded key 但全在冷却 | :1077-1082 |
| 503 | `relayer_unfunded` | **全部**中继 key 被判没 gas(`allDry()`) | :1077-1082, :837-839 |
| 502 | `send_failed` | 节点拒收/发送重试 3 次仍失败(可当场重试);带 `detail`(viem 错误摘要) | :1676-1686 |
| 405 | `method_not_allowed` | 非 POST 打 /api/claim | :1774 |
| 500 | `internal` | 路由兜底异常(设计上几乎不可达:进程级 uncaught 已吞,:1831-1839) | :1820 |

失败响应统一形状:`{ ok:false, error, retryAfterMs?, detail?, queue }`(`queue`=当前全局在途)。
前端文案映射见 `web/src/join.ts` 的 `ERR_TEXT`(:403-422,含 `network/no_faction/reverted` 等纯客户端码);**`cooldown_3s` 不许改名**——join.ts 按字面匹配(:99-100 注释)。

## 3. GET /api/stats(:1777 → statsBody :383-407)

```json
{ "queued": 0, "sent": 359, "failed": 0, "tps": 8.43, "keys": 8, "dryKeys": 0,
  "uptimeSec": 1735, "occupied": 373, "claims": 373, "block": 81474020,
  "confirmLatencyP50ms": 1210, "confirmLatencyP95ms": 1590, "confirmLatencyCount": 10,
  "cooldownMode": false }
```

- `tps`:近 5 s 发送数 /5(:385-386);`dryKeys`:当前停用(没 gas)的 key 数,观众页干涸横幅数据源(:388);
- `confirmLatency*`:仅 sync 成功笔的 tap→链上确认滚动窗口(≤100 样本),**无样本=null**,界面显示"—"不许编 0(:348-376);
- 注资补币后 key 自动恢复(20 s 探测,无需重启)::1252-1271。

## 4. GET /api/state(:1778 → snapshotGrid :703-734)

```json
{ "cells": [[1873,2,1],[42,3,7,0.8]], "occupied": 373, "total": 2500, "claims": 373,
  "block": 81474020, "historyFrom": 81473921, "complete": false,
  "updatedAt": 1763…, "tags": [[1873,"吃瓜真人"]] }
```

- 只发非零格 `[id, color, heat]`;第 4 位 `age`(秒)仅中继精确知道时间(本进程发过)的格子才有,未知年龄缺位、前端按全亮画不装知道(:709-713);
- `complete:false` = 公共 RPC 只给近 ~100 块日志窗,历史不可深回放(:423-433;README.md:204);
- `tags`:最新 ≤512 条署名(`TAG_SNAPSHOT_MAX`),只含中继代付的观众 claim(蜂群匿名)(:158,470-483,716-719);
- 缓存头 `public, max-age=2`(:1704)。

## 5. /api/director(:1779)

**POST**(导演台→中继,handleDirectorPost :1726-1752):体为任意 `{type: string, …}`,≤2 KB。
- `type:"burst"`(:1740-1743 → requestBurst :526-547):默认 240 笔(1..600 夹取),静默 5.2 s 后在 420 ms 内均匀提交,15 s 全局冷却。
  - 成功 200:`{ok:true,total:240}`;
  - 冷却中 429:`{ok:false,error:"burst_cooldown",retryAfterMs}`;
  - 未部署:`{ok:false,error:"not_deployed"}`。
  - burst **不进**消息队列(两边时钟各走各的,只共享起跳时刻,:1737-1739)。
- 其他 type(subtitle/mute/hype 等):入队(环形留最近 64 条,`DIRECTOR_QUEUE_MAX` :1722)→ 200 `{ok:true,seq:N}`。
- 非法:400 `invalid_json` / `invalid_msg`;读体失败 400 `bad_body`。

**GET** `?since=<seq>`(大屏轮询,handleDirectorGet :1754-1758):200 `{ok:true,seq:<当前最大>,msgs:[…]}`,只回 seq>since 的消息。跨设备与同屏 `BroadcastChannel` 双通道并存(RUNBOOK §0.2)。

## 6. GET /health(:1784 → handleHealth :1708-1710)

`{ "ok": true, "block": 81474020, "rpc": true, "occupied": 373 }` — `rpc:false` = 近一次 getBlockNumber 失败;stage.mjs 用它确认隧道打通(:1784)。

## 7. 其它

- `/api/*` 未匹配 → 404 `not_found`(:1786);非 API 且 dist/ 三端齐全 → 静态服务,缺文件 404 `static_off` 带 hint(:1498-1533,含路径穿越防护 403 `forbidden`、坏编码 400 `bad_path`)。
- 发送内部机制(非协议,运维须知):每 key 本地占号不 await receipt(:1090-1093);失败后队列清空时回链对账 nonce,空洞自愈、空闲对账只许前进(:1127-1156);连败 ≥3 次的 key 进 ≤15 s 冷却(:747-758);没 gas 的 key `markUnfunded` 停用、补币后 ≤30 s 自动恢复(:779-783)。
- 交易参数契约:legacy + 显式 `gasPrice`(缓存值,兜底 110 gwei)、固定 `gas=60000`(:942-1022;GAS_LIMIT env :58)。**复用时不要改成 EIP-1559**——公共测试网节点实测不稳定(README.md:56)。

---

来源核对:server/index.mjs:59-69,72-100,135,158,348-407,423-433,470-483,526-547,703-734,747-758,779-783,837-839,857-1000,1026-1125,1127-1156,1252-1271,1278-1295,1305-1344,1542-1564,1566-1887,1708-1710,1722-1758,1760-1791;web/src/join.ts:403-422,515-555;README.md:56,104,181-188,204;docs/RUNBOOK.md §0.2。
