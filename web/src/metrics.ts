/**
 * 纯逻辑度量模块 —— 不碰 DOM、不碰网络，方便单测。
 */

const nowFn = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** 滑动窗口 TPS：只保留最近 windowMs 内的打点 */
export class TpsWindow {
  private stamps: number[] = [];

  constructor(private windowMs = 1000) {}

  push(t: number = nowFn()): void {
    this.stamps.push(t);
    this.prune(t);
  }

  tps(now: number = nowFn()): number {
    this.prune(now);
    return this.stamps.length;
  }

  clear(): void {
    this.stamps.length = 0;
  }

  get size(): number {
    return this.stamps.length;
  }

  private prune(now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] < cut) i++;
    if (i > 0) this.stamps.splice(0, i);
  }
}

/** 事件去重：断线重连 + 回填区间重叠时，同一条 log 不能算两次 */
export class Dedupe {
  private set = new Set<string>();

  constructor(private limit = 40_000) {}

  /** 首次见到返回 false，重复返回 true */
  seen(key: string): boolean {
    if (this.set.has(key)) return true;
    this.set.add(key);
    if (this.set.size > this.limit) {
      const half = Math.floor(this.limit / 2);
      const it = this.set.values();
      for (let i = 0; i < half; i++) {
        const v = it.next();
        if (v.done) break;
        this.set.delete(v.value);
      }
    }
    return false;
  }

  size(): number {
    return this.set.size;
  }
}

/** 指数滑动平均，用来把跳动的 TPS 变平滑（drone 厚度、字幕提示都用它） */
export class Ema {
  private v = 0;
  private primed = false;

  constructor(private alpha = 0.15) {}

  push(x: number): number {
    if (!this.primed) {
      this.v = x;
      this.primed = true;
    } else {
      this.v = this.v + this.alpha * (x - this.v);
    }
    return this.v;
  }

  get value(): number {
    return this.v;
  }
}

/* ───────────────────── v3 产品级升级 · 纯函数（单测覆盖） ─────────────── */

/**
 * L1「热的土地」：格子亮度的衰减曲线。
 *
 * heat 在链上是单调递增的计数器，衰减只发生在**呈现层** ——
 * 一格有多热 = 它最近一次被 claim 距离现在有多近。
 * 曲线是纯函数：中继算一次、大屏画一次，两边必须同一条曲线（见 server/index.mjs 里的镜像实现）。
 *
 * 未知年龄（历史回放读不到时间戳）→ 全亮：宁可画亮，不可把没人碰过的格子画暗。
 */
const AGING_SECONDS = 3 * 24 * 3600;
const AGING_FLOOR = 0.42;

export function decayFactor(ageSec: number): number {
  if (!Number.isFinite(ageSec) || ageSec <= 0) return 1;
  const t = Math.max(0, Math.min(1, ageSec / AGING_SECONDS));
  return AGING_FLOOR + (1 - AGING_FLOOR) * (1 - t);
}

/** 实时主网账单：这个 TPS 下每秒燃烧的主网等值美元 */
export function burnRatePerSecond(
  tps: number,
  gasPerTx: number,
  gwei: number,
  ethPriceUsd: number,
): number {
  const n = Math.max(0, Number.isFinite(tps) ? tps : 0);
  return n * gasPerTx * gwei * 1e-9 * ethPriceUsd;
}

/**
 * v3「静默墙」发车时刻表：n 笔在 spreadMs 内均匀铺开。
 * 确定性纯函数 —— 中继按它 setTimeout，大屏按它排涟漪，两边不需要同步时钟。
 */
export function burstSchedule(n: number, spreadMs = 420): number[] {
  const total = Math.max(0, Math.min(600, Math.floor(Number.isFinite(n) ? n : 0)));
  if (total <= 1) return total === 1 ? [0] : [];
  const step = spreadMs / (total - 1);
  const out: number[] = [];
  for (let i = 0; i < total; i++) out.push(i * step);
  return out;
}

/** 人肉车道：按住连点的节律。距上次不足 intervalMs 不该再发（服务端限频是第二道闸） */
export function shouldFireHold(now: number, lastFiredAt: number, intervalMs = 1000): boolean {
  return now - lastFiredAt >= intervalMs;
}
