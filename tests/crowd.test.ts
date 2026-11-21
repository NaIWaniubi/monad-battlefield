/**
 * K-crowd · web/src/crowd.ts 观众模拟器单测
 *
 * 只依赖冻结接口:
 *   Crowd(size, seed?) / step(dt) / stats() / setMood()
 *   parseCrowdSize(search) —— main.ts 读 ?crowd=N 的纯函数(不碰 window,可在 node 环境测)
 *
 * 纪律:
 *   · step 返回的是复用缓冲(环形池),跨步留档必须当场拷贝 —— run() 里做了
 *   · 断言只用黑盒可观察量:claim 数 / 阵营分布 / 反捣计数 / mood 密度方向
 *   · 阈值方向即规格语义:同 seed 必须逐条一致(可复现截图),rush 必须比 calm 密
 */
import { describe, expect, it } from "vitest";
import { CELLS, SIDE } from "../web/src/grid";
import { CROWD_DEFAULT, CROWD_MAX, CROWD_MIN, Crowd, parseCrowdSize } from "../web/src/crowd";

type Snap = { cell: number; faction: number; nick: string };

/** 推进 steps 步,把 claim 当场拷贝进 sink(返回池是复用的,不能直接攒引用),返回总数 */
function run(c: Crowd, steps: number, dt: number, sink: Snap[]): number {
  let n = 0;
  for (let i = 0; i < steps; i++) {
    const claims = c.step(dt);
    for (const cl of claims) {
      sink.push({ cell: cl.cell, faction: cl.faction, nick: cl.nick });
    }
    n += claims.length;
  }
  return n;
}

describe("parseCrowdSize", () => {
  it("无参数 / 空串 / 非法值返回 null", () => {
    expect(parseCrowdSize("")).toBeNull();
    expect(parseCrowdSize("?demo=1")).toBeNull();
    expect(parseCrowdSize("?crowd=abc")).toBeNull();
    expect(parseCrowdSize("?crowd=")).toBeNull();
  });

  it("?crowd=N 解析并夹到 [10, 1500]", () => {
    expect(parseCrowdSize("?crowd=300")).toBe(300);
    expect(parseCrowdSize("crowd=78")).toBe(78); // 不带 ? 也收
    expect(parseCrowdSize("?demo=1&crowd=500")).toBe(500);
    expect(parseCrowdSize("?crowd=1")).toBe(CROWD_MIN);
    expect(parseCrowdSize("?crowd=999999")).toBe(CROWD_MAX);
    expect(parseCrowdSize("?crowd=77.6")).toBe(78); // 四舍五入
  });
});

describe("Crowd · 密度与形状(验收主条)", () => {
  it("同 seed 240 人跑 300 步(5s):claims ≥ 800,四阵营全活跃,字段合法", () => {
    const c = new Crowd(240, 42);
    const sink: Snap[] = [];
    const n = run(c, 300, 1 / 60, sink);
    expect(n).toBeGreaterThanOrEqual(800);
    expect(n).toBe(sink.length);

    const byF = [0, 0, 0, 0];
    for (const s of sink) {
      expect(Number.isInteger(s.cell)).toBe(true);
      expect(s.cell).toBeGreaterThanOrEqual(0);
      expect(s.cell).toBeLessThan(CELLS);
      expect(s.faction).toBeGreaterThanOrEqual(1);
      expect(s.faction).toBeLessThanOrEqual(4);
      expect(s.nick.length).toBeGreaterThan(0);
      byF[s.faction - 1]++;
    }
    for (let f = 0; f < 4; f++) expect(byF[f]).toBeGreaterThan(0);

    const st = c.stats();
    expect(st.total).toBe(240);
    expect(st.active).toBeGreaterThan(0);
    expect(st.active).toBeLessThanOrEqual(st.total);
    expect(st.peakActive).toBeGreaterThanOrEqual(st.active);
    // 活跃四阵营都非零 = 拉锯在打
    for (let f = 0; f < 4; f++) expect(st.byFaction[f]).toBeGreaterThan(0);
  });

  it("反捣:跑 900 步(15s)后 revengeActions > 0", () => {
    const c = new Crowd(240, 42);
    run(c, 900, 1 / 60, []);
    expect(c.stats().revengeActions).toBeGreaterThan(0);
  });
});

describe("Crowd · 可复现与参数防御", () => {
  it("同 seed 两次运行逐条一致(mulberry32 决定论)", () => {
    const a: Snap[] = [];
    const b: Snap[] = [];
    run(new Crowd(240, 42), 300, 1 / 60, a);
    run(new Crowd(240, 42), 300, 1 / 60, b);
    expect(a.length).toBeGreaterThan(800);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("不同 seed 序列不同", () => {
    const a: Snap[] = [];
    const b: Snap[] = [];
    run(new Crowd(240, 42), 200, 1 / 60, a);
    run(new Crowd(240, 43), 200, 1 / 60, b);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("size 构造期夹到 [CROWD_MIN, CROWD_MAX],默认容量 = CROWD_DEFAULT", () => {
    expect(CROWD_DEFAULT).toBe(CROWD_DEFAULT);
    expect(new Crowd(1, 7).stats().total).toBe(CROWD_MIN);
    expect(new Crowd(99999, 7).stats().total).toBe(CROWD_MAX);
    // 1500 人压力上限也能跑(3s 不崩、密度可观)
    const big = new Crowd(CROWD_MAX, 1);
    const n = run(big, 180, 1 / 60, []);
    expect(n).toBeGreaterThan(100);
  });

  it("dt<=0 / NaN 不产生 claim,也不推时钟", () => {
    const c = new Crowd(240, 42);
    expect(c.step(0).length).toBe(0);
    expect(c.step(-1).length).toBe(0);
    expect(c.step(NaN).length).toBe(0);
  });
});

describe("Crowd · mood", () => {
  it("rush 比 calm 密(同 seed,暖机后同窗口对比)", () => {
    const rush = new Crowd(240, 7);
    const calm = new Crowd(240, 7);
    rush.autoMood = false;
    calm.autoMood = false;
    rush.setMood("rush");
    calm.setMood("calm");
    run(rush, 1500, 1 / 60, []); // 25s 暖机:第一轮齐射+冷却走完
    run(calm, 1500, 1 / 60, []);
    const nr = run(rush, 900, 1 / 60, []);
    const nc = run(calm, 900, 1 / 60, []);
    expect(nr).toBeGreaterThan(0);
    expect(nr).toBeGreaterThan(nc * 1.5);
  });

  it("autoMood 开着时 90s 内档位会变过(画面有起伏)", () => {
    const c = new Crowd(240, 9);
    const seen = new Set<string>([c.currentMood]);
    for (let i = 0; i < 5400; i++) {
      c.step(1 / 60);
      seen.add(c.currentMood);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("Crowd · 与网格几何相容", () => {
  it("claim 不会越界到 CELLS 之外(含热区圆裁边)", () => {
    const c = new Crowd(60, 3);
    const sink: Snap[] = [];
    run(c, 1800, 1 / 60, sink);
    expect(sink.length).toBeGreaterThan(0);
    for (const s of sink) {
      expect(s.cell).toBeLessThan(CELLS);
      // 反捣邻格钳边:行列都在 [0, SIDE)
      expect(s.cell % SIDE).toBeLessThan(SIDE);
      expect(Math.floor(s.cell / SIDE)).toBeLessThan(SIDE);
    }
  });
});
