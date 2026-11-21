/**
 * C-signage · 格子署名（task 1）的纯逻辑单测
 *
 * GridRenderer.draw 要 canvas/window/document，node 环境测不了。
 * 所以把「哪些格子该画署名」这件纯逻辑抽成 selectLabelCells()，
 * 用 ArrayLike 喂数组，不碰 DOM。渲染层与单测共用同一个判定，
 * 测的就是真正跑在大屏里的那段规则（不会测一套、跑另一套）。
 *
 * 规则（来自任务要求）：
 *   只有「已占领 + 有署名 + 最近 window 秒内有 claim」的格子才进署名墙。
 *   age 未知（Infinity，读不到时间戳）不算「最近」→ 不画。
 *   候选超过 cap 时，保留最新的 cap 个（age 升序）。
 */
import { describe, expect, it } from "vitest";
import { CELLS, GridState, LABEL_WINDOW, selectLabelCells } from "../web/src/grid";

/** 造一组等长数组，默认全是空格 / 无署名 / 年龄未知 */
function blank() {
  const color = new Uint8Array(CELLS);
  const labelOf = new Array<string | null>(CELLS).fill(null);
  const age = new Float64Array(CELLS).fill(Infinity);
  return { color, labelOf, age };
}

describe("selectLabelCells", () => {
  it("全空：一个都不选", () => {
    const { color, labelOf, age } = blank();
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("已占领 + 有署名 + 新鲜 → 选中该格", () => {
    const { color, labelOf, age } = blank();
    color[42] = 1;
    labelOf[42] = "小明";
    age[42] = 3; // < 默认窗口
    expect(selectLabelCells(color, labelOf, age)).toEqual([42]);
  });

  it("没署名（null）不选", () => {
    const { color, labelOf, age } = blank();
    color[10] = 2;
    age[10] = 1;
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("空串署名不选（防御：即使 labelOf 被塞了空串也不画空标签）", () => {
    const { color, labelOf, age } = blank();
    color[11] = 2;
    labelOf[11] = "   ";
    age[11] = 1;
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("未占领（color=0）但有署名 → 不选（署名必须是占领格）", () => {
    const { color, labelOf, age } = blank();
    labelOf[12] = "幽灵";
    age[12] = 0;
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("非法阵营（color>4）→ 不选", () => {
    const { color, labelOf, age } = blank();
    color[13] = 9;
    labelOf[13] = "越界";
    age[13] = 0;
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("age 未知（Infinity）→ 不算「最近」，不选", () => {
    const { color, labelOf, age } = blank();
    color[14] = 3;
    labelOf[14] = "考古";
    // age[14] 留 Infinity
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);
  });

  it("age >= 窗口 → 冷掉了，不选；窗口边界用 < 严格判定", () => {
    const { color, labelOf, age } = blank();
    color[15] = 1;
    labelOf[15] = "刚好过期";
    age[15] = LABEL_WINDOW;
    expect(selectLabelCells(color, labelOf, age)).toEqual([]);

    color[16] = 1;
    labelOf[16] = "还差一点";
    age[16] = LABEL_WINDOW - 0.001;
    expect(selectLabelCells(color, labelOf, age)).toEqual([16]);
  });

  it("window 可覆盖：设很小窗口时，3s 的格子就不选", () => {
    const { color, labelOf, age } = blank();
    color[20] = 4;
    labelOf[20] = "慢热";
    age[20] = 3;
    expect(selectLabelCells(color, labelOf, age, { window: 1 })).toEqual([]);
    expect(selectLabelCells(color, labelOf, age, { window: 10 })).toEqual([20]);
  });

  it("超过 cap 时保留最新的 cap 个，且按 age 升序", () => {
    const { color, labelOf, age } = blank();
    // 放 6 个有效署名，age = i*2
    for (let i = 0; i < 6; i++) {
      const id = 100 + i;
      color[id] = 1;
      labelOf[id] = `n${i}`;
      age[id] = i * 2; // 0,2,4,6,8,10
    }
    const picked = selectLabelCells(color, labelOf, age, { cap: 3 });
    expect(picked).toEqual([100, 101, 102]); // 最新 3 个（age 最小）
    // 升序检查
    for (let i = 1; i < picked.length; i++) {
      expect(age[picked[i]]).toBeGreaterThanOrEqual(age[picked[i - 1]]);
    }
  });

  it("返回的是新数组，不共享输入引用", () => {
    const { color, labelOf, age } = blank();
    color[1] = 2;
    labelOf[1] = "x";
    age[1] = 0;
    const out = selectLabelCells(color, labelOf, age);
    expect(Array.isArray(out)).toBe(true);
    expect(out).not.toBe(color);
  });

  it("对短数组也安全：按最短长度迭代，不越界", () => {
    // 三数组长度不一致时，取最小范围，绝不读到 undefined 崩
    const color = new Uint8Array([1, 2, 0]);
    const labelOf = ["a", null, "c"];
    const age = [0, 0, 0];
    expect(selectLabelCells(color, labelOf, age)).toEqual([0]);
  });
});

describe("GridState 署名 / 年龄数据路径", () => {
  it("新格 age 默认 Infinity（apply 不传 ageSec）", () => {
    const s = new GridState();
    s.apply(3, 2, 5);
    expect(s.age[3]).toBe(Infinity);
  });

  it("apply 传入有限 ageSec 会写入；负数/NaN 回落 Infinity", () => {
    const s = new GridState();
    s.apply(4, 2, 5, 12.5);
    expect(s.age[4]).toBe(12.5);
    s.apply(5, 2, 5, -1);
    expect(s.age[5]).toBe(Infinity);
    s.apply(6, 2, 5, NaN);
    expect(s.age[6]).toBe(Infinity);
  });

  it("setLabel：非空 trim 存下，超 16 字截断；空/纯空白清成 null", () => {
    const s = new GridState();
    s.setLabel(1, "  张三  ");
    expect(s.labelOf[1]).toBe("张三");
    s.setLabel(2, "0123456789abcdef0123456789"); // 32 字
    expect(s.labelOf[2]).toBe("0123456789abcdef"); // 截到 16
    s.setLabel(3, "   ");
    expect(s.labelOf[3]).toBeNull();
    s.setLabel(4, "");
    expect(s.labelOf[4]).toBeNull();
  });

  it("setLabel 越界 id 不改任何东西", () => {
    const s = new GridState();
    s.setLabel(-1, "坏");
    s.setLabel(CELLS, "坏");
    s.setLabel(NaN, "坏");
    expect(s.labelOf.every((v) => v === null)).toBe(true);
  });

  it("端到端：relay 式 apply(带age)+setLabel 后，selectLabelCells 能挑出这格", () => {
    const s = new GridState();
    s.apply(77, 3, 9, 2); // 中继快照：新鲜
    s.setLabel(77, "现场观众");
    const picked = selectLabelCells(s.color, s.labelOf, s.age);
    expect(picked).toContain(77);
  });

  it("reset 清掉署名与年龄", () => {
    const s = new GridState();
    s.apply(8, 1, 3, 1);
    s.setLabel(8, "名");
    s.reset();
    expect(s.labelOf[8]).toBeNull();
    expect(s.age[8]).toBe(Infinity);
  });
});
