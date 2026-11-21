/**
 * A-atmo · web/src/audio.ts「现场氛围音乐」升级的纯逻辑单测
 *
 * audio.ts 的 DSP 本体要在浏览器里听，node 环境测不了声音；
 * 所以把**可测的两层**钉死：
 *   1. 导出的纯函数（档位 / 声像 / 调式 / 根音 / 混响送出）—— 行为契约；
 *   2. BattleAudio 的健壮性 —— 用一个假 AudioContext 把整张图搭起来，
 *      保证「任何异常都不许抛回主循环」「稳态节点数 < 80」「voice 用完即弃」
 *      这三条硬约束在 fake 下也成立（fake 的指数斜坡到 0 会像真 WebAudio 一样抛错，
 *      生产代码若踩了会在这里红）。
 */
import { describe, expect, it } from "vitest";
import {
  AEOLIAN,
  BattleAudio,
  DORIAN,
  noteSendForRow,
  panForCol,
  rootHzForColor,
  scaleForColor,
  tierForTps,
} from "../web/src/audio";

/* ───────────────────── 假 WebAudio 桩 ─────────────────────
 * 只实现 audio.ts 用到的 API 子集；行为刻意「严格」：
 * exponentialRampToValueAtTime 目标为 0 或起点为 0 → 抛（和 Chrome 一致），
 * 这样包络写法错误会在单测里暴露，而不是等大屏现场炸。 */

class FakeParam {
  value: number;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, _t: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, _t: number, _tc: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, _t: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, _t: number): this {
    if (v === 0) throw new Error("exponentialRamp to 0");
    if (this.value === 0) throw new Error("exponentialRamp from 0");
    this.value = v;
    return this;
  }
  cancelScheduledValues(_t: number): this {
    return this;
  }
}

let NODE_SEQ = 0;

class FakeCtx {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination: FakeNode = { kind: "destination", id: NODE_SEQ++, disconnect: () => undefined };
  /** 所有已创建节点（含未释放的瞬态 voice） */
  created = 0;
  /** 当前还“活着”的节点数：创建 +1，disconnect -1 */
  live = 0;
  peakLive = 0;
  /** 已计划 stop 但未到点的节点 —— flushEnded() 模拟浏览器事件循环收割 */
  private pending: FakeNode[] = [];

  private queueEnd(n: FakeNode, t?: number): void {
    n._stopAt = t === undefined ? this.currentTime : Math.max(this.currentTime, t);
    this.pending.push(n);
  }

  /** 把到点的节点触发 onended（真浏览器里 ended 是异步事件，voice 的并发存在于此刻之间） */
  flushEnded(): void {
    const due: FakeNode[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const n = this.pending[i];
      if ((n._stopAt ?? 0) <= this.currentTime) {
        due.push(n);
        this.pending.splice(i, 1);
      }
    }
    for (const n of due) {
      try {
        n.onended?.();
      } catch {
        /* onended 自己吞 */
      }
    }
  }

  private born(_kind: string): FakeNode {
    this.created += 1;
    this.live += 1;
    if (this.live > this.peakLive) this.peakLive = this.live;
    const node: FakeNode = {
      kind: _kind,
      id: NODE_SEQ++,
      disconnect: () => {
        this.live -= 1;
      },
      connect: (dest: unknown) => dest,
    };
    return node;
  }

  createGain(): FakeNode {
    const n = this.born("gain");
    n.gain = new FakeParam(1);
    return n;
  }
  createOscillator(): FakeNode {
    const n = this.born("osc");
    n.type = "sine";
    n.frequency = new FakeParam(440);
    n.detune = new FakeParam(0);
    n.start = () => undefined;
    n.stop = (t?: number) => {
      this.queueEnd(n, t);
    };
    return n;
  }
  createBiquadFilter(): FakeNode {
    const n = this.born("biquad");
    n.type = "lowpass";
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    n.gain = new FakeParam(0);
    n.detune = new FakeParam(0);
    return n;
  }
  createDynamicsCompressor(): FakeNode {
    const n = this.born("comp");
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) {
      n[k] = new FakeParam(0);
    }
    return n;
  }
  createStereoPanner(): FakeNode {
    const n = this.born("pan");
    n.pan = new FakeParam(0);
    return n;
  }
  createConvolver(): FakeNode {
    const n = this.born("conv");
    return n;
  }
  createBufferSource(): FakeNode {
    const n = this.born("bufsrc");
    n.loop = false;
    n.start = () => undefined;
    n.stop = (t?: number) => {
      this.queueEnd(n, t);
    };
    return n;
  }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    const data: Float32Array[] = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return {
      numberOfChannels: ch,
      length: len,
      sampleRate: sr,
      duration: len / sr,
      getChannelData: (i: number) => data[i],
    };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
}

type FakeNode = {
  kind: string;
  id: number;
  gain?: FakeParam;
  frequency?: FakeParam;
  Q?: FakeParam;
  detune?: FakeParam;
  pan?: FakeParam;
  type?: string;
  buffer?: FakeBuffer;
  loop?: boolean;
  normalize?: boolean;
  onended?: (() => void) | null;
  /** queueEnd 记录的计划停止时刻（秒，ctx 时钟） */
  _stopAt?: number;
  start?: (t?: number, off?: number) => void;
  stop?: (t?: number) => void;
  connect: (dest: unknown) => unknown;
  disconnect: () => void;
  [key: string]: unknown;
};

type FakeBuffer = {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  getChannelData: (i: number) => Float32Array;
};

/** 在 globalThis 上装 window.AudioContext，返回 ctx 工厂以便统计。 */
function installFakeWindow(): { last: () => FakeCtx | null } {
  const g = globalThis as unknown as { window?: unknown };
  let lastCtx: FakeCtx | null = null;
  class BoundCtx extends FakeCtx {
    constructor() {
      super();
      lastCtx = this;
    }
  }
  g.window = { AudioContext: BoundCtx };
  return { last: () => lastCtx };
}

/* ───────────────────────── 纯函数契约 ───────────────────────── */

describe("tierForTps（能量档位）", () => {
  it("四档边界：0-4.999 静 / 5-29 流动 / 30-59 加密 / ≥60 满载", () => {
    expect(tierForTps(0)).toBe(0);
    expect(tierForTps(4.9)).toBe(0);
    expect(tierForTps(5)).toBe(1);
    expect(tierForTps(29.9)).toBe(1);
    expect(tierForTps(30)).toBe(2);
    expect(tierForTps(59.9)).toBe(2);
    expect(tierForTps(60)).toBe(3);
    expect(tierForTps(240)).toBe(3);
  });

  it("非法输入落到 0 档（安静实验室兜底，不许 NaN 扩散）", () => {
    expect(tierForTps(NaN)).toBe(0);
    expect(tierForTps(-10)).toBe(0);
    expect(tierForTps(Infinity)).toBe(3); // 大数走满档，由 setDensity 上游钳制
  });
});

describe("panForCol（x 坐标 → 立体声声像）", () => {
  it("x=0 → -0.8，x=24.5 → 0，x=49 → +0.8", () => {
    expect(panForCol(0)).toBeCloseTo(-0.8, 6);
    expect(panForCol(24.5)).toBeCloseTo(0, 6);
    expect(panForCol(49)).toBeCloseTo(0.8, 6);
  });

  it("单调右移；越界钳到两端", () => {
    let prev = -Infinity;
    for (let c = 0; c <= 49; c++) {
      const p = panForCol(c);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(panForCol(-5)).toBeCloseTo(-0.8, 6);
    expect(panForCol(100)).toBeCloseTo(0.8, 6);
    expect(panForCol(NaN)).toBe(0);
  });
});

describe("调式与根音（Dorian / Aeolian 双轨）", () => {
  it("紫/青走 Dorian，琥珀/绯走 Aeolian", () => {
    expect(scaleForColor(1)).toBe(DORIAN);
    expect(scaleForColor(2)).toBe(DORIAN);
    expect(scaleForColor(3)).toBe(AEOLIAN);
    expect(scaleForColor(4)).toBe(AEOLIAN);
    expect(scaleForColor(99)).toBe(DORIAN); // 未知阵营兜底
  });

  it("Dorian 有 9/10 没有 8；Aeolian 有 8 没有 9 —— 两轨各 7 音", () => {
    expect(DORIAN.length).toBe(7);
    expect(AEOLIAN.length).toBe(7);
    expect(DORIAN).toContain(9);
    expect(DORIAN).toContain(10);
    expect(DORIAN).not.toContain(8);
    expect(AEOLIAN).toContain(8);
    expect(AEOLIAN).not.toContain(9);
    // 共有音（同主音时不撞车的骨架）
    for (const s of [0, 2, 3, 5, 7]) {
      expect(DORIAN).toContain(s);
      expect(AEOLIAN).toContain(s);
    }
  });

  it("根音：紫 F4 / 青 C5 / 琥珀 A3 / 绯 D3", () => {
    expect(rootHzForColor(1)).toBeCloseTo(349.23, 2);
    expect(rootHzForColor(2)).toBeCloseTo(523.25, 2);
    expect(rootHzForColor(3)).toBeCloseTo(220.0, 2);
    expect(rootHzForColor(4)).toBeCloseTo(146.83, 2);
  });
});

describe("noteSendForRow（行号 → 混响送出）", () => {
  it("随 y 增大而增大，全程在 0..0.3 的「微微」范围", () => {
    let prev = -1;
    for (let r = 0; r <= 49; r++) {
      const s = noteSendForRow(r);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0.3);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(noteSendForRow(NaN)).toBeGreaterThanOrEqual(0);
  });
});

/* ───────────────────── BattleAudio 健壮性（fake） ───────────────────── */

describe("BattleAudio · 未 enable 前一切公开方法都不炸", () => {
  it("note/setDensity/stinger/setSilenceWallProgress 静默返回", () => {
    const a = new BattleAudio();
    expect(a.ready).toBe(false);
    a.note(7, 3, 1);
    a.setDensity(50);
    for (const k of ["capture", "start", "end", "burst"] as const) a.stinger(k);
    a.setSilenceWallProgress(0.5);
    expect(a.toggle()).toBe(false);
  });
});

describe("BattleAudio · 假 AudioContext 下的整图搭建与负载", () => {
  it("enable() 建图成功，稳态节点数 < 80", async () => {
    const win = installFakeWindow();
    try {
      const a = new BattleAudio();
      const ok = await a.enable();
      expect(ok).toBe(true);
      expect(a.ready).toBe(true);
      const ctx = win.last();
      expect(ctx).not.toBeNull();
      // 持久节点（bed/pad/sweep/reverb/母带链）必须远小于 80
      expect(ctx!.live).toBeLessThan(80);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("四档 TPS 扫一遍不炸；档位切换不泄漏节点", async () => {
    const win = installFakeWindow();
    try {
      const a = new BattleAudio();
      expect(await a.enable()).toBe(true);
      const ctx = win.last()!;
      const base = ctx.live;
      for (const tps of [0, 2, 7, 25, 31, 55, 61, 240]) a.setDensity(tps);
      expect(ctx.live).toBe(base); // setDensity 只动增益，不新增持久节点
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("灌 400 笔 note + 全部 stinger：voice 用完即弃，稳态峰值活节点 < 80", async () => {
    const win = installFakeWindow();
    try {
      const a = new BattleAudio();
      expect(await a.enable()).toBe(true);
      const ctx = win.last()!;
      const base = ctx.live;
      a.setDensity(120); // 满载档：FM + sweep + 和声墙全开
      for (let i = 0; i < 400; i++) {
        ctx.currentTime += 0.02; // 20ms/笔 ≈ 50 TPS，把令牌桶压满
        a.note(i * 13 + (i % 7), i % 65, (i % 4) + 1);
        if (i % 25 === 0) ctx.currentTime += 0.15; // 偶尔快进，让到期 voice 排队
        ctx.flushEnded(); // 浏览器事件循环收割到期 onended
      }
      // 稳态契约：令牌桶 + 并发闸双保险下，note 阶段的峰值必须 < 80
      expect(ctx.peakLive).toBeLessThan(80);

      // stinger 是秒级瞬态（齐鸣 3 层 + 闪音 + 噪声冲击 + sub），允许短暂越过稳态，
      // 但尾音落定后必须全部释放回 base —— 泄漏一条就会一路带到散场。
      // 本用例故意背靠背连发（实操中 capture 有 1s 冷却、start/burst 一局一次，
      // 永不这样叠加），所以瞬态上限取设计推导的最坏堆叠：
      //   持久 34 + start(2 铺底+8 FM arpeggio) + end 8 + 两次 burst + note 并发闸残余 ≤5×8 ≈ 200。
      // 稳态 < 80 的硬契约由上面 note 阶段的断言把守，不在这里放宽。
      ctx.peakLive = ctx.live;
      for (const k of ["capture", "start", "end", "burst"] as const) {
        ctx.currentTime += 0.2;
        a.stinger(k);
        ctx.flushEnded();
      }
      // start 的 8 音 arpeggio 是计划在未来发声的，推过它们的尾音再收割
      ctx.currentTime += 0.8;
      a.stinger("burst"); // 再来一次 burst（此时 lastStingerAt 已过期）
      ctx.currentTime += 6;
      ctx.flushEnded();
      expect(ctx.live).toBe(base);
      expect(ctx.peakLive).toBeLessThan(200); // 背靠背连发的最坏堆叠（文档值），超了说明 stinger 节点没回收

      a.setSilenceWallProgress(1);
      a.setSilenceWallProgress(NaN);
      a.setSilenceWallProgress(0);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("setMuted/toggle 与静默墙互不踩踏", async () => {
    const win = installFakeWindow();
    try {
      const a = new BattleAudio();
      expect(await a.enable()).toBe(true);
      expect(a.setMuted(true)).toBe(false);
      expect(a.isMuted).toBe(true);
      a.setSilenceWallProgress(0.5); // 静音状态下也不许炸
      expect(a.setMuted(false)).toBe(true);
      a.stinger("burst"); // burst 必须把墙衰减复位，否则下一段永远没声
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});
