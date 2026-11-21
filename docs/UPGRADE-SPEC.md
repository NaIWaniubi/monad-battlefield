# MONAD BATTLEFIELD v2 —— 冻结接口与文件所有权

> 所有并行 worker 必须先读这一份。**接口不许改，文件不许越界。**

## 产品三端

| 端 | 文件 | 谁用 |
|---|---|---|
| 大屏 | `web/index.html` + `web/src/main.ts` | 投影到大屏幕，评委看这个 |
| 观众页 | `web/join.html` + `web/src/join.ts` | 78 个观众扫码，手机上点 |
| 导演台 | `web/director.html` + `web/src/director.ts` | 你一个人控场，第二轮屏/平板 |

## 服务

`server/index.mjs`：Node 原生 `node:http`，**不加任何新依赖**（只用已装的 `viem`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | `{ contract, chainId, rpc, joinUrl, factionNames[] }` |
| POST | `/api/claim` | body `{ cell: number, faction: 1..4, clientId?: string }` → `{ ok, txHash?, queue, error? }` |
| GET | `/api/stats` | `{ queued, sent, failed, tps, keys, uptimeSec }` |
| GET | `/health` | `{ ok: true, block }` |

**关键实现要求（这是招聘理由里最硬的一条）：**
中继必须用 **N 个独立私钥轮转**（默认 8 个，从 `.relayers.json` 读，没有就自动生成并打印）。
原因：一个 EOA 的 tx 按 nonce 严格串行，单 key relayer 会把 78 个观众的点击压成一条队。
每个 key 维护自己的本地 nonce 队列，失败时回链同步。**不许 await receipt 阻塞下一个请求。**

## 大屏 / 观众页共享的前端接口（冻结）

### `web/src/grid.ts`

```ts
export const SIDE = 50;
export const CELLS = 2500;
export const FACTIONS: Array<{ name: string; hex: string }>;  // index 0 = 空

export class GridState {
  readonly color: Uint8Array;   // 0..4
  readonly heat: Uint32Array;
  readonly flash: Float32Array;
  total: number;
  apply(id: number, color: number, heat: number): void;
  reset(): void;
}

export class GridRenderer {
  constructor(canvas: HTMLCanvasElement, container: HTMLElement);
  resize(): void;
  needsResize(): boolean;
  // opts 可选；允许内部加特效，但签名不许变
  draw(state: GridState, dt: number, opts?: { pulseId?: number; mode?: "normal" | "hype" }): void;
}
```

### `web/src/audio.ts`

```ts
export class BattleAudio {
  ready: boolean;
  isMuted: boolean;
  enable(): Promise<boolean>;
  toggle(): boolean;                 // 返回「是否出声」
  note(id: number, heat: number, color: number): void;   // color 1..4 分声部
  setDensity(tps: number): void;
  stinger(kind: "capture" | "start" | "end"): void;       // 事件音效
}
```

### `web/src/metrics.ts`（已存在，不许改签名）

```ts
export class TpsWindow { constructor(windowMs?: number); push(t?: number): void; tps(now?: number): number; }
export class Dedupe { seen(key: string): boolean; size(): number; }
```

## 导演台协议（BroadcastChannel `battlefield`）

```ts
type DirectorMsg =
  | { type: "mute"; muted: boolean }
  | { type: "banner"; text: string }          // 空字符串 = 清除
  | { type: "mode"; mode: "normal" | "hype" }
  | { type: "reset" }                          // 仅清屏幕，不动链上
  | { type: "fullscreen" };
```

大屏监听 `new BroadcastChannel("battlefield")`，收到就执行。导演台只发不收（可额外读 /api/stats 显示）。

## 文件所有权（越界 = 直接冲突）

| Worker | 只能改这些文件 |
|---|---|
| **W1 视觉** | `web/src/grid.ts`, `web/src/effects.ts`(新建) |
| **W2 声音** | `web/src/audio.ts` |
| **W3 中继+观众** | `server/**`(新建), `web/join.html`, `web/src/join.ts`, `web/src/join.css` |
| **W4 测试+手册** | `tests/**`, `vitest.config.ts`, `docs/RUNBOOK.md` |
| **主控（我）** | `web/src/main.ts`, `web/director.html`, `web/src/director.ts`, `web/src/rpc.ts`, `web/src/metrics.ts`, `package.json`, `README.md`, `.env.example` |

**所有人共同禁止：**
- 不许 `npm install`（依赖冲突）
- 不许改 `package.json`
- 不许改 `contracts/Battlefield.sol`
- 不许改别人的文件
- 不许删现有导出（只能加）

## 验收（每个人交付前自查）

```bash
npm run build:web     # 必须通过
npx tsc --noEmit      # 允许有既有类型噪音，但不许新增
```

---

## 视觉设计要求（W1）

目标：让 1080p 投影下的 50×50 网格「像一块活的生物组织」，而不是一个表格。

- 每格是圆角小方块，带 1px 内发光
- 被占领的格子按 heat 分层亮度，heat 越高越亮
- 新 claim 有冲击波：以该格为中心向外扩散的圆环，0.35s 衰减
- 同阵营相邻格之间画极细的连线，形成「领地」感
- 背景有极慢的星尘漂移（不能抢主体）
- 整体加一层 vignette + 轻微扫描线
- 性能：2500 格 + 特效必须在 60fps，帧内不许分配大对象

## 声音设计要求（W2）

目标：像「一场正在进行的比赛」，不是「随机音符」。

- 4 个阵营 = 4 个声部（不同波形/音区：紫=triangle 中高、青=sine 高、琥珀=square 中、绯=saw 低）
- 同一阵营的音符走五声音阶，避免不协和
- drone 随 TPS 变厚，并在每 30s 做一次和声转换（紧张→舒展）
- 全局限流 ~14 note/s，超过就只更新 drone，不发声（否则是噪音墙）
- 加 compressor 防削波
- 任何异常都不许抛到主循环（audio 挂了画面必须继续）

---

# v3 产品级升级（2026-11-21，追加章节；v2 章节全部保留）

一句话：**把「看一个数字」变成「把自己放进证明里」**。观众 = 并行负载本身。

## 新增纯函数（web/src/metrics.ts，可单测）

| 函数 | 契约 |
|---|---|
| `decayFactor(ageSec)` | 未知年龄 → 1；3 天线性沉到 0.42；单调、封底 |
| `burnRatePerSecond(tps, gasPerTx, gwei, ethPrice)` | 每笔 × TPS × 单价；非法输入 → 0 |
| `burstSchedule(n, spreadMs=420)` | n 笔在 spreadMs 内均匀铺开时刻表；1≤n≤600 |
| `shouldFireHold(now, lastAt, intervalMs=1000)` | 按住连点节律判定 |

## GridState / GridRenderer 扩展（只加不改）

- `GridState.age`：每格最近 claim 的秒数，`Infinity` = 未知（历史回放读不到时间戳）
- `GridState.labelOf`：每格最近署名（观众昵称），null = 无名；中继代付才署名，蜂群匿名
- `GridRenderer.queueBurst(count)`：静默墙欠账的涟漪（上限 240，按令牌节流排掉，与普通 claim 共用节流锁）
- 衰减呈现：档位 = `round(tier × decayFactor(age))`，只压暗不提亮，未知年龄不变

## 中继端点变更（server/index.mjs）

- `POST /api/director` 新增 `type:"burst"`：**不进 directorQueue**，走 `requestBurst(count)`：
  点火时刻 = 收到指令 + 5200ms，`count` 笔在 420ms 内均匀发（默认 240），
  `burstUntil = 点火 + 420ms + 15000ms 冷却`。冷却期内再来 → 429 `burst_cooldown`
- `/api/claim` body 可选 `nick`（≤16 字）→ 成功后写 `cellTags[id]`；空串不写
- `/api/state`：`cells` 第 4 位可选 age（秒）；尾部新增 `tags: [[cellId, "名字"], …]`（最新 ≤512 条）

## 导演台协议扩展（DirectorMsg 新增）

```ts
{ type: "burst"; count?: number }
{ type: "stinger"; kind: "burst" }   // 齐鸣音效（大屏收到 burst 时自己放）
```

导演台 SHOW 时间轴插入爆点：58s「安静…五秒后，一起涌入」→ 62s burst(240)
→ 65s「同样的负载，主网打不进去」。大屏从收到 burst 起各自倒数 5.2s，两端不互等。

## 文件所有权（v3）

| 文件 | v3 权限 |
|---|---|
| `web/src/metrics.ts` | 追加纯函数（签名见上） |
| `web/src/grid.ts` | GridState/GridRenderer 追加字段与方法，禁止改动既有签名 |
| `web/src/audio.ts` | 追加 `setMuted(m)`、`stinger("burst")` |
| `web/src/main.ts` | mergeState、静默墙、账单角标、BURST 消息处理 |
| `web/src/join.ts` | 代号（localStorage `mbf.nick`）+ 按住连点 |
| `web/src/director.ts` | burst 按钮 + SHOW 新 cue |
| `server/index.mjs` | burst 状态机、cellTags、age/tags 快照 |
| `contracts/Battlefield.sol` | **仍然冻结** |

## v3 验收

```bash
node scripts/gate.mjs        # 六道全绿（含密钥扫描）
vitest run                  # metrics 单测覆盖 decayFactor/burn/burst/hold 四个新函数
```

边界声明：
- 静默墙爆发需要 gas（中继钱包）。余额不足时中继逐笔失败并留痕，大屏涟漪由本地事件驱动仍会播放 —— 话术必须照 `budget.mjs` 档位说，不许超出顶栏标注的模式。
- qr-check 的 A 情形在本机 Windows 网络配置为 Public 时会失败（回环拒绝），属环境问题非代码问题：会场默认走隧道模式（`stage.mjs` 不带 `--lan`），不受影响。
