#!/usr/bin/env node
/**
 * settle.mjs — 参与证明 → 真实结算（纯 JS，零 TS 强转，零构建步骤）
 *
 * 把「活动参与」从计数升级为**真实链上经济行为**：
 *   观众 claim（可验证的参与） → 链下按事件聚合（可复核的排名） → 真实转账（真金白银的结算）
 *
 * 数据来源全部可独立复核：
 *   · Claim 事件：Battlefield.sol `event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)`
 *   · 公共 RPC eth_getLogs 单窗口实测上限 ≲100 块 → 本脚本分块并发扫描，块大小自动收缩
 *   · 合约无全局计数器，所有统计都是链下从事件推导（与合约设计一致）
 *
 * 用法：
 *   node scripts/settle.mjs                          # 干跑：只算账，不转账，退出 0
 *   node scripts/settle.mjs --window 8000             # 干跑，扫描最近 8000 块
 *   node scripts/settle.mjs --pot 0.02                # 真转 0.02 MON 给贡献榜前 3 名（按 claim 数比例）
 *   node scripts/settle.mjs --pot 0.02 --top 5        # 前 5 名
 *   node scripts/settle.mjs --pot 0.02 --to 0xABC…    # 指定单一受益人（赞助池模式）
 *   node scripts/settle.mjs --from 81472000 --to-block 81500000   # 显式块区间（覆盖历史爆发段）
 *   node scripts/settle.mjs --window 60000 --json     # 末尾多打一行机器可读 JSON 汇总
 *
 * 退出码：0 成功 / 1 参数或状态错误（余额不足、窗口内 0 条 claim 等）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/* ── 常量（与合约 / 前端保持同一口径） ─────────────────────────────── */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RPC = "https://testnet-rpc.monad.xyz";
const EXPLORER = "https://testnet.monadscan.com";

/** grid.ts FACTIONS 下标 → 名称（0 号为无主） */
const FACTIONS = [null, "紫", "青", "琥珀", "绯"];

const GAS_PRICE_DEFAULT = 110_000_000_000n; // 110 gwei，legacy
const GAS_LIMIT_DEFAULT = 60_000n;          // 纯 EOA 转账（21000 起 + 余量）
const CHUNK_DEFAULT = 100n;                 // 公共 RPC eth_getLogs 实测硬上限 ≲100 块
const CONCURRENCY_DEFAULT = 8;

/* ── 小工具 ───────────────────────────────────────────────────────── */

const num = (n) => Number(n).toLocaleString("en-US");

class CliError extends Error {}

function parseArgs(argv) {
  const o = {
    pot: null,
    top: 3,
    window: 5000n,
    from: null,
    toBlock: null,
    payTo: null,
    chunk: CHUNK_DEFAULT,
    concurrency: CONCURRENCY_DEFAULT,
    gasPrice: GAS_PRICE_DEFAULT,
    gasLimit: GAS_LIMIT_DEFAULT,
    noWait: false,
    json: false,
    help: false,
  };

  const VALUE_FLAGS = new Set([
    "--pot", "--top", "--window", "--from", "--to-block", "--to",
    "--chunk", "--concurrency", "--gas-price", "--gas-limit",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : null;

    if (!flag.startsWith("--")) throw new CliError(`无法识别的参数：${raw}（参数须以 -- 开头）`);

    if (VALUE_FLAGS.has(flag)) {
      let value = inline;
      if (value === null) {
        if (i + 1 >= argv.length) throw new CliError(`${flag} 缺少取值`);
        value = argv[++i];
      }
      if (value === "" || value.startsWith("--")) throw new CliError(`${flag} 缺少取值`);
      switch (flag) {
        case "--pot": o.pot = value; break;
        case "--top": o.top = toInt(value, flag, 1); break;
        case "--window": o.window = toBigInt(value, flag, 0n); break;
        case "--from": o.from = toBigInt(value, flag, 0n); break;
        case "--to-block": o.toBlock = toBigInt(value, flag, 0n); break;
        case "--to": o.payTo = value; break;
        case "--chunk": o.chunk = toBigInt(value, flag, 1n); break;
        case "--concurrency": o.concurrency = toInt(value, flag, 1); break;
        case "--gas-price": o.gasPrice = toBigInt(value, flag, 1n); break;
        case "--gas-limit": o.gasLimit = toBigInt(value, flag, 21_000n); break;
      }
      continue;
    }

    switch (flag) {
      case "--no-wait": o.noWait = true; break;
      case "--json": o.json = true; break;
      case "--help":
      case "-h": o.help = true; break;
      default: throw new CliError(`未知参数：${flag}（--help 看用法）`);
    }
  }
  return o;
}

function toBigInt(v, flag, min) {
  if (!/^\d+$/.test(String(v))) throw new CliError(`${flag} 需要非负整数，收到 ${v}`);
  const n = BigInt(v);
  if (n < min) throw new CliError(`${flag} 不能小于 ${min}，收到 ${v}`);
  return n;
}

function toInt(v, flag, min) {
  const n = toBigInt(v, flag, BigInt(min));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CliError(`${flag} 过大：${v}`);
  return Number(n);
}

/** 进程环境优先；缺失时回落读 .env（让 `node scripts/settle.mjs` 裸跑也能工作） */
function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

function readJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new CliError(`缺少文件：${rel}`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CliError(`${rel} 不是合法 JSON：${e.message}`);
  }
}

const pct = (part, whole) => (whole === 0 ? "0.0" : ((part * 100) / whole).toFixed(1));

/* ── 分块扫描 Claim 事件 ───────────────────────────────────────────── */

function makeChunks(from, to, chunk) {
  const out = [];
  for (let f = from; f <= to; f += chunk) {
    const end = f + chunk - 1n;
    out.push([f, end > to ? to : end]);
  }
  return out;
}

/**
 * viem 的 getLogs 不保证在运行时 ABI 下填 `args`（实测 viem 2.57 返回原始 Log），
 * 所以这里显式用 decodeEventLog 解一次；再失败则按 topics/words 手工兜底，
 * 保证「拿不到解码结果」永远不会被静默当成「没有 claim」。
 */
function decodeClaim(log, abi) {
  if (log.args && log.args.who) return log.args;
  try {
    const decoded = decodeEventLog({ abi, eventName: "Claim", topics: log.topics, data: log.data });
    if (decoded?.args?.who) return decoded.args;
  } catch {
    /* 落到手工解析 */
  }
  // 手工兜底：topic1 = id(uint16)，topic2 = who(address)，data word0 = color(uint8)，word1 = heat(uint32)
  const t = log.topics || [];
  const d = String(log.data || "");
  if (t.length < 3 || d.length < 66) return null;
  const who = "0x" + t[2].slice(26).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(who)) return null;
  const colorHex = d.slice(2, 66);
  return {
    id: BigInt(t[1]),
    who,
    color: Number(BigInt("0x" + colorHex)),
    heat: BigInt("0x" + d.slice(66, 130)),
  };
}

/**
 * 并发拉取 Claim 日志。公共 RPC 对 getLogs 的窗口有硬上限，
 * 单窗口失败时自动对半收缩（收缩对后续窗口同样生效）。
 */
async function scanClaims({ pub, address, abi, from, to, chunk, concurrency }) {
  let effectiveChunk = chunk;
  const chunks = makeChunks(from, to, effectiveChunk);
  const logs = [];
  const failures = [];
  const undecodable = [];
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const [start, end] = chunks[cursor++];
      let a = start;
      while (a <= end) {
        const b = a + effectiveChunk - 1n > end ? end : a + effectiveChunk - 1n;
        try {
          const batch = await pub.getLogs({
            address,
            abi,
            eventName: "Claim",
            fromBlock: a,
            toBlock: b,
          });
          for (const raw of batch) {
            const args = decodeClaim(raw, abi);
            if (args) logs.push({ args, blockNumber: raw.blockNumber, txHash: raw.transactionHash });
            else undecodable.push({ block: String(raw.blockNumber), tx: raw.transactionHash });
          }
          a = b + 1n;
        } catch (e) {
          const msg = String(e?.shortMessage || e?.message || e);
          // 窗口过大 → 收缩后原地重试；其他错误记录并跳过该窗口
          if (/block range|too large|exceed|limit|range/i.test(msg) && effectiveChunk > 1n) {
            effectiveChunk = effectiveChunk / 2n;
            continue;
          }
          failures.push({ from: String(a), to: String(b), error: msg.slice(0, 120) });
          a = b + 1n;
        }
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, chunks.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { logs, failures, undecodable, effectiveChunk };
}

/* ── 主流程 ───────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0];
    console.log(header.replace(/^#!.*\n/, ""));
    return 0;
  }

  loadEnv();

  const RPC = process.env.RPC_URL || DEFAULT_RPC;
  const deployments = readJson("deployments.json");
  const artifact = readJson("contracts/artifacts/Battlefield.json");
  const address = deployments.address;
  const abi = artifact.abi;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new CliError(`deployments.json 里没有合法 address：${address}`);
  }
  if (!Array.isArray(abi)) throw new CliError("contracts/artifacts/Battlefield.json 缺少 abi 数组");

  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new CliError("缺少合法 PRIVATE_KEY（环境变量或 .env），无法确定结算账户");
  }

  const chain = {
    id: Number(deployments.chainId) || 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };

  const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, timeout: 20_000 }) });
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain, transport: http(RPC, { retryCount: 2, timeout: 20_000 }) });

  /* 1) 解析扫描区间 */
  const head = await pub.getBlockNumber();
  const toBlock = opts.toBlock !== null && opts.toBlock <= head ? opts.toBlock : head;
  const fromBlock = opts.from !== null ? opts.from : (toBlock > opts.window ? toBlock - opts.window : 0n);
  if (fromBlock > toBlock) throw new CliError(`扫描区间非法：from ${fromBlock} > to ${toBlock}`);
  const span = toBlock - fromBlock + 1n;

  const balance = await pub.getBalance({ address: account.address });

  console.log(`合约      ${address}  (chainId ${chain.id})`);
  console.log(`结算账户  ${account.address}`);
  console.log(`账户余额  ${formatEther(balance)} MON`);
  console.log(`扫描区间  #${num(fromBlock)} → #${num(toBlock)}（${num(span)} 块）`);
  console.log(`RPC       ${RPC}`);
  console.log(`分块      ${opts.chunk} 块/请求，并发 ${opts.concurrency}\n`);

  /* 2) 拉日志并聚合 */
  const t0 = Date.now();
  const { logs, failures, undecodable, effectiveChunk } = await scanClaims({
    pub,
    address,
    abi,
    from: fromBlock,
    to: toBlock,
    chunk: opts.chunk,
    concurrency: opts.concurrency,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (effectiveChunk !== opts.chunk) {
    console.log(`[自适应] RPC 拒绝 ${opts.chunk} 块窗口，块大小已收缩为 ${effectiveChunk}`);
  }
  if (failures.length) {
    console.log(`[警告] ${failures.length} 个窗口读取失败（统计可能偏低）：`);
    for (const f of failures.slice(0, 3)) console.log(`        #${f.from}-#${f.to}: ${f.error}`);
  }
  if (undecodable.length) {
    console.log(`[警告] ${undecodable.length} 条 Claim 日志解码失败，已从统计中排除：`);
    for (const u of undecodable.slice(0, 3)) console.log(`        block #${u.block} tx ${u.tx}`);
  }

  /** addr(lowercase) → { count, factions: Map<color,count> } */
  const byWho = new Map();
  /** color → claim 次数 */
  const byColor = new Map();

  for (const l of logs) {
    const who = String(l.args?.who || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(who)) continue;
    const color = Number(l.args?.color);
    const rec = byWho.get(who) || { count: 0, factions: new Map() };
    rec.count += 1;
    rec.factions.set(color, (rec.factions.get(color) || 0) + 1);
    byWho.set(who, rec);
    byColor.set(color, (byColor.get(color) || 0) + 1);
  }

  const totalClaims = logs.length;
  const uniqueWallets = byWho.size;

  /* 3) 阵营胜负：1..4 中计数最高者 */
  const factionCounts = [0, 0, 0, 0, 0];
  let otherColors = 0;
  for (const [c, n] of byColor) {
    if (c >= 1 && c <= 4) factionCounts[c] += n;
    else otherColors += n;
  }
  let winner = 1;
  for (let c = 2; c <= 4; c++) if (factionCounts[c] > factionCounts[winner]) winner = c;

  /* 4) 贡献榜 */
  const ranks = [...byWho.entries()]
    .map(([who, rec]) => {
      const topf = [...rec.factions.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      return { who, count: rec.count, topFaction: topf };
    })
    .sort((a, b) => b.count - a.count || a.who.localeCompare(b.who));

  const factionLine = factionCounts
    .slice(1)
    .map((n, i) => `${FACTIONS[i + 1]} ${n}`)
    .join(" / ");
  const winnerLabel = `${FACTIONS[winner]}方 #${winner}`;

  console.log(`Claim 总数   ${num(totalClaims)}   独立地址 ${num(uniqueWallets)}   扫描耗时 ${elapsed}s`);
  console.log(`阵营计数     ${factionLine}${otherColors ? ` / 其他 ${otherColors}` : ""}`);
  console.log(
    `胜方阵营     ${winnerLabel}（${factionCounts[winner]} 条 claim，占 ${pct(factionCounts[winner], totalClaims)}%）`
  );

  const showTop = Math.min(opts.top, ranks.length);
  console.log(`\n贡献榜 Top ${showTop}：`);
  if (ranks.length === 0) {
    console.log("  （本窗口内没有任何 Claim 事件）");
  } else {
    for (let i = 0; i < showTop; i++) {
      const r = ranks[i];
      const fl = FACTIONS[r.topFaction] || `color=${r.topFaction}`;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${r.who}  ×${String(r.count).padStart(3)}` +
          `  (${pct(r.count, totalClaims)}%)  [${fl}]`
      );
    }
  }

  /* 5) 生成结算计划（干跑也打印，便于先看清楚） */
  let targets;
  if (opts.payTo) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.payTo)) throw new CliError(`--to 不是合法地址：${opts.payTo}`);
    targets = [{ who: opts.payTo.toLowerCase(), weight: 1, note: "指定受益人" }];
  } else {
    targets = ranks.slice(0, opts.top).map((r) => ({ who: r.who, weight: r.count, note: "" }));
  }

  const self = account.address.toLowerCase();
  const skippedSelf = [];
  targets = targets.filter((t) => {
    if (t.who === self) {
      skippedSelf.push(t.who);
      return false;
    }
    return true;
  });

  const weightSum = targets.reduce((s, t) => s + t.weight, 0);

  console.log(
    `\n结算计划${opts.payTo ? "（指定受益人）" : `（贡献榜前 ${targets.length} 名，按 claim 数加权）`}：`
  );
  if (skippedSelf.length) {
    console.log(`  · 跳过 ${skippedSelf.length} 个「结算账户自身」地址（自转无意义，省 gas）`);
  }
  if (targets.length === 0) {
    console.log("  （无受益人）");
  } else {
    for (const t of targets) {
      const share = weightSum > 0 ? `${pct(t.weight, weightSum)}%` : "n/a";
      console.log(`  · ${t.who}  权重 ${t.weight} (${share})${t.note ? `  ${t.note}` : ""}`);
    }
  }

  const summary = {
    contract: address,
    settlementAccount: account.address,
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    spanBlocks: String(span),
    totalClaims,
    uniqueWallets,
    factionCounts: {
      [FACTIONS[1]]: factionCounts[1],
      [FACTIONS[2]]: factionCounts[2],
      [FACTIONS[3]]: factionCounts[3],
      [FACTIONS[4]]: factionCounts[4],
    },
    winnerFaction: winnerLabel,
    top: ranks.slice(0, opts.top).map((r) => ({ address: r.who, claims: r.count })),
  };

  /* 6) 干跑 */
  if (!opts.pot) {
    if (opts.json) console.log(`\nSETTLE_JSON ${JSON.stringify({ mode: "dry-run", ...summary })}`);
    console.log(`\n[干跑] 未发生任何转账。`);
    console.log(`       加 --pot <MON> 即真实转入上面的受益人（按权重分配），tx 可在 ${EXPLORER} 复核。`);
    return 0;
  }

  /* 7) 真实结算 */
  if (targets.length === 0) {
    console.error(`\n[中止] 没有可结算的受益人（窗口内 0 条 claim，或唯一贡献者就是结算账户本身）。`);
    return 1;
  }

  const pot = parseEther(opts.pot);
  if (pot <= 0n) throw new CliError(`--pot 必须大于 0，收到 ${opts.pot}`);

  const gasCost = opts.gasPrice * opts.gasLimit * BigInt(targets.length);
  const needed = pot + gasCost;
  if (balance < needed) {
    console.error(
      `\n[中止] 余额不足：需要 ${formatEther(needed)} MON` +
        `（奖池 ${formatEther(pot)} + gas 上限 ${formatEther(gasCost)}），`
    );
    console.error(`       当前 ${formatEther(balance)} MON，缺 ${formatEther(needed - balance)} MON。`);
    return 1;
  }

  // 按权重分配，最后一笔吃掉整数除法余数 → 各笔之和严格等于奖池
  const amounts = targets.map((t) => (pot * BigInt(t.weight)) / BigInt(weightSum));
  const distributed = amounts.reduce((s, a) => s + a, 0n);
  amounts[amounts.length - 1] += pot - distributed;

  let nonce = await pub.getTransactionCount({ address: account.address });
  const sent = [];

  console.log(`\n真实结算：奖池 ${formatEther(pot)} MON → ${targets.length} 个地址`);
  console.log(
    `gas ${opts.gasPrice / 1_000_000_000n} gwei × ${opts.gasLimit} × ${targets.length} 笔，起始 nonce ${nonce}\n`
  );

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const value = amounts[i];
    try {
      const hash = await wallet.sendTransaction({
        to: t.who,
        value,
        nonce: nonce++,          // 串行 nonce，避免并发覆盖
        gas: opts.gasLimit,
        gasPrice: opts.gasPrice, // 给了 gasPrice 且无 type → legacy tx
      });
      let receipt = null;
      if (!opts.noWait) {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }
      sent.push({
        to: t.who,
        valueWei: value.toString(),
        value: formatEther(value),
        hash,
        status: receipt ? receipt.status : "pending",
        block: receipt ? Number(receipt.blockNumber) : null,
      });
      const statusText = receipt
        ? `${receipt.status} · block #${num(receipt.blockNumber)}`
        : "已广播";
      console.log(`  ✓ ${t.who}  ${formatEther(value)} MON  ${statusText}`);
      console.log(`    tx ${hash}`);
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      console.log(`  ✗ ${t.who}  ${formatEther(value)} MON  失败：${msg.slice(0, 100)}`);
      sent.push({
        to: t.who,
        valueWei: value.toString(),
        value: formatEther(value),
        hash: null,
        error: msg.slice(0, 200),
      });
      // 失败后重新对齐链上 nonce，避免后续交易全部卡住
      nonce = await pub.getTransactionCount({ address: account.address });
    }
  }

  const ok = sent.filter((s) => s.hash && s.status === "success").length;
  const failed = sent.length - ok;

  console.log(`\n结算结果：成功 ${ok} 笔，失败 ${failed} 笔，奖池 ${formatEther(pot)} MON`);
  for (const s of sent) {
    if (s.hash) console.log(`  ${EXPLORER}/tx/${s.hash}`);
  }
  console.log(`\n复核方式：任取上面一个 tx hash，在 ${EXPLORER} 打开，`);
  console.log(`          或用 eth_getTransactionByHash 直连 ${RPC} 读取（无需信任本脚本的输出）。`);
  console.log(`          这就是闭环的最后一环：参与不只是计数，是真实经济行为。`);

  if (opts.json) {
    console.log(
      `\nSETTLE_JSON ${JSON.stringify({
        mode: "settle",
        pot: formatEther(pot),
        gasPriceGwei: String(opts.gasPrice / 1_000_000_000n),
        gasLimit: String(opts.gasLimit),
        ...summary,
        transfers: sent,
      })}`
    );
  }

  return ok > 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof CliError) {
      console.error(`\n[参数/状态错误] ${e.message}`);
    } else {
      console.error(`\n[运行错误] ${e?.shortMessage || e?.message || e}`);
      if (process.env.SETTLE_DEBUG) console.error(e);
    }
    process.exit(1);
  });
