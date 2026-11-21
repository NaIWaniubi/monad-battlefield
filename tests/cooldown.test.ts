/**
 * G-cooldown · 演示对照模式（COOLDOWN_MODE）单测
 *
 * 背景（与往届 #363 千人像素战争的差异化实证）：
 *   #363 式合约内冷却 —— 被拒的点击也在链上执行并照扣 gas（Monad 按
 *   gasLimit 计费，revert 也付钱，见 docs/EVIDENCE.md §5）。
 *   我们的对照面：合约 claim 合法 range 内零拒绝 + 观众不持钱包；
 *   「演示对照模式」是把 **#363 的冷却语义搬到服务端代持层** 跑一遍给评委看：
 *   COOLDOWN_MODE=1 时同格 3s 内重复点击 → 中继直接 429（cooldown_3s），
 *   **拒绝发生在发 tx 之前**，一克 gas 都不烧 —— 对照表由 scripts/ab-demo.mjs 产出。
 *
 * 纪律（与 tests/e-fixes-server.test.ts 同款）：
 *   server/index.mjs 的启动段被 IS_MAIN 包住，import 不占端口不打网络，
 *   纯函数直接钉行为契约；真 HTTP 429 的接线由 node 冒烟验收（见 done 文件）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COOLDOWN_ERROR,
  createCellCooldown,
  createCooldownGuard,
  resolveCooldownMode,
  statsBody,
} from "../server/index.mjs";

/* join.ts 在模块顶层就摸 document / 跑 boot()，node 环境 import 会炸 ——
 * 沿用 tests/e-fixes-web.test.ts 与 hud-dom-contract.test.ts 的文本契约纪律：
 * 正则断言接线，不执行浏览器、不新增依赖。 */
const JOIN = readFileSync(resolve(__dirname, "../web/src/join.ts"), "utf8");

/* ─────────────── 开关解析：缺省必须是「完全不影响现行为」 ─────────────── */

describe("resolveCooldownMode（开关只认明确的 1/true/--cooldown）", () => {
  it("未设置 / 空串 / 0 / false / 乱值 → 一律关（现行为零变化）", () => {
    expect(resolveCooldownMode(undefined, [])).toBe(false);
    expect(resolveCooldownMode("", [])).toBe(false);
    expect(resolveCooldownMode("0", [])).toBe(false);
    expect(resolveCooldownMode("false", [])).toBe(false);
    expect(resolveCooldownMode("yes-please", [])).toBe(false);
  });

  it('"1" / "true"（忽略大小写与空白）→ 开', () => {
    expect(resolveCooldownMode("1", [])).toBe(true);
    expect(resolveCooldownMode("TRUE", [])).toBe(true);
    expect(resolveCooldownMode(" true ", [])).toBe(true);
  });

  it("启动参数 --cooldown 等价于 COOLDOWN_MODE=1；--cooldown=0 不开", () => {
    expect(resolveCooldownMode(undefined, ["--cooldown"])).toBe(true);
    expect(resolveCooldownMode(undefined, ["node", "server/index.mjs", "--cooldown"])).toBe(true);
    expect(resolveCooldownMode(undefined, ["--cooldown=0"])).toBe(false);
    expect(resolveCooldownMode("0", ["--cooldown"])).toBe(true); // 显式旗标压过 env 的 0
  });
});

/* ─────────────── 每格 3s 冷却账本（纯逻辑，时钟注入） ─────────────── */

describe("createCellCooldown（同格 3s：拒绝发生在发 tx 之前）", () => {
  const T0 = 1_000_000; // 任意起点，ms

  it("同格二击落在 3s 窗口内 → 拒，retryAfterMs = 窗口剩余", () => {
    const c = createCellCooldown(3000);
    expect(c.hit(7, T0).ok).toBe(true);
    const r = c.hit(7, T0 + 1000);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(2000);
  });

  it("隔 3.1s 再打同格 → 放行，且放行时刻成为新的冷却锚点", () => {
    const c = createCellCooldown(3000);
    expect(c.hit(7, T0).ok).toBe(true);
    expect(c.hit(7, T0 + 3100).ok).toBe(true); // 3.1s 后放行
    // 锚点必须滚动到 3100：3100+1500 处再打要拒
    const r = c.hit(7, T0 + 3100 + 1500);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(1500);
    // 再隔满 3s：3100+3000 之后放行
    expect(c.hit(7, T0 + 3100 + 3001).ok).toBe(true);
  });

  it("窗口边界：恰好整 3s 不属『3s 内』→ 放行（含边界语义钉死）", () => {
    const c = createCellCooldown(3000);
    expect(c.hit(7, T0).ok).toBe(true);
    expect(c.hit(7, T0 + 2999).ok).toBe(false);
    expect(c.hit(7, T0 + 3000).ok).toBe(true);
  });

  it("格与格独立：A 格冷却中，B 格照常放行", () => {
    const c = createCellCooldown(3000);
    expect(c.hit(7, T0).ok).toBe(true);
    expect(c.hit(7, T0 + 500).ok).toBe(false);
    expect(c.hit(8, T0 + 500).ok).toBe(true);
  });
});

/* ─────────────── 模式合成：mode=0 全放行（回归钉） ─────────────── */

describe("createCooldownGuard（mode=0 全放行 / mode=1 启用 429 语义）", () => {
  it("mode=false：同格连打 20 次全放行 —— 关开关时现行为一字不变", () => {
    const g = createCooldownGuard(false, 3000);
    for (let i = 0; i < 20; i++) {
      expect(g.hit(42, 1000 + i * 10).ok).toBe(true);
    }
  });

  it("mode=true：第二击被拒且带 error=cooldown_3s（响应体错误码的单一来源）", () => {
    const g = createCooldownGuard(true, 3000);
    expect(g.hit(1, 0).ok).toBe(true);
    const r = g.hit(1, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(COOLDOWN_ERROR);
    expect(COOLDOWN_ERROR).toBe("cooldown_3s");
    expect(r.retryAfterMs).toBe(2999);
  });
});

/* ─────────────── API 形状：/api/stats 的 cooldownMode ─────────────── */

describe("statsBody().cooldownMode（评委肉眼可见的开关状态）", () => {
  it("测试进程未设 COOLDOWN_MODE → stats 里 cooldownMode 恒为 boolean false", () => {
    const s = statsBody();
    expect(typeof s.cooldownMode).toBe("boolean");
    expect(s.cooldownMode).toBe(false);
  });
});

/* ─────────────── join.ts 接线（文本契约，同 e-fixes-web 纪律） ─────────────── */

/** 截取 headerRe 起的一个函数体（花括号配平）；找不到起点返回 ""。 */
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

describe("join.ts · 顶栏对照模式小字（G-cooldown）", () => {
  it("小字元素动态建（join.html 不许动）；文案含「对照模式」与「3s」", () => {
    expect(JOIN).toMatch(/document\.createElement\("span"\)/);
    expect(JOIN).toMatch(/对照模式[^\n]*3s冷却/);
  });

  it("setCooldownBadge：on=true 才挂进顶栏；false/undefined 只隐藏 —— mode=0 时 DOM 零变化", () => {
    const body = functionBody(JOIN, /function setCooldownBadge\(/);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/isConnected/); // 只在首次 true 时 append，不重复挂
    expect(body).toMatch(/appendChild/);
    expect(body).toMatch(/hidden\s*=\s*true/);
  });

  it("poll() 每轮把 /api/stats 的 cooldownMode 接进顶栏渲染", () => {
    const body = functionBody(JOIN, /async function poll\(/);
    expect(body).toMatch(/setCooldownBadge\(\s*s\.cooldownMode\s*\)/);
  });
});

describe("join.ts · claim 429 cooldown_3s = 正常提示不是故障（G-cooldown）", () => {
  const claimBody = functionBody(JOIN, /async function claim\(/);

  it("claim 失败分支里专属拦截 cooldown_3s，早退（不落到 showError 红条）", () => {
    expect(claimBody.length).toBeGreaterThan(0);
    const branch = /if\s*\(\s*code\s*===\s*"cooldown_3s"\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(claimBody);
    expect(branch).not.toBeNull();
    // 分支里：写中性状态行 + 短提示；且必须 return —— 不许走到 showError
    expect(branch![1]).toMatch(/elLast\.textContent/);
    expect(branch![1]).toMatch(/return;/);
    expect(branch![1]).not.toMatch(/showError\(/);
  });

  it("不许用全局冷却条 startCooldown 拦它：那是每 clientId 的语义，同格冷却是每格的 —— 混用会误伤别的格子", () => {
    const branch = /if\s*\(\s*code\s*===\s*"cooldown_3s"\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(claimBody);
    expect(branch).not.toBeNull();
    expect(branch![1]).not.toMatch(/startCooldown\(/);
  });

  it("ERR_TEXT 里有 cooldown_3s 兜底文案（任何漏网路径到 showError 也不裸显 code）", () => {
    const errText = functionBody(JOIN, /const ERR_TEXT[^=]*=/);
    expect(errText).toMatch(/cooldown_3s/);
    expect(errText).toMatch(/对照模式/);
  });
});
