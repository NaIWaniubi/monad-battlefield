/**
 * E-fixes#8 · lib.waitBalancesVisible 行为单测
 *
 * lib.ts 顶层只建 viem client（不触网），可直接 import。
 * 依赖注入：假 pub（可编程 getBalance）+ 假 sleep，测试毫秒级跑完。
 *
 * 契约：
 *   waitBalancesVisible(pubLike, addrs, needWei, {timeoutMs, pollMs, settleMs, sleep})
 *     → Promise<{ ready: number, pending: string[] }>
 *   · 每轮 pollMs 查一遍全部地址；全部 ≥ needWei → 立即进入收尾
 *   · 收尾固定再等 settleMs（D=3 可见性余量，演示防「新号发 tx 被拒」）
 *   · 超时不强等：返回未就位的地址清单给调用方打印
 */
import { describe, expect, it } from "vitest";
import { waitBalancesVisible } from "../scripts/lib.ts";

const A = `0x${"1".repeat(40)}` as `0x${string}`;
const B = `0x${"2".repeat(40)}` as `0x${string}`;

function fakePub(map: Record<string, bigint>) {
  const calls: string[] = [];
  return {
    calls,
    getBalance: async ({ address }: { address: string }) => {
      calls.push(address);
      return map[address] ?? 0n;
    },
  };
}

const NO_SLEEP = async (_ms: number) => {};

describe("waitBalancesVisible", () => {
  it("全部就位：一轮即停，pending 为空，settle 也等了", async () => {
    const pub = fakePub({ [A]: 100n, [B]: 100n });
    const sleeps: number[] = [];
    const r = await waitBalancesVisible(pub, [A, B], 100n, {
      timeoutMs: 5000,
      pollMs: 10,
      settleMs: 1500,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(r).toEqual({ ready: 2, pending: [] });
    expect(sleeps).toContain(1500); // 额外防抖窗口确实执行
  });

  it("余额从不足变可见：轮询到就位为止", async () => {
    const map: Record<string, bigint> = { [A]: 150n, [B]: 0n };
    const pub = fakePub(map);
    let round = 0;
    const r = await waitBalancesVisible(pub, [A, B], 100n, {
      timeoutMs: 5000,
      pollMs: 1,
      settleMs: 0,
      sleep: async () => {
        round++;
        if (round === 1) map[B] = 120n; // 第二块才可见（节点索引滞后）
      },
    });
    expect(r.ready).toBe(2);
    expect(r.pending).toEqual([]);
    // 至少查了 B 两轮
    expect(pub.calls.filter((a) => a === B).length).toBeGreaterThanOrEqual(2);
  });

  it("超时不强等：返回未就位清单，调用方自己决定怎么打印", async () => {
    const pub = fakePub({ [A]: 120n, [B]: 1n });
    const r = await waitBalancesVisible(pub, [A, B], 100n, {
      timeoutMs: 30,
      pollMs: 5,
      settleMs: 0,
      sleep: async (ms: number) => {
        await new Promise((res) => setTimeout(res, ms));
      },
    });
    expect(r.ready).toBe(1);
    expect(r.pending).toEqual([B]);
  });

  it("空地址列表立即返回（不睡 settle：没东西可等）", async () => {
    const pub = fakePub({});
    const r = await waitBalancesVisible(pub, [], 1n, {
      timeoutMs: 1000,
      pollMs: 10,
      settleMs: 1500,
      sleep: NO_SLEEP,
    });
    expect(r).toEqual({ ready: 0, pending: [] });
  });

  it("need=0（跳过注资的全家已够）：直接就位，但 settle 仍执行（链的可见性与金额无关）", async () => {
    const pub = fakePub({ [A]: 0n });
    const sleeps: number[] = [];
    const r = await waitBalancesVisible(pub, [A], 0n, {
      timeoutMs: 100,
      pollMs: 10,
      settleMs: 1500,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(r.ready).toBe(1);
    expect(sleeps).toContain(1500);
  });
});
