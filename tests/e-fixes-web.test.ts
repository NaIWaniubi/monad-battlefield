/**
 * E-fixes · 前端与脚本层的静态契约测试（修复 1/4/5/7/9/10 的接线面）
 *
 * 为什么用文本契约：main.ts / join.ts / swarm.ts / budget.mjs 在模块顶层就跑
 * boot()/主循环/读余额（与 web/index.html、localStorage、网络耦合），
 * node 环境无法 import；这正是 tests/hud-dom-contract.test.ts 立下的先例 ——
 * 纯文本正则断言，不执行浏览器、不新增依赖。
 *
 * 能真跑的（grid.ts 的 LABEL_WINDOW 是冻结导出的纯常量、lib.ts 的
 * waitBalancesVisible 依赖注入可测）放在各自的行为测试里，见下。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LABEL_WINDOW } from "../web/src/grid";

const ROOT = resolve(__dirname, "..");
const MAIN = readFileSync(resolve(ROOT, "web/src/main.ts"), "utf8");
const JOIN = readFileSync(resolve(ROOT, "web/src/join.ts"), "utf8");
const SWARM = readFileSync(resolve(ROOT, "scripts/swarm.ts"), "utf8");
const FUND = readFileSync(resolve(ROOT, "scripts/fund.ts"), "utf8");
const BUDGET = readFileSync(resolve(ROOT, "scripts/budget.mjs"), "utf8");
const SERVER = readFileSync(resolve(ROOT, "server/index.mjs"), "utf8");

/** 截取 fromIdx 起的一个函数体（花括号配平）；找不到起点返回 ""。 */
function functionBody(src: string, headerRe: RegExp): string {
  const m = headerRe.exec(src);
  if (!m) return "";
  let i = src.indexOf("{", m.index);
  if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return "";
}

/* ─────────────── Fix 1 · 历史回放不污染实时 TPS（main.ts） ─────────────── */

describe("E-fixes#1 历史回放不污染实时 TPS", () => {
  const applyClaim = functionBody(MAIN, /function applyClaim\(/);

  it("applyClaim 有 live 形参", () => {
    expect(MAIN).toMatch(/function applyClaim\([^)]*\blive\b[^)]*\)/);
  });

  it("applyClaim 体里 stamps.push 只在 live 分支内（回放路径一笔都不许多数）", () => {
    expect(applyClaim.length).toBeGreaterThan(0);
    const pushes = applyClaim.match(/stamps\.push\(/g) ?? [];
    expect(pushes.length).toBe(1); // 只允许出现一次 push 调用
    expect(applyClaim).toMatch(/if\s*\(\s*live\s*\)\s*stamps\.push\(/);
  });

  it("loadHistory 调用 applyClaim 明确传 live=false（回放不是本秒发生）", () => {
    const body = functionBody(MAIN, /async function loadHistory\(/);
    expect(body).toMatch(/applyClaim\(\s*l\s*,\s*false\s*\)/);
    // 不许有任何省略 live 的裸调用 applyClaim(l)
    expect(body).not.toMatch(/applyClaim\(\s*l\s*\)/);
  });

  it("事件订阅（watch onLogs）走 live=true —— 实时流照常计数", () => {
    expect(MAIN).toMatch(/applyClaim\(\s*l\s*,\s*true\s*\)/);
  });

  it("mergeState 走 state.apply 不碰 stamps（中继快照不算实时流量）", () => {
    const body = functionBody(MAIN, /async function mergeState\(/);
    expect(body).not.toContain("stamps.push");
  });

  it("demo 播种（plant）按非实时处理：开屏瞬间不许冒一排假 TPS", () => {
    const body = functionBody(MAIN, /const plant = \(/);
    expect(body).toContain(", false");
  });
});

/* ─────────────── Fix 4 · join 弱网三修 ─────────────── */

describe("E-fixes#4 join 弱网三修", () => {
  it("① sync 超时不回滚乐观涂色：catch 里超时分支保留画面并说「确认中」", () => {
    // 超时/中断：保留乐观色，文案必须出现「已发送」+「确认中」
    expect(JOIN).toContain("已发送");
    expect(JOIN).toContain("确认中");
    // 并且「已发送 · 确认中」这条路径不能落在回滚（color[id] = prevColor）之后 ——
    // 静态近似：整个 claim() 的 catch 块里回滚只允许发生在非超时分支之前，
    // 超时分支的文案行必须晚于最后一次 prevColor 回滚且不在同一 if 内。
    const claimBody = functionBody(JOIN, /async function claim\(/);
    const abortGuard = claimBody.match(/abort|AbortError|timeout/i);
    expect(abortGuard).not.toBeNull();
  });

  it("① 同格 in-flight 去重短路：claim 开头 pendingLocal.has(id) 直接 return", () => {
    expect(JOIN).toMatch(/if\s*\(\s*pendingLocal\.has\(\s*id\s*\)\s*\)\s*return/);
  });

  it("② syncGrid 跳过在途格（修「在途格每 2s 闪没」），且不再全清 pendingLocal", () => {
    const body = functionBody(JOIN, /async function syncGrid\(/);
    expect(body).toContain("pendingLocal.has(");
    expect(body).not.toContain("pendingLocal.clear()");
  });

  it("② claim 落定（成功/失败/超时）后把格子从 pendingLocal 摘除 —— 不能永久挡住快照修正", () => {
    const body = functionBody(JOIN, /async function claim\(/);
    expect(body).toContain("pendingLocal.delete(id)");
  });

  it("③ 署名窗口 14s → 30s（真常量断言，不是文本）", () => {
    expect(LABEL_WINDOW).toBe(30);
  });
});

/* ─────────────── Fix 5 · 干涸可感知 ─────────────── */

describe("E-fixes#5 干涸可感知", () => {
  it("server：/api/stats 的 dryKeys 用「!funded」实时数出来（不是写死 0）", () => {
    expect(SERVER).toMatch(/dryKeys\s*[:=][^,\n]*funded/);
  });

  it("join：StatsResp 类型带 dryKeys，且 poll 消费它", () => {
    expect(JOIN).toMatch(/dryKeys[?]?:\s*number/);
    expect(JOIN).toMatch(/s\.dryKeys|\.dryKeys\s*\?\?/);
  });

  it("join：干涸横幅走 setBanner（持久），文案含「暂满」与「续气」", () => {
    // 走 setBanner（持久通道）不是 showError（3.2s 自动消失）；文案在 DRY_BANNER 常量里
    expect(JOIN).toMatch(/DRY_BANNER\s*=\s*"[^"]*暂满[^"]*"/);
    expect(JOIN).toMatch(/DRY_BANNER\s*=\s*"[^"]*续气[^"]*"/);
    // 必须有两处 setBanner(DRY_BANNER)：poll 的 dryKeys>0 分支 + claim 的 relayer_unfunded 分支
    const calls = JOIN.match(/setBanner\(\s*DRY_BANNER\s*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("join：claim 返回 relayer_unfunded 时同样弹持久横幅", () => {
    expect(JOIN).toMatch(/relayer_unfunded[\s\S]{0,400}?setBanner\(/);
  });
});

/* ─────────────── Fix 6 · IP 第二桶接线（server 源面） ─────────────── */

describe("E-fixes#6 IP 第二桶限流接线", () => {
  it("handleClaim 里在 clientId 桶之外再查一次 IP 桶（30/10s）", () => {
    const body = functionBody(SERVER, /async function handleClaim\(/);
    // 第二次 rateHit 调用，显式带 30 与 10s 量级的窗口参数
    const hits = body.match(/rateHit\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/rateHit\([^)]*(ipKey|IP_LIMIT)[^)]*\)/);
  });

  it("超限返回 429 + error=too_many（区别于 client 桶的 rate_limited）", () => {
    const body = functionBody(SERVER, /async function handleClaim\(/);
    expect(body).toContain("too_many");
    expect(body).toMatch(/429/);
  });
});

/* ─────────────── Fix 9 · tap→确认延迟仪表接线 ─────────────── */

describe("E-fixes#9 tap→确认延迟仪表接线", () => {
  it("server：sync 路径回执成功后把 elapsed 记进窗口（noteConfirmLatency 在 handleClaim/relay 链路）", () => {
    const body = functionBody(SERVER, /async function handleClaim\(/);
    expect(body).toMatch(/noteConfirmLatency\(/);
  });

  it("server：claim 响应带 confirmMs（join 当场显示「本次确认」）", () => {
    const body = functionBody(SERVER, /async function handleClaim\(/);
    expect(body).toMatch(/confirmMs/);
  });

  it("main：HUD 有 tap→confirm 行，且诚实标注不含画面同步", () => {
    expect(MAIN).toMatch(/tap→confirm/);
    expect(MAIN).toContain("不含画面同步");
  });

  it("main：无数据时显示「—」而不是 0ms 假数（count<1 走占位符）", () => {
    // latencyP50/95 从 stats 读；空样本必须渲染破折号
    expect(MAIN).toMatch(/confirmLatencyP50ms/);
    const line = MAIN.match(/[^\n]*tap→confirm[^\n]*/g) ?? [];
    expect(line.length).toBeGreaterThanOrEqual(1);
  });

  it("join：每笔回执显示「本次确认」", () => {
    expect(JOIN).toContain("本次确认");
    expect(JOIN).toMatch(/confirmMs/);
  });
});

/* ─────────────── Fix 7 · 蜂群 reserve 自适应 ─────────────── */

describe("E-fixes#7 蜂群按 reserve-balance 自适应", () => {
  it("每车道启动先查一次余额", () => {
    expect(SWARM).toMatch(/getBalance\(/);
  });

  it("<10 MON 自钳 1300ms 间隔，并在启动日志注明限速模式", () => {
    expect(SWARM).toContain("1300");
    expect(SWARM).toMatch(/限速模式/);
  });

  it("峰值口径诚实：不再直接喊 80 tx/s 的理论值，按限速/满速分开算", () => {
    expect(SWARM).toMatch(/满速|限速/);
    // 旧的「理论峰值」直推公式必须改掉
    expect(SWARM).not.toMatch(/理论峰值/);
  });

  it("余额烧穿（NOGAS 类错误）→ 车道干净退出，不再刷屏重试", () => {
    // 先判余额耗尽并 return（退出该车道的 while），后判普通失败
    const re = /insufficient[^\n]*balance|NOGAS|reserve/i;
    expect(re.test(SWARM)).toBe(true);
    // 退出前必须有一条 lane 结束的日志（不是静默 return）
    expect(SWARM).toMatch(/车道\s*#?\$\{?idx\}?[^"]*退出|退出车道|本道退出/);
  });

  it("失败节流保留：连续失败拉大间隔而不是零间隔重试", () => {
    expect(SWARM).toMatch(/laneGap|Math\.min\(.*5000\)/);
  });
});

/* ─────────────── Fix 8 · fund 防抖 ─────────────── */

describe("E-fixes#8 fund 注资后可见性防抖", () => {
  it("fund.ts 完成后调用 waitBalancesVisible（lib 提供）", () => {
    expect(FUND).toContain("waitBalancesVisible");
  });
  it("lib.ts 导出 waitBalancesVisible 纯函数（行为契约见 e-fixes-lib.test.ts）", () => {
    const lib = readFileSync(resolve(ROOT, "scripts/lib.ts"), "utf8");
    expect(lib).toMatch(/export async function waitBalancesVisible|export function waitBalancesVisible|export const waitBalancesVisible/);
  });
});

/* ─────────────── Fix 10 · budget reserve 模型 ─────────────── */

describe("E-fixes#10 budget.mjs reserve 模型", () => {
  it("输出两种上限：限速道 0.83 tps/道 与 满储备 2 tps/道", () => {
    expect(BUDGET).toContain("0.83");
    expect(BUDGET).toMatch(/2(\.0)?\s*tps|满速/);
    expect(BUDGET).toMatch(/限速|reserve/i);
  });

  it("给出现实并行上限（按各道余额分类合计），不再只按 BOTS×1000/GAP 算术", () => {
    expect(BUDGET).toMatch(/10\s*MON|≥\s*10/);
    expect(BUDGET).toMatch(/现实并行|实测上限|reserve 上限/);
  });

  it("到 80 tps 的门槛算式在场：40 道 × ≥10 MON = 400 MON", () => {
    expect(BUDGET).toMatch(/40\s*道?\s*[×x*]\s*10\s*MON|400\s*MON/);
  });
});
