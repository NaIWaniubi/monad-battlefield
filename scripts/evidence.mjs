#!/usr/bin/env node
/**
 * E1-2 · 链上证据自动化
 *
 * 直连 Monad 测试网公共 RPC，产出 docs/EVIDENCE.auto.md：
 *   1. eth_blockNumber 取当前块高；
 *   2. 精确统计最近 N 块（默认 200）打到 Battlefield 的 Claim 事件；
 *   3. 自 startBlock 以来的累计 Claim —— 主口径是**精确值**：合约没有全局
 *      计数器，但每格 cells[id].heat 恰好是该格被 claim 的累计次数
 *      （见 Battlefield.sol：每笔 claim 对单格 heat 严格 +1），
 *      所以 Σ heat(id=0..2499) = 部署以来总 claim 数。用 eth_getStorageAt
 *      分批读回求和。副口径保留事件抽样线性外推作量级互证。
 *
 * 为什么副口径要抽样而不是全史回放（实测，写死在这里免得后人再踩）：
 *   · 公共 RPC 的 eth_getLogs 窗口上限约 100 块（200 块直接
 *     "block range too large"，见 server/index.mjs §LOG_WINDOW 注释）；
 *   · startBlock(79,333,331) 距今约 218 万块 → 全史需 2 万+ 请求，
 *     公共节点不该也没有这个义务扛。抽样 24 窗 = 24 个请求，一分钟级跑完。
 *
 * 在 CI 里的地位：evidence job（仅 main push）调用本脚本；
 * 步骤标了 continue-on-error —— 证据生成失败（RPC 抽风等）绝不把 CI 弄红。
 * 本地随时可手动跑：node scripts/evidence.mjs
 *
 * 依赖：仅 node 内置模块 + 全局 fetch（node ≥ 18）。不 import viem，
 * 这样 CI 的 evidence job 连 npm ci 都不用跑。topic0 的正确性由
 * tests/evidence.test.ts 用 viem 现场计算来钉死。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* 与 contracts/Battlefield.sol:21 的事件声明一一对应；
 * keccak256("Claim(uint16,address,uint8,uint32)")，单测里用 viem 复核。 */
export const CLAIM_TOPIC0 =
  "0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9";

export const DEFAULTS = {
  rpc: "https://testnet-rpc.monad.xyz",
  address: "0xd525ef7ee4072e80765fd61633d80322040afd9d",
  startBlock: 79333331n,
  chainId: 10143n,
  recentBlocks: 200n, // 精确统计的近期窗口总跨度
  windowSize: 100n, // 单次 eth_getLogs 的块跨度上限（实测公共 RPC 硬约束）
  sampleWindows: 24, // 全史抽样的窗口个数（副口径，量级互证）
  totalCells: 2500n, // 合约格子总数；Σ heat 精确总口径的读回数量
  storageBatch: 100, // 每批 eth_getStorageAt 条数（实测公共 RPC batch 上限恰为 100）
};

/* ───────────────────────── 纯函数区（单测覆盖） ───────────────────────── */

/** JSON-RPC 的十六进制区块号 → bigint；形状不对直接 TypeError，绝不静默出 0。 */
export function parseBlockNumber(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(hex)) {
    throw new TypeError(`not a hex block number: ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}

/** bigint/number → 公共 RPC 接受的 0x 十六进制字符串。 */
export function toHexBlock(n) {
  return "0x" + BigInt(n).toString(16);
}

/**
 * 把「以 latest 结尾、总跨度 span」的区间切成一串 ≤ windowSize 的窗口。
 * 升序返回，相邻窗口无缝隙无重叠；首尾贴边时允许短窗。
 */
export function splitWindows(latest, span, windowSize) {
  latest = BigInt(latest);
  span = BigInt(span);
  windowSize = BigInt(windowSize);
  if (span <= 0n || windowSize <= 0n) return [];
  const start = latest - span + 1n < 0n ? 0n : latest - span + 1n;
  const out = [];
  let to = latest;
  while (to >= start) {
    const from = to - windowSize + 1n < start ? start : to - windowSize + 1n;
    out.push({ from, to });
    to = from - 1n;
  }
  return out.reverse();
}

/**
 * 在 [startBlock, latest] 上放 count 个等距 windowSize 宽窗口（确定性：
 * 同样输入永远同样布局，CI 产物可复现）。
 * 窗口够密则互不重叠；历史短于全部窗口时退化为 splitWindows 全量覆盖。
 */
export function sampleWindows(startBlock, latest, count, windowSize) {
  startBlock = BigInt(startBlock);
  latest = BigInt(latest);
  windowSize = BigInt(windowSize);
  count = Math.max(0, Math.floor(Number(count)));
  if (count === 0 || latest < startBlock) return [];
  const span = latest - startBlock + 1n;
  if (span <= windowSize * BigInt(count)) {
    return splitWindows(latest, span, windowSize);
  }
  const usable = span - windowSize; // 首窗贴 startBlock、末窗贴 latest 时可分配的总步长
  const denom = BigInt(Math.max(1, count - 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = startBlock + (usable * BigInt(i)) / denom;
    out.push({ from, to: from + windowSize - 1n });
  }
  return out;
}

/**
 * 只数真属于本合约 Claim 事件的日志（topic0 + 地址都过滤）。
 * 公共 RPC 理论上是服务端过滤后返回的，但证据脚本不赌它守约 ——
 * 客户端再核一遍，错一条宁少计不多计。
 */
export function countClaims(logs, address, topic0 = CLAIM_TOPIC0) {
  const wantTopic = String(topic0).toLowerCase();
  const wantAddr = address == null ? null : String(address).toLowerCase();
  let n = 0;
  for (const l of logs ?? []) {
    if (!l || !Array.isArray(l.topics)) continue;
    if (String(l.topics[0] ?? "").toLowerCase() !== wantTopic) continue;
    if (wantAddr && String(l.address ?? "").toLowerCase() !== wantAddr) continue;
    n++;
  }
  return n;
}

/** 采样密度线性外推：sampledClaims / sampledBlocks × totalBlocks，四舍五入。 */
export function extrapolate(sampledClaims, sampledBlocks, totalBlocks) {
  sampledClaims = BigInt(sampledClaims);
  sampledBlocks = BigInt(sampledBlocks);
  totalBlocks = BigInt(totalBlocks);
  if (sampledBlocks <= 0n || totalBlocks <= 0n) return 0;
  return Math.round(Number(sampledClaims) * Number(totalBlocks) / Number(sampledBlocks));
}

/**
 * eth_getStorageAt 的槽值 → 该格 heat。
 * Battlefield.sol 的 Cell{owner,heat,color} 打包在一个 slot：
 * 低 20 字节 owner，随后 4 字节 heat（>>160），再高 color（>>188）。
 * 空槽（'0x'/'0x0'/全零）→ 0n；形状不对抛 TypeError，绝不猜。
 */
export function parseHeatSlot(raw) {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{0,64}$/.test(raw)) {
    throw new TypeError(`not a storage hex word: ${JSON.stringify(raw)}`);
  }
  if (raw.length <= 3) return 0n; // "0x" / "0x0"
  return (BigInt(raw) >> 160n) & 0xffffffffn;
}

const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * 渲染 docs/EVIDENCE.auto.md。
 * 时间戳双轨（UTC + 北京）；估计值旁边必须带「均匀假设外推、仅量级参考」的
 * 免责句 —— 这份文件会被截图进展示，口径必须自己站得住。
 */
export function renderEvidenceMarkdown(d, now = new Date()) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const cst = new Date(now.getTime() + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
  const estTxt = d.estimate == null ? "—" : "~" + fmt(d.estimate);
  const estNote =
    d.estimate == null
      ? `本轮 ${fmt(d.sampleCount)} 个抽样窗全部失败（sampleFails=${d.sampleFails}），互证口径未给出估计值；以上方 Σheat 精确值为准。`
      : `**~${fmt(d.estimate)} 建立在「claim 在全史均匀分布」假设上，只作量级参考。**
链上活动实际不均匀（演示/蜂群时段集中爆发，均匀采样常打不中），
引用总数请以上方 Σheat 精确值为准。`;
  return `# EVIDENCE.auto · 链上证据（自动生成）

> **链上证据自动生成于 ${iso}（UTC）/ ${cst}（北京时间）** ——
> 本文件由 CI 的 \`evidence\` job（main push）运行 \`scripts/evidence.mjs\` 生成，
> 手工修改会在下次跑 CI 时被覆盖。人工策展版证据见 \`docs/EVIDENCE.md\`。

## 口径与数据源

| 项 | 值 |
|---|---|
| RPC（JSON-RPC 直连，可当场复现） | \`${d.rpc}\` |
| 链 | chainId ${d.chainId}（Monad Testnet） |
| 合约（Battlefield） | \`${d.address}\` |
| 部署块 startBlock | ${fmt(d.startBlock)} |
| Claim 事件 topic0 | \`${CLAIM_TOPIC0}\` |

公共 RPC 实测硬约束：\`eth_getLogs\` 单次窗口 ≲100 块（超限报
\`block range too large\`），因此下表由分窗口求和得出，非全史回放。

## 最新观测

| 指标 | 值 |
|---|---|
| 当前块高（采集时刻） | ${fmt(d.latest)} |
| 最近 ${fmt(d.recentBlocks)} 块内的 Claim（**精确计数**，eth_getLogs 分窗） | ${fmt(d.recentClaims)} |
| ${fmt(d.startBlock)} → ${fmt(d.latest)} 累计 Claim 总数（**精确**，Σ cells[id].heat） | ${d.totalClaims == null ? "—（存储读回不可用，降级见下）" : fmt(d.totalClaims)} |
| 同区间累计 Claim（抽样估计 · 互证口径，均匀假设外推） | ${estTxt} |

累计精确口径的原理：Battlefield.sol 没有任何全局计数器，但每笔 claim 对
所写格子的 \`heat\` 严格 +1，所以 2500 个 slot 的 heat 之和 = 部署以来总
claim 数。本表用 \`eth_getStorageAt\`（分批 batch）直接读合约存储求和 ——
不依赖公共 RPC 的日志索引（索引有滞后），也不受 getLogs 窗口上限约束。

抽样互证细节：${fmt(d.sampleCount)} 个 100 块等距窗口（失败 ${d.sampleFails} 个），
合计采样 ${fmt(d.sampledBlocks)} 块、${fmt(d.sampledClaims)} 条 Claim，按密度外推。
${estNote}

## 复现命令

\`\`\`bash
# 1) 当前块高
curl -s -X POST ${d.rpc} -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# 2) 一个 100 块窗口的 Claim 精确计数（改 hex 区间即可复核任意窗口）
curl -s -X POST ${d.rpc} -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
    "address":"${d.address}",
    "topics":["${CLAIM_TOPIC0}"],
    "fromBlock":"${toHexBlock(BigInt(d.latest) - 99n)}",
    "toBlock":"${toHexBlock(d.latest)}"
  }]}' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).result.length+' claims in last 100 blocks'))"
\`\`\`

浏览器抽查：\`https://testnet.monadscan.com/address/${d.address}\`
`;
}

/* ───────────────────────── 网络区（单测不覆盖，CI 真跑） ───────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcCall(rpc, method, params, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${method} 连续 ${tries} 次失败：${lastErr?.message ?? lastErr}`);
}

/** JSON-RPC batch：一次 HTTP 往返带 ≤100 条 eth_getStorageAt（实测公共 RPC batch 上限=100）。 */
async function rpcBatchCall(rpc, method, paramsList, { tries = 3, timeoutMs = 30000 } = {}) {
  const body = paramsList.map((params, i) => ({ jsonrpc: "2.0", id: i + 1, method, params }));
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const arr = Array.isArray(j) ? j : null;
      if (!arr) {
        // 超限等场景公共 RPC 回单个 error 对象，把它的原话带进异常而不是吞成"形状异常"
        const why = j && j.error ? JSON.stringify(j.error).slice(0, 200) : JSON.stringify(j).slice(0, 160);
        throw new Error(`batch 响应非数组：${why}`);
      }
      if (arr.length !== paramsList.length) {
        throw new Error(`batch 响应条数 ${arr.length} ≠ 请求 ${paramsList.length}`);
      }
      const byId = new Map(arr.map((r) => [r.id, r]));
      return paramsList.map((_, k) => {
        const r = byId.get(k + 1);
        if (!r) throw new Error(`batch 缺 id=${k + 1} 的响应`);
        if (r.error) throw new Error(`${method}#${k + 1}: ${JSON.stringify(r.error).slice(0, 200)}`);
        return r.result;
      });
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${method} batch 连续 ${tries} 次失败：${lastErr?.message ?? lastErr}`);
}

/**
 * 精确累计口径：Σ heat(cells[0..totalCells-1]) = 部署以来总 claim 数。
 * 前提（Battlefield.sol 保证）：每笔 claim 对单格 heat 严格 +1，uint32 不溢出。
 * 任何一批最终失败 → 抛错（宁缺毋假），由调用方决定降级还是放弃。
 */
export async function sumHeat(rpc, address, totalCells, batchSize) {
  const n = BigInt(totalCells);
  const size = BigInt(batchSize);
  let sum = 0n;
  for (let start = 0n; start < n; start += size) {
    const end = start + size < n ? start + size : n;
    const paramsList = [];
    for (let id = start; id < end; id++) paramsList.push([address, toHexBlock(id), "latest"]);
    const results = await rpcBatchCall(rpc, "eth_getStorageAt", paramsList);
    for (const raw of results) sum += parseHeatSlot(raw);
    await sleep(100); // 公共节点礼让节流
  }
  return sum;
}

/** 读 deployments.json（有则用），环境变量优先。 */
export function loadConfig(env = process.env) {
  const conf = { ...DEFAULTS };
  const p = join(ROOT, "deployments.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j.address) conf.address = String(j.address);
      if (j.startBlock != null) conf.startBlock = BigInt(j.startBlock);
      if (j.chainId != null) conf.chainId = BigInt(j.chainId);
    } catch {
      /* deployments.json 坏了不拦证据脚本 —— 用内置默认值并在产物里如实标注来源 */
    }
  }
  if (env.RPC_URL || env.MONAD_RPC_URL) conf.rpc = env.RPC_URL || env.MONAD_RPC_URL;
  if (env.ADDRESS) conf.address = env.ADDRESS;
  if (env.START_BLOCK) conf.startBlock = BigInt(env.START_BLOCK);
  if (env.EVIDENCE_RECENT_BLOCKS) conf.recentBlocks = BigInt(env.EVIDENCE_RECENT_BLOCKS);
  if (env.EVIDENCE_WINDOW) conf.windowSize = BigInt(env.EVIDENCE_WINDOW);
  if (env.EVIDENCE_SAMPLES) conf.sampleWindows = Number(env.EVIDENCE_SAMPLES);
  return conf;
}

export async function main() {
  const conf = loadConfig();
  const log = (...a) => console.log("[evidence]", ...a);
  log(`RPC=${conf.rpc} address=${conf.address} startBlock=${conf.startBlock}`);

  const chainIdHex = await rpcCall(conf.rpc, "eth_chainId", []);
  const chainId = parseBlockNumber(chainIdHex);
  if (chainId !== conf.chainId) {
    throw new Error(`RPC 返回 chainId=${chainId}，期望 ${conf.chainId} —— 拒绝在错链上出证据`);
  }

  const latest = parseBlockNumber(await rpcCall(conf.rpc, "eth_blockNumber", []));
  log(`latest block = ${latest}`);

  /* 1) 近段精确计数：拆成 ≤windowSize 的窗口逐窗拉，任何一窗失败则整项失败
   *    （精确计数宁可报错，不能给个偏小的「精确」数）。 */
  let recentClaims = 0;
  for (const w of splitWindows(latest, conf.recentBlocks, conf.windowSize)) {
    const logs = await rpcCall(conf.rpc, "eth_getLogs", [
      {
        address: conf.address,
        topics: [CLAIM_TOPIC0],
        fromBlock: toHexBlock(w.from),
        toBlock: toHexBlock(w.to),
      },
    ]);
    recentClaims += countClaims(logs, conf.address);
    await sleep(120);
  }
  log(`claims in last ${conf.recentBlocks} blocks = ${recentClaims}`);

  /* 2) 累计精确口径：Σ cells[id].heat（直接读合约存储，不依赖日志索引）。
   *    读挂了就降级为「只有抽样」，产物里如实写明，不中断出文件。 */
  let totalClaims = null;
  try {
    totalClaims = await sumHeat(conf.rpc, conf.address, conf.totalCells, conf.storageBatch);
    log(`Σ heat = ${totalClaims}（部署以来总 claim，精确）`);
  } catch (e) {
    log(`存储求和不可用，累计口径降级为仅抽样：${String(e.message).slice(0, 160)}`);
  }

  /* 3) 全史抽样（互证口径）：个别窗失败计数后继续，产物里如实写 sampleFails。 */
  let sampledClaims = 0n;
  let sampledBlocks = 0n;
  let sampleFails = 0;
  const wins = sampleWindows(conf.startBlock, latest, conf.sampleWindows, conf.windowSize);
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    try {
      const logs = await rpcCall(conf.rpc, "eth_getLogs", [
        {
          address: conf.address,
          topics: [CLAIM_TOPIC0],
          fromBlock: toHexBlock(w.from),
          toBlock: toHexBlock(w.to),
        },
      ]);
      sampledClaims += BigInt(countClaims(logs, conf.address));
      sampledBlocks += w.to - w.from + 1n;
    } catch (e) {
      sampleFails++;
      log(`抽样窗 #${w.from}→#${w.to} 失败：${String(e.message).slice(0, 120)}`);
    }
    process.stdout.write(`\r[evidence] 抽样 ${i + 1}/${wins.length}`);
    await sleep(120);
  }
  process.stdout.write("\n");
  const samplesAllFailed = wins.length > 0 && sampleFails === wins.length;
  if (samplesAllFailed && totalClaims == null) {
    throw new Error(`抽样 ${wins.length} 窗全部失败且 Σheat 读回不可用 —— 无任何累计口径，不出文件`);
  }

  const totalBlocks = latest - conf.startBlock + 1n;
  const estimate = samplesAllFailed ? null : extrapolate(sampledClaims, sampledBlocks, totalBlocks);
  log(
    `sampled ${sampledClaims} claims / ${sampledBlocks} blocks → ` +
      (estimate == null ? "estimate n/a" : `estimate ~${estimate} total`),
  );

  const md = renderEvidenceMarkdown(
    {
      rpc: conf.rpc,
      chainId: conf.chainId.toString(),
      address: conf.address,
      startBlock: conf.startBlock.toString(),
      latest,
      recentBlocks: conf.recentBlocks,
      recentClaims,
      totalClaims: totalClaims == null ? null : Number(totalClaims),
      sampledClaims,
      sampledBlocks,
      sampleCount: wins.length,
      sampleFails,
      estimate,
    },
    new Date(),
  );
  const out = join(ROOT, "docs", "EVIDENCE.auto.md");
  writeFileSync(out, md, "utf8");
  log(`written: ${out}`);
}

/* ── IS_MAIN：被 import 时（单测）只导出纯函数，绝不触网 ── */
const SELF_PATH = resolve(fileURLToPath(import.meta.url));
const ARGV_PATH = process.argv[1] ? resolve(process.argv[1]) : "";
const IS_MAIN =
  process.platform === "win32"
    ? SELF_PATH.toLowerCase() === ARGV_PATH.toLowerCase()
    : SELF_PATH === ARGV_PATH;

if (IS_MAIN) {
  main().catch((e) => {
    console.error("[evidence] FAILED:", e?.message ?? e);
    process.exitCode = 1;
  });
}
