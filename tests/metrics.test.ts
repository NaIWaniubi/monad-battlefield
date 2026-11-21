/**
 * W4 · web/src/metrics.ts 单测
 *
 * metrics.ts 是纯逻辑（不碰 DOM / 网络），所以这里的用例就是它的行为契约。
 * 冻结接口见 docs/UPGRADE-SPEC.md：
 *   TpsWindow { push(t?), tps(now?) } / Dedupe { seen(key), size() }
 *
 * 注意：本文件里有 3 个 [已知缺陷] 用例 —— 它们断言的是「当前真实行为」，
 * 用来把 bug 钉在测试里（以后修好时把它们改成正确断言即可）。
 */
import { describe, expect, it } from "vitest";
import { Dedupe, Ema, TpsWindow, burstSchedule, burnRatePerSecond, decayFactor, shouldFireHold } from "../web/src/metrics";

/* ────────────────────────────── TpsWindow ────────────────────────────── */

describe("TpsWindow", () => {
  it("空窗口 tps = 0", () => {
    const w = new TpsWindow();
    expect(w.tps(0)).toBe(0);
    expect(w.size).toBe(0);
  });

  it("默认窗口宽 1000ms", () => {
    const w = new TpsWindow();
    w.push(0);
    // 999ms 后还在窗口内
    expect(w.tps(999)).toBe(1);
    // 1000ms 后到期（cut = 0，`0 < 0` 为假 → 保留）
    expect(w.tps(1000)).toBe(1);
    // 1000.001ms 后出窗
    expect(w.tps(1000.001)).toBe(0);
  });

  it("推入 5 个同刻点 → tps = 5", () => {
    const w = new TpsWindow();
    for (let i = 0; i < 5; i++) w.push(100);
    expect(w.tps(100)).toBe(5);
    expect(w.size).toBe(5);
  });

  it("同刻点不会互相淘汰（全部保留）", () => {
    const w = new TpsWindow(500);
    for (let i = 0; i < 40; i++) w.push(7);
    expect(w.tps(7)).toBe(40);
  });

  it("超过窗口宽度的点被淘汰", () => {
    const w = new TpsWindow();
    w.push(0);
    w.push(400);
    w.push(800);
    // now = 1000 → cut = 0 → 0ms 那个正好在边界，保留
    expect(w.tps(1000)).toBe(3);
    // now = 1100 → cut = 100 → 淘汰 0ms
    expect(w.tps(1100)).toBe(2);
    // now = 1500 → cut = 500 → 淘汰 0 / 400
    expect(w.tps(1500)).toBe(1);
    // now = 1900 → cut = 900 → 全淘汰
    expect(w.tps(1900)).toBe(0);
  });

  it("边界：stamp 正好等于 cutoff 时保留（淘汰条件是严格小于）", () => {
    const w = new TpsWindow(1000);
    w.push(500);
    // now = 1500 → cut = 500 → 500 < 500 为假 → 保留
    expect(w.tps(1500)).toBe(1);
    // now = 1501 → cut = 501 → 淘汰
    expect(w.tps(1501)).toBe(0);
  });

  it("淘汰只发生在窗口左侧：连续 push 时 tps 不会膨胀", () => {
    const w = new TpsWindow(1000);
    // 1 秒内每秒 10 笔，模拟 2 秒
    let tpsAtEnd = 0;
    for (let t = 0; t <= 2000; t += 100) {
      w.push(t);
      tpsAtEnd = w.tps(t);
    }
    // 1000..2000 之间共 11 个点（含两端）
    expect(tpsAtEnd).toBe(11);
  });

  it("clear() 清空窗口", () => {
    const w = new TpsWindow();
    for (let i = 0; i < 10; i++) w.push(0);
    expect(w.tps(0)).toBe(10);
    w.clear();
    expect(w.tps(0)).toBe(0);
    expect(w.size).toBe(0);
  });

  it("自定义窗口宽度生效（500ms）", () => {
    const w = new TpsWindow(500);
    w.push(0);
    expect(w.tps(499)).toBe(1);
    expect(w.tps(500)).toBe(1); // 边界保留
    expect(w.tps(501)).toBe(0);
  });

  it("push() 省略时间戳时取当前时钟（可被 tps() 立刻数到）", () => {
    const w = new TpsWindow();
    w.push();
    expect(w.tps()).toBe(1);
  });

  it("[已知缺陷] 乱序时间戳会让过期点永远留在窗口里", () => {
    // 缺陷：prune 只从数组头部（最旧端）往前扫，遇到「比 cutoff 新」的点就停。
    // 只要有一条更旧的点排在它后面，就永远扫不到 → tps 被高估。
    // 真实触发路径：历史回放 / 断线重连把旧事件补进来（main.ts 目前用独立数组，
    // 但如果迁移到 TpsWindow 就会踩到）。
    const w = new TpsWindow(1000);
    w.push(5000); // 新的先到
    w.push(100); // 旧的后到（乱序）
    // 期望 1（只有 5000 在窗口内），实际 2
    expect(w.tps(5200)).toBe(2);
    // 再加 5 个新点：期望 6，实际 7 —— 那个 100 永远不会被淘汰
    for (let i = 0; i < 5; i++) w.push(5100 + i);
    expect(w.tps(5104)).toBe(7);
  });
});

/* ─────────────────────────────── Dedupe ─────────────────────────────── */

describe("Dedupe", () => {
  it("同 key：第一次 false，第二次 true", () => {
    const d = new Dedupe();
    expect(d.seen("0xabc:1")).toBe(false);
    expect(d.seen("0xabc:1")).toBe(true);
    expect(d.seen("0xabc:1")).toBe(true); // 一直 true
  });

  it("不同 key 各自独立", () => {
    const d = new Dedupe();
    expect(d.seen("a")).toBe(false);
    expect(d.seen("b")).toBe(false);
    expect(d.seen("a")).toBe(true);
    expect(d.seen("b")).toBe(true);
  });

  it("size() 只数唯一 key", () => {
    const d = new Dedupe();
    d.seen("a");
    d.seen("a");
    d.seen("b");
    expect(d.size()).toBe(2);
  });

  it("超过 limit 后仍可工作：旧 key 被淘汰后可再次返回 false", () => {
    // limit=4 → 第 5 个 key 触发淘汰，删掉最旧的 2 个（floor(4/2)）
    const d = new Dedupe(4);
    for (const k of ["a", "b", "c", "d"]) expect(d.seen(k)).toBe(false);
    expect(d.size()).toBe(4);

    // 第 5 个：插入后 size=5 > 4 → 淘汰最旧的 a、b，剩 {c,d,e}
    expect(d.seen("e")).toBe(false);
    expect(d.size()).toBe(3);

    // 幸存者（c/d/e）仍然是重复 —— 必须在重新插入 a/b 之前断言，
    // 因为再插两个就会触发下一轮淘汰。
    expect(d.seen("c")).toBe(true);
    expect(d.seen("d")).toBe(true);
    expect(d.seen("e")).toBe(true);

    // 被淘汰的旧 key：重新当作第一次见到
    expect(d.seen("a")).toBe(false);
    // 此时 size=4（c,d,e,a），再加 b 会触发淘汰，但 b 本身是新 key
    expect(d.seen("b")).toBe(false);
  });

  it("没有 limit 时默认上限 40000，正常去重不受影响", () => {
    const d = new Dedupe();
    for (let i = 0; i < 1000; i++) expect(d.seen(`k${i}`)).toBe(false);
    for (let i = 0; i < 1000; i++) expect(d.seen(`k${i}`)).toBe(true);
    expect(d.size()).toBe(1000);
  });

  it("淘汰后集合大小不会无限增长（limit 足够大时）", () => {
    const d = new Dedupe(100);
    for (let i = 0; i < 5000; i++) d.seen(`k${i}`);
    // size 到 101 就删 50 个 → 稳定在 51..101 之间，不随 key 数量增长
    expect(d.size()).toBeGreaterThan(50);
    expect(d.size()).toBeLessThanOrEqual(101);
  });

  it("[已知缺陷] limit <= 1 时永不淘汰，集合无上限增长", () => {
    // 缺陷：淘汰数量是 floor(limit / 2)。
    //   limit=1 → floor(0.5)=0 → 一个都不删 → set 无限增长（内存缓慢泄漏）
    //   limit=0 → 同样 0 个
    // 真实触发路径：构造函数传错（例如把「窗口毫秒」当 limit 传进来）。
    const one = new Dedupe(1);
    for (let i = 0; i < 200; i++) one.seen(`k${i}`);
    expect(one.size()).toBe(200); // 期望 ≈1，实际 200

    const zero = new Dedupe(0);
    for (let i = 0; i < 200; i++) zero.seen(`k${i}`);
    expect(zero.size()).toBe(200);
  });
});

/* ──────────────────────────────── Ema ──────────────────────────────── */

describe("Ema", () => {
  it("首次 push 的结果等于输入（不做从 0 起算的爬坡）", () => {
    const e = new Ema(0.15);
    expect(e.push(80)).toBe(80);
    expect(e.value).toBe(80);

    const e2 = new Ema(0.15);
    expect(e2.push(0)).toBe(0);
    expect(e2.push(1)).toBe(0.15); // 之后才按 alpha 混合
  });

  it("收敛方向正确：向目标单调逼近，不越过", () => {
    const e = new Ema(0.15);
    e.push(0);
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const v = e.push(100);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThan(100);
      prev = v;
    }
    // 100 步之后已经很接近目标（0.85^100 ≈ 1e-7）
    expect(e.value).toBeGreaterThan(99.9);
  });

  it("下降方向同样单调", () => {
    const e = new Ema(0.15);
    e.push(100);
    let prev = 100;
    for (let i = 0; i < 50; i++) {
      const v = e.push(0);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThan(0);
      prev = v;
    }
  });

  it("alpha = 1 时完全跟随输入", () => {
    const e = new Ema(1);
    e.push(10);
    expect(e.push(3)).toBe(3);
    expect(e.push(7)).toBe(7);
  });

  it("alpha 越小越平滑：同一输入序列下峰谷差更小", () => {
    // 方波输入 → 比较最后几拍的峰谷差（振幅），不是离均值的距离
    const fast = new Ema(0.9);
    const slow = new Ema(0.1);
    const seq = [0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100];
    let fMin = Infinity;
    let fMax = -Infinity;
    let sMin = Infinity;
    let sMax = -Infinity;
    for (const x of seq) {
      const f = fast.push(x);
      const s = slow.push(x);
      fMin = Math.min(fMin, f);
      fMax = Math.max(fMax, f);
      sMin = Math.min(sMin, s);
      sMax = Math.max(sMax, s);
    }
    const fAmp = fMax - fMin;
    const sAmp = sMax - sMin;
    expect(sAmp).toBeLessThan(fAmp);
    // fast 几乎跟随方波（振幅接近 100），slow 被压平（振幅明显更小）
    expect(fAmp).toBeGreaterThan(80);
    expect(sAmp).toBeLessThan(70);
  });

  it("恒定输入 → 值恒定", () => {
    const e = new Ema(0.15);
    for (let i = 0; i < 20; i++) e.push(42);
    expect(e.value).toBe(42);
  });
});

/* ────────────── v3 · 产品级升级纯函数（decayFactor / burn / burst / hold） ─────── */

describe("decayFactor（L1 热的土地）", () => {
  it("未知年龄 → 全亮：历史回放读不到时间戳，不许把格子画暗", () => {
    expect(decayFactor(0)).toBe(1);
    expect(decayFactor(-5)).toBe(1);
    expect(decayFactor(NaN)).toBe(1);
    expect(decayFactor(Infinity)).toBe(1);
  });

  it("单调衰减，3 天触底 0.42，不再往下走", () => {
    expect(decayFactor(3600)).toBeGreaterThan(decayFactor(7200));
    expect(decayFactor(7200)).toBeGreaterThan(decayFactor(21600));
    expect(decayFactor(3 * 86400)).toBeCloseTo(0.42, 6);
    expect(decayFactor(30 * 86400)).toBeCloseTo(0.42, 6);
  });

  it("线性中点落在公式上", () => {
    // 1.5 天 → t = 0.5 → 0.42 + 0.58 × 0.5
    expect(decayFactor(1.5 * 86400)).toBeCloseTo(0.42 + 0.58 * 0.5, 6);
  });
});

describe("burnRatePerSecond（实时主网账单）", () => {
  it("80 tx/s × 60k gas × 110 gwei × $3000 = $1,584/s", () => {
    // 单笔 60000×110gwei = 0.0066 ETH ≈ $19.8；每秒 80 笔 ≈ $1,584
    expect(burnRatePerSecond(80, 60_000, 110, 3000)).toBeCloseTo(1584, 6);
  });

  it("0 / NaN / 负数不炸，返回 0", () => {
    expect(burnRatePerSecond(0, 60_000, 110, 3000)).toBe(0);
    expect(burnRatePerSecond(NaN, 60_000, 110, 3000)).toBe(0);
    expect(burnRatePerSecond(-10, 60_000, 110, 3000)).toBe(0);
  });
});

describe("burstSchedule（静默墙发车时刻表）", () => {
  it("240 笔在 420ms 内均匀铺开", () => {
    const s = burstSchedule(240, 420);
    expect(s).toHaveLength(240);
    expect(s[0]).toBe(0);
    expect(s[239]).toBeCloseTo(420, 6);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]).toBeGreaterThan(s[i - 1]);
    }
  });

  it("边界与非法值", () => {
    expect(burstSchedule(0)).toEqual([]);
    expect(burstSchedule(-5)).toEqual([]);
    expect(burstSchedule(NaN)).toEqual([]);
    expect(burstSchedule(1)).toEqual([0]);
    expect(burstSchedule(9999)).toHaveLength(600); // 上限封死，防误配
  });
});

describe("shouldFireHold（人肉车道节律）", () => {
  it("满 1000ms 才再发", () => {
    expect(shouldFireHold(1000, 0)).toBe(true);
    expect(shouldFireHold(999, 0)).toBe(false);
    expect(shouldFireHold(5000, 4000)).toBe(true);
    expect(shouldFireHold(4500, 4000)).toBe(false);
  });
});
