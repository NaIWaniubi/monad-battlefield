/**
 * 给蜂群钱包注资。
 * 顺序发送 + 显式 nonce —— 因为注资者是同一个 EOA，它的 tx 本来就只能串行。
 */
import { formatEther, parseEther, type Hex } from "viem";
import { loadBots, mustEnv, pub, sleep, waitBalancesVisible, wallet } from "./lib.js";

const pk = mustEnv("PRIVATE_KEY") as Hex;
const w = wallet(pk);
const funder = w.account!;
const NEED = parseEther(process.env.FUND_MON ?? "0.05");
const bots = loadBots();

let nonce = await pub.getTransactionCount({ address: funder.address });
const funderBal = await pub.getBalance({ address: funder.address });

console.log(`funder ${funder.address}`);
console.log(`balance ${formatEther(funderBal)} MON   nonce=${nonce}`);
console.log(`目标：每户 ${formatEther(NEED)} MON，共 ${bots.length} 户`);

let sent = 0;
let skipped = 0;
for (const b of bots) {
  const bal = await pub.getBalance({ address: b.address });
  if (bal >= NEED) {
    skipped++;
    continue;
  }
  try {
    const hash = await w.sendTransaction({
      to: b.address,
      value: NEED - bal,
      nonce: nonce++,
    });
    sent++;
    process.stdout.write(`\r注资中 ${sent}/${bots.length}  ${hash.slice(0, 12)}…   `);
  } catch (e) {
    console.error(`\n注资失败 ${b.address}: ${(e as Error).message}`);
    nonce = await pub.getTransactionCount({ address: funder.address });
  }
  await sleep(100);
}

console.log(`\n完成：新注资 ${sent}，已足够跳过 ${skipped}`);

// E-fixes#8（C2）：注资「发出去」≠ 各节点「查得到」。Monad 异步执行，状态可见
// 有秒级滞后 —— 不防抖就接 npm run swarm，新号第一笔 tx 会因余额还没被看到而被拒，
// 日志里那串 fail= 有一截是这么白造的。轮询到全部可见（上限 15s）再额外等 1.5s。
{
  const addrs = bots.map((b) => b.address);
  const t0 = Date.now();
  process.stdout.write(`\r确认余额可见（${addrs.length} 户，最多 15s）…   `);
  const { ready, pending } = await waitBalancesVisible(pub, addrs, NEED);
  if (pending.length) {
    console.log(`\n⚠ ${ready}/${addrs.length} 户余额已可见，${pending.length} 户超时未就位：`);
    for (const a of pending.slice(0, 8)) console.log(`   ${a}`);
    console.log(`   （再跑一次 npm run fund，或稍后它们会自行就位）`);
  } else {
    console.log(`\r余额可见：全部 ${ready} 户就位（${((Date.now() - t0) / 1000).toFixed(1)}s，含 1.5s 防抖）`);
  }
}

console.log(`剩余 funder 余额 ${formatEther(await pub.getBalance({ address: funder.address }))} MON`);
