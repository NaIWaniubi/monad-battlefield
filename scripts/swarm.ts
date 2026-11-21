/**
 * 蜂群：K 条独立车道，每条车道一个独立钱包。
 *
 * 为什么不是「一个 relayer 发 K 笔」——
 *   同一个 EOA 的 tx 按 nonce 严格串行，一个 relayer 等于一条车道，
 *   并行度上限 = 独立发送方数量。这是这套 demo 唯一的硬约束。
 *
 * 每条车道自己维护 nonce，失败时回链上重新同步；
 * 不 await receipt，否则单车道会被出块时间卡死在 2 tx/s 以下。
 *
 * E-fixes#7（C2#3，议会定案）：车道节律尊重 Monad 的 reserve-balance 物理线。
 *   平台规则：余额 < 10 MON 的 EOA 被限 1 tx / 3 块（0.5s 块 → 约 1 tx/1.2s ≈ 0.83 tx/s），
 *   和 GAP_MS 设多小无关。旧代码 17 条 0.14 MON 车道按 500ms 硬发，
 *   撞上这条线就整片被拒（swarm-live.log：sent=359 / fail=6421 —— 曲线在撒谎，
 *   fail 在爆炸）。现在：
 *   · 每道启动先查余额：<10 MON → 该道自钳 1300ms（1tx/1.2s + 余量）并打限速日志；
 *   · 余额烧穿（NOGAS 类错误）→ 车道干净退出，不再刷屏重试；
 *   · 启动横幅按「满速道 × 速率 + 限速道 × 0.83」报现实并行上限，不报纸面算术。
 *
 * 结构（E-fixes 起）：所有会触网/跑循环的部分收进 main()，由 IS_MAIN 守卫调用 ——
 * 与 server/index.mjs 同一纪律：被 import（单测/工具）时零副作用，
 * laneGapFor / isNoGasError 作为纯函数导出可测。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URLS,
  loadArtifact,
  loadBots,
  loadDeploy,
  monad,
  pub,
  sleep,
  type Bot,
} from "./lib.js";

/** 链上 baseFee 约 100 gwei，给足余量；可用 GAS_PRICE_GWEI 覆盖 */
const GAS_PRICE = parseGwei(process.env.GAS_PRICE_GWEI ?? "110");
/** 实测：claim 需要 60000 gas。50000 会 revert（0/3 成功），60000 稳定 3/3。Monad 按 gasLimit 计费，所以别给多 */
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? 60_000);
const K = Number(process.env.BOTS ?? 40);
const GAP = Number(process.env.GAP_MS ?? 500);

/** E-fixes#7：reserve-balance 线。低于这个余额的车道物理上发不快，硬发只是刷 fail。 */
export const RESERVE_MIN_WEI = 10n * 10n ** 18n;
/** 限速道间隔：1 tx/1.2s 再加 100ms 安全边（viem 重试窗口）。env LIMIT_GAP_MS 可调 */
export const LIMIT_GAP_MS = Number(process.env.LIMIT_GAP_MS ?? 1300);
/** 限速道的平台速率（横幅与预算按这个数算，不是估的：0.5s 块 × 1tx/3块） */
export const LIMITED_LANE_TPS = 1000 / (LIMIT_GAP_MS - 100); // ≈0.83

/** 余额 → 该车道的发车间隔 + 是否处于限速模式。纯函数（tests 里按文本契约钉） */
export function laneGapFor(balanceWei: bigint, fastGap = GAP, limitGap = LIMIT_GAP_MS): { gap: number; limited: boolean } {
  if (balanceWei >= RESERVE_MIN_WEI) return { gap: fastGap, limited: false };
  return { gap: Math.max(fastGap, limitGap), limited: true };
}

/**
 * 「没油了」类错误：余额不足 / reserve 拒绝。这类失败重试一万次也不会变成成功，
 * 车道必须退出而不是留在循环里烧日志。
 * 刻意不含 nonce too low（C2 原案有）—— 那是本地计数与链不同步，
 * fetchNonce 重读一次自愈（server 同款事故经验），退出反而丢产能。
 */
export function isNoGasError(e: unknown): boolean {
  const err = e as { message?: unknown; shortMessage?: unknown };
  return /insufficient (funds|balance)|exceeds balance|not enough funds|reserve/i.test(
    String(err?.message ?? err?.shortMessage ?? e ?? ""),
  );
}

/**
 * E2-1（swarm-dryrun 钉契约）：连续失败节流的纯函数形态。
 * >3 连败 → 间隔 1.5× 拉大、封顶 5000ms；≤3 不动。
 * 调用方（lane 循环）只在失败路径用它，成功不回缩 —— 防限速↔满速临界震荡。
 */
export function nextLaneGap(gap: number, consecutiveFails: number): number {
  if (consecutiveFails > 3) return Math.min(Math.round(gap * 1.5), 5_000);
  return gap;
}

/* ── IS_MAIN：被 import 时（单测/门禁工具）只导出纯函数，绝不跑主循环 ── */
const SELF_PATH = resolve(fileURLToPath(import.meta.url));
const ARGV_PATH = process.argv[1] ? resolve(process.argv[1]) : "";
const IS_MAIN =
  process.platform === "win32"
    ? SELF_PATH.toLowerCase() === ARGV_PATH.toLowerCase()
    : SELF_PATH === ARGV_PATH;

async function main() {
  const { abi } = loadArtifact();
  const { address } = loadDeploy();
  const bots = loadBots().slice(0, K);

  let sent = 0;
  let fail = 0;
  let running = true;
  const perLane = new Array<number>(bots.length).fill(0);

  /** 带退避的 nonce 读取：40 条车道同时打 RPC 会 429，必须能扛住 */
  async function fetchNonce(addr: `0x${string}`, reader = pub): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await reader.getTransactionCount({ address: addr });
      } catch {
        await sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
      }
    }
    throw new Error("nonce 读取连续失败");
  }

  async function lane(bot: Bot, idx: number) {
    const account = privateKeyToAccount(bot.pk as Hex);
    const rpc = RPC_URLS[idx % RPC_URLS.length];
    const client = createWalletClient({
      account,
      chain: monad,
      transport: http(rpc, { retryCount: 2, timeout: 20_000 }),
    });
    const lanePub = createPublicClient({ chain: monad, transport: http(rpc, { retryCount: 2, timeout: 20_000 }) });

    // 错峰启动：否则 40 条车道同一瞬间要 nonce，直接把 RPC 打到 429
    await sleep(idx * 180);

    let nonce: number;
    try {
      nonce = await fetchNonce(account.address, lanePub);
    } catch (e) {
      console.error(`车道 #${idx} 启动失败：${(e as Error).message}`);
      return;
    }

    const color = (idx % 4) + 1;
    let consecutiveFails = 0;
    // E-fixes#7：本道发车间隔由启动余额决定（预扫描已算进 laneGaps），
    // 之后只会被失败节流拉大，成功不缩回 —— 防「限速↔满速」临界震荡。
    let laneGap = laneGaps[idx] ?? GAP;

    while (running) {
      const id = Math.floor(Math.random() * 2500);
      try {
        await client.writeContract({
          address,
          abi,
          functionName: "claim",
          args: [id, color],
          nonce: nonce++,
          gas: GAS_LIMIT,
          // 统一 legacy + 显式 gasPrice：viem 默认 type-2 在公共测试网实测不稳定
          gasPrice: GAS_PRICE,
        });
        sent++;
        perLane[idx]++;
        consecutiveFails = 0;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // E-fixes#7：余额烧穿 = 这条道的演出结束。报一行、干净退出；
        // 继续 while 只会把 6421 次注定失败的 RPC 拍在日志和观众脸上。
        if (isNoGasError(e)) {
          console.log(`车道#${idx + 1} 余额烧穿（${msg.slice(0, 90)}）→ 本道退出（干净收尾，不再重试）`);
          return;
        }
        fail++;
        consecutiveFails++;
        if (fail <= 3) console.error(`[lane#${idx}] 发送失败:`, msg.slice(0, 300));
        try {
          nonce = await fetchNonce(account.address, lanePub);
        } catch {
          await sleep(2_000);
          continue;
        }
        // C2#3 失败节流：连续失败（多半撞限速线）就把间隔拉大，封顶 5s（纯函数 nextLaneGap，E2-1 钉死）
        laneGap = nextLaneGap(laneGap, consecutiveFails);
      }
      await sleep(laneGap + Math.floor(Math.random() * 60));
    }
  }

  /* 单车道异常不许杀掉整个蜂群 */
  process.on("unhandledRejection", (e) => {
    console.error("[unhandledRejection]", String(e).slice(0, 160));
  });
  process.on("uncaughtException", (e) => {
    console.error("[uncaughtException]", e.message);
  });

  process.on("SIGINT", () => {
    running = false;
    console.log("\n收到 Ctrl-C，收尾中…");
  });

  /* ── E-fixes#7：逐道预查 reserve 余额（串行 + 小憩，公共 RPC 怕并发） ── */
  const laneGaps: number[] = [];
  let fastN = 0;
  let limitedN = 0;
  console.log(`预检 ${bots.length} 条车道的 reserve-balance（ Monad 对 <10 MON 的 EOA 限 1 tx/3 块）…`);
  for (let i = 0; i < bots.length; i++) {
    let bal = 0n;
    try {
      bal = await pub.getBalance({ address: bots[i].address });
    } catch {
      /* 查不到余额：按限速道处理 —— 宁可慢，不要开局刷 fail */
    }
    const { gap, limited } = laneGapFor(bal);
    laneGaps.push(gap);
    if (limited) {
      limitedN++;
      console.log(`  车道#${i + 1} 限速模式（余额 ${formatEther(bal)} MON < 10 MON → 1 tx/1.2s，间隔钳到 ${gap}ms）`);
    } else {
      fastN++;
    }
    await sleep(60);
  }

  console.log(`合约   ${address}`);
  console.log(`车道   ${bots.length}（独立钱包数 = 并行度上限）`);
  // 诚实口径（C1-W1/C2#3）：不再按 BOTS×1000/GAP 报纸面算术 ——
  // 那在 reserve 限速下是假数字，实测被 0.83 tx/s/道 的物理线压着。
  const honestPeak = fastN * (1000 / GAP) + limitedN * 0.83;
  console.log(
    `间隔   满速道 ${GAP}ms × ${fastN} 道 + 限速道 ${laneGaps[fastN] ?? GAP}ms × ${limitedN} 道` +
      ` → 现实并行上限 ${honestPeak.toFixed(1)} tx/s（GAP 再小也压不过 reserve 线）`,
  );
  console.log(`RPC    ${RPC_URLS.length} 个节点轮转：${RPC_URLS.join(" , ")}`);
  console.log(`开始运行，Ctrl-C 停止\n`);

  let last = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const tps = sent - last;
    last = sent;
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`[${el}s] sent=${sent} tps=${tps} fail=${fail}`);
  }, 1_000);

  await Promise.all(bots.map((b, i) => lane(b, i)));

  clearInterval(timer);
  const top = perLane
    .map((n, i) => ({ i, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  console.log(`\n结束：sent=${sent} fail=${fail}`);
  console.log(`最忙车道：${top.map((t) => `#${t.i}=${t.n}`).join("  ")}`);
}

if (IS_MAIN) {
  await main();
}
