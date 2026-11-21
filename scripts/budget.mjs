/**
 * 上台前的gas预算核算 —— 回答唯一那个不能靠感觉回答的问题：
 * 「我这点币，够演多久？」
 *
 * 用法：
 *   node scripts/budget.mjs                 # 按当前余额 + 默认计划算
 *   node scripts/budget.mjs --txs 80 --sec 90 --audience 78
 *   node scripts/budget.mjs --swarm-sec 10  # 只算背景压测跑 10 秒
 *   node scripts/budget.mjs --watch --max-claims 3000   # S2-1 外部保险丝：
 *       轮询中继 /api/stats 的 sent，达到 N 打印 STOP 并以退出码 2 结束。
 *       只读中继计数、不碰链 —— RPC 黑洞下照常工作。硬截停的归属见 --patch。
 *   node scripts/budget.mjs --patch          # 打印「往 relay 接 MAX_CLAIMS 硬截停」
 *       的 5 行接入说明（纯输出，不改任何文件）。
 *
 * 它不做任何交易，只读余额和 deployments.json（--watch 模式只读中继 stats）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { createPublicClient, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── 参数 ─────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const strArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

/** 实测值，不是估值：claim 需要 60000 gas，50000 会 revert */
const GAS_PER_TX = BigInt(process.env.GAS_LIMIT ?? 60_000);
const GWEI = Number(process.env.GAS_PRICE_GWEI ?? 110);
const COST_PER_TX = Number(GAS_PER_TX) * GWEI * 1e-9; // MON

const TPS = arg("txs", 80);
const SECONDS = arg("sec", 90);
const AUDIENCE = arg("audience", 78);
const SWARM_SEC = arg("swarm-sec", null); // 只算这么多秒的背景压测

/* ── S2-1 · --patch：relay 侧硬截停的接入说明（输出即文档）──────
 * 边界诚实：真正的「第 N+1 笔必拒」只能长在 relay 里（stats.sent 的自增点、
 * allDry/queue 机制都在它进程内）。budget.mjs 在台面之外，只能做保险丝；
 * 这段文字是给上台前最后 10 分钟的人看的：粘 3 行进 server/index.mjs 即可。
 */
const PATCH_TEXT = `
  budget.mjs --patch · 把硬截停接进 relay（server/index.mjs）—— 说明，不自动改文件
  ─────────────────────────────────────────────────────────────
  ①  常量区（和 MAX_PENDING 等为邻）加一行：
        const MAX_CLAIMS = Number(process.env.MAX_CLAIMS ?? 0); // 0 = 不限
  ②  handleClaim() 里，输入校验 + 限频之后、进 relayClaim 之前插三行：
        if (MAX_CLAIMS > 0 && stats.sent >= MAX_CLAIMS)
          return json(res, 429, { ok: false, error: "budget_exhausted", queue: totalPending() });
  ③  重启中继：MAX_CLAIMS=3000 npm run relay
      —— /api/stats 与 /join.html 仍 200（诚实降级），观众点击得到 budget_exhausted。
  在 ①② 落地前，本脚本的 --watch 是外部保险丝：sent≥N 时 STOP+exit 2，
  看门狗/人按它掐掉 npm run swarm 与静默墙（链上剩余 tx 会自然出完）。
  现有 allDry/queue 只防「没 gas 空转」，防不了「gas 还有很多但演出到点了」——
  MAX_CLAIMS 截的是「笔数预算」，GAS 预算截的是「钱」，两条线不互相替代。
`;

/* ── S2-1 · --watch：轮询中继 stats.sent，达上限 STOP + exit 2 ──
 * 纯读 HTTP，不 import relay、不碰链：中继进程挂了/没起 → 每轮告警继续，
 * 绝不因拉取失败而误触发掐线（掐错比漏掐更糟）。
 * --polls k 给 CI/自测用：轮 k 次未触及 → 正常退 0；不给就永远看着。
 */
async function watchMain() {
  const max = arg("max-claims", Number(process.env.MAX_CLAIMS ?? NaN));
  if (!Number.isFinite(max) || max <= 0) {
    console.error("  --watch 需要上限：--max-claims N（或 env MAX_CLAIMS=N），N>0。拒绝盲跑。");
    process.exit(1);
  }
  const relayUrl = (strArg("relay", process.env.RELAY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8791}`)).replace(/\/+$/, "");
  const interval = Math.max(50, arg("interval", 5000));
  const polls = arg("polls", Infinity);
  const statsUrl = `${relayUrl}/api/stats`;
  console.log(`  watch  ${statsUrl} · 每 ${interval}ms · 上限 sent>=${max}（STOP+exit 2）`);
  for (let i = 0; i < polls; i++) {
    let sent = null;
    try {
      const r = await fetch(statsUrl, { cache: "no-store", signal: AbortSignal.timeout(Math.min(interval, 8000)) });
      if (r.ok) {
        const j = await r.json();
        sent = Number(j?.sent ?? NaN);
      } else {
        console.warn(`  [轮${i + 1}] 中继应答 ${r.status} —— 不可信数据，继续等`);
      }
    } catch (e) {
      console.warn(`  [轮${i + 1}] stats 拉取失败/unreachable：${String(e?.message ?? e).slice(0, 80)} —— 不触发，继续等`);
    }
    if (Number.isFinite(sent)) {
      console.log(`  [轮${i + 1}] sent=${sent} / max=${max}`);
      if (sent >= max) {
        console.log("");
        console.log(`  ██ STOP ██  sent=${sent} ≥ MAX_CLAIMS=${max} —— 预算已烧到线！`);
        console.log("  ██ STOP ██  立刻：Ctrl-C 蜂群、停静默墙；大屏切 ?demo=1 合成打底收尾。");
        console.log("  （永久截停在 relay：跑 node scripts/budget.mjs --patch 看 5 行接入说明）");
        process.exit(2);
      }
    }
    if (i + 1 < polls) await new Promise((r) => setTimeout(r, interval));
  }
  console.log(`  watch 结束：共 ${polls} 轮，未触及上限（未触发）`);
  process.exit(0);
}

if (has("patch")) {
  console.log(PATCH_TEXT);
  process.exit(0);
}
if (has("watch")) {
  await watchMain();
}

/* ── 读余额 ───────────────────────────────────────── */
function loadKeys() {
  const p = resolve(ROOT, ".relayers.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.keys ?? raw.relayers ?? [];
    const out = [];
    for (const it of list) {
      const v = typeof it === "string" ? it : it?.privateKey ?? it?.pk ?? it?.key;
      if (typeof v !== "string") continue;
      const pk = v.startsWith("0x") ? v : `0x${v}`;
      if (/^0x[0-9a-fA-F]{64}$/.test(pk)) out.push(pk);
    }
    return out;
  } catch {
    return [];
  }
}

const RPC_URL = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const pub = createPublicClient({ transport: http(RPC_URL, { timeout: 10_000 }) });

const keys = loadKeys();
if (!keys.length) {
  console.error("没有 .relayers.json 或里面没有合法私钥 —— 先 npm run relay 生成，或跑 tests/keys");
  process.exit(1);
}

const rows = [];
let totalWei = 0n;
for (const pk of keys) {
  const acc = privateKeyToAccount(pk);
  let bal = 0n;
  try {
    bal = await pub.getBalance({ address: acc.address });
  } catch {
    /* 查不到按 0 算，下面会标出来 */
  }
  totalWei += bal;
  rows.push({ addr: acc.address, bal });
}

const total = Number(totalWei) / 1e18;
const usable = rows.reduce((n, r) => n + Math.floor((Number(r.bal) / 1e18) / COST_PER_TX), 0);

/* ── 报告 ─────────────────────────────────────────── */
const fmt = (n) => n.toFixed(4);
const pad = (s, w) => String(s).padEnd(w);

console.log("");
console.log("  GAS 预算核算 · MONAD BATTLEFIELD");
console.log("  ─────────────────────────────────────────────");
console.log(`  单价          ${COST_PER_TX.toFixed(5)} MON / 笔  (${GAS_PER_TX} gas @ ${GWEI} gwei)`);
console.log(`  中继钱包      ${rows.length} 个`);
for (const r of rows) {
  const n = Math.floor((Number(r.bal) / 1e18) / COST_PER_TX);
  const flag = n === 0 ? "  ← 没 gas，会被跳过" : "";
  console.log(`    ${r.addr.slice(0, 10)}…  ${pad(fmt(Number(r.bal) / 1e18), 8)} MON  ${String(n).padStart(4)} 笔${flag}`);
}
console.log(`  合计          ${fmt(total)} MON  →  可支撑 ${usable} 笔`);
console.log("  ─────────────────────────────────────────────");

/* ── 计划 vs 预算 ─────────────────────────────────── */
const audienceNeed = AUDIENCE;
const swarmTxs = SWARM_SEC !== null ? TPS * SWARM_SEC : TPS * SECONDS;
const swarmNeed = Math.ceil(swarmTxs);
const needAll = audienceNeed + swarmNeed;

console.log("");
if (SWARM_SEC !== null) {
  console.log(`  计划：观众 ${audienceNeed} 笔 + 蜂群 ${TPS} tx/s × ${SWARM_SEC}s = ${swarmNeed} 笔`);
} else {
  console.log(`  计划：观众 ${audienceNeed} 笔 + 蜂群 ${TPS} tx/s × ${SECONDS}s = ${swarmNeed} 笔`);
}
console.log(`  需要          ${needAll} 笔 = ${fmt(needAll * COST_PER_TX)} MON`);
console.log(`  缺口          ${needAll > usable ? `${needAll - usable} 笔 = ${fmt((needAll - usable) * COST_PER_TX)} MON` : "无"}`);
console.log("");

if (needAll > usable) {
  // 给出「在现有预算下能怎么演」的可执行结论，而不是只报个红字
  const remainAfterAudience = usable - audienceNeed;
  const swarmSeconds = Math.max(0, Math.floor(remainAfterAudience / TPS));
  const audienceAffordable = Math.min(audienceNeed, usable);

  console.log("  ── 现有预算下能做到的方案 ──────────────────");
  if (usable >= audienceNeed) {
    console.log(`  ① 观众全量参与      ${audienceNeed} 笔（${fmt(audienceNeed * COST_PER_TX)} MON）— 可以做`);
    console.log(`     → 剩余还能跑蜂群 ${swarmSeconds} 秒（${TPS} tx/s）`);
    if (swarmSeconds < 5) {
      console.log(`     这不够撑起「80 tx/s」的观感。`);
      console.log(`     建议：蜂群改用 ?demo=1 合成密度打底，真实链上只留给观众点击 ——`);
      console.log(`           顶栏会如实标 DEMO+链上，不谎报成纯链上。`);
    }
  } else {
    console.log(`  ① 观众全量参与      做不到：只够 ${audienceAffordable} / ${audienceNeed} 人`);
    console.log(`     → 现场必须先把 faucet 的钱打进中继钱包，再谈演示`);
  }
  console.log("");
  console.log(`  ② 补币目标：至少要 ${fmt(needAll * COST_PER_TX)} MON 才能按计划演；`);
  console.log(`     建议备 ${fmt(needAll * COST_PER_TX * 1.5)} MON（1.5 倍余量，防重试和意外）`);
} else {
  console.log("  ✅ 预算够按计划演。留出余量再跑一次门禁就可以上台。");
}

/* ── E-fixes#10（C4#3）：reserve-balance 模型 ────────────────────
 * 「够多少钱」只回答「能发多少笔」，回答不了「每秒最多发多少笔」。
 * Monad 对余额 <10 MON 的 EOA 限 1 tx/3 块 ≈ 0.83 tx/s（0.5s 出块）；
 * ≥10 MON 才放满速（我们 500ms 间隔 = 2 tx/s/道）。C1 审计抓到的
 * 「实测 16 ≈ 0.83×17」正是这条线的形状。上限由钱包余额给，不由 GAP_MS 给。
 */
const RESERVE_MIN_MON = 10;
const fastLanes = rows.filter((r) => Number(r.bal) / 1e18 >= RESERVE_MIN_MON).length;
const slowLanes = rows.length - fastLanes;
const FAST_CAP = 2; // tx/s：GAP_MS=500 的满速道
const SLOW_CAP = 0.83; // tx/s：reserve 限速道（1 tx / 3 块）
const honestTps = fastLanes * FAST_CAP + slowLanes * SLOW_CAP;

console.log("");
console.log("  ── Reserve-balance 模型（吞吐上限是钱包给的，不是代码给的）──");
console.log(`  满储备道（≥10 MON/道）  ${String(fastLanes).padStart(3)} 道 × ${FAST_CAP} tps/道 = ${(fastLanes * FAST_CAP).toFixed(2)} tx/s`);
console.log(`  限速道（<10 MON/道）    ${String(slowLanes).padStart(3)} 道 × ${SLOW_CAP} tps/道 = ${(slowLanes * SLOW_CAP).toFixed(2)} tx/s`);
console.log(`  → 当前 ${rows.length} 道现实并行上限 ${honestTps.toFixed(1)} tx/s —— GAP_MS 调再小也压不过这条平台物理线`);
console.log(`  → 满打 80 tx/s 需要 40 道 × ≥10 MON = 400 MON 储备；当前 ${rows.length} 道 / ${fmt(total)} MON（缺口 ${fmt(Math.max(0, 400 - total))} MON，faucet 单地址有日限，按天分批注）`);
if (TPS > honestTps + 0.5) {
  console.log(`  ⚠ 计划 ${TPS} tx/s > 现实并行上限 ${honestTps.toFixed(1)} tx/s：超出部分不会变慢，会变成 fail`);
  console.log(`     —— 先把车道注到 ≥10 MON，或把计划口径改成 ${honestTps.toFixed(1)} tx/s（swarm.ts 已按此自钳限速）。`);
}
console.log("");
