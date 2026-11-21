/**
 * W-visual · 署名墙「有效年龄」回归测试
 *
 * 实拍 bug(2026-11-21,W probe2/3b):demo/crowd 模式下 main.ts 对每次 claim 调
 * state.apply(..., 0) —— age 写成 0 之后没有任何人推进它。于是
 *   · selectLabelCells 的 age < LABEL_WINDOW 永远为真:所有历史格都算「最近」,
 *     稳定排序按 index 升序取前 36 → 署名墙钉死在最顶行,最新动作永远不上墙;
 *   · LABEL_FADE 临期淡出永不触发(候选集不轮换,到期时刻每次重扫都被重置)。
 * 渲染层因此引入「有效年龄」:观察值没变的格按渲染时钟自然老化,观察值一变
 * (中继快照推进 / 重新 claim)就以新值为基准 —— 呈现层自愈,不要求 main.ts 接线改动。
 * trackAgeAt 是纯函数(类型化数组进、时钟进),node 可测,渲染热路径与单测共用。
 */
import { describe, expect, it } from "vitest";
import {
  CELLS,
  LABEL_WINDOW,
  GridState,
  selectLabelCells,
  trackAgeAt,
} from "../web/src/grid";

/** 建一套渲染器内部同构的缓冲 */
function buffers() {
  return {
    mirror: new Float64Array(CELLS).fill(NaN), // 渲染器用 NaN 起始,任何首次观察都建基准
    base: new Float64Array(CELLS).fill(0),
    eff: new Float64Array(CELLS).fill(Infinity),
  };
}

describe("trackAgeAt(有效年龄跟踪)", () => {
  it("首次观察:eff = 观察值(0 的格 age 0 起步,不是瞬间 0)", () => {
    const { mirror, base, eff } = buffers();
    expect(trackAgeAt(0, 7, mirror, base, eff, 5)).toBe(0);
    expect(eff[7]).toBe(0);
  });

  it("观察值不再变化(demo 钉死 age=0)时,eff 随渲染时钟自然老化", () => {
    const { mirror, base, eff } = buffers();
    trackAgeAt(0, 7, mirror, base, eff, 1); // claim 瞬间
    // 之后 main 不再推进 age,但时间走了 20s(每帧都会带新 now 进来)
    const e = trackAgeAt(0, 7, mirror, base, eff, 21);
    expect(e).toBeCloseTo(20, 9);
    expect(eff[7]).toBeCloseTo(20, 9);
  });

  it("观察值跳变(中继把 age 从 12 更新到 15)→ 以新值为基准,不重复加时钟", () => {
    const { mirror, base, eff } = buffers();
    trackAgeAt(12, 3, mirror, base, eff, 100); // t=100 看到 age=12
    expect(trackAgeAt(12, 3, mirror, base, eff, 102)).toBeCloseTo(14, 9); // 没更新 → 自己老
    const e = trackAgeAt(15, 3, mirror, base, eff, 103); // 中继推到 15
    expect(e).toBe(15); // 是新观察值,不是 15+3
    expect(trackAgeAt(15, 3, mirror, base, eff, 104)).toBeCloseTo(16, 9); // 继续自然老化
  });

  it("Infinity(读不到年龄)→ eff 恒 Infinity,重新有限观察后以新值为基准", () => {
    const { mirror, base, eff } = buffers();
    expect(trackAgeAt(Infinity, 9, mirror, base, eff, 1)).toBe(Infinity);
    expect(trackAgeAt(Infinity, 9, mirror, base, eff, 50)).toBe(Infinity);
    expect(trackAgeAt(4, 9, mirror, base, eff, 60)).toBe(4);
  });
});

describe("署名墙端到端:demo 的钉死 age 不再把墙钉在顶行", () => {
  /** 模拟 crowd 流:claim 时 observed age 恒 0、之后无人推进(与 main.ts L337 一致) */
  function simulateStuckAgeClaim(
    state: GridState,
    bufs: ReturnType<typeof buffers>,
    cell: number,
    nick: string,
    now: number,
  ) {
    state.apply(cell, 1 + (cell % 4), 1, 0);
    state.setLabel(cell, nick);
    trackAgeAt(state.age[cell], cell, bufs.mirror, bufs.base, bufs.eff, now);
  }

  it("t=1 的一批 claim 到 t=45 全部过期出墙;t=45 的新 claim 顶上(旧逻辑两者都做不到)", () => {
    const state = new GridState();
    const bufs = buffers();

    // 开场一批:小 index 格子先被 claim(实拍里墙就是这样被 index 排序钉死的)
    const first: number[] = [];
    for (const cell of [0, 1, 2, 3, 5, 8, 13]) {
      simulateStuckAgeClaim(state, bufs, cell, "早期", 1);
      first.push(cell);
    }

    // 44 秒后:观察值没人推进(还是 0),但有效年龄已过窗 → 一个都不能选
    for (const cell of first) {
      trackAgeAt(state.age[cell], cell, bufs.mirror, bufs.base, bufs.eff, 45);
    }
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([]);

    // 同一时刻新动作:age 0 → 必须上墙,而且只轮到它
    simulateStuckAgeClaim(state, bufs, 2000, "现在", 45);
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([2000]);
  });

  it("旧 bug 复现锚点:直接拿 state.age(demo 恒 0)选,44s 前的 claim 仍会入选 —— 所以才必须喂有效年龄", () => {
    const state = new GridState();
    const bufs = buffers();
    simulateStuckAgeClaim(state, bufs, 0, "早期", 1);
    // 不推进任何帧:selectLabelCells 只看 age=0 < 30,照选不误(这就是钉死墙的根源)
    expect(selectLabelCells(state.color, state.labelOf, state.age)).toEqual([0]);
    // 走 44s 渲染时钟后,有效年龄把它正确地踢出
    trackAgeAt(state.age[0], 0, bufs.mirror, bufs.base, bufs.eff, 45);
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([]);
  });

  it("窗口边界:有效年龄恰好 LABEL_WINDOW 不选,< LABEL_WINDOW 选(沿用既有规则)", () => {
    const state = new GridState();
    const bufs = buffers();
    simulateStuckAgeClaim(state, bufs, 42, "边界", 0);
    trackAgeAt(state.age[42], 42, bufs.mirror, bufs.base, bufs.eff, LABEL_WINDOW - 0.5);
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([42]);
    trackAgeAt(state.age[42], 42, bufs.mirror, bufs.base, bufs.eff, LABEL_WINDOW + 0.5);
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([]);
  });

  it("未占领格(observed age Infinity)不污染 eff 选择结果", () => {
    const state = new GridState();
    const bufs = buffers();
    state.apply(9, 2, 3); // 历史回放式:age Infinity
    state.setLabel(9, "考古");
    trackAgeAt(state.age[9], 9, bufs.mirror, bufs.base, bufs.eff, 10);
    expect(bufs.eff[9]).toBe(Infinity);
    expect(selectLabelCells(state.color, state.labelOf, bufs.eff)).toEqual([]);
  });
});
