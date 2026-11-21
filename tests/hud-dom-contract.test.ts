/**
 * H-hud · HUD 赛博指挥台改造的静态契约测试
 *
 * 目的（为什么存在）：
 *   H-hud 切片只允许改 web/index.html 与 web/src/style.css。
 *   main.ts 用 getElementById 拿元素，改 DOM 结构时最容易踩的雷
 *   就是误删/改名 main.ts 依赖的 id —— 大屏会白屏，而且要到运行时才炸。
 *   这个测试在 CI（vitest, node 环境）里提前把「id 一个都不能少」钉死，
 *   并对新增的结构锚点（状态点 data-signal、COST 卡片、QR 角括号）与
 *   关键 CSS 承诺（TX/S 心跳 1.6s、扫描线、tabular-nums、不引入 blur）做断言。
 *
 * 纪律：纯文本正则断言，不执行浏览器、不需要 jsdom、不新增依赖。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const HTML = readFileSync(resolve(ROOT, "web/index.html"), "utf8");
const MAIN = readFileSync(resolve(ROOT, "web/src/main.ts"), "utf8");
const CSS = readFileSync(resolve(ROOT, "web/src/style.css"), "utf8");

/** main.ts 三种取元素写法：$("id") / $<HTMLElement>("id") / document.getElementById("id") */
function idsReferenced(src: string): string[] {
  const found = new Set<string>();
  const re =
    /\$\s*<[^>]*>\(\s*"([^"]+)"\s*\)|\$\(\s*"([^"]+)"\s*\)|getElementById\(\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) found.add(m[1] ?? m[2] ?? m[3]);
  return [...found];
}

describe("H-hud 契约一：main.ts 引用的 id 在 index.html 一个都不能少", () => {
  const ids = idsReferenced(MAIN);

  it("id 提取正则本身工作正常（找到 ≥20 个）", () => {
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });

  for (const id of ids) {
    it(`保留 id="${id}"`, () => {
      expect(HTML).toContain(`id="${id}"`);
    });
  }

  it("main.ts 依赖的 class 锚点没被动过（.ctl-label / .share-* 由 JS 生成或查找）", () => {
    expect(HTML).toContain("ctl-label");
  });
});

describe("H-hud 契约二：新结构锚点", () => {
  it("#conn 带 data-signal 初值（CSS 状态点靠它着色）", () => {
    expect(HTML).toMatch(/<span[^>]*id="conn"[^>]*data-signal="connecting"|<span[^>]*data-signal="connecting"[^>]*id="conn"/);
  });

  it("COST 金额与附注包进 .cost-card 发光卡片", () => {
    const card = HTML.match(/class="cost-card"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    expect(card, "找不到 .cost-card 容器").not.toBeNull();
    expect(card![1]).toContain('id="ethcost"');
    expect(card![1]).toContain('id="ethnote"');
  });

  it("#qrwrap 内加了 .qr-brk（另两个角的 bracket 层）", () => {
    const wrap = HTML.match(/id="qrwrap"[\s\S]*?<\/div>/);
    expect(wrap, "找不到 #qrwrap").not.toBeNull();
    expect(wrap![0]).toContain("qr-brk");
  });

  it("index.html 内联被动观测脚本：只写 data-signal/--burn，不碰业务", () => {
    expect(HTML).toContain("MutationObserver");
    expect(HTML).toContain("--burn");
    // main.ts 本体必须保持零改动：它不包含 MutationObserver
    expect(MAIN).not.toContain("MutationObserver");
  });
});

describe("H-hud 契约三：style.css 视觉承诺", () => {
  it("TX/S 心跳 keyframes 存在且 1.6s 周期", () => {
    expect(CSS).toContain("@keyframes txs-heartbeat");
    expect(CSS).toMatch(/animation:[^;]*txs-heartbeat[^;]*1\.6s/);
  });

  it("整体扫描线 keyframes scan 存在且 6s", () => {
    expect(CSS).toContain("@keyframes scan");
    expect(CSS).toMatch(/animation:[^;]*scan[^;]*6s/);
  });

  it("大数字显示用等宽科技字体栈 + tabular-nums", () => {
    expect(CSS).toMatch(/--f-display:/);
    expect(CSS).toMatch(/\.display\s*\{[^}]*var\(--f-display\)/);
    expect(CSS).toMatch(/\.display\s*\{[^}]*tabular-nums/);
  });

  it("主数字发光：TX/S 紫白、BURN 绯红、COST 琥珀", () => {
    expect(CSS).toMatch(/#tps\s*\{[^}]*text-shadow/);
    expect(CSS).toMatch(/#burnrate\s*\{[^}]*text-shadow/);
    expect(CSS).toMatch(/#ethcost\s*\{[^}]*text-shadow/);
  });

  it("TERRITORY 条宽度过渡 .35s ease-out + 发光轨道", () => {
    expect(CSS).toMatch(/\.share-fill\s*\{[^}]*width\s+\.?0?\.35s\s+ease-out/);
    expect(CSS).toMatch(/\.share-track\s*\{[^}]*box-shadow/);
  });

  it("BURN 强度走 CSS 变量 --burn（JS 只推变量，不做每帧样式）", () => {
    expect(CSS).toContain("var(--burn)");
  });

  it("状态点四色都在 :root 变量里，CSS 不硬编码新色值", () => {
    for (const v of ["--sig-live:", "--sig-demo:", "--sig-conn:", "--sig-err:", "--hud-txs:"]) {
      expect(CSS, `:root 缺 ${v}`).toContain(v);
    }
    expect(CSS).toMatch(/#conn\[data-signal="live"\]/);
  });

  it("新增样式不许用 blur/backdrop-filter（4K 投影掉帧雷区）—— 存量 banner 一处除外", () => {
    const blurs = CSS.match(/blur\(/g) ?? [];
    expect(blurs.length).toBeLessThanOrEqual(1);
  });
});
