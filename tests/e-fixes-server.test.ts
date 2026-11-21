/**
 * E-fixes · 中继侧纯逻辑单测（议会定案修复 2/3/5/6/9）
 *
 * 与 tests/sync-claim.test.ts 同一纪律：server/index.mjs 的启动段被 IS_MAIN 守卫
 * 包住，作为模块 import 不占端口、不打网络，所以可以直接把新抽出的纯函数
 * import 进来钉行为契约。
 *
 * 覆盖：
 *   Fix 2  createClaimLedger —— noteLocalClaim 与 refreshGridState 双计数去重
 *   Fix 3  pickBurstCell     —— 静默墙不再覆盖观众署名格
 *   Fix 5  statsBody().dryKeys —— 干涸可感知（API 形状）
 *   Fix 6  rateHit(id, limit, windowMs, now) —— 每 IP 第二桶限流（可注入参数）
 *   Fix 9  latencyPercentiles / noteConfirmLatency —— tap→链上确认 P50/P95 滚动窗口
 */
import { describe, expect, it } from "vitest";
import {
  createClaimLedger,
  latencyPercentiles,
  noteConfirmLatency,
  pickBurstCell,
  rateHit,
  statsBody,
} from "../server/index.mjs";

/* ─────────────────────── Fix 2 · 双计数去重 ─────────────────────── */

const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);

describe("createClaimLedger（E-fixes#2：claims 双计数去重）", () => {
  it("链上日志第一次见到 → 计数；重复见到（窗口重叠重放）→ 不再计数", () => {
    const l = createClaimLedger();
    expect(l.countLog({ transactionHash: TX_A, logIndex: 0 })).toBe(true);
    expect(l.countLog({ transactionHash: TX_A, logIndex: 0 })).toBe(false);
    expect(l.countLog({ transactionHash: TX_A, logIndex: 1 })).toBe(true); // 同 tx 不同 log 是两条事件
  });

  it("本进程中继已代发过（noteLocal 记过账）的 tx → 链上日志到达时不重复计数", () => {
    const l = createClaimLedger();
    l.noteLocal(TX_A); // relayClaim 乐观计数的那一刻
    expect(l.countLog({ transactionHash: TX_A, logIndex: 0 })).toBe(false); // 事件后到 → 不双计
    expect(l.countLog({ transactionHash: TX_B, logIndex: 0 })).toBe(true); // 蜂群直发的不相干 tx → 正常计
  });

  it("同一 tx 的多条日志：noteLocal 之后都不该再计（本合约 claim 一笔一条事件，防御性钉死）", () => {
    const l = createClaimLedger();
    l.noteLocal(TX_A);
    expect(l.countLog({ transactionHash: TX_A, logIndex: 0 })).toBe(false);
    expect(l.countLog({ transactionHash: TX_A, logIndex: 1 })).toBe(false);
  });

  it("noteLocal 对空哈希中性（KNOWN_ERR 路径拿不到 hash：不能拿 undefined 当键）", () => {
    const l = createClaimLedger();
    l.noteLocal(null);
    l.noteLocal(undefined);
    expect(l.countLog({ transactionHash: TX_A, logIndex: 0 })).toBe(true);
  });

  it("缺 transactionHash 时用 区块+交易序 兜底去重，不抛异常", () => {
    const l = createClaimLedger();
    expect(l.countLog({ blockNumber: 123, transactionIndex: 4, logIndex: 0 })).toBe(true);
    expect(l.countLog({ blockNumber: 123, transactionIndex: 4, logIndex: 0 })).toBe(false);
    expect(l.countLog({ blockNumber: 123, transactionIndex: 5, logIndex: 0 })).toBe(true);
    expect(l.countLog({})).toBe(true); // 完全没坐标：至少不崩
  });
});

/* ─────────────────────── Fix 3 · burst 避开署名格 ─────────────────────── */

describe("pickBurstCell（E-fixes#3：burst 不覆盖观众署名格）", () => {
  it("候选格被占用时重试到未占用的格", () => {
    // rand 序列：0.0 → 格 0（被占），0.004 → 格 10（被占），0.008 → 格 20（干净）
    const seq = [0.0, 0.004, 0.008];
    let i = 0;
    const rand = () => seq[Math.min(i++, seq.length - 1)];
    const taken = (c: number) => c === 0 || c === 10;
    expect(pickBurstCell(taken, 2500, rand)).toBe(20);
  });

  it("永远选不到干净格时（全场署名）退回最后一次随机格，绝不抛、绝不返回越界", () => {
    const rand = () => 0.5;
    const c = pickBurstCell(() => true, 2500, rand);
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(2500);
  });

  it("返回值恒在 [0, cells) 内（多组 rand 序列扫一遍）", () => {
    for (const x of [0, 0.0004, 0.5, 0.9999, 1 - 1e-12]) {
      for (const taker of [() => false, (c: number) => c % 3 === 0]) {
        const c = pickBurstCell(taker, 2500, () => x);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(2500);
      }
    }
  });
});

/* ─────────────────────── Fix 6 · IP 第二桶限流 ─────────────────────── */

describe("rateHit 可注入限流参数（E-fixes#6：每 IP 30 笔/10s）", () => {
  it("同一 id 打满 limit 后第 limit+1 次被拒，并带 retryAfterMs", () => {
    const id = "ip:10.0.0.9";
    for (let k = 0; k < 30; k++) {
      expect(rateHit(id, 30, 10_000, 1_000_000 + k).ok).toBe(true);
    }
    const denied = rateHit(id, 30, 10_000, 1_000_029);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("窗口滑过之后自动放行", () => {
    const id = "ip:10.0.0.8";
    for (let k = 0; k < 30; k++) rateHit(id, 30, 10_000, 2_000_000 + k);
    expect(rateHit(id, 30, 10_000, 2_000_005).ok).toBe(false);
    expect(rateHit(id, 30, 10_000, 2_010_001).ok).toBe(true);
  });

  it("不同 id 互不影响", () => {
    expect(rateHit("ip:1.1.1.1", 1, 10_000, 100).ok).toBe(true);
    expect(rateHit("ip:1.1.1.1", 1, 10_000, 101).ok).toBe(false);
    expect(rateHit("ip:2.2.2.2", 1, 10_000, 101).ok).toBe(true);
  });

  it("省略参数时走 clientId 桶的默认值（RL_LIMIT/RL_WINDOW_MS 语义不变）", () => {
    const id = "c:default-bucket-" + Date.now() + Math.random();
    // 默认 6/10s：连打 6 次必须都放行
    for (let k = 0; k < 6; k++) expect(rateHit(id).ok).toBe(true);
    expect(rateHit(id).ok).toBe(false);
  });
});

/* ─────────────────────── Fix 9 · tap→确认延迟仪表 ─────────────────────── */

describe("latencyPercentiles（E-fixes#9：P50/P95 近 100 笔滚动窗口）", () => {
  it("空窗口 → 全 null（大屏显示「—」，没有样本就不许编数）", () => {
    expect(latencyPercentiles([])).toEqual({ p50: null, p95: null, count: 0 });
  });

  it("1..100 的样本 → p50=50, p95=95（最近秩法，向上取整）", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const r = latencyPercentiles(arr);
    expect(r.p50).toBe(50);
    expect(r.p95).toBe(95);
    expect(r.count).toBe(100);
  });

  it("单个样本：p50 = p95 = 该值；乱序输入不影响结果（内部排序）", () => {
    expect(latencyPercentiles([700])).toEqual({ p50: 700, p95: 700, count: 1 });
    const a = latencyPercentiles([900, 100, 500, 300, 700]);
    const b = latencyPercentiles([100, 300, 500, 700, 900]);
    expect(a).toEqual(b);
  });

  it("非有限值被过滤（降级/异常路径塞进来的垃圾不进百分位）", () => {
    const r = latencyPercentiles([100, NaN, 200, Infinity, -5, 300]);
    expect(r.count).toBe(3);
    expect(r.p50).toBe(200);
  });

  it("noteConfirmLatency 滚动窗口封顶 100：第 101 笔挤掉最旧", () => {
    for (let i = 0; i < 101; i++) noteConfirmLatency(10 + i);
    const s = statsBody();
    // 最旧的 10 被挤掉，窗口里只剩 11..110 → p50=60
    expect(s.confirmLatencyCount).toBe(100);
    expect(s.confirmLatencyP50ms).toBe(60);
    expect(s.confirmLatencyP95ms).toBe(105);
  });
});

/* ─────────────────────── Fix 5 · dryKeys API 形状 ─────────────────────── */

describe("statsBody 的干涸可见性字段（E-fixes#5）", () => {
  it("/api/stats 必须带 dryKeys:number（观众横幅与导演台都靠它）", () => {
    const s = statsBody();
    expect(typeof s.dryKeys).toBe("number");
    expect(Number.isFinite(s.dryKeys)).toBe(true);
  });

  it("dryKeys 不得超过 keys 总数（形状自洽：不可能比钱包数还干）", () => {
    const s = statsBody();
    expect(s.dryKeys).toBeLessThanOrEqual(s.keys);
    expect(s.dryKeys).toBeGreaterThanOrEqual(0);
  });
});
