/**
 * G2 · scripts/ab-demo.mjs 纯函数单测（A/B 对照的算术与状态机，不触网）
 *
 * 背景：打往届 #363「同格反复点被合约冷却拒、gas 照烧」的差异化实证。
 * ab-demo 主流程要么真发 tx（蜂群预算充足时），要么 DRY 全本地模拟（余额不足，
 * 排练永远能跑）。两种模式的**算术**必须可单测钉死：
 *   · decideDry —— 余额/预算判定（车道够不够、预算顶不顶得住计划笔数）；
 *   · clampPlan —— 预算硬上限折算笔数（0.025 MON 红线，超了必须缩）；
 *   · simulateRound —— 轮次状态机：逐拍过同格冷却账本 → landed/rejected；
 *   · gasTable —— 「被拒的也烧钱(#363) vs 被拒的零成本(我们)」的对照算术。
 * IS_MAIN 守卫：被 import 时 main() 不跑，绝不打网络（与 server/swarm 同纪律）。
 */
import { describe, expect, it } from "vitest";
import {
  clampPlan,
  decideDry,
  gasTable,
  simulateRound,
} from "../scripts/ab-demo.mjs";

const COST = 0.0066; // MON / 笔（60000 gas × 110 gwei，实测口径）

/* ─────────────── decideDry：车道与预算 ─────────────── */

describe("decideDry（余额不足自动 DRY，排练永远能跑）", () => {
  it("合格车道（≥0.007 MON）不足 2 条 → DRY，理由里说明车道数", () => {
    const d = decideDry({ monPerBot: [0.0014, 0.0014, 0.0041], costPerTx: COST, budgetMon: 0.025, tapsPerRound: 20 });
    expect(d.dry).toBe(true);
    expect(d.reason).toContain("车道");
  });

  it("车道够但计划笔数 × 单价 超 0.025 MON 预算 → DRY，理由里说明预算", () => {
    // 4 条合格道 × 2 轮 × 20 拍 = 160 笔 × 0.0066 ≈ 1.056 MON，远超 0.025
    const d = decideDry({ monPerBot: [0.05, 0.05, 0.05, 0.05], costPerTx: COST, budgetMon: 0.025, tapsPerRound: 20 });
    expect(d.dry).toBe(true);
    expect(d.reason).toContain("预算");
  });

  it("车道够且预算装得下计划 → 真发（dry=false）", () => {
    // 2 道 × 2 轮 × 1 拍 = 4 笔 × 0.0066 = 0.0264 > 0.025… 用 3 笔：0.0198 ≤ 0.025
    const d = decideDry({ monPerBot: [0.02, 0.02, 0.02], costPerTx: COST, budgetMon: 0.025, tapsPerRound: 1, rounds: 2 });
    expect(d.dry).toBe(false);
    expect(d.usableLanes).toBe(3);
  });
});

/* ─────────────── clampPlan：预算硬顶折算 ─────────────── */

describe("clampPlan（预算红线只缩不胀，向下取整）", () => {
  it("0.025 MON ÷ 0.0066 = 3 笔（不是 3.79 笔）", () => {
    expect(clampPlan(0.025, COST)).toBe(3);
  });

  it("计划笔数小于预算容量 → 按计划，不虚报能发更多", () => {
    expect(clampPlan(0.025, COST, 2)).toBe(2);
  });

  it("预算为 0 / 单价为 0 的退化输入 → 0 笔（绝不除零爆炸）", () => {
    expect(clampPlan(0, COST)).toBe(0);
    expect(clampPlan(0.025, 0)).toBe(0);
  });
});

/* ─────────────── simulateRound：轮次状态机 ─────────────── */

describe("simulateRound（同格反复点 = #363 式被拒；分散点 = 全上链）", () => {
  it("轮A 反复打同一格：3s 窗口内第 2..N 拍全被同格冷却拒 → landed=1, rejected=N-1", () => {
    const taps = Array.from({ length: 8 }, (_, i) => ({ cell: 137, t: 1000 + i * 300 })); // 每 0.3s 一拍
    const r = simulateRound(taps, 3000);
    expect(r.landed).toBe(1);
    expect(r.rejected).toBe(7);
    expect(r.cellsTouched).toBe(1);
  });

  it("轮B 每拍不同格：一笔都不被拒 → landed=N, rejected=0", () => {
    const taps = Array.from({ length: 8 }, (_, i) => ({ cell: 500 + i, t: 1000 + i * 300 }));
    const r = simulateRound(taps, 3000);
    expect(r.landed).toBe(8);
    expect(r.rejected).toBe(0);
    expect(r.cellsTouched).toBe(8);
  });

  it("同格但间隔拉满 3s：每拍都放行（冷却窗口已过 —— 拒的是连点不是常客）", () => {
    const taps = [0, 1, 2].map((i) => ({ cell: 7, t: i * 3000 }));
    const r = simulateRound(taps, 3000);
    expect(r.landed).toBe(3);
    expect(r.rejected).toBe(0);
  });
});

/* ─────────────── gasTable：烧钱对照算术 ─────────────── */

describe("gasTable（#363：被拒也扣 gas；我们：服务端拒 = 零 gas）", () => {
  it("轮A 8 拍：them 烧 8×单价（拒的也烧），us 只烧 landed×单价（拒的 0 成本）", () => {
    const t = gasTable({ taps: 8, landed: 1, costPerTx: COST });
    expect(t.themGasMon).toBeCloseTo(8 * COST, 10);
    expect(t.usGasMon).toBeCloseTo(1 * COST, 10);
    expect(t.wasteMon).toBeCloseTo(7 * COST, 10);
  });

  it("全放行（rejected=0）时 waste=0，them=us（我们的 claim 合法 range 永成功 → 点击 0 浪费）", () => {
    const t = gasTable({ taps: 5, landed: 5, costPerTx: COST });
    expect(t.wasteMon).toBeCloseTo(0, 10);
    expect(t.themGasMon).toBeCloseTo(t.usGasMon, 10);
  });
});
