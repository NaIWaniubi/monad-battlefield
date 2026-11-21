/**
 * E2-1 · 蜂群零网络干跑（swarm-dryrun）
 *
 * scripts/swarm.ts 自 E-fixes 起有 IS_MAIN 守卫：被 import 时只出纯函数、
 * 不跑主循环、不触网 —— 所以这里的 import 本身就是安全的（lib.ts 顶层只建
 * viem client，client 构造不发请求）。
 *
 * 钉的行为契约（对应 E-fixes#7 / C2#3 议会定案）：
 *   1. laneGapFor：reserve-balance 分档 —— 余额 ≥10 MON 满速；<10 MON 自钳
 *      到 max(fastGap, LIMIT_GAP_MS)，且「查不到余额按 0 处理 → 限速」方向安全。
 *   2. isNoGasError：只有「没油了」类错误才允许车道退出；
 *      nonce 失步类错误必须返回 false（自愈路径 = fetchNonce 重同步，
 *      误判成退出错杀 = 白丢一条车道产能 —— 这是重同步决策的核心分支）。
 *   3. nextLaneGap：连续失败 >3 后 1.5× 节流、5000ms 封顶；
 *      ≤3 不动（成功/浅失败不把节奏打乱）。
 *   4. 真实进程干跑：BOTS=0 + RPC 指向黑洞，swarm 主程序必须能完整走完
 *      启动横幅 → 预检(0 道) → 收尾 sent=0 fail=0 并 exit 0。
 *      这是「接手的人一条命令能验证蜂群没被改坏」的最小证据。
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  isNoGasError,
  laneGapFor,
  LIMIT_GAP_MS,
  LIMITED_LANE_TPS,
  nextLaneGap,
  RESERVE_MIN_WEI,
} from "../scripts/swarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MON = 10n ** 18n;

describe("laneGapFor · reserve-balance 分档", () => {
  it("RESERVE_MIN_WEI = 10 MON（平台物理线，改它必须先过议会）", () => {
    expect(RESERVE_MIN_WEI).toBe(10n * MON);
  });

  it("恰好 ≥10 MON → 满速：gap=fastGap、limited=false", () => {
    expect(laneGapFor(RESERVE_MIN_WEI)).toEqual({ gap: 500, limited: false });
    expect(laneGapFor(RESERVE_MIN_WEI + 1n)).toEqual({ gap: 500, limited: false });
  });

  it("差 1 wei 不足 10 MON → 限速：钳到 LIMIT_GAP_MS(1300)", () => {
    expect(laneGapFor(RESERVE_MIN_WEI - 1n)).toEqual({ gap: 1300, limited: true });
  });

  it("余额 0（含「RPC 查不到按 0 处理」的调用方约定）→ 限速，方向安全", () => {
    expect(laneGapFor(0n).limited).toBe(true);
    expect(laneGapFor(0n).gap).toBeGreaterThanOrEqual(LIMIT_GAP_MS);
  });

  it("fastGap 比限速线还宽时不反向加速：gap = max(fastGap, limitGap)", () => {
    expect(laneGapFor(0n, 2000, 1300)).toEqual({ gap: 2000, limited: true });
    expect(laneGapFor(0n, 500, 999)).toEqual({ gap: 999, limited: true });
  });

  it("限速道的平台速率 ≈0.83 tx/s（1 tx/1.2s，横幅与预算同口径）", () => {
    expect(LIMITED_LANE_TPS).toBeCloseTo(1000 / 1200, 2);
    expect(LIMITED_LANE_TPS).toBeLessThan(1);
  });
});

describe("isNoGasError · 退出 vs 重同步的分岔口", () => {
  it("没油类文案 → true（重试不会变成功，车道干净退出）", () => {
    const cases = [
      "Insufficient funds for gas * price + value",
      "intrinsic gas too low: cumulative gas cost exceeds balance",
      "not enough funds for transfer",
      "Monad reserve balance not met for this EOA",
    ];
    for (const m of cases) expect(isNoGasError(new Error(m)), m).toBe(true);
  });

  it("nonce 失步类 → false：必须走 fetchNonce 重同步而不是退出（C2 原案修正）", () => {
    expect(isNoGasError(new Error("nonce too low"))).toBe(false);
    expect(isNoGasError(new Error("invalid nonce: expected 12, got 9"))).toBe(false);
    expect(isNoGasError(new Error("replacement transaction underpriced"))).toBe(false);
  });

  it("其它链上失败（revert / 网络抖动）→ false，交给失败节流", () => {
    expect(isNoGasError(new Error("Execution reverted"))).toBe(false);
    expect(isNoGasError(new Error("fetch failed"))).toBe(false);
  });

  it("viem 的 shortMessage 形状与裸字符串也能判", () => {
    expect(isNoGasError({ shortMessage: "Insufficient balance" })).toBe(true);
    expect(isNoGasError("raw string: exceeds balance")).toBe(true);
    expect(isNoGasError(null)).toBe(false);
  });
});

describe("nextLaneGap · 连续失败节流（重同步决策的时间维度）", () => {
  it("连续失败 ≤3：不动节奏（一次抖动不许把 500ms 车道打成慢车道）", () => {
    for (const n of [0, 1, 3]) expect(nextLaneGap(500, n), `fails=${n}`).toBe(500);
  });

  it("连续失败 >3：1.5× 拉大", () => {
    expect(nextLaneGap(500, 4)).toBe(750);
    expect(nextLaneGap(750, 5)).toBe(1125);
  });

  it("封顶 5000ms，且只增不减（成功缩回会引发限速↔满速临界震荡）", () => {
    expect(nextLaneGap(4000, 4)).toBe(5000);
    expect(nextLaneGap(5000, 99)).toBe(5000);
    expect(nextLaneGap(1300, 4)).toBe(1950);
    // 「成功不回缩」由调用方保证：这里钉的是纯节流函数本身的单调性
    let g = 500;
    for (let i = 0; i < 10; i++) g = nextLaneGap(g, 5);
    expect(g).toBe(5000);
  });
});

describe("swarm 主程序 · BOTS=0 零车道干跑（真起进程，不发交易）", () => {
  const tsxCli = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
  const prerequisites = [tsxCli, resolve(ROOT, "scripts/swarm.ts"), resolve(ROOT, ".bots.json")].every(existsSync);

  it(
    "BOTS=0 + 黑洞 RPC：完整走横幅→预检→收尾，exit 0，零网络依赖",
    () => {
      const r = spawnSync(process.execPath, [tsxCli, "scripts/swarm.ts"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, BOTS: "0", RPC_URL: "http://127.0.0.1:9", RPC_URLS: "http://127.0.0.1:9" },
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      expect(r.status, out.slice(-2000)).toBe(0);
      expect(out).toContain("预检 0 条车道");
      expect(out).toContain("结束：sent=0 fail=0");
      expect(out).not.toContain("6421"); // 历史事故口径不许复活
    },
    { skip: !prerequisites },
  );

  it(
    "swarm.ts 的纯函数导出面是契约的一部分（被人改回无守卫脚本时这里先红）",
    () => {
      const src = readFileSync(resolve(ROOT, "scripts/swarm.ts"), "utf8");
      for (const fn of ["laneGapFor", "isNoGasError", "nextLaneGap", "RESERVE_MIN_WEI"]) {
        expect(src, `swarm.ts 应导出 ${fn}`).toContain(`export ${fn.startsWith("RESERVE") ? "const" : "function"} ${fn}`);
      }
      expect(src).toContain("IS_MAIN");
    },
  );
});
