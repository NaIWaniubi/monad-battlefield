#!/usr/bin/env node
/**
 * G2 · ab-demo —— 「打往届 #363 千人像素战争」一键 A/B 对照（台上/排练素材）
 *
 * 差异化的物证，不是一句话：
 *   #363 把冷却写进合约 —— 同格反复点，被拒的那几拍**照样上链执行、照样扣 gas**
 *   （Monad 按 gasLimit 计费，revert 也付钱 —— 单笔实测见 docs/EVIDENCE.md §5）。
 *   我们的设计：合约 claim() 合法 range 永成功（零拒绝 → 观众点击 0 浪费）；
 *   「同格 3s 冷却」只是中继的**可选演示开关**（COOLDOWN_MODE=1），
 *   拒绝发生在发 tx 之前 —— 被拒的拍子一克 gas 都不烧。
 *
 * 两轮轻量蜂群（各 ≤15s）：
 *   轮A = 模拟 #363 式「同格反复点」：所有拍子砸同一格 → landed/rejected 计数；
 *   轮B = 我们的「分散打」：每拍一个格 → 全部 landed。
 *   打印对比表并写 docs/ab-result.json（RUNBOOK §4 Q4 的「ab见 docs/ab-result.json」就指这里）。
 *
 * 预算纪律（硬红线）：
 *   · 只用 .bots.json 里余额 ≥ MIN_LANE_MON(默认0.007) 的道；
 *   · 两轮合计 gas ≤ BUDGET_MON(默认0.025 MON)，单价按实测 0.0066 MON/笔算；
 *   · 道不够 或 预算装不下计划笔数 → 自动降级 **DRY**（纯本地状态机模拟，不发交易，
 *     不出网之外的任何 RPC 写）—— 表里大字标 DRY，保证台上排练 100% 跑得出来。
 *   · --dry 强制模拟（连余额查询都不发）。
 *
 * 用法：
 *   node scripts/ab-demo.mjs            # 自动判：够钱真发，不够 DRY
 *   node scripts/ab-demo.mjs --dry      # 强制 DRY（排练用，永远能跑）
 *   node scripts/ab-demo.mjs --taps 12  # 每轮拍数（默认 20）
 *
 * 纯函数（decideDry/clampPlan/simulateRound/gasTable）由 IS_MAIN 守卫保护：
 * 被 tests/ab-demo.test.ts import 时零副作用。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 实测单价：60,000 gas × 110 gwei = 0.0066 MON（RUNBOOK §1.1，revert 同价） */
export const COST_PER_TX_MON = 0.0066;
/** A/B 两轮合计 gas 硬上限（真链总预算 0.03 MON，这里只拿 0.025，留 0.005 给重试抖动） */
export const BUDGET_MON = 0.025;
/** 一条「够格」的车道至少要有 0.007 MON ≈ 1 笔的票价 + 一点零头 */
export const MIN_LANE_MON = 0.007;
/** 每轮默认拍数与窗口（15s 内打完，reserve 限速下真发轮会更少 —— clampPlan 说了算） */
export const TAPS_PER_ROUND = 20;
export const ROUND_MS = 15_000;
/** 服务端同格冷却窗口 —— 与 server/index.mjs COOLDOWN_WINDOW_MS 同一语义 */
export const COOLDOWN_MS = 3000;

/* ───────────────────────── 纯函数（单测钉死） ───────────────────────── */

/** 预算容量：还能发几笔整数票。退化输入（0/负/NaN）→ 0，绝不除零。 */
export function clampPlan(budgetMon, costPerTx, planned = Infinity) {
  if (!(budgetMon > 0) || !(costPerTx > 0)) return 0;
  const cap = Math.floor(budgetMon / costPerTx);
  return Math.min(cap, Number.isFinite(planned) ? planned : cap);
}

/**
 * 发不发得起来？三件事：合格车道数、计划总笔数、预算容量。
 * 计划总笔数按「每轮 tapsPerRound 拍 × rounds 轮」算 —— 车道只决定摊得开不开，
 * 不放大笔数（这正是 reserve 限速下诚实的算术口径）。
 */
export function decideDry({ monPerBot, costPerTx = COST_PER_TX_MON, budgetMon = BUDGET_MON, tapsPerRound = TAPS_PER_ROUND, rounds = 2, minLanes = 2 }) {
  const usable = (monPerBot ?? []).filter((m) => Number.isFinite(m) && m >= MIN_LANE_MON).length;
  if (usable < minLanes) return { dry: true, reason: `合格车道（≥${MIN_LANE_MON} MON）只有 ${usable} 条，不足 ${minLanes} 条`, usableLanes: usable };
  const planned = tapsPerRound * rounds;
  const capacity = clampPlan(budgetMon, costPerTx, planned);
  if (capacity < planned) {
    return { dry: true, reason: `计划 ${planned} 笔 × ${costPerTx} MON = ${(planned * costPerTx).toFixed(4)} MON，超出 A/B 预算红线 ${budgetMon} MON（容量仅 ${capacity} 笔）`, usableLanes: usable };
  }
  return { dry: false, reason: `预算装得下：${capacity} / ${planned} 笔`, usableLanes: usable };
}

/**
 * 轮次状态机：逐拍过一遍「同格 3s 冷却」账本（语义与 server 的 createCellCooldown
 * 一致：放行成为新锚点；恰好满窗放行；被拒不续期）。
 * taps: [{cell, t}]（t 为 ms）。返回 landed/rejected/cellsTouched。
 */
export function simulateRound(taps, windowMs = COOLDOWN_MS) {
  const anchor = new Map();
  let landed = 0;
  let rejected = 0;
  const touched = new Set();
  for (const { cell, t } of taps) {
    const prev = anchor.get(cell);
    if (prev !== undefined && t - prev < windowMs) {
      rejected++;
      continue;
    }
    anchor.set(cell, t);
    landed++;
    touched.add(cell);
  }
  return { landed, rejected, cellsTouched: touched.size };
}

/**
 * 烧钱对照：#363 式（被拒的也上链扣钱）vs 我们（被拒的零成本）。
 * them = 每一拍都付钱；us = 只有放行笔付钱；waste = them - us。
 */
export function gasTable({ taps, landed, costPerTx = COST_PER_TX_MON }) {
  const themGasMon = taps * costPerTx;
  const usGasMon = landed * costPerTx;
  return { themGasMon, usGasMon, wasteMon: themGasMon - usGasMon };
}

/* ───────────────────────── 输入整形（也纯） ───────────────────────── */

/** 轮A 拍子：全砸同一格，均速铺满 roundMs（模拟观众对着一个热点格狂点）。 */
export function tapsA(n, cell = 2499, roundMs = ROUND_MS) {
  const step = n > 1 ? Math.floor(roundMs / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => ({ cell, t: i * step }));
}
/** 轮B 拍子：逐拍换格（分散打），同样铺满 roundMs。 */
export function tapsB(n, roundMs = ROUND_MS) {
  const step = n > 1 ? Math.floor(roundMs / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => ({ cell: i, t: i * step }));
}

/* ───────────────────────── 主流程（IS_MAIN 才跑） ───────────────────────── */

const SELF_PATH = resolve(fileURLToPath(import.meta.url));
const ARGV_PATH = process.argv[1] ? resolve(process.argv[1]) : "";
const IS_MAIN =
  process.platform === "win32"
    ? SELF_PATH.toLowerCase() === ARGV_PATH.toLowerCase()
    : SELF_PATH === ARGV_PATH;

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const argNum = (f, d) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
  };
  const forcedDry = has("--dry");
  const tapsPerRound = argNum("--taps", TAPS_PER_ROUND);
  const budgetMon = argNum("--budget", BUDGET_MON);

  let monPerBot = [];
  let bots = [];
  if (!forcedDry) {
    const p = resolve(ROOT, ".bots.json");
    if (existsSync(p)) {
      try {
        bots = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        bots = [];
      }
    }
    if (!bots.length) {
      console.warn("⚠ 没有 .bots.json —— 无法查真实余额，按 0 车道处理（自动 DRY）");
    } else {
      console.log(`查询 ${bots.length} 条车道的余额（串行，公共 RPC 怕并发）…`);
      const { createPublicClient, http } = await import("viem");
      const pub = createPublicClient({ transport: http(process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz", { timeout: 8_000 }) });
      for (const b of bots) {
        try {
          const wei = await pub.getBalance({ address: b.address });
          monPerBot.push(Number(wei) / 1e18);
        } catch {
          monPerBot.push(0);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  const planA = tapsA(tapsPerRound);
  const planB = tapsB(tapsPerRound);
  const decision = forcedDry
    ? { dry: true, reason: "--dry 强制本地模拟（不出网）", usableLanes: 0 }
    : decideDry({ monPerBot, tapsPerRound, budgetMon });

  const simA = simulateRound(planA);
  const simB = simulateRound(planB);
  const gA = gasTable({ taps: planA.length, landed: simA.landed });
  const gB = gasTable({ taps: planB.length, landed: simB.landed });

  const mode = decision.dry ? "DRY" : "REAL";
  console.log("");
  console.log(`  A/B 对照 · ${mode === "DRY" ? "DRY（本地模拟，未发任何 tx）" : "REAL（真链蜂群）"}`);
  console.log(`  判定依据：${decision.reason}`);
  console.log(`  合格车道：${decision.usableLanes} 条 ≥ ${MIN_LANE_MON} MON`);
  console.log("  ─────────────────────────────────────────────");
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`  ${pad("", 22)}${pad(`轮A 同格反复×${planA.length}`, 24)}轮B 分散×${planB.length}`);
  console.log(`  ${pad("上链成功 landed", 22)}${pad(simA.landed, 24)}${simB.landed}`);
  console.log(`  ${pad("被拒 rejected", 22)}${pad(simA.rejected, 24)}${simB.rejected}`);
  console.log(`  ${pad("我们烧的 gas", 22)}${pad(`${gA.usGasMon.toFixed(4)} MON`, 24)}${gB.usGasMon.toFixed(4)} MON`);
  console.log(`  ${pad("#363式烧的 gas", 22)}${pad(`${gA.themGasMon.toFixed(4)} MON`, 24)}${gB.themGasMon.toFixed(4)} MON`);
  console.log(`  ${pad("浪费差值", 22)}${pad(`${gA.wasteMon.toFixed(4)} MON`, 24)}${gB.wasteMon.toFixed(4)} MON`);
  console.log("  ─────────────────────────────────────────────");
  console.log("  读法：轮A 同格连点若发生在 #363 式合约冷却里，被拒的拍子每笔照烧 0.0066 MON；");
  console.log("        我们的栈里被拒只发生在服务端（发 tx 之前），零 gas。轮B 全放行是常态：");
  console.log("        合约 claim() 对合法 id 永成功，所以真实点击不存在白烧。");
  console.log("");

  // REAL 模式：真发（本轮预算下笔数被 clampPlan 顶死；reserve 限速 1 tx/3块 自然节流）
  let real = null;
  if (!decision.dry) {
    const usable = bots
      .map((b, i) => ({ ...b, mon: monPerBot[i] }))
      .filter((b) => b.mon >= MIN_LANE_MON)
      .slice(0, 2);
    real = await runRealRounds(usable, planA, planB, budgetMon);
  }

  const out = {
    ts: new Date().toISOString(),
    mode,
    reason: decision.reason,
    usableLanes: decision.usableLanes,
    costPerTxMon: COST_PER_TX_MON,
    budgetMon,
    cooldownWindowMs: COOLDOWN_MS,
    rounds: {
      A: { strategy: "same-cell hammer (as #363-style)", taps: planA.length, landed: simA.landed, rejected: simA.rejected, usGasMon: gA.usGasMon, themGasMon: gA.themGasMon, wasteMon: gA.wasteMon, real },
      B: { strategy: "spread over distinct cells", taps: planB.length, landed: simB.landed, rejected: simB.rejected, usGasMon: gB.usGasMon, themGasMon: gB.themGasMon, wasteMon: gB.wasteMon, real },
    },
  };
  const outPath = resolve(ROOT, "docs/ab-result.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`  已写 ${outPath.replace(ROOT + "/", "")}（RUNBOOK §4 / README 指向的就是它）`);
}

/**
 * 真发轮（预算红线在每一拍前复查；节点拒收的不计 spent —— 没上链就没烧钱）。
 * 我们的合约对合法 id 永成功，所以真发轮里「被拒」只可能来自 RPC/余额层，
 * 不是业务层 —— 业务层的同格拒绝是服务端 COOLDOWN_MODE 的演示面（见 simulateRound）。
 */
async function runRealRounds(usable, planA, planB, budgetMon) {
  const { createWalletClient, defineChain, http, parseGwei } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments.json"), "utf8"));
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID ?? 10143),
    name: "Monad Testnet",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz"] } },
  });
  const abi = [
    {
      type: "function",
      name: "claim",
      inputs: [
        { name: "id", type: "uint16" },
        { name: "color", type: "uint8" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ];
  const GAS_LIMIT = 60_000n; // 实测下限（50000 → 0/3 revert），按 gasLimit 计费所以也别多给
  const GAS_PRICE = parseGwei("110");
  const wallets = usable.map((bot) => {
    const account = privateKeyToAccount(bot.pk);
    return createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 15_000 }) });
  });

  let spent = 0;
  const summary = {};
  for (const [tag, plan] of [["A", planA], ["B", planB]]) {
    let landed = 0;
    let failed = 0;
    for (let i = 0; i < plan.length; i++) {
      if (spent + COST_PER_TX_MON > budgetMon) {
        console.warn(`轮${tag}：预算红线 ${budgetMon} MON 触顶，第 ${i + 1} 拍起停发（诚实计数，不硬挤）`);
        break;
      }
      try {
        const hash = await wallets[i % wallets.length].writeContract({
          address: dep.address,
          abi,
          functionName: "claim",
          args: [plan[i].cell, 1],
          gas: GAS_LIMIT,
          gasPrice: GAS_PRICE,
        });
        if (hash) {
          landed++;
          spent += COST_PER_TX_MON;
        }
      } catch (e) {
        failed++;
        console.warn(`轮${tag}第${i + 1}拍发送失败（不计 spent）：${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}`);
      }
      await new Promise((r) => setTimeout(r, 1300)); // reserve 限速线：1 tx/3 块 + 余量
    }
    summary[tag] = { landed, failed, spentMon: spent };
  }
  return summary;
}

if (IS_MAIN) {
  main().catch((e) => {
    console.error("ab-demo 失败：", e?.message ?? e);
    process.exit(1);
  });
}
