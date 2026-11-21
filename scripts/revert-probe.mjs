#!/usr/bin/env node
/**
 * G2 · revert-probe —— 「被拒的写也烧 gas」的真链物证（只烧 ≤2 笔，预算 0.015 MON）
 *
 * 对照对象：往届 #363 千人像素战争把冷却写在合约里 —— 被冷却拒掉的点击
 * 依然是一笔真 tx，依然按 gasLimit 扣钱。我们不做辩解，直接发一笔
 * **注定 revert 的 claim(9999)**（合法 uint16、过不了 id<2500 的 BadId 检查），
 * 把回执摊在 docs/EVIDENCE.md §5：status=reverted（失败）、gasUsed>0（照扣）、
 * from 余额前后差 = 一笔的票价 —— 失败不免费，这就是那堵墙本身。
 *
 * 纪律：
 *   · 依赖只有 node: + viem（与 server/swarm 同路：legacy + 显式 gasPrice）；
 *   · 只用 .bots.json 里余额 ≥ 0.0075 MON（票价+余量）的道，逐条实查、不信账面；
 *   · 发送层异常最多重试一次；receipt 超时**不重发**（tx 可能已在飞，重发=双倍烧钱）；
 *   · 钱已经烧出去之后的任何采集失败都不许让进程崩 —— 兜底写进 §5，诚实存档；
 *   · 已有 §5 真数据默认跳过，--force 才再烧（防手滑连跑两遍）；
 *   · 余额不够 → EVIDENCE.md 写「待现场补」exit 0（这是预算纪律不是失败）。
 *
 * 用法：node scripts/revert-probe.mjs [--force]
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const RPC = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const GAS_LIMIT = 60_000n; // 实测口径：按 gasLimit 计费，给够但一分不多
const GAS_PRICE = 110_000_000_000n; // 110 gwei（baseFee≈100 的实测稳定档）
const COST_PER_TX_MON = 0.0066; // 60000 × 110 gwei
const LANE_MIN_MON = 0.0075; // 票价 + ~14% 余量
const RECEIPT_TIMEOUT_MS = 90_000;
const EV_PATH = resolve(ROOT, "docs/EVIDENCE.md");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const weiToMon = (w) => Number(w) / 1e18;
const short = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 180);

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 15_000, retryCount: 1 }) });

const CLAIM_ABI = [
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

/** 把 md 写成 EVIDENCE.md 的唯一 §5：已有占位（待现场补）就整段替换，没有就追加。 */
function upsertSection5(md) {
  const t = readFileSync(EV_PATH, "utf8");
  const start = t.indexOf("## §5");
  if (start < 0) {
    appendFileSync(EV_PATH, md);
    return;
  }
  const nl = t.indexOf("\n## ", start + 1); // §5 后面的下一个二级标题（若有）
  const tail = nl >= 0 ? "\n" + t.slice(nl + 1) : "";
  writeFileSync(EV_PATH, t.slice(0, start).replace(/\s*$/, "") + "\n" + md.trimStart() + tail);
}

function skipPlaceholder(why) {
  const note = `
## §5 Revert 也要付钱（对照 #363 式合约冷却）

**待现场补** —— 预检未通过：${why}。
结论口径不变（依据 = 本仓库实测链上规则：按 gasLimit 计费、revert 照扣，见 RUNBOOK §1.1）；
真 tx 物证在注资到位后一条命令补上：\`node scripts/revert-probe.mjs\`（预算上限 0.015 MON）。
`;
  try {
    const t = readFileSync(EV_PATH, "utf8");
    if (!t.includes("## §5")) appendFileSync(EV_PATH, note);
  } catch {
    /* EVIDENCE.md 不可写也别炸脚本（跳过原因已经打在 stdout 上） */
  }
  console.log(`跳过真发：${why}（EVIDENCE.md 已标「待现场补」）`);
}

async function main() {
  const force = process.argv.includes("--force");
  const checkOnly = process.argv.includes("--check"); // 只走预检不发 tx（台上排练用，0 gas）
  const evText = existsSync(EV_PATH) ? readFileSync(EV_PATH, "utf8") : "";
  const hasReal = evText.includes("## §5") && !evText.includes("待现场补");
  if (hasReal && !force) {
    log("EVIDENCE.md 已有 §5 真数据 —— 跳过（要再烧一笔请显式 --force）。");
    return;
  }

  // ── 1. 选道（串行实查余额） ──
  const p = resolve(ROOT, ".bots.json");
  if (!existsSync(p)) return skipPlaceholder("没有 .bots.json");
  let bots = [];
  try {
    bots = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return skipPlaceholder(".bots.json 解析失败");
  }
  let lane = null;
  for (const b of bots) {
    let wei = 0n;
    try {
      wei = await pub.getBalance({ address: b.address });
    } catch {
      continue; // 查不到按不够处理
    }
    if (weiToMon(wei) >= LANE_MIN_MON) {
      lane = { ...b, mon: weiToMon(wei) };
      break; // 一笔探针只要一条道
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!lane) return skipPlaceholder(`没有一条道余额 ≥ ${LANE_MIN_MON} MON（预算纪律：不为演示凑合）`);
  log(`探针车道：${lane.address.slice(0, 10)}…（${lane.mon.toFixed(4)} MON）`);
  if (checkOnly) {
    log(
      `--check：预检通过 —— 车道 ${lane.address.slice(0, 10)}… 余额 ${lane.mon.toFixed(4)} MON ≥ ${LANE_MIN_MON} MON，` +
        `真发只需去掉 --check（烧 ${COST_PER_TX_MON} MON）。未发任何 tx，EVIDENCE.md 未动。`,
    );
    return;
  }

  // ── 2. 发一笔注定 revert 的 claim(9999)（与蜂群同款：legacy + 显式 gasPrice） ──
  const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments.json"), "utf8"));
  const data = encodeFunctionData({ abi: CLAIM_ABI, functionName: "claim", args: [9999, 1] });
  log(`calldata=${data} —— selector ${data.slice(0, 10)}；9999 ≥ 2500 → 合约 BadId 必 revert`);

  const account = privateKeyToAccount(lane.pk);
  const nonce = await pub.getTransactionCount({ address: lane.address, blockTag: "pending" });
  const tx = { account, chain, to: dep.address, data, nonce, gas: GAS_LIMIT, gasPrice: GAS_PRICE, type: "legacy" };
  const wc = createWalletClient({ account, chain, transport: http(RPC, { timeout: 15_000, retryCount: 0 }) });

  let hash;
  try {
    hash = await wc.sendTransaction(tx);
  } catch (e) {
    log(`发送失败（重试一次）：${short(e)}`);
    try {
      hash = await wc.sendTransaction(tx);
    } catch (e2) {
      throw new Error(`两次发送均失败，停手不烧：${short(e2)}`);
    }
  }
  log(`已发出：${hash}`);

  // ── 3. 等回执（超时绝不重发 —— tx 可能已在飞） ──
  let rcpt = null;
  let receiptErr = null;
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline && !rcpt) {
    try {
      rcpt = await pub.getTransactionReceipt({ hash });
    } catch (e) {
      receiptErr = short(e);
    }
    if (!rcpt) await new Promise((r) => setTimeout(r, 1500));
  }

  // ── 4. 余额对照（块上历史查询优先，公共 RPC 剪枝就退到 latest 差值） ──
  let spentNote = "余额差未取得（公共 RPC 不支持历史块查询 / 查询失败）";
  let spentWei = null;
  if (rcpt) {
    const bn = rcpt.blockNumber;
    try {
      const before = await pub.getBalance({ address: lane.address, blockNumber: bn - 1n });
      const after = await pub.getBalance({ address: lane.address, blockNumber: bn });
      spentWei = before - after;
      spentNote = `块 #${bn - 1n}→#${bn} 实差 **${weiToMon(spentWei).toFixed(6)} MON**`;
    } catch (e) {
      spentNote = `历史余额差不可用（${short(e).slice(0, 80)}）—— 仅回执 gasUsed 存档`;
    }
  }

  if (!rcpt) {
    // 钱已花（或至少已广播），绝不重发 —— 把已知事实如实存档
    const md = `
## §5 Revert 也要付钱（对照 #363 式合约冷却）

**部分待补** —— tx 已广播但 90s 内未取到回执（不重发，这是预算纪律）：
\`${hash}\` · claim(9999) · 车道 ${lane.address.slice(0, 10)}… · 取回执错误 ${receiptErr ?? "无"}。
浏览器：https://testnet.monadscan.com/tx/${hash}
`;
    upsertSection5(md);
    throw new Error(`回执超时 —— 已存档 ${hash}，不重发`);
  }

  const okShape = rcpt.status === "reverted" && rcpt.gasUsed > 0n;
  // gasLimit：Monad 的 receipt 不返回这个字段（实测 keys 里没有 gasLimit），
  // 必须回 eth_getTransactionByHash 取 —— 而「gasUsed == tx.gas」正是「按 gasLimit 计费」的物证。
  let txGas = null;
  try {
    const rawTx = await pub.request({ method: "eth_getTransactionByHash", params: [hash] });
    txGas = rawTx?.gas ? BigInt(rawTx.gas) : null;
  } catch {
    /* 拿不到就按发送参数兜底（本脚本自己设的 GAS_LIMIT，是同一值的已知来源） */
  }
  const gasLimitShown = txGas ?? GAS_LIMIT;
  const billedFullGasLimit = rcpt.gasUsed === gasLimitShown;

  log(`回执：status=${rcpt.status} gasUsed=${rcpt.gasUsed} gasLimit=${gasLimitShown} block=#${rcpt.blockNumber}`);
  log(`余额：${spentNote}`);

  const md = `
## §5 Revert 也要付钱（对照 #363 式合约冷却）

> 结论一句话：**在 Monad 上，一笔「注定失败、什么都没改变」的链上写入，照样按 gas 扣钱。**
> #363 把冷却写进合约，被它拒掉的每一次点击都是一笔这样的 tx —— 观众的手感免费，主办方的钱包不免费。
> 我们的栈：合约 claim() 对合法 id 永成功（观众点击不存在「被拒还烧钱」）；同格 3s 冷却是中继的
> 演示开关（COOLDOWN_MODE=1），拒绝发生在发 tx 之前，被拒点击 0 gas —— 对照表见 docs/ab-result.json。

| 项 | 值 |
|---|---|
| 交易 | \`claim(9999)\`（selector \`${data.slice(0, 10)}\` = claim(uint16,uint8)）→ 合约第一行 \`if (id >= 2500) revert BadId()\` |
| hash | \`${hash}\` |
| 状态 | \`${rcpt.status}\` —— 失败，链上状态**零**改变 |
| gasUsed / gasLimit | \`${rcpt.gasUsed}\` / \`${gasLimitShown}\`${billedFullGasLimit ? "（**gasUsed == gasLimit**）" : ""} —— Monad 的 receipt 不返回 gasLimit，取自 eth_getTransactionByHash.gas。${billedFullGasLimit ? "一笔 revert 的交易按全额 gasLimit 扣费 = 「revert 也烧钱」的直接物证" : "失败交易分文不少"} |
| 发送方余额 | ${spentNote}（单笔全价 ≈ ${COST_PER_TX_MON} MON） |
| 区块 | #${rcpt.blockNumber} · Monad Testnet (chainId ${CHAIN_ID}) |
| 浏览器 | https://testnet.monadscan.com/tx/${hash} |
| 形状判定 | ${okShape ? "✅ status=reverted 且 gasUsed>0（预期坐实）" : "⚠ 与预期形状不符，照实存档"} |

零成本复现（读侧，两条 curl）：
\`\`\`bash
# 回执：status=0x0、gasUsed=0xea60 —— 注意回执不含 gasLimit 字段（Monad 特性）
curl -s -X POST ${RPC} -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${hash}"]}'
# 交易本体：gas=0xea60 → gasUsed == gasLimit
curl -s -X POST ${RPC} -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["${hash}"]}'
\`\`\`
发送侧复现：\`node scripts/revert-probe.mjs --force\`（再烧 ${COST_PER_TX_MON} MON —— 别在手抖的早上跑）。
`;
  upsertSection5(md);
  log(`已写入 EVIDENCE.md §5（${hash.slice(0, 14)}…）`);
  if (spentWei !== null && weiToMon(spentWei) > 0.015) {
    console.warn(`⚠ 单笔实烧 ${weiToMon(spentWei).toFixed(4)} MON 超出 0.015 档位 —— 立即停，不再发任何 tx`);
  }
}

main().catch((e) => {
  console.error("revert-probe 失败：", e?.message ?? e);
  process.exit(1);
});
