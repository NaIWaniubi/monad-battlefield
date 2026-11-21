/**
 * W4 · web/src/grid.ts 的 GridState 单测
 *
 * 只依赖 docs/UPGRADE-SPEC.md 冻结的接口：
 *   SIDE / CELLS / FACTIONS / GridState{color, heat, flash, total, apply(), reset()}
 *
 * 刻意不 import GridRenderer：它构造时就要 document/window + canvas 2d，
 * 属于 W1 的内部实现，不在本 worker 的测试范围内。
 * grid.ts 在模块顶层没有 DOM 副作用（只有 import 和常量定义），
 * 所以 node 环境里 import 它是安全的。
 */
import { describe, expect, it } from "vitest";
import { CELLS, FACTIONS, GridState, SIDE } from "../web/src/grid";

describe("grid 常量", () => {
  it("SIDE = 50，CELLS = 2500", () => {
    expect(SIDE).toBe(50);
    expect(CELLS).toBe(2500);
    expect(CELLS).toBe(SIDE * SIDE);
  });

  it("FACTIONS：index 0 是空，1..4 是四个阵营，都有名字和颜色", () => {
    expect(FACTIONS.length).toBe(5);
    for (let i = 1; i <= 4; i++) {
      expect(FACTIONS[i].name.length).toBeGreaterThan(0);
      expect(FACTIONS[i].hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // 四个阵营颜色互不相同
    const hexes = FACTIONS.slice(1).map((f) => f.hex.toLowerCase());
    expect(new Set(hexes).size).toBe(4);
  });
});

describe("GridState.apply", () => {
  it("新实例：全 0，total = 0", () => {
    const s = new GridState();
    expect(s.total).toBe(0);
    expect(s.color.length).toBe(CELLS);
    expect(s.heat.length).toBe(CELLS);
    expect(s.flash.length).toBe(CELLS);
    expect(s.color.every((v) => v === 0)).toBe(true);
    expect(s.heat.every((v) => v === 0)).toBe(true);
    expect(s.flash.every((v) => v === 0)).toBe(true);
  });

  it("apply 后 color / heat / total 正确", () => {
    const s = new GridState();
    s.apply(123, 2, 7);
    expect(s.color[123]).toBe(2);
    expect(s.heat[123]).toBe(7);
    expect(s.total).toBe(1);

    // 只影响这一格
    expect(s.color[122]).toBe(0);
    expect(s.color[124]).toBe(0);
  });

  it("apply 把 flash 拉满到 1（渲染层据此识别「新 claim」）", () => {
    const s = new GridState();
    s.apply(0, 1, 1);
    expect(s.flash[0]).toBe(1);
  });

  it("同一格多次 apply：total 累加，color/heat 以最后一次为准（heat 累计由链上负责）", () => {
    const s = new GridState();
    s.apply(500, 1, 1);
    s.apply(500, 3, 9);
    expect(s.color[500]).toBe(3);
    expect(s.heat[500]).toBe(9);
    expect(s.total).toBe(2);
  });

  it("四个阵营都能写入（1..4）", () => {
    const s = new GridState();
    for (let c = 1; c <= 4; c++) s.apply(c - 1, c, c * 10);
    for (let c = 1; c <= 4; c++) {
      expect(s.color[c - 1]).toBe(c);
      expect(s.heat[c - 1]).toBe(c * 10);
    }
    expect(s.total).toBe(4);
  });

  it("边界 id：2499 可写，2500 / 负 / NaN 一律不改 total", () => {
    const s = new GridState();

    s.apply(CELLS - 1, 4, 40);
    expect(s.total).toBe(1);
    expect(s.color[CELLS - 1]).toBe(4);

    s.apply(CELLS, 1, 1); // >= CELLS
    s.apply(CELLS + 1000, 1, 1);
    s.apply(-1, 1, 1); // 负数（关键：不加防护会被写成数组属性 "-1"）
    s.apply(-2500, 1, 1);
    s.apply(NaN, 1, 1);
    s.apply(Infinity, 1, 1);
    s.apply(-Infinity, 1, 1);

    expect(s.total).toBe(1); // 只有 2499 那次算数
    expect(s.color[0]).toBe(0); // 越界写入没有污染到 0 号格
  });

  it("color > 4 被规范成 0（空格），heat 仍然写入", () => {
    const s = new GridState();
    s.apply(10, 5, 3);
    expect(s.color[10]).toBe(0);
    expect(s.heat[10]).toBe(3);
    expect(s.total).toBe(1);

    s.apply(11, 255, 1); // Uint8 上界
    expect(s.color[11]).toBe(0);

    s.apply(12, 4, 1); // 4 是合法上界
    expect(s.color[12]).toBe(4);
  });

  it("color = 0 是合法的「清空该格」写法", () => {
    const s = new GridState();
    s.apply(20, 3, 5);
    s.apply(20, 0, 5);
    expect(s.color[20]).toBe(0);
    expect(s.heat[20]).toBe(5);
    expect(s.total).toBe(2);
  });

  it("heat 是 Uint32：大值不溢出到负", () => {
    const s = new GridState();
    s.apply(30, 2, 4_000_000_000);
    expect(s.heat[30]).toBe(4_000_000_000);
    // 超过 2^32-1 时按 ToUint32 回绕（链上 heat 是 uint32，不会到这一步）
    s.apply(31, 2, 4_294_967_296);
    expect(s.heat[31]).toBe(0);
  });
});

describe("GridState.reset", () => {
  it("reset 后 color / heat / flash / total 全部归零", () => {
    const s = new GridState();
    for (let i = 0; i < 100; i++) s.apply(i * 7, (i % 4) + 1, i);
    expect(s.total).toBe(100);
    expect(s.color.some((v) => v !== 0)).toBe(true);

    s.reset();

    expect(s.total).toBe(0);
    expect(s.color.every((v) => v === 0)).toBe(true);
    expect(s.heat.every((v) => v === 0)).toBe(true);
    expect(s.flash.every((v) => v === 0)).toBe(true);
  });

  it("reset 之后可以继续 apply（数组引用不变）", () => {
    const s = new GridState();
    const colorRef = s.color;
    const heatRef = s.heat;
    s.apply(1, 2, 3);
    s.reset();
    s.apply(2, 4, 40);

    expect(s.color).toBe(colorRef); // 同一个 Uint8Array 实例
    expect(s.heat).toBe(heatRef);
    expect(s.color[2]).toBe(4);
    expect(s.total).toBe(1);
  });

  it("空状态 reset 是幂等的", () => {
    const s = new GridState();
    s.reset();
    s.reset();
    expect(s.total).toBe(0);
  });
});

describe("GridState 在真实事件流下的形态", () => {
  it("模拟 1000 笔随机 claim：total 与实际写入次数一致，颜色取值恒在 0..4", () => {
    const s = new GridState();
    let n = 0;
    // 确定性伪随机，避免 flaky
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < 1000; i++) {
      const id = Math.floor(rnd() * CELLS);
      const color = 1 + Math.floor(rnd() * 4);
      const heat = 1 + Math.floor(rnd() * 64);
      s.apply(id, color, heat);
      n++;
    }

    expect(s.total).toBe(n);
    for (let i = 0; i < CELLS; i++) {
      expect(s.color[i]).toBeLessThanOrEqual(4);
      expect(s.color[i]).toBeGreaterThanOrEqual(0);
    }
    // 1000 笔打在 2500 格上，点亮数应 > 0 且 <= 1000
    const lit = s.color.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThanOrEqual(1000);
  });
});
