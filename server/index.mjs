#!/usr/bin/env node
/**
 * MONAD BATTLEFIELD · 中继服务（W3）
 *
 * 唯一目的：把 78 个观众手指的点击，变成 78 条互不排队的上链交易。
 *
 * 核心设计（不是「跑了就行」，是这套东西的全部价值）：
 *   1. N 个独立 EOA 私钥轮转（默认 8 个）。一个 EOA 的 nonce 是严格串行的，
 *      单 key 会把所有人的点击压成一条队；8 个 key = 8 条并行车队。
 *   2. 每个 key 自己维护本地 nonce 计数，发 tx 时直接带上 nonce，不等 receipt。
 *   3. 分配 nonce 是同步的（先占号再发送），所以并发请求之间不会有 nonce 竞争；
 *      发送本身并发放行，节点只要收到的是连续 nonce 就会照单接收。
 *   4. 任何一条失败 → 该 key 在「队列清空时」回链同步 nonce（`eth_getTransactionCount`），
 *      缺号会被下一次 claim 重新占用，nonce 空洞自愈。
 *   5. 任何异常都只计入 failed，绝不让进程退出。
 *
 * 依赖：只用 node: 内置模块 + 已装的 viem。不许 npm install。
 *
 * 环境变量：
 *   PORT=8791                 监听端口（0.0.0.0）
 *   RPC_URL / CHAIN_ID        链
 *   RELAYER_COUNT=8           自动生成的 key 数量
 *   RELAYER_KEYS=0x..,0x..    直接指定私钥（优先于 .relayers.json）
 *   GAS_LIMIT=60000           claim 的固定 gas 上限（省掉一次 estimateGas 往返）
 *   JOIN_URL=                 观众页地址（覆盖自动推导）
 *   STATIC_DIR=dist           静态目录（存在就顺带把大屏/观众页一起服务）
 *   MAX_PENDING=4000          全局在途上限，超过就回 queue_full
 *   RL_LIMIT=6 RL_WINDOW_MS=10000   每 clientId 的滑动窗口限频
 *   COOLDOWN_MODE=0            演示对照模式：1 = 每格 3s 服务端冷却（同格重复
 *                              点击 → 429 cooldown_3s，拒绝发生在发 tx 之前）。
 *                              也可用启动参数 --cooldown。缺省 0 = 现行为零变化。
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/* ────────────────────────────────────────────────────────────
 * 0. 常量 / 环境
 * ──────────────────────────────────────────────────────────── */

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // 仓库根目录
const PORT = Number(process.env.PORT ?? 8791);
const RPC_URL = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RELAYER_COUNT = Math.max(1, Math.min(64, Number(process.env.RELAYER_COUNT ?? 8)));
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? 60_000);
const MAX_PENDING = Number(process.env.MAX_PENDING ?? 4_000);
const RL_LIMIT = Number(process.env.RL_LIMIT ?? 6);
const RL_WINDOW_MS = Number(process.env.RL_WINDOW_MS ?? 10_000);
/**
 * E-fixes#6（C3 T4）：clientId 是自报的 localStorage 值 —— 脚本带随机 clientId
 * 就把每客户端 6/10s 的闸整个绕开。第二道闸锚在 IP：同网段 NAT 下 78 台手机
 * 共用出口 IP 是 1 台/人各点一下也够（30/10s ≈ 全场 4 倍余量），
 * 随机 clientId 刷量则撞在这条线上。想收/放：IP_RL_LIMIT / IP_RL_WINDOW_MS。
 */
const IP_RL_LIMIT = Number(process.env.IP_RL_LIMIT ?? 30);
const IP_RL_WINDOW_MS = Number(process.env.IP_RL_WINDOW_MS ?? 10_000);

/**
 * G-cooldown · 演示对照模式（与往届 #363 千人像素战争的差异化实证）。
 *
 * #363 把冷却写进合约：被拒的点击照样上链执行、gas 照扣 —— Monad 按
 * gasLimit 计费、revert 也付费（实测见 docs/EVIDENCE.md §5）。
 * 本开关把**同样的 3s 同格冷却搬到服务端代持层**给评委现场对照：
 * COOLDOWN_MODE=1 时同格 3s 内重复点击 → 中继直接 429（error=cooldown_3s），
 * 拒绝发生在**发 tx 之前**，一克 gas 都不烧。
 * 缺省 0：下面整个冷却路径短路，现行为零变化（tests/cooldown.test.ts 钉死）。
 * 开法：`COOLDOWN_MODE=1 node server/index.mjs` 或 `node server/index.mjs --cooldown`。
 * 对比表由 scripts/ab-demo.mjs 产出（docs/ab-result.json）。
 */
export function resolveCooldownMode(raw, argv = []) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "1" || s === "true") return true;
  for (const a of argv) {
    const v = String(a);
    if (v === "--cooldown") return true;
    if (v.startsWith("--cooldown=")) {
      const x = v.slice("--cooldown=".length).trim().toLowerCase();
      if (x === "1" || x === "true") return true;
    }
  }
  return false;
}
/** 只认明确的 1/true/--cooldown；其余（未设/0/乱值）一律关 —— 现行为的安全默认 */
const COOLDOWN_MODE = resolveCooldownMode(process.env.COOLDOWN_MODE, process.argv.slice(2));
const COOLDOWN_WINDOW_MS = 3000;
/** 429 响应体的错误码：join.ts 的 ERR_TEXT 用它映射文案，别改名 */
export const COOLDOWN_ERROR = "cooldown_3s";

/**
 * 每格冷却账本（纯逻辑，时钟可注入）。语义：放行时刻成为新锚点（滚动窗口，
 * 不是固定栅栏）；恰好满 3s 不属「3s 内」→ 放行。被拒的 hit **不**续期锚点，
 * 否则洪峰能把一格永久锁死 —— 这不是本开关要演示的东西。
 */
export function createCellCooldown(windowMs = COOLDOWN_WINDOW_MS) {
  const last = new Map(); // cell -> 最近一次放行的 ms
  return {
    hit(cell, now = Date.now()) {
      const prev = last.get(cell);
      if (prev !== undefined && now - prev < windowMs) {
        return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - prev)) };
      }
      last.set(cell, now);
      return { ok: true };
    },
  };
}

/** mode=0 → 恒放行的桩（handleClaim 里走不到账本，回归钉）；mode=1 → 真账本 + 错误码。 */
export function createCooldownGuard(mode, windowMs = COOLDOWN_WINDOW_MS) {
  if (!mode) return { hit: () => ({ ok: true }) };
  const ledger = createCellCooldown(windowMs);
  return {
    hit(cell, now = Date.now()) {
      const r = ledger.hit(cell, now);
      if (r.ok) return r;
      return { ok: false, error: COOLDOWN_ERROR, retryAfterMs: r.retryAfterMs };
    },
  };
}
const cellCooldown = createCooldownGuard(COOLDOWN_MODE);

const BODY_LIMIT = 2 * 1024; // 2KB
const GAS_PRICE_TTL_MS = 15_000;
/** 与合约、大屏、观众页同一口径：50 × 50 */
const CELLS = 2500;
const BLOCK_TTL_MS = 2_000;
const IDLE_RESYNC_MS = 5_000;
const MAX_SEND_ATTEMPTS = 3;

/* ── v3 产品级升级常量 ────────────────────────────────────────── */

/** 「静默墙」倒计时：中继在收到 burst 指令后先安静这么久，再把 240 笔一起轰出去。
 *  与大屏的本地倒计时对齐到同一个数字（web/src/main.ts SILENCE_MS）——两边各数各的，
 *  因为它们本来就不该互相等待；只要起跳时刻同为收到指令那一刻。 */
const BURST_SILENCE_MS = 5200;
/** 240 笔在多少毫秒内铺开（均匀） */
const BURST_SPREAD_MS = 420;
/** 默认一次爆发多少笔（主席位全开约 3.2s 出块，240 笔 ≈ 一条完整队列） */
const BURST_DEFAULT = 240;
/** 静默墙冷却：一次爆发后的全局冷却，防止连点把 gas 预算一秒烧光 */
const BURST_COOLDOWN_MS = 15_000;
/** 观众昵称长度上限（与前端输入框 maxlength 一致） */
const NICK_MAX = 16;
/** /api/state 里最多带回多少个署名标签 */
const TAG_SNAPSHOT_MAX = 512;

const T0 = Date.now();

/** claim(uint16 id, uint8 color) —— 先用 artifacts 里的 ABI，没有就用这份内联的（合约冻结） */
const CLAIM_ABI_INLINE = [
  {
    inputs: [
      { internalType: "uint16", name: "id", type: "uint16" },
      { internalType: "uint8", name: "color", type: "uint8" },
    ],
    name: "claim",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint16", name: "id", type: "uint16" },
      { indexed: true, internalType: "address", name: "who", type: "address" },
      { indexed: false, internalType: "uint8", name: "color", type: "uint8" },
      { indexed: false, internalType: "uint32", name: "heat", type: "uint32" },
    ],
    name: "Claim",
    type: "event",
  },
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const warn = (...a) => console.warn(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────────
 * 1. 链 / 合约配置（deployments.json 缺失时优雅降级）
 * ──────────────────────────────────────────────────────────── */

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const pub = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 1, timeout: 8_000 }),
});

/** 部署信息：读不到就返回 null，调用方负责降级，绝不让进程起不来 */
function loadDeploy() {
  const p = resolve(ROOT, "deployments.json");
  if (!existsSync(p)) {
    warn(`缺少 deployments.json —— 中继以「未部署」模式启动（/api/claim 会返回 not_deployed）`);
    return null;
  }
  try {
    const info = JSON.parse(readFileSync(p, "utf8"));
    const address = String(info.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      warn(`deployments.json 里的 address 无效（${address}）—— 按未部署处理`);
      return null;
    }
    return {
      address,
      startBlock: Number(info.startBlock ?? 0),
      deployer: info.deployer ?? null,
      chainId: Number(info.chainId ?? CHAIN_ID),
    };
  } catch (e) {
    warn(`deployments.json 解析失败：${e.message} —— 按未部署处理`);
    return null;
  }
}

const DEPLOY = loadDeploy();

/**
 * ABI：优先 artifacts（随合约编译更新），否则内联。
 * 必须同时保留 `claim` 函数和 `Claim` 事件 —— 只留函数的话
 * getLogs 无法解码 args，/api/state 会拿到一堆 undefined。
 */
const CLAIM_ABI = (() => {
  try {
    const p = resolve(ROOT, "contracts/artifacts/Battlefield.json");
    if (!existsSync(p)) return CLAIM_ABI_INLINE;
    const art = JSON.parse(readFileSync(p, "utf8"));
    const picked = (art.abi ?? []).filter(
      (x) => (x.type === "function" && x.name === "claim") || (x.type === "event" && x.name === "Claim"),
    );
    const hasFn = picked.some((x) => x.type === "function");
    const hasEv = picked.some((x) => x.type === "event");
    return hasFn && hasEv ? picked : CLAIM_ABI_INLINE;
  } catch {
    return CLAIM_ABI_INLINE;
  }
})();

/* ────────────────────────────────────────────────────────────
 * 2. 密钥池（.relayers.json；没有就生成 N 个）
 * ──────────────────────────────────────────────────────────── */

const KEYS_FILE = resolve(ROOT, ".relayers.json");

/** 从各种可能的形状里抽出私钥字符串 */
function extractKeys(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.keys) ? raw.keys : Array.isArray(raw?.relayers) ? raw.relayers : [];
  const out = [];
  for (const item of list) {
    const v = typeof item === "string" ? item : item?.privateKey ?? item?.pk ?? item?.key;
    if (typeof v !== "string") continue;
    const pk = v.startsWith("0x") ? v : `0x${v}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(pk)) out.push(pk);
    else warn(`跳过非法私钥：${pk.slice(0, 10)}…`);
  }
  return out;
}

function loadKeyPool() {
  // 1) 环境变量优先（临时换一批 key 不用改文件）
  const env = (process.env.RELAYER_KEYS ?? "").split(/[\s,;]+/).filter(Boolean);
  if (env.length) {
    const keys = extractKeys(env);
    if (keys.length) {
      log(`密钥池：来自 RELAYER_KEYS（${keys.length} 个）`);
      return keys;
    }
    warn("RELAYER_KEYS 里没有合法私钥，回落到文件/自动生成");
  }

  // 2) .relayers.json
  if (existsSync(KEYS_FILE)) {
    try {
      const keys = extractKeys(JSON.parse(readFileSync(KEYS_FILE, "utf8")));
      if (keys.length) {
        log(`密钥池：来自 .relayers.json（${keys.length} 个）`);
        return keys;
      }
      warn(".relayers.json 里没有合法私钥，重新生成");
    } catch (e) {
      warn(`.relayers.json 解析失败：${e.message}，重新生成`);
    }
  }

  // 3) 自动生成并落盘
  const keys = Array.from({ length: RELAYER_COUNT }, () => generatePrivateKey());
  try {
    writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    log(`密钥池：已生成 ${keys.length} 个并写入 .relayers.json（请给每个地址打 gas）`);
  } catch (e) {
    warn(`.relayers.json 写入失败（${e.message}）—— 本次只在内存里使用这批 key`);
  }
  return keys;
}

/* ────────────────────────────────────────────────────────────
 * 3. 每 key 一条 nonce 队列（本服务的核心）
 * ──────────────────────────────────────────────────────────── */

function createRelayer(pk, index) {
  const account = privateKeyToAccount(pk);
  return {
    index,
    address: account.address,
    account,
    client: createWalletClient({
      account,
      chain,
      // 重试/超时都自己做，避免 viem 内部重试把并发搞乱
      transport: http(RPC_URL, { retryCount: 0, timeout: 8_000 }),
    }),
    nextNonce: null, // bigint | null（懒加载）
    nonceInit: null, // Promise | null（并发只发起一次）
    pending: 0, // 已占号、尚未发送完成的笔数
    sent: 0,
    failed: 0,
    failStreak: 0,
    cooldownUntil: 0,
    resyncNeeded: false,
    funded: true, // false = 已知没 gas，直接跳过（见 markUnfunded）
  };
}

const relayers = loadKeyPool().map(createRelayer);
let rr = 0; // round-robin 游标

/** 全局统计 */
const stats = { sent: 0, failed: 0 };
const sentStamps = []; // 最近 5s 的发送时间戳

/**
 * E-fixes#9（C2#2 的诚实版，替代 WS 推送方案）：tap→链上确认延迟仪表。
 *
 * 口径（必须钉死，C1 审计的诚实要求）：
 *   · 起点 = 中继 handleClaim 收到请求那一刻（≈观众松手；手机→中继的
 *     HTTP 上行 ~30-80ms 不计，大屏 3s 轮询的显示延迟也不计 ——
 *     **这是 tap→链上确认，不含画面同步**，HUD 与文档都这么写）；
 *   · 终点 = 同步回执返回（sendClaimSync 拿到 receipt / 降级发送完成）。
 *   只统计 sync=true 且成功返回的笔（异步吞吐路径没有"确认"可言）。
 * 滚动窗口近 100 笔；无样本 → P50/P95 = null（界面显示「—」，不许编 0）。
 */
const CONFIRM_WINDOW_MAX = 100;
const confirmLatencies = [];

export function noteConfirmLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return; // 时钟抖动/挂起的极端值不进窗口
  confirmLatencies.push(Math.round(ms));
  if (confirmLatencies.length > CONFIRM_WINDOW_MAX) confirmLatencies.shift();
}

/** 最近秩百分位（p ∈ {50,95}）：空 → null；非有限值先滤掉。纯函数供单测。 */
export function latencyPercentiles(arr) {
  const vals = (Array.isArray(arr) ? arr : [])
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  if (!vals.length) return { p50: null, p95: null, count: 0 };
  const pick = (p) => vals[Math.min(vals.length - 1, Math.ceil((p / 100) * vals.length) - 1)];
  return { p50: pick(50), p95: pick(95), count: vals.length };
}

/**
 * /api/stats 的响应体 —— 抽成纯函数：路由只管发，字段口径集中一处。
 * E-fixes#5：dryKeys = 当前「没 gas 被停用」的中继钱包数（观众页干涸横幅的数据源）。
 * E-fixes#9：confirmLatency* = tap→链上确认延迟（见上，null = 还没有样本）。
 */
export function statsBody() {
  const now = Date.now();
  while (sentStamps.length && now - sentStamps[0] > 5_000) sentStamps.shift();
  const tps = Math.round((sentStamps.length / 5) * 100) / 100;
  const lat = latencyPercentiles(confirmLatencies);
  const dryKeys = relayers.filter((k) => !k.funded).length;

  return {
    queued: totalPending(),
    sent: stats.sent,
    failed: stats.failed,
    tps,
    keys: relayers.length,
    dryKeys,
    uptimeSec: Math.floor((now - T0) / 1000),
    occupied: gridState.occupiedCount ?? 0,
    claims: gridState.claims,
    block: gridState.lastBlock === null ? null : Number(gridState.lastBlock),
    confirmLatencyP50ms: lat.p50,
    confirmLatencyP95ms: lat.p95,
    confirmLatencyCount: lat.count,
    /** G-cooldown：对照模式开关状态（观众页顶栏据此显示小字，评委肉眼可见切换） */
    cooldownMode: COOLDOWN_MODE,
  };
}

/* ────────────────────────────────────────────────────────────
 * 全局版图缓存（/api/state 的唯一数据源）
 *
 * 为什么需要在服务端缓存：手机页原来是「单机游戏」——
 * 它只统计本机这一次会话点过的格子，从不读链上别人的格子，
 * 于是点一下手机显示「己方 100%」，而大屏上是四块大陆。
 *
 * 硬约束（实测）：Monad 测试网公共 RPC 的 eth_getLogs 不允许从部署块回溯，
 * 只接受较近的窗口（50 块稳定通过，1000 块被拒），且 fromBlock/toBlock
 * 必须是十六进制字符串（传十进制数字直接被判 invalid params）。
 * 所以这里不做全量回放，而是滚动窗口：启动时从 latest - WINDOW 起，
 * 之后每 2s 只补增量。窗口外的历史读不到 —— 这一点如实暴露给前端
 * （historyFrom / complete 字段），不让界面假装它知道全部。
 * ──────────────────────────────────────────────────────────── */
/**
 * eth_getLogs 的单次窗口上限（实测）。
 *
 * 在 Monad 测试网公共 RPC 上二分测出来：span=100 通过，span=120 被拒。
 * 这不是"建议值"而是硬上限 —— 请求超过它，RPC 返回
 * "Invalid parameters were provided to the RPC method"，看起来像参数写错，
 * 实际是范围过大。踩过的坑：早期把它设成 900 再分 40 块一片，
 * 前 20 片全被拒、catch 静默 break，于是界面显示"跑通了但 0 格"。
 * 所以：一次只拉一个窗口，且失败必须留痕。
 */
const LOG_WINDOW = BigInt(process.env.LOG_WINDOW ?? 100);
/** 启动时回看多少个窗口（不是块数）—— 0 表示只要当前窗口 */
const GRID_WINDOWS_BACK = Number(process.env.GRID_WINDOWS_BACK ?? 0);

const gridState = {
  /** color[i] = 0 未占领 / 1..4 阵营 */
  color: new Uint8Array(CELLS),
  /** heat[i] = 累计冲击次数（上限 255，与合约 uint32 截断后一致） */
  heat: new Uint8Array(CELLS),
  /** 已统计的最后一个区块；null = 尚未初始化 */
  lastBlock: null,
  /** 本次进程能回看到的最早区块（窗口起点） */
  historyFrom: null,
  /** 最近一次成功刷新的时间戳 */
  updatedAt: 0,
  /** 本进程观测到的 Claim 事件数（不是合约累计总数） */
  claims: 0,
  /** 是否完整覆盖了链上全部历史（公共 RPC 下通常为 false） */
  complete: false,
  /** 已占领格子数（每次 refresh 后更新，给 /api/stats 用） */
  occupiedCount: 0,
};

let gridBusy = false;

/**
 * v3「热的土地」：每格最近一次 claim 的时间戳（ms epoch）；-1 = 未知。
 *
 * 只有**本进程自己发过的 claim** 有精确时间：
 *   · getLogs 的 Claim 事件不带时间戳；
 *   · 公共 RPC 又拒绝逐块回放，追 100 块 × 每个窗口一次的代价不值当。
 * 所以衰减曲线对「中继流量」精确，对历史回放按未知处理 ——
 * 呈现层（web/src/metrics.ts decayFactor）对未知年龄一律按全亮画，不装知道。
 * 曲线与前端 metrics.ts 是同一条公式：3 天线性沉到 0.42 倍亮度。
 */
const lastClaimedAt = new Float64Array(CELLS).fill(-1);

/**
 * v3「格子上的名字」：id → { nick, faction, ts }。
 * 只在中继代付的观众 claim 上写（蜂群是匿名背景压力），
 * 所以大屏上能读到的每一个名字都是真人 —— 这正是「观众就是蜂群」的证据。
 */
const cellTags = new Map();

/** 最近一次成功的观众署名（GET /api/state 会挑最新的 TAG_SNAPSHOT_MAX 个带回） */
function setCellTag(id, faction, nick) {
  if (!Number.isInteger(id) || id < 0 || id >= CELLS) return;
  const t = String(nick ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, NICK_MAX);
  if (!t) return; // 空昵称不写：不许出现"干净的空标签"把真名挤掉
  cellTags.set(id, { nick: t, faction, ts: Date.now() });
}

/** 下一场静默墙最早可点火时刻（含本次发车全程 + 冷却）——防止连点把 gas 一秒烧光 */
let burstUntil = 0;

function randFaction() { return 1 + ((Math.random() * 4) | 0); }

/**
 * E-fixes#3（C4#7b）：静默墙选格 —— 跳过观众署名的格子。
 *
 * 大屏上「有名字的格子」是这场 demo 最硬的证据（C1 台词②：「你能扫到名字的
 * 这些格子，每个都有哈希」）。burst 随机盖到署名格 = 观众的名字凭空消失，
 * 恰好炸掉自己最不能炸的东西。署名格在全场占比 <2%，重试几次必然落空位；
 * 真选不到（全场皆署名，理论不可能）退回最后一发 —— 爆发不因此哑火。
 * 纯函数 + 注入 rand，供单测钉死。
 */
export function pickBurstCell(isTaken, cells = CELLS, rand = Math.random, maxTries = 24) {
  let last = -1;
  for (let t = 0; t < maxTries; t++) {
    last = Math.min(cells - 1, (rand() * cells) | 0);
    if (!isTaken(last)) return last;
  }
  return last >= 0 ? last : 0;
}

/** 单笔静默墙交易：失败静默跳过（爆发队列不因单笔失败中断） */
async function fireOne(cell, faction) {
  try {
    await relayClaim(cell, faction);
  } catch (e) {
    warn(`静默墙一笔失败：${errText(e)}`);
  }
}

/**
 * v3「静默墙」指令入口：先安静 BURST_SILENCE_MS，再把 total 笔均匀轰出去。
 *
 * 时刻表与 web/src/metrics.ts 的 burstSchedule 同一条公式（均匀铺开），
 * 但这里不再 setTimeout 整表后统一计冷却，而是一个单调时钟变量说了算：
 *   · 点火时刻 = 收到指令 + BURST_SILENCE_MS（大屏也从同一刻起数倒计时）
 *   · burstUntil = 点火时刻 + 铺开 + 冷却 → 这之前来的第二下直接拒（burst_cooldown）
 * 两台设备同时按下？第一下把窗口占了，第二下拿到明确的 429 式回执，不排队不叠加。
 */
function requestBurst(countArg) {
  const nowMs = Date.now();
  if (!DEPLOY) return { ok: false, error: "not_deployed" };
  if (nowMs < burstUntil) {
    return { ok: false, error: "burst_cooldown", retryAfterMs: Math.max(1, burstUntil - nowMs) };
  }
  let total = Number.isFinite(countArg) ? Math.floor(countArg) : BURST_DEFAULT;
  total = Math.max(1, Math.min(600, total));

  burstUntil = nowMs + BURST_SILENCE_MS + BURST_SPREAD_MS + BURST_COOLDOWN_MS;
  const step = total > 1 ? BURST_SPREAD_MS / (total - 1) : 0;
  for (let i = 0; i < total; i++) {
    // E-fixes#3：burst 不盖观众署名格（cellTags 里出现过的 id 全部跳过）
    const cell = pickBurstCell((c) => cellTags.has(c));
    setTimeout(() => void fireOne(cell, randFaction()), BURST_SILENCE_MS + i * step);
  }
  log(
    `静默墙：已排定 ${total} 笔，${(BURST_SILENCE_MS / 1000).toFixed(1)}s 后齐发` +
      `（${BURST_SPREAD_MS}ms 内铺开），冷却 ${(BURST_COOLDOWN_MS / 1000).toFixed(0)}s`,
  );
  return { ok: true, total };
}

/**
 * E-fixes#2（C4#7）：claims 双计数去重账本。
 *
 * 两条路径会数到同一笔 claim：
 *   · noteLocalClaim —— 中继代发时乐观 +1（交易还没进块就得让大屏亮）；
 *   · refreshGridState —— getLogs 索引到 Claim 事件后再 +1。
 * 加上窗口重叠/重拉，链上同一事件也可能被数两次。
 * 解法（照 web/src/metrics.ts 的 Dedupe 移植，那边是 TS 不能直接 import）：
 *   · seenKeys：已入账事件的唯一坐标 txHash:logIndex（缺哈希时退 区块:交易序:log）；
 *   · localTxs：本进程中继已代发（已乐观入账）的 txHash。
 *   事件坐标第一次见 → 记入 seenKeys；若其 txHash 在 localTxs 里 → 链上真值照写，
 *   但计数不再 +1（乐观那一笔已经数过了）。
 * 纯逻辑导出给 tests/e-fixes-server.test.ts 钉死，不依赖网络。
 */
export function createClaimLedger(limit = 40_000) {
  const seenKeys = new Set();
  const localTxs = new Set();
  const remember = (set, key) => {
    set.add(key);
    if (set.size > limit) {
      // 环形淘汰最旧一半（与 metrics.Dedupe 同策略；limit<=1 时退化，但它只为演示服务）
      const half = Math.max(1, Math.floor(limit / 2));
      const it = set.values();
      for (let i = 0; i < half; i++) {
        const v = it.next();
        if (v.done) break;
        set.delete(v.value);
      }
    }
  };
  return {
    /** 本进程中继代发一笔（乐观计数的那一刻）。拿不到哈希（KNOWN_ERR）时中性跳过 */
    noteLocal(txHash) {
      if (typeof txHash === "string" && txHash) remember(localTxs, txHash.toLowerCase());
    },
    /** 链上 Claim 事件到达：该不该给 gridState.claims +1？（同时把事件坐标记入去重集） */
    countLog(l) {
      const txh = typeof l?.transactionHash === "string" ? l.transactionHash.toLowerCase() : null;
      const key = txh
        ? `${txh}:${l.logIndex ?? 0}`
        : l?.blockNumber != null
          ? `b:${l.blockNumber}:${l.transactionIndex ?? "?"}:${l.logIndex ?? 0}`
          : null; // 什么坐标都没有：放行（宁多计不误吞，反正没有可去重的键）
      if (key) {
        if (seenKeys.has(key)) return false; // 同一事件重复拉取
        remember(seenKeys, key);
        if (txh && localTxs.has(txh)) return false; // 本进程已乐观入账
      }
      return true;
    },
  };
}

const claimLedger = createClaimLedger();

/**
 * 本进程自己发出的 claim 立即写进缓存。
 *
 * 为什么必须这么做：链上事件要等公共 RPC 索引，实测有几十到几百块的滞后。
 * 如果只靠 getLogs，演示现场会出现「观众点了一格、大屏立刻亮了，
 * 但他自己手机上要等半分钟才看到别人也点过」——而且窗口一旦滑过去，
 * 那一格就永远补不回来了。
 * 本地写入是**乐观**的：合约行为是 last-write-wins + heat 自增，
 * 我们提交的就是 (id, color)，heat 先按已知值 +1 估；链上事件到达后会覆盖成真值。
 *
 * E-fixes#2：txHash 交给去重账本 —— 这条乐观 +1 与稍后 getLogs 的 +1 是同一笔，
 * 不能让 gridState.claims 数两遍。
 */
function noteLocalClaim(id, color, txHash = null) {
  if (!Number.isInteger(id) || id < 0 || id >= CELLS) return;
  if (!Number.isInteger(color) || color < 1 || color > 4) return;
  gridState.color[id] = color;
  gridState.heat[id] = Math.min(255, gridState.heat[id] + 1);
  gridState.claims++;
  claimLedger.noteLocal(txHash);
  lastClaimedAt[id] = Date.now(); // v3：热度从这一刻开始衰减（呈现层曲线）
  let occ = 0;
  for (let i = 0; i < CELLS; i++) if (gridState.color[i] > 0) occ++;
  gridState.occupiedCount = occ;
  gridState.updatedAt = Date.now();
}

async function refreshGridState() {
  if (gridBusy) return;
  if (!DEPLOY) return; // 未部署：/api/state 会回空版图
  gridBusy = true;
  try {
    const latest = await pub.getBlockNumber();

    // 首次：只看最近的窗口（公共 RPC 只允许 100 块，回溯不了部署块）
    let from;
    if (gridState.lastBlock === null) {
      const back = LOG_WINDOW * BigInt(1 + Math.max(0, GRID_WINDOWS_BACK));
      const winStart = latest > back ? latest - back : 0n;
      const deployBlock = BigInt(DEPLOY.startBlock ?? 0);
      from = winStart > deployBlock ? winStart : deployBlock;
      gridState.historyFrom = from;
      gridState.complete = from === deployBlock;
    } else {
      from = gridState.lastBlock + 1n;
      // 落后超过一个窗口（RPC 挂了一阵）：对齐到最近窗口，不硬追
      if (latest > from + LOG_WINDOW) {
        from = latest - LOG_WINDOW;
        gridState.historyFrom = from;
        gridState.complete = false;
      }
    }

    if (from > latest) {
      gridState.updatedAt = Date.now();
      return;
    }

    // 一次拉一个窗口，绝不超限。失败的窗口留痕。
    const to = from + LOG_WINDOW - 1n > latest ? latest : from + LOG_WINDOW - 1n;
    let logs;
    try {
      logs = await pub.getLogs({
        address: DEPLOY.address,
        abi: CLAIM_ABI,
        eventName: "Claim",
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      warn(`版图窗口 #${from}→#${to} 读取失败：${errText(e)}`);
      return;
    }

    for (const l of logs) {
      const a = l.args;
      const id = Number(a?.id ?? -1);
      if (id < 0 || id >= CELLS) continue;
      // E-fixes#2：先问过账本再计数 —— 本进程中继代发的 tx 早已乐观 +1，
      // 这里只把 color/heat 覆盖成链上真值；重复拉到的同一事件也不再计。
      const counted = claimLedger.countLog(l);
      gridState.color[id] = Number(a?.color ?? 0) & 0xff;
      gridState.heat[id] = Number(a?.heat ?? 0) & 0xff;
      if (counted) gridState.claims++;
    }
    gridState.lastBlock = to;

    // 每次刷新后重算占领数，/api/stats 直接读这个字段
    let occ = 0;
    for (let i = 0; i < CELLS; i++) if (gridState.color[i] > 0) occ++;
    gridState.occupiedCount = occ;
    gridState.updatedAt = Date.now();
  } catch {
    /* RPC 抖动：保留旧状态，下一轮再试 */
  } finally {
    gridBusy = false;
  }
}

/** 打包成紧凑传输格式：只发非零格子，[id, color, heat] 三元组；v3 有精确时间的补第 4 位 age(秒) */
function snapshotGrid() {
  const cells = [];
  const nowMs = Date.now();
  for (let i = 0; i < CELLS; i++) {
    const c = gridState.color[i];
    if (c > 0) {
      const ageSec = lastClaimedAt[i] > 0 ? (nowMs - lastClaimedAt[i]) / 1000 : Infinity;
      // 未知年龄给 null 而不是 null 之外的任何数 —— 前端对未知一律按全亮处理，
      // 绝不许把"读不到时间"画成"很久没动"
      cells.push(ageSec === Infinity ? [i, c, gridState.heat[i]] : [i, c, gridState.heat[i], ageSec]);
    }
  }
  // v3「格子上的名字」：挑最新的 TAG_SNAPSHOT_MAX 个署名（Map 按插入序，最新的在尾）
  const tags = [];
  for (const [id, v] of cellTags) tags.push([id, v.nick]);
  if (tags.length > TAG_SNAPSHOT_MAX) tags.splice(0, tags.length - TAG_SNAPSHOT_MAX);
  return {
    cells,
    occupied: cells.length,
    total: CELLS,
    claims: gridState.claims,
    block: gridState.lastBlock === null ? null : Number(gridState.lastBlock),
    /** 本次能回看到的最早区块；null = 还没开始回放 */
    historyFrom: gridState.historyFrom === null ? null : Number(gridState.historyFrom),
    /** 是否覆盖了链上全部历史。公共 RPC 下通常 false —— 前端据此说明「只显示最近」 */
    complete: gridState.complete,
    updatedAt: gridState.updatedAt,
    /** v3：每格最近署名的观众昵称（[cellId, "名字"]，最多 TAG_SNAPSHOT_MAX 条） */
    tags,
  };
}

function totalPending() {
  let n = 0;
  for (const k of relayers) n += k.pending;
  return n;
}

function recordSent() {
  stats.sent++;
  sentStamps.push(Date.now());
}

function recordFailed(key, err) {
  stats.failed++;
  if (key) {
    key.failed++;
    key.failStreak++;
    // 连续失败（多半是没 gas）→ 冷却，别把 RPC 和日志打爆
    if (key.failStreak >= 3) {
      key.cooldownUntil = Date.now() + Math.min(15_000, 1_500 * key.failStreak);
      warn(`relayer#${key.index} ${key.address} 连续失败 ${key.failStreak} 次，冷却 ${(key.cooldownUntil - Date.now()) / 1000}s`);
    }
  }
  warn(`send failed: ${errText(err)}`);
}

/** 错误文本：viem 把真正原因藏在 details / cause 里 */
function errText(e) {
  if (!e) return "unknown";
  const parts = [e.shortMessage, e.details, e.message, e.cause?.shortMessage, e.cause?.message];
  const s = parts.filter(Boolean).join(" | ");
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

const NONCE_ERR = /nonce too low|nonce has already been used|nonce too high|old nonce/i;
const KNOWN_ERR = /already known|known transaction|already imported|already exists/i;
const UNDERPRICE_ERR = /underpriced|fee too low|less than block base fee/i;
const NOGAS_ERR = /insufficient (funds|balance)|exceeds balance|not enough funds/i;

/**
 * 记一个「这个 key 没 gas」的结论并进入冷却。
 * 好处：观众连点 20 下时，不会产生 20 次注定失败的 RPC 往返（也不会把节点打出 429）。
 * 有专门的 30s 计时器负责解禁并重新查余额（见 startLoops），所以补了 gas 之后会自动恢复。
 */
function markUnfunded(key) {
  if (key.funded) warn(`relayer#${key.index} ${key.address} 没有 gas —— 暂时停用（补 gas 后 30s 内自动恢复）`);
  key.funded = false;
  key.cooldownUntil = Math.max(key.cooldownUntil, Date.now() + 30_000);
}

/** 懒加载链上 nonce：并发请求共享同一个 Promise */
function ensureNonce(key) {
  if (key.nextNonce !== null) return Promise.resolve(key.nextNonce);
  if (!key.nonceInit) {
    key.nonceInit = pub
      .getTransactionCount({ address: key.address, blockTag: "pending" })
      .then((n) => {
        // 只在我们还没有本地计数时采用链上值；否则说明期间已有本地占号，别把已分配的回退掉
        if (key.nextNonce === null) key.nextNonce = BigInt(n);
        return key.nextNonce;
      })
      .finally(() => {
        key.nonceInit = null;
      });
  }
  return key.nonceInit;
}

/**
 * 选 key：优先「空闲 key 的 round-robin」，全忙时选 pending 最少的那个。
 * 这就是 8 条车队的分道逻辑 —— 空闲时严格轮流，忙碌时自动向最闲的倾斜。
 */
function pickRelayer() {
  const n = relayers.length;
  const now = Date.now();
  const usable = (k) => k.funded && k.cooldownUntil <= now;

  for (let off = 0; off < n; off++) {
    const k = relayers[(rr + off) % n];
    if (usable(k) && k.pending === 0) {
      rr = (rr + off + 1) % n;
      return k;
    }
  }

  let best = null;
  let bestOff = 0;
  let bestPending = Infinity;
  for (let off = 0; off < n; off++) {
    const k = relayers[(rr + off) % n];
    if (!usable(k)) continue;
    if (k.pending < bestPending) {
      best = k;
      bestPending = k.pending;
      bestOff = off;
    }
  }
  if (best) rr = (rr + bestOff + 1) % n;
  return best;
}

/** 所有 key 是否都处于「没 gas」状态（用来给出准确的错误码） */
function allDry() {
  return relayers.every((k) => !k.funded);
}

/** gasPrice 缓存：每笔都问一次 RPC 会平白多一倍延迟 */
let gasPrice = null;
let gasPriceAt = 0;

async function refreshGasPrice() {
  try {
    const p = await pub.getGasPrice();
    if (p > 0n) {
      gasPrice = p;
      gasPriceAt = Date.now();
    }
  } catch (e) {
    if (!gasPrice) warn(`getGasPrice 失败（将让 viem 每笔自行补全）：${errText(e)}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 3.5 同步回执（B-sync：观众单次点击专用，蜂群/吞吐路径不经过这里）
 *
 * Monad 支持 eth_sendRawTransactionSync：节点把交易塞进块里、
 * 同步把回执一起返回。观众点一格等这一次，手机当场自证「真上链」。
 * 各节点对返回结构没有统一约定（官方 / drpc / viem 包装形状都不同），
 * 所以解析必须先做成一个打得死的纯函数：任何输入都不抛，坏输入=中性结果。
 * （纯函数导出给 tests/sync-claim.test.ts 单测钉契约，无 gas 也能验证逻辑。）
 * ──────────────────────────────────────────────────────────── */

const HEX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** blockNumber 的五花八门形状 → 非负整数 | null（"0x1f4" / "26" / 30 / 30n） */
function toBlockNumber(v) {
  if (typeof v === "bigint") return v >= 0n ? Number(v) : null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s) || /^\d+$/.test(s)) {
      try {
        return Number(BigInt(s));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 回执 status → true(成功) / false(revert) / null(回执里没有这个字段) */
function toStatus(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v === 1n ? true : v === 0n ? false : null;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "0x1" || s === "0x01" || s === "1" || s === "01" || s === "true" || s === "success") return true;
    if (s === "0x0" || s === "0" || s === "00" || s === "false") return false;
  }
  return null;
}

/**
 * 从 eth_sendRawTransactionSync 的各种可能返回结构里提取回执要点。纯函数、永不抛。
 * confirmed 的口径是硬的：只有回执里出现了区块号或状态字段才 true。
 * 裸哈希 / 只有哈希的对象 = 节点收了但没给回执 → confirmed=false，调用方降级，
 * 前端就绝不许写「已上链」（写不出回执就不许承诺回执）。
 */
export function parseSyncReceipt(raw) {
  const out = { txHash: null, blockNumber: null, status: null, confirmed: false, isError: false, errorText: null };
  try {
    let v = raw;
    // 有些网关把结果再套一层 JSON-RPC 信封 —— 先拆信封
    if (v && typeof v === "object" && !Array.isArray(v) && "jsonrpc" in v && "result" in v) v = v.result;

    if (typeof v === "string") {
      const s = v.trim();
      if (HEX_HASH_RE.test(s)) out.txHash = s;
      else if (s) {
        out.isError = true;
        out.errorText = s.slice(0, 300);
      }
      // 空串：中性，什么都不说
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const h = v.transactionHash ?? v.hash ?? v.txHash;
      if (v.error != null && typeof h !== "string") {
        // 错误对象（error 既可能是 {code,message} 也可能是裸字符串）
        out.isError = true;
        out.errorText =
          (typeof v.error === "string" ? v.error : String(v.error?.message ?? v.error?.code ?? "node error")).slice(0, 300);
      } else {
        if (typeof h === "string" && HEX_HASH_RE.test(h)) out.txHash = h;
        out.blockNumber = toBlockNumber(v.blockNumber ?? v.block_number);
        out.status = v.status === undefined || v.status === null ? null : toStatus(v.status);
      }
    }
    // null / undefined / number / boolean / array → 保持中性结果

    out.confirmed = out.txHash != null && (out.blockNumber != null || out.status != null);
  } catch {
    /* 解析器被叫到名字之外的任何东西：中性结果，调用方降级 */
  }
  return out;
}

/** 与 sendClaim 完全同款的交易参数（legacy + 显式 gasPrice——实测公共节点对 type-2 不稳定）。
 *  独立一份而不是重构 sendClaim：蜂群热路径一个字都不动，这是纪律。 */
function buildClaimTx(cell, faction, nonce) {
  const data = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: "claim",
    args: [cell, faction],
  });
  const fresh = gasPrice && gasPrice > 0n && Date.now() - gasPriceAt < GAS_PRICE_TTL_MS * 3;
  const FALLBACK_GAS_PRICE = 110_000_000_000n; // 110 gwei（baseFee 约 100）
  return {
    chain,
    chainId: CHAIN_ID,
    to: DEPLOY.address,
    data,
    nonce: Number(nonce),
    gas: GAS_LIMIT,
    gasPrice: fresh ? gasPrice : FALLBACK_GAS_PRICE,
    type: "legacy",
  };
}

/**
 * 同步发送：签名 → eth_sendRawTransactionSync → 解析回执。
 * 返回 { txHash, confirmed, blockNumber, status, sync }。
 * 铁律：任何同步失败（方法不支持 / 超时 / 返回看不懂 / 节点回错）都
 * 原样降级回 sendClaim —— 观众的点击永远拿到与今天一致的回复，
 * 同步只是加料，不是新故障面。sendClaim 自己也失败时按原有语义往上抛。
 */
async function sendClaimSync(key, nonce, cell, faction) {
  try {
    const serialized = await key.account.signTransaction(buildClaimTx(cell, faction, nonce));
    // viem 没有这个 method 的现成 action —— 走底层 EIP-1193 request
    const rawResult = await pub.request({
      method: "eth_sendRawTransactionSync",
      params: [serialized],
    });
    const parsed = parseSyncReceipt(rawResult);
    if (!parsed.txHash) {
      throw new Error(`sync 无回执: ${parsed.errorText ?? JSON.stringify(rawResult ?? null).slice(0, 160)}`);
    }

    // 同步路径成功：补上与 sendClaim 成功分支相同的账（否则 stats/tps 会少记）
    key.sent++;
    key.failStreak = 0;
    recordSent();
    return {
      txHash: parsed.txHash,
      confirmed: parsed.confirmed,
      blockNumber: parsed.blockNumber,
      status: parsed.status,
      sync: true,
    };
  } catch (e) {
    warn(`sync 发送失败，降级为普通发送：${errText(e)}`);
    const hash = await sendClaim(key, nonce, cell, faction);
    return { txHash: hash, confirmed: false, blockNumber: null, status: null, sync: false };
  }
}

/** 真正发出去：带我们自己的 nonce，不等 receipt */
async function sendClaim(key, nonce, cell, faction) {
  const data = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: "claim",
    args: [cell, faction],
  });

  const base = {
    account: key.account,
    chain,
    to: DEPLOY.address,
    data,
    nonce: Number(nonce),
    gas: GAS_LIMIT,
  };
  // 统一走 legacy + 显式 gasPrice：公共测试网节点对 EIP-1559(type-2) 实测不稳定，legacy 是全通过的路径。
  // 缓存的新鲜 gasPrice 优先；拿不到就用兜底价（baseFee 约 100 gwei，给 150 足够）。
  const fresh = gasPrice && gasPrice > 0n && Date.now() - gasPriceAt < GAS_PRICE_TTL_MS * 3;
  const FALLBACK_GAS_PRICE = 110_000_000_000n; // 110 gwei（baseFee 约 100）
  const tx = { ...base, gasPrice: fresh ? gasPrice : FALLBACK_GAS_PRICE, type: "legacy" };

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const hash = await key.client.sendTransaction(tx);
      key.sent++;
      key.failStreak = 0;
      recordSent();
      return hash;
    } catch (e) {
      lastErr = e;
      const msg = errText(e);

      // 节点已经见过这笔 → 它其实进池了，按成功算
      if (KNOWN_ERR.test(msg)) {
        key.sent++;
        key.failStreak = 0;
        recordSent();
        return null;
      }
      // nonce 出问题 → 不再硬怼，交给回链同步；继续重试只会加重错乱
      if (NONCE_ERR.test(msg) || UNDERPRICE_ERR.test(msg)) {
        key.resyncNeeded = true;
        break;
      }
      // 没 gas → 这个 key 短期报废，别让同一个人继续往它上面撞
      if (NOGAS_ERR.test(msg)) {
        markUnfunded(key);
        break;
      }
      if (attempt < MAX_SEND_ATTEMPTS) await sleep(150 * attempt);
    }
  }

  key.resyncNeeded = true;
  recordFailed(key, lastErr ?? new Error("send failed"));
  throw lastErr ?? new Error("send failed");
}

/**
 * 一个 claim 的完整路径：占号（同步）→ 发送（异步等节点接收）。
 * 返回 txHash，但绝不 await receipt —— 0.5s 出块的链上，等 receipt 等于自断吞吐。
 *
 * sync=true（仅观众单次点击会传；蜂群与静默墙都不传，占号/对账逻辑两路共用）：
 * 走 sendClaimSync 拿同步回执，多返回 confirmed/blockNumber；失败自动降级回
 * 异步路径，调用方只看到 confirmed=false。
 */
async function relayClaim(cell, faction, sync = false) {
  if (totalPending() >= MAX_PENDING) {
    const err = new Error("queue_full");
    err.code = "queue_full";
    throw err;
  }

  const key = pickRelayer();
  if (!key) {
    const err = new Error(allDry() ? "relayer_unfunded" : "no_relayer_available");
    err.code = allDry() ? "relayer_unfunded" : "no_relayer_available";
    throw err;
  }

  // 先记「占位」，再 await：否则并发请求会在 await 期间看到 pending=0，
  // 全都挤到同一个 key 上，round-robin 就白做了
  key.pending++;
  try {
    await ensureNonce(key);

    // ★ 同步占号：从读 nextNonce 到写回之间没有 await，
    //   因为 JS 单线程 + 没有 await，两个并发请求不可能拿到同一个 nonce
    const nonce = key.nextNonce;
    key.nextNonce = nonce + 1n;

    let txHash = null;
    let confirmed = false;
    let blockNumber = null;
    let revertStatus = null;
    if (sync) {
      const s = await sendClaimSync(key, nonce, cell, faction);
      txHash = s.txHash;
      confirmed = s.confirmed;
      blockNumber = s.blockNumber;
      revertStatus = s.status;
    } else {
      txHash = await sendClaim(key, nonce, cell, faction);
    }
    // 交易已被节点接收 → 立刻写进版图缓存，不等 RPC 索引
    // （实测公共 RPC 的日志索引滞后几十到几百块，只靠 getLogs 现场会看起来"卡住"）
    // 例外：同步回执明确说这笔 revert 了 → 这一格链上没变，不写乐观缓存
    // E-fixes#2：把 txHash 一起交给 noteLocalClaim，让去重账本记住这笔是本进程代发的
    if (revertStatus !== false) noteLocalClaim(cell, faction, txHash);
    const out = { txHash, relayer: key.index, nonce: Number(nonce) };
    if (sync) {
      out.confirmed = confirmed;
      out.blockNumber = blockNumber;
      if (revertStatus === false) out.reverted = true;
    }
    return out;
  } finally {
    key.pending--;
    // 队列清空后立刻对账：把失败的 key 拉回链上真实 nonce（允许回退）
    if (key.pending === 0 && key.resyncNeeded) void resyncNonce(key, true);
  }
}

/**
 * nonce 对账。
 *
 * allowRewind = true  ：发送报过错（nonce too low / underpriced / 被丢弃）→
 *                       完全信任链上 pending nonce，允许往回退，把空洞补上。
 * allowRewind = false ：空闲期的例行对账 → **只允许前进**。
 *                       这是关键的保守策略：交易刚广播出去、还没进节点 mempool 视图时，
 *                       链上 nonce 会短暂落后于我们本地计数；此时若跟着退号，
 *                       下一笔就会和已经在飞的交易撞 nonce，整条车队连环失败。
 */
async function resyncNonce(key, allowRewind) {
  if (key.pending > 0) return; // 有在途交易时绝不动号
  try {
    const chainNonce = BigInt(
      await pub.getTransactionCount({ address: key.address, blockTag: "pending" }),
    );
    const local = key.nextNonce;
    const next =
      local === null ? chainNonce : allowRewind ? chainNonce : chainNonce > local ? chainNonce : local;

    if (next !== local) {
      log(`relayer#${key.index} nonce 对账：本地 ${local} → ${next}（链上 ${chainNonce}）`);
      key.nextNonce = next;
    }
    if (allowRewind) key.resyncNeeded = false;
    key.failStreak = 0;
  } catch (e) {
    warn(`relayer#${key.index} nonce 对账失败：${errText(e)}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 4. 限频（滑动窗口）
 * ──────────────────────────────────────────────────────────── */

const buckets = new Map(); // id -> number[]

/**
 * 滑动窗口限流。E-fixes#6：limit/windowMs/now 全部可注入 ——
 * 同一个桶机制服务两道闸（clientId 桶 6/10s、IP 桶 30/10s），
 * 也让 tests/e-fixes-server.test.ts 能用注入的 now 钉死窗口边界行为。
 */
export function rateHit(id, limit = RL_LIMIT, windowMs = RL_WINDOW_MS, now = Date.now()) {
  let arr = buckets.get(id);
  if (!arr) {
    if (buckets.size > 50_000) buckets.clear(); // 极端情况下的自保
    arr = [];
    buckets.set(id, arr);
  }
  let drop = 0;
  while (drop < arr.length && now - arr[drop] >= windowMs) drop++;
  if (drop) arr.splice(0, drop);

  if (arr.length >= limit) {
    return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - arr[0])) };
  }
  arr.push(now);
  return { ok: true };
}

/** E-fixes#6：请求的出口 IP（与 clientIdOf 同优先级：XFF 首段 > socket 对端）。 */
function ipOf(req) {
  const xff = req.headers["x-forwarded-for"];
  return (typeof xff === "string" ? xff.split(",")[0].trim() : "") || req.socket?.remoteAddress || "unknown";
}

function sweepBuckets() {
  const now = Date.now();
  for (const [id, arr] of buckets) {
    let drop = 0;
    while (drop < arr.length && now - arr[drop] >= RL_WINDOW_MS) drop++;
    if (drop) arr.splice(0, drop);
    if (arr.length === 0) buckets.delete(id);
  }
}

/* ────────────────────────────────────────────────────────────
 * 5. 后台轮询（block / gasPrice / 空闲 key 对账）
 * ──────────────────────────────────────────────────────────── */

let latestBlock = null;
let rpcOk = false;

let blockTimer = null;
let gasTimer = null;
let resyncTimer = null;
let sweepTimer = null;
let probeTimer = null;
let gridTimer = null;

function startLoops() {
  blockTimer = setInterval(async () => {
    try {
      const n = await pub.getBlockNumber();
      latestBlock = Number(n);
      rpcOk = true;
    } catch {
      rpcOk = false;
    }
  }, BLOCK_TTL_MS);
  blockTimer.unref?.();

  gasTimer = setInterval(() => {
    refreshGasPrice().catch(() => {});
  }, GAS_PRICE_TTL_MS);
  gasTimer.unref?.();

  // 空闲 key 例行对账：只许前进，不许退号（防止把在飞的交易覆盖掉）
  resyncTimer = setInterval(() => {
    for (const k of relayers) {
      if (k.pending === 0) void resyncNonce(k, false);
    }
  }, IDLE_RESYNC_MS);
  resyncTimer.unref?.();

  sweepTimer = setInterval(sweepBuckets, 30_000);
  sweepTimer.unref?.();

  // 全局版图：首次全量回放会很重（从部署块到现在几百块 × CHUNK），
  // 所以启动后立刻拉一次，之后每 2s 只补增量（通常 0 个新块，一次 getBlockNumber 就够）。
  gridTimer = setInterval(() => {
    refreshGridState().catch(() => {});
  }, 2_000);
  gridTimer.unref?.();

  // 被判定「没 gas」的 key：每 20s 重新探一次余额，补了 gas 就自动解禁。
  // 这样运营中途 npm run fund 之后不用重启中继。同样串行，避免把公共 RPC 打出 429。
  probeTimer = setInterval(async () => {
    for (const k of relayers) {
      if (k.funded) continue;
      try {
        const bal = await pub.getBalance({ address: k.address });
        if (bal > 0n) {
          k.funded = true;
          k.cooldownUntil = 0;
          k.failStreak = 0;
          log(`relayer#${k.index} 已恢复（余额 ${formatEther(bal)} MON）`);
        }
      } catch {
        /* 查不到就下一轮再说 */
      }
      await sleep(120);
    }
  }, 20_000);
  probeTimer.unref?.();
}

/* ────────────────────────────────────────────────────────────
 * 6. HTTP 小工具
 * ──────────────────────────────────────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const fail = (code, status) => {
      if (done) return;
      done = true;
      reject(new HttpError(status, code));
      req.destroy();
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail("body_too_large", 413);
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function clientIdOf(req, body) {
  const cid = body && typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (cid) return `c:${cid.slice(0, 64)}`;
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (typeof xff === "string" ? xff.split(",")[0].trim() : "") ||
    req.socket?.remoteAddress ||
    "unknown";
  return `i:${ip}`;
}

/* ────────────────────────────────────────────────────────────
 * 7. joinUrl 推导（手机上必须能真的打开）
 * ──────────────────────────────────────────────────────────── */

/**
 * 虚拟网卡的地址手机扫不到：Tailscale 是 CGNAT（100.x），VMware / WSL / Hyper-V
 * 是宿主机内部网段。会场的手机只在 WLAN 那个网段上。
 * 原来的实现取「第一个非 internal 的 IPv4」，在这台机器上恰好命中 Tailscale，
 * 于是二维码编码了一个全场没有一台设备能路由到的地址。
 */
const VIRTUAL_NIC = /tailscale|zerotier|vmware|vmnet|vethernet|hyper-v|wsl|docker|virtualbox|vbox|loopback|utun|^tun\d|^tap\d/i;
const PHYSICAL_NIC = /^(wlan|wi-?fi|以太网|ethernet|eth\d|en\d|本地连接|local area)/i;

function lanCandidates() {
  const nets = networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      // 169.254.x 是 DHCP 失败时的自分配地址，同样不可用
      if (ni.address.startsWith("169.254.")) continue;
      const rank = VIRTUAL_NIC.test(name) ? 2 : PHYSICAL_NIC.test(name) ? 0 : 1;
      out.push({ name, address: ni.address, rank });
    }
  }
  // sort 在 V8 上是稳定的：同级保持系统枚举顺序
  return out.sort((a, b) => a.rank - b.rank);
}

function lanIp() {
  return lanCandidates()[0]?.address ?? "127.0.0.1";
}

function resolveJoinUrl(reqHost, hasJoinFile) {
  if (process.env.JOIN_URL) {
    // 回环地址的 JOIN_URL 一定是错的：手机永远打不开它。
    // 这行曾经真实存在（.env 里写死 localhost:5180），会把下面所有推导全短路。
    // 与其相信一个可证明错误的配置，不如忽略它并留一条告警。
    const configured = process.env.JOIN_URL.trim();
    if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(configured)) {
      warn(`JOIN_URL=${configured} 指向本机，手机打不开 —— 已忽略，改用自动推导的地址`);
    } else {
      return configured;
    }
  }

  const hostHeader = typeof reqHost === "string" ? reqHost.trim() : "";
  const hostIsLoopback = /^(localhost|127\.|\[::1\])/i.test(hostHeader);

  if (hostHeader && !hostIsLoopback) {
    // 请求来自局域网地址 → 就用这个地址，扫码即可打开（中继自己也发静态文件）
    return `http://${hostHeader}/join.html`;
  }
  if (hasJoinFile) return `http://${lanIp()}:${PORT}/join.html`;
  // 没打包时观众页由 vite dev server 提供（默认 5180）
  return `http://${lanIp()}:5180/join.html`;
}

/* ────────────────────────────────────────────────────────────
 * 8. 静态文件（dist/ 存在就把大屏 / 观众页 / 导演台一起发出去）
 * ──────────────────────────────────────────────────────────── */

const STATIC_DIR = resolve(ROOT, process.env.STATIC_DIR ?? "dist");

/** 三端入口一个都不能少 —— 只发大屏不发观众页，二维码就扫到 404 */
const STATIC_ENTRIES = ["index.html", "join.html", "director.html"];

/**
 * 静态服务是否可用 —— **每次调用都重新判**。
 *
 * 原来是模块加载时算一次的常量。踩过的坑：dist/ 被部分清掉
 * （只剩 assets + join.html），常量为 false，于是 / /join.html /director.html 全 404，
 * 而 /health 照样 200 —— 二维码乖乖指向一个 404 页面，台上毫无征兆。
 */
function staticOn() {
  return STATIC_ENTRIES.every((f) => existsSync(resolve(STATIC_DIR, f)));
}

/**
 * web/vite.config.ts 的 input 只有 index.html（那个文件属于主控，W3 不能改），
 * 所以 `npm run build:web` 不会产出 dist/join.html —— 观众页就发不出去。
 *
 * 补建**三端全部入口**，缺哪个补哪个（任何缺一个都补全套）。
 * 原来只补 join.html：dist/ 被部分清掉时，观众页有了、大屏和导演台没有，
 * staticOn() 判 false，于是三个页面全 404 —— 二维码指向一个 404。
 *   - configFile: false  → 不依赖 cwd，absolute input，行为稳定
 *   - emptyOutDir: false → 增量补，不删已有文件
 *   - SKIP_AUTOBUILD=1   → 完全关掉
 */
let staticBuilding = null;

async function ensureStatic() {
  if (process.env.SKIP_AUTOBUILD === "1") return false;
  if (staticOn()) return true;

  const missing = STATIC_ENTRIES.filter((f) => !existsSync(resolve(STATIC_DIR, f)));
  if (!missing.length) return true;
  if (staticBuilding) return staticBuilding; // 并发请求共享同一次构建

  staticBuilding = (async () => {
    try {
      const { build } = await import("vite");
      log(`dist 缺少 ${missing.join(" / ")} —— 用 vite 增量补建三端…`);
      const web = resolve(ROOT, "web");
      await build({
        root: web,
        configFile: false,
        logLevel: "warn",
        build: {
          outDir: STATIC_DIR,
          emptyOutDir: false, // 不许清掉已有的产物
          rollupOptions: {
            input: {
              main: resolve(web, "index.html"),
              join: resolve(web, "join.html"),
              director: resolve(web, "director.html"),
            },
          },
        },
      });
      const ok = staticOn();
      log(ok ? "✔ 三端已补建到 dist/" : `补建后仍不全：${STATIC_ENTRIES.filter((f) => !existsSync(resolve(STATIC_DIR, f))).join(" / ")}`);
      return ok;
    } catch (e) {
      warn(`三端补建失败（不影响中继发 API）：${errText(e)}`);
      warn("  请手动跑：npm run build:web");
      return false;
    } finally {
      staticBuilding = null;
    }
  })();

  return staticBuilding;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, pathname) {
  if (!staticOn()) {
    return json(res, 404, {
      ok: false,
      error: "static_off",
      hint: "dist/ 不存在：先 npm run build:web，或用 vite dev server 打开观众页",
    });
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { ok: false, error: "bad_path" });
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const file = resolve(STATIC_DIR, `.${rel}`);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    return json(res, 403, { ok: false, error: "forbidden" });
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    return json(res, 404, { ok: false, error: "not_found", path: rel });
  }

  const ext = extname(file).toLowerCase();
  const immutable = rel.startsWith("/assets/") && !ext.endsWith(".html");
  res.writeHead(200, {
    ...CORS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

/* ────────────────────────────────────────────────────────────
 * 9. 路由
 * ──────────────────────────────────────────────────────────── */

const FACTION_NAMES = ["紫", "青", "琥珀", "绯"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

async function handleConfig(req, res) {
  // 观众页可能还没打包：先确保它存在，再据此给出正确的 joinUrl
  await ensureStatic().catch(() => false);
  const joinUrl = resolveJoinUrl(req.headers.host, existsSync(resolve(STATIC_DIR, "join.html")));
  if (!DEPLOY) {
    // 优雅降级：占位合约 + 明确 error，前端据此显示「未部署」，而不是白屏
    return json(res, 200, {
      contract: ZERO_ADDR,
      chainId: CHAIN_ID,
      rpc: RPC_URL,
      joinUrl,
      factionNames: FACTION_NAMES,
      error: "not_deployed",
    });
  }
  return json(res, 200, {
    contract: DEPLOY.address,
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    joinUrl,
    factionNames: FACTION_NAMES,
  });
}

async function handleClaim(req, res) {
  const raw = await readBody(req, BODY_LIMIT);

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(res, 400, { ok: false, error: "invalid_json", queue: totalPending() });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { ok: false, error: "invalid_body", queue: totalPending() });
  }

  // 输入校验
  const cell = body.cell;
  const faction = body.faction;
  if (!Number.isInteger(cell) || cell < 0 || cell > 2499) {
    return json(res, 400, { ok: false, error: "invalid_cell", queue: totalPending() });
  }
  if (!Number.isInteger(faction) || faction < 1 || faction > 4) {
    return json(res, 400, { ok: false, error: "invalid_faction", queue: totalPending() });
  }

  // 限频
  const cid = clientIdOf(req, body);
  const rl = rateHit(cid);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    return json(res, 429, {
      ok: false,
      error: "rate_limited",
      retryAfterMs: rl.retryAfterMs,
      queue: totalPending(),
    });
  }

  // E-fixes#6（C3 T4）：IP 第二桶。clientId 是自报值，随机 id 脚本能绕过上一道闸；
  // 这一道锚在出口 IP（30 笔/10s）。错误码区分开：too_many = 你这一片网络整体超速，
  // 观众页不用进逐人冷却条（那是 rate_limited 的语义），只会静默拒掉脚本洪峰。
  const ipKey = `ip:${ipOf(req)}`;
  const ipRl = rateHit(ipKey, IP_RL_LIMIT, IP_RL_WINDOW_MS);
  if (!ipRl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(ipRl.retryAfterMs / 1000)));
    return json(res, 429, {
      ok: false,
      error: "too_many",
      retryAfterMs: ipRl.retryAfterMs,
      queue: totalPending(),
    });
  }

  // G-cooldown 演示对照模式：同格 3s 服务端冷却（#363 式合约冷却的对照面）。
  // 刻意放在 IP 桶之后、not_deployed/useSync/relayClaim 之前 —— 拒绝必须发生在
  // **发 tx 之前**：对照点就是「服务端 429 不烧 gas」vs「#363 合约 revert 照烧 gas」。
  // 限频两闸在前，现行为（含其 429 语义）一字不动；mode=0 时整段短路。
  // tests/cooldown.test.ts 钉死纯函数；真 HTTP 429 由 node 冒烟验收（见 G-cooldown.done）。
  if (COOLDOWN_MODE) {
    const cd = cellCooldown.hit(cell);
    if (!cd.ok) {
      res.setHeader("Retry-After", String(Math.ceil(cd.retryAfterMs / 1000)));
      return json(res, 429, {
        ok: false,
        error: COOLDOWN_ERROR,
        retryAfterMs: cd.retryAfterMs,
        queue: totalPending(),
      });
    }
  }

  if (!DEPLOY) {
    return json(res, 503, { ok: false, error: "not_deployed", queue: totalPending() });
  }

  // B-sync：观众单次点击要同步回执（sync:true）。
  // 静默墙爆发期间（burstUntil 未过）key 全饱和，此时等回执会拖垮吞吐 ——
  // 一律退回异步路径，回复形状与今天完全一致（不带 confirmed 字段）。
  // 蜂群脚本不发 sync 字段，吞吐路径零改动。
  const useSync = body.sync === true && Date.now() >= burstUntil;

  // E-fixes#9：tap→链上确认计时锚点。起点 = 中继收到请求（≈观众松手，
  // 手机→中继的 HTTP 上行 ~30-80ms 不计入）；终点 = 同步回执拿到手。
  const claimT0 = Date.now();
  try {
    const r = await relayClaim(cell, faction, useSync);
    // E-fixes#9：只有 sync 路径且成功返回才进延迟窗口（异步吞吐没有"确认"可言）
    let confirmMs = null;
    if (useSync) {
      confirmMs = Date.now() - claimT0;
      noteConfirmLatency(confirmMs);
    }
    // v3「格子上的名字」：观众代号随成功提交一起落进中继缓存。
    // 蜂群（swarm.ts）不经过这个入口，所以大屏标签墙上每一个字都是真人。
    if (typeof body.nick === "string" && body.nick.trim()) setCellTag(cell, faction, body.nick);
    const resp = {
      ok: true,
      txHash: r.txHash,
      queue: totalPending(),
      relayer: r.relayer,
      nonce: r.nonce,
    };
    // 只有走了同步路径才多给这两个字段（向后兼容：旧客户端读不到就按原样处理）
    if (typeof r.confirmed === "boolean") {
      resp.confirmed = r.confirmed;
      resp.blockNumber = r.blockNumber ?? null;
      if (r.reverted) resp.reverted = true;
    }
    // E-fixes#9：本次 tap→链上确认耗时（观众页显示「本次确认 X.Xs」的原料）
    if (typeof confirmMs === "number") resp.confirmMs = confirmMs;
    return json(res, 200, resp);
  } catch (e) {
    // 中继侧的资源/配置问题用 503（运维该处理），发送失败用 502（当场可重试）
    const infra = e?.code === "queue_full" || e?.code === "no_relayer_available" || e?.code === "relayer_unfunded";
    const code = infra ? e.code : "send_failed";
    return json(res, infra ? 503 : 502, {
      ok: false,
      error: code,
      detail: errText(e),
      queue: totalPending(),
    });
  }
}

function handleStats(req, res) {
  // E-fixes#5/#9：字段（dryKeys / confirmLatency*）统一由 statsBody() 出，路由不发散
  return json(res, 200, statsBody());
}

/**
 * 全局版图快照。三端共享同一个真相源：
 *   大屏   → 启动时拉一次做基线，之后靠 getLogs 增量
 *   观众页 → 每 3s 轮询，看到别人的格子
 *   导演台 → 轮询 /api/stats（含 occupied/claims）
 * 只发非零格子（[id,color,heat]），2500 格全空时响应 ~60 字节。
 */
function handleState(req, res) {
  const body = JSON.stringify(snapshotGrid());
  // 观众页 78 台手机会反复拉，给个短缓存省带宽但不至于过期
  res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=2" });
  return res.end(body);
}

function handleHealth(req, res) {
  return json(res, 200, { ok: true, block: latestBlock, rpc: rpcOk, occupied: gridState.occupiedCount ?? 0 });
}

/* ────────────────────────────────────────────────────────────
 * 控场指令中转（导演台 → 大屏，跨设备）
 *
 * 为什么需要：BroadcastChannel 只在**同一浏览器同源页面**之间有效。
 * 而导演台的设计意图就是「第二个屏幕 / 平板」—— 一个人参赛时，
 * 笔记本接投影放大大屏、手机或平板开导演台，这是两台设备。
 * 原来的实现里 postMessage 不报错、状态栏还显示「已发送」，
 * 大屏那边什么都不会发生 —— 静默失效 + 假装成功，是最恶劣的失败形态。
 * 用中继转发：导演台 POST、大屏轮询 GET，两台设备同一个 origin 就行。
 * ──────────────────────────────────────────────────────────── */
const DIRECTOR_QUEUE_MAX = 64;
const directorQueue = []; // { seq, msg }
let directorSeq = 0;

function handleDirectorPost(req, res) {
  return readBody(req, BODY_LIMIT)
    .then((raw) => {
      let msg;
      try {
        msg = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { ok: false, error: "invalid_json" });
      }
      if (!msg || typeof msg.type !== "string") return json(res, 400, { ok: false, error: "invalid_msg" });

      // v3「静默墙」：中继收到就点火 —— 它自己数 5.2s 后把 total 笔轰出去；
      // 大屏拿到的是同一条消息，也从这一刻起各自倒数。
      // 不进 directorQueue：中继等待 ≠ 大屏等待，两边时钟各走各的，才对得齐。
      if (msg.type === "burst") {
        const r = requestBurst(msg.count);
        return json(res, r.ok ? 200 : 429, r);
      }

      directorSeq++;
      directorQueue.push({ seq: directorSeq, msg });
      // 只留最近 N 条：观众轮询慢的时候不该无限堆积
      while (directorQueue.length > DIRECTOR_QUEUE_MAX) directorQueue.shift();
      return json(res, 200, { ok: true, seq: directorSeq });
    })
    .catch(() => json(res, 400, { ok: false, error: "bad_body" }));
}

function handleDirectorGet(req, res, url) {
  const since = Number(url.searchParams.get("since") ?? 0);
  const msgs = directorQueue.filter((e) => e.seq > since).map((e) => e.msg);
  return json(res, 200, { ok: true, seq: directorSeq, msgs });
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (path === "/api/config") {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return handleConfig(req, res);
  }
  if (path === "/api/claim") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return handleClaim(req, res);
  }
  if (path === "/api/stats") return handleStats(req, res);
  if (path === "/api/state") return handleState(req, res);
  if (path === "/api/director") {
    if (req.method === "POST") return handleDirectorPost(req, res);
    if (req.method === "GET") return handleDirectorGet(req, res, url);
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }
  if (path === "/health") return handleHealth(req, res);

  if (path.startsWith("/api/")) return json(res, 404, { ok: false, error: "not_found" });

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, path);

  return json(res, 405, { ok: false, error: "method_not_allowed" });
}

/* ────────────────────────────────────────────────────────────
 * 10. 启动 / 退出
 *
 * IS_MAIN：只有作为主模块运行（node server/index.mjs / npm run relay /
 * gate.mjs 与 stage.mjs 的 spawn —— 都以脚本路径为 argv[1]）才占端口、
 * 开轮询、注册进程级 handler。被当作模块 import（tests/sync-claim.test.ts
 * 引 parseSyncReceipt 做纯逻辑单测）时这些全部跳过：单测进程不占 8791、
 * 不打网络、更不会在端口被占时 process.exit(1) 把 vitest 带走。
 * Windows 下路径比较忽略大小写（盘符 E:\ vs e:\ 会来自不同启动方）。
 * ──────────────────────────────────────────────────────────── */

const SELF_PATH = resolve(fileURLToPath(import.meta.url));
const ARGV_PATH = process.argv[1] ? resolve(process.argv[1]) : "";
const IS_MAIN =
  process.platform === "win32"
    ? SELF_PATH.toLowerCase() === ARGV_PATH.toLowerCase()
    : SELF_PATH === ARGV_PATH;

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    // 任何异常都不许崩：记录 + 尽量回一个 JSON
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { ok: false, error: e.code });
      else res.end();
      return;
    }
    warn(`unhandled route error: ${errText(e)}`);
    if (!res.headersSent) json(res, 500, { ok: false, error: "internal" });
    else res.end();
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

if (IS_MAIN) {
  // 进程级兜底：宁可少送一笔，也不能让 78 个人看到「连接失败」
  // （只在作为主模块运行时注册 —— 被单测 import 时不许吞掉 vitest 自己的错误）
  process.on("uncaughtException", (e) => {
    stats.failed++;
    warn(`uncaughtException（已吞掉，进程继续）：${errText(e)}`);
  });
  process.on("unhandledRejection", (e) => {
    stats.failed++;
    warn(`unhandledRejection（已吞掉，进程继续）：${errText(e)}`);
  });
}

function printBanner() {
  const ip = lanIp();
  const join = process.env.JOIN_URL ?? (staticOn() ? `http://${ip}:${PORT}/join.html` : `http://${ip}:5180/join.html`);
  console.log("");
  console.log("  MONAD BATTLEFIELD · relay");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  listen   http://0.0.0.0:${PORT}`);
  console.log(`  chain    ${CHAIN_ID}  rpc=${RPC_URL}`);
  console.log(`  contract ${DEPLOY ? DEPLOY.address : "未部署（deployments.json 缺失，/api/claim → not_deployed）"}`);
  console.log(`  relayer  ${relayers.length} keys · round-robin + least-loaded`);
  if (COOLDOWN_MODE) {
    console.log(`  ⚠ 对照模式 COOLDOWN_MODE=1：每格 3s 服务端冷却（429 ${COOLDOWN_ERROR}，发 tx 前拒绝）`);
  }
  console.log(`  static   ${staticOn() ? STATIC_DIR : "不全 → 正在自动补建（几秒后自动开始服务）"}`);
  console.log(`  join     ${join}`);
  console.log("  ─────────────────────────────────────────────");
  // 台上要用的是这一行：同一个局域网 origin 发大屏，二维码才和它同源可扫。
  // 用 localhost 开大屏，二维码就会指向 localhost，手机一台都打不开。
  // 大屏该用哪个地址：JOIN_URL 指向隧道时，投影也必须用隧道地址。
  // 三个面必须同源 —— 导演台靠 BroadcastChannel 推字幕，跨 origin 会静默失效。
  const joinOrigin = process.env.JOIN_URL?.match(/^https?:\/\/[^/]+/)?.[0] ?? `http://${ip}:${PORT}`;
  const usingTunnel = joinOrigin.startsWith("https://") && !joinOrigin.includes(ip);
  if (staticOn()) {
    console.log(`  大屏 →   ${joinOrigin}/`);
    console.log(`  导演 →   ${joinOrigin}/director.html`);
    console.log(`  ${usingTunnel ? "（公网隧道：手机用流量也能扫码）" : `（局域网：手机必须和本机同一个 wifi）`}`);
  } else {
    console.log(`  大屏 →   http://${ip}:5180/            ← 先 npm run dev；投影用这个，不要用 localhost`);
  }
  const alts = lanCandidates().slice(1, 4);
  if (alts.length) console.log(`  备用网卡 ${alts.map((a) => `${a.address}(${a.name})`).join("  ")}`);
  console.log("  ─────────────────────────────────────────────");
  for (const k of relayers) console.log(`   #${k.index}  ${k.address}`);
  console.log("");
}

/**
 * 启动时逐条查余额（**串行**）。
 * 公共 RPC 对并发很敏感：8 个 getBalance 一起打过去会被 429，
 * 而且会把真正要紧的 nonce 查询一起拖下水。宁可多花 2 秒。
 */
async function printBalances() {
  let dry = 0;
  for (const k of relayers) {
    try {
      const bal = await pub.getBalance({ address: k.address });
      const mon = Number(formatEther(bal));
      if (mon <= 0) {
        dry++;
        markUnfunded(k);
        warn(`relayer#${k.index} ${k.address} 余额 0 —— 这笔车队暂时停用`);
      } else {
        log(`relayer#${k.index} ${k.address} ${mon.toFixed(4)} MON`);
      }
    } catch (e) {
      // 查不到不等于没钱：保持可用，真发的时候再说
      warn(`relayer#${k.index} 余额查询失败：${errText(e)}`);
    }
    await sleep(120); // 给公共 RPC 一点喘息
  }
  if (dry) warn(`${dry}/${relayers.length} 个中继钱包没有 gas —— 跑 npm run fund 或用 RELAYER_KEYS 换一批`);
}

function shutdown(sig) {
  const up = Math.floor((Date.now() - T0) / 1000);
  console.log("");
  log(`收到 ${sig}，准备退出`);
  log(`uptime ${up}s · sent ${stats.sent} · failed ${stats.failed} · pending ${totalPending()}`);
  for (const k of relayers) {
    log(`  #${k.index} ${k.address} sent=${k.sent} failed=${k.failed} nextNonce=${k.nextNonce}`);
  }
  clearInterval(blockTimer);
  clearInterval(gasTimer);
  clearInterval(resyncTimer);
  clearInterval(sweepTimer);
  clearInterval(gridTimer);
  clearInterval(probeTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}

if (IS_MAIN) {
  server.listen(PORT, "0.0.0.0", () => {
    printBanner();
    startLoops();
    refreshGasPrice().catch(() => {});
    printBalances().catch(() => {});
    // 观众页可能还没打包：补建一次（不阻塞监听，失败只 warn）
    void ensureStatic();
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`端口 ${PORT} 已被占用 —— 换一个：PORT=8788 node server/index.mjs`);
      process.exit(1);
    }
    warn(`server error: ${errText(e)}`);
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
