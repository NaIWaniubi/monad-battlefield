/**
 * merkle-build — 扫链上 Claim 事件 → 贡献统计 → 按比例分奖池 → Merkle 树
 *
 *   node scripts/merkle-build.mjs [--window 8000] [--top 32] [--pool-mon 0.01]
 *                                [--from N] [--to N] [--max-window 24000]
 *
 * 公共 RPC 的 eth_getLogs 硬限 ≤100 块/次：按 100 块切片、多节点轮转、并发少量。
 * 输出 docs/merkle.json（root + 每个叶子的 proof），写盘前自检：
 *   重算 root === 输出 root，且每条 proof 都能验证。
 */
import { createPublicClient, getAddress, http, keccak256, toHex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { arg, fmt, loadEnv } from "./merkle-env.mjs";
import { buildDistribution, getRoot, leafHash, verifyProof } from "./merkle-core.mjs";

loadEnv();

const RPCS = (
  process.env.RPC_URLS ??
  "https://testnet-rpc.monad.xyz,https://monad-testnet.drpc.org,https://rpc.ankr.com/monad_testnet"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHUNK = Number(arg("chunk", 100));
const WINDOW = Number(arg("window", 8000));
const MAX_WINDOW = Number(arg("max-window", 24000));
const TOP = Number(arg("top", 32));
const POOL_MON = String(arg("pool-mon", "0.01"));
const CONC = Number(arg("concurrency", 6));
const TOPIC0 = keccak256(toHex("Claim(uint16,address,uint8,uint32)"));

const dep = JSON.parse(readFileSync("deployments.json", "utf8"));
const pub = createPublicClient({
  transport: http(RPCS[0], { retryCount: 2, timeout: 30_000 }),
});

async function rpcCall(method, params, tries = 6) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    const rpc = RPCS[(t + Math.floor(Math.random() * RPCS.length)) % RPCS.length];
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (t + 1) + Math.random() * 300));
    }
  }
  throw lastErr;
}

async function scanRange(from, to) {
  const jobs = [];
  for (let lo = from; lo <= to; lo += CHUNK) {
    jobs.push([lo, Math.min(lo + CHUNK - 1, to)]);
  }
  const counts = new Map(); // address(lowercase) -> count
  let logs = 0;
  let done = 0;
  let idx = 0;

  async function worker() {
    for (;;) {
      const j = idx++;
      if (j >= jobs.length) return;
      const [lo, hi] = jobs[j];
      const result = await rpcCall("eth_getLogs", [
        {
          address: dep.address,
          topics: [TOPIC0],
          fromBlock: "0x" + lo.toString(16),
          toBlock: "0x" + hi.toString(16),
        },
      ]);
      for (const log of result) {
        logs++;
        const who = log.topics?.[2];
        if (!who) continue;
        const addr = getAddress("0x" + who.slice(26)).toLowerCase();
        counts.set(addr, (counts.get(addr) ?? 0) + 1);
      }
      done++;
      if (done % 20 === 0 || done === jobs.length) {
        console.log(`  scanned ${done}/${jobs.length} chunks (${lo}-${hi}) logs=${logs} addrs=${counts.size}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
  return { counts, logs };
}

async function main() {
  const head = Number(await rpcCall("eth_blockNumber", []));
  const to = arg("to") ? Number(arg("to")) : head - 2;
  let from = arg("from") ? Number(arg("from")) : to - WINDOW + 1;
  const floor = Math.max(Number(dep.startBlock), to - MAX_WINDOW + 1);

  console.log(`contract : ${dep.address} (deploy block ${dep.startBlock})`);
  console.log(`topic0   : ${TOPIC0}`);
  console.log(`window   : ${from} → ${to} (${to - from + 1} blocks, chunk=${CHUNK}, conc=${CONC})`);

  let counts = new Map();
  let logs = 0;
  let usedFrom = from;
  for (;;) {
    ({ counts, logs } = await scanRange(from, to));
    if (counts.size >= 2 || from <= floor) break;
    const next = Math.max(floor, from - WINDOW);
    if (next === from) break;
    console.log(`  contributors=${counts.size} < 2 → 向前扩大窗口到 ${next}`);
    from = next;
    usedFrom = from;
  }

  const all = [...counts.entries()].map(([account, contributions]) => ({ account, contributions }));
  const totalContributions = all.reduce((s, e) => s + e.contributions, 0);
  const selected = [...all]
    .sort((a, b) => b.contributions - a.contributions || (a.account < b.account ? -1 : 1))
    .slice(0, TOP);

  const poolWei = BigInt(Math.round(Number(POOL_MON) * 1e6)) * 10n ** 12n;
  const dist = buildDistribution(selected, poolWei);

  // 写盘前自检（防手滑/编码漂移导致链上全体 claim 失败）
  const recomputed = getRoot(
    dist.leaves.map((l) => leafHash(l.index, l.account, BigInt(l.amountWei))),
  );
  if (dist.leaves.length && recomputed !== dist.root) {
    throw new Error(`root 自检失败: ${recomputed} != ${dist.root}`);
  }
  for (const l of dist.leaves) {
    if (!verifyProof(dist.root, l.index, l.account, l.amountWei, l.proof)) {
      throw new Error(`leaf ${l.index} proof 自检失败`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    chainId: Number(process.env.CHAIN_ID ?? 10143),
    source: {
      contract: dep.address,
      event: "Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)",
      topic0: TOPIC0,
    },
    scan: {
      fromBlock: usedFrom,
      toBlock: to,
      blocks: to - usedFrom + 1,
      chunk: CHUNK,
      logs,
      contributorsFound: all.length,
      included: selected.length,
      top: TOP,
      note:
        all.length > selected.length
          ? `按贡献取前 ${TOP} 名入树；奖池仅在这些叶子间按贡献比例分配`
          : "全部贡献者入树",
    },
    poolMon: POOL_MON,
    poolWei: poolWei.toString(),
    totalWei: poolWei.toString(),
    totalContributions,
    includedContributions: selected.reduce((s, e) => s + e.contributions, 0),
    root: dist.root,
    leaves: dist.leaves.map((l) => ({
      index: l.index,
      account: l.account,
      amountWei: l.amountWei.toString(),
      amountMon: fmt(l.amountWei),
      contributions: l.contributions,
      proof: l.proof,
    })),
  };
  writeFileSync("docs/merkle.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\ncontributors found : ${all.length} (${totalContributions} claims)`);
  console.log(`included in tree   : ${selected.length}`);
  console.log(`pool               : ${fmt(poolWei)}`);
  console.log(`root               : ${dist.root}`);
  for (const l of out.leaves.slice(0, 5)) {
    console.log(`  #${l.index} ${l.account} ${l.amountMon} (${l.contributions} claims, proof=${l.proof.length})`);
  }
  console.log(`✔ 写入 docs/merkle.json（root/全部 proof 已自检）`);
}

main().catch((e) => {
  console.error("✘", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
