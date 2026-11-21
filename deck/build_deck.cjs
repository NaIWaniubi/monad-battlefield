/* Monad Battlefield — pitch deck builder (pptxgenjs, LAYOUT_WIDE 13.33x7.5) */
const pptxgen = require("pptxgenjs");
const fs = require("fs");

const p = new pptxgen();
p.layout = "LAYOUT_WIDE";
p.author = "Monad Battlefield team";
p.title = "Monad Battlefield";

// ---- palette (BACKGROUND -> PRIMARY -> ACCENT) ----
const BG = "0D0B16";        // deep indigo near-black
const PANEL = "171227";     // card tint
const PANEL2 = "1F1936";    // lighter tint
const LINE = "322A52";      // hairline
const PRIMARY = "8B5CF6";   // Monad purple
const PDIM = "5B4BB0";      // dimmed purple
const ACCENT = "F5A623";    // amber = measured/high-energy
const TEXT = "F1F5F9";
const MUTED = "9CA3AF";
const MONO = "Consolas";
const SANS = "Microsoft YaHei";

const W = 13.33, H = 7.5, M = 0.5, CW = W - 2 * M;

// ---- helpers ----
function slide(n) {
  const s = p.addSlide();
  s.background = { color: BG };
  return s;
}
function footer(s, i, total) {
  s.addText("MONAD BATTLEFIELD · 2026-11-21 广州 Monad Blitz", {
    x: M, y: H - 0.42, w: 7, h: 0.3, fontFace: SANS, fontSize: 12, color: "6B6485", align: "left", margin: 0,
  });
  s.addText(`${String(i).padStart(2, "0")} / ${total}`, {
    x: W - 1.7, y: H - 0.42, w: 1.2, h: 0.3, fontFace: SANS, fontSize: 12, color: "6B6485", align: "right", margin: 0,
  });
}
function kickerTitle(s, kicker, title, titleSize) {
  s.addText(kicker, { x: M, y: 0.42, w: 9, h: 0.3, fontFace: SANS, fontSize: 13, color: PRIMARY, charSpacing: 2, bold: true, margin: 0 });
  s.addText(title, { x: M, y: 0.72, w: 10.6, h: 0.75, fontFace: SANS, fontSize: titleSize || 30, color: TEXT, bold: true, margin: 0 });
}
// signature motif: cluster of "cells" (one cell = one storage slot)
function cellCluster(s, x, y, cols, rows, cell, gap, opt) {
  opt = opt || {};
  const step = cell + gap;
  const hi = opt.hi || {};            // index -> color
  const hiT = opt.hiT || 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    const col = hi[i] || opt.base || PDIM;
    s.addShape(p.shapes.RECTANGLE, {
      x: x + c * step, y: y + r * step, w: cell, h: cell,
      fill: { color: col, transparency: hi[i] ? (hiT || 0) : (opt.baseT == null ? 78 : opt.baseT) },
      line: { type: "none" },
    });
  }
}
function rowItem(s, x, y, w, lead, desc, sqColor) {
  s.addShape(p.shapes.RECTANGLE, { x, y: y + 0.05, w: 0.16, h: 0.16, fill: { color: sqColor || PRIMARY }, line: { type: "none" } });
  s.addText(lead, { x: x + 0.34, y, w: w - 0.34, h: 0.34, fontFace: SANS, fontSize: 16.5, color: TEXT, bold: true, margin: 0 });
  s.addText(desc, { x: x + 0.34, y: y + 0.36, w: w - 0.34, h: 0.62, fontFace: SANS, fontSize: 13, color: MUTED, margin: 0 });
}
function panel(s, x, y, w, h, color) {
  s.addShape(p.shapes.RECTANGLE, { x, y, w, h, fill: { color: color || PANEL }, line: { color: LINE, width: 0.75 } });
}
const TOTAL = 16;

/* ============ S1 · COVER ============ */
{
  const s = slide();
  // big cell field, right half
  cellCluster(s, 7.15, 0.9, 14, 14, 0.32, 0.11, {
    base: "241E3E", baseT: 0,
    hi: { 5: PRIMARY, 18: ACCENT, 33: PRIMARY, 47: PDIM, 60: ACCENT, 74: PRIMARY, 91: PRIMARY, 108: ACCENT, 122: PRIMARY, 140: ACCENT, 15: PDIM, 96: PDIM }, hiT: 8,
  });
  s.addShape(p.shapes.RECTANGLE, { x: 6.4, y: 0, w: 1.6, h: H, fill: { color: BG, transparency: 45 }, line: { type: "none" } });
  s.addText("GUANGZHOU MONAD BLITZ · 黑客松路演 · 2026-11-21", { x: M, y: 1.15, w: 7, h: 0.3, fontFace: SANS, fontSize: 13, color: PRIMARY, charSpacing: 2, bold: true, margin: 0 });
  s.addText("MONAD", { x: M, y: 1.5, w: 7.2, h: 0.95, fontFace: SANS, fontSize: 54, color: TEXT, bold: true, margin: 0 });
  s.addText("BATTLEFIELD", { x: M, y: 2.42, w: 7.2, h: 0.95, fontFace: SANS, fontSize: 54, color: PRIMARY, bold: true, margin: 0 });
  s.addText("把「并行 EVM」变成 78 人能亲手推、\n看得见、听得着的数字", { x: M, y: 3.65, w: 6.6, h: 1.15, fontFace: SANS, fontSize: 23, color: TEXT, margin: 0 });
  s.addText([
    { text: "每一次变色、每一声,都是一笔真实链上交易。", options: { breakLine: true, color: ACCENT, fontSize: 16, bold: true } },
    { text: "2,500 个格子 · 一格一个 storage slot · claim 零重叠", options: { color: MUTED, fontSize: 14 } },
  ], { x: M, y: 5.0, w: 6.6, h: 0.85, fontFace: SANS, margin: 0, paraSpaceAfter: 6 });
  s.addText("github.com/NaIWaniubi/monad-battlefield   ·   naiwaniubi.github.io/monad-battlefield", { x: M, y: 6.55, w: 8.5, h: 0.3, fontFace: MONO, fontSize: 12.5, color: MUTED, margin: 0 });
  footer(s, 1, TOTAL);
}

/* ============ S2 · PROBLEM + KILLER LINE ============ */
{
  const s = slide();
  kickerTitle(s, "01 · 问题", "如何让 78 位不带钱包的观众,为并行出一笔交易?", 26);
  cellCluster(s, W - 2.6, 0.5, 5, 3, 0.26, 0.1, { hi: { 2: ACCENT, 7: PRIMARY }, base: "241E3E", baseT: 0 });
  panel(s, M, 1.75, CW, 1.5);
  s.addText("HMW(How Might We)", { x: 0.85, y: 1.95, w: 3, h: 0.3, fontFace: SANS, fontSize: 12.5, color: PRIMARY, bold: true, margin: 0 });
  s.addText("黑客松观众不带钱包、不懂 RPC——怎样让他们「亲手」把一笔笔交易推进同一个块,\n并且当场看见、听见并行 EVM 吞吐量的形状?", { x: 0.85, y: 2.28, w: 11.6, h: 0.85, fontFace: SANS, fontSize: 17, color: TEXT, margin: 0 });
  s.addText("我们的答案:", { x: M, y: 3.62, w: 4, h: 0.3, fontFace: SANS, fontSize: 13, color: MUTED, margin: 0 });
  s.addText([
    { text: "我们没写一行并行代码。", options: { breakLine: true } },
    { text: "只是把状态切成 2,500 个互不相干的格子,", options: { breakLine: true, color: ACCENT } },
    { text: "让 Monad 的并行 EVM 自己去跑它们。", options: {} },
  ], { x: M, y: 4.0, w: 12.33, h: 2.0, fontFace: SANS, fontSize: 33, color: TEXT, bold: true, margin: 0, paraSpaceAfter: 8 });
  s.addText("性能故事不靠解释,靠一屏涟漪和 4 个声部——声音本身就是 TPS。", { x: M, y: 6.35, w: 12.33, h: 0.4, fontFace: SANS, fontSize: 14, color: MUTED, margin: 0 });
  footer(s, 2, TOTAL);
}

/* ============ S3 · WHY MONAD ============ */
{
  const s = slide();
  kickerTitle(s, "02 · 为什么必须是 Monad", "零重叠的状态划分,才是并行 EVM 的用武之地");
  rowItem(s, M, 1.7, 6.1,
    "一格一 slot",
    "Cell 结构 25 字节独占一个 storage slot;claim(id) 只写自己那一格,块与块之间互不相干。");
  rowItem(s, M, 2.85, 6.1,
    "没有全局计数器",
    "无共享余额、无锁;屏上所有统计都由链上事件离线推导,并发 claim 写集零重叠。");
  rowItem(s, M, 4.0, 6.1,
    "零重执行税",
    "写集若重叠,乐观并行执行会重执行冲突批次、吐回大部分并行红利;我们零重叠 → 零重执行税,吞吐随车道数线性。");
  rowItem(s, M, 5.15, 6.1,
    "真正的上限不是链",
    "是独立付款地址数:一个 EOA 的 tx 被 nonce 严格串行。所以并行度 = 独立发送方数量。", ACCENT);
  // right: code panel
  panel(s, 7.0, 1.7, 5.83, 4.0, "120E1F");
  s.addText("contracts/Battlefield.sol(部署态冻结 · 676 B)", { x: 7.25, y: 1.88, w: 5.4, h: 0.3, fontFace: SANS, fontSize: 11.5, color: MUTED, margin: 0 });
  s.addText([
    { text: "struct Cell { address owner;", options: { breakLine: true } },
    { text: "            uint32 heat;", options: { breakLine: true } },
    { text: "            uint8  color; } // 25B", options: { breakLine: true, color: "7DD3FC" } },
    { text: "Cell[2500] public cells;", options: { breakLine: true } },
    { text: "", options: { breakLine: true } },
    { text: "function claim(uint16 id, uint8 color)", options: { breakLine: true } },
    { text: "    external {", options: { breakLine: true } },
    { text: "  Cell storage c = cells[id];", options: { breakLine: true, color: "F5A623" } },
    { text: "  c.owner = msg.sender;", options: { breakLine: true } },
    { text: "  c.color = color;", options: { breakLine: true } },
    { text: "  unchecked { c.heat += 1; }", options: { breakLine: true } },
    { text: "  emit Claim(id, msg.sender,", options: { breakLine: true } },
    { text: "               color, heat);", options: {} },
    { text: "}", options: {} },
  ], { x: 7.25, y: 2.22, w: 5.4, h: 3.3, fontFace: MONO, fontSize: 13, color: "C4B5FD", margin: 0, lineSpacingMultiple: 1.12 });
  s.addText("高亮行 = 唯一被并发的写:每笔只碰自己的格子", { x: 7.0, y: 5.85, w: 5.83, h: 0.35, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
  footer(s, 3, TOTAL);
}

/* ============ S4 · WHAT THE FLOOR LOOKS LIKE ============ */
{
  const s = slide();
  kickerTitle(s, "03 · 现场", "三通道一台中继:视觉墙 · 声化 · 扫码参战");
  const imgY = 2.05, imgH = 4.19;
  // main screen (1600x1000 -> ratio 1.6)
  const mw = imgH * 1.6; // 6.70
  s.addText("视觉墙 + 声化 · 大屏", { x: M, y: imgY - 0.32, w: 4, h: 0.3, fontFace: SANS, fontSize: 13, color: PRIMARY, bold: true, margin: 0 });
  s.addImage({ path: "../docs/screenshots/main-demo.png", x: M, y: imgY, w: mw, h: imgH });
  // audience (430x900 portrait)
  const ax = M + mw + 0.25;
  const aw = imgH * (430 / 900); // 2.00
  s.addText("扫码参战", { x: ax, y: imgY - 0.32, w: 2, h: 0.3, fontFace: SANS, fontSize: 13, color: PRIMARY, bold: true, margin: 0 });
  s.addImage({ path: "../docs/screenshots/audience-page.png", x: ax, y: imgY, w: aw, h: imgH });
  // director (1280x900 ratio 1.422)
  const dx = ax + aw + 0.25;
  const dw = 3.13, dh = dw / 1.422;
  s.addText("导演台 · 平板控场", { x: dx, y: imgY - 0.32, w: 3, h: 0.3, fontFace: SANS, fontSize: 13, color: PRIMARY, bold: true, margin: 0 });
  s.addImage({ path: "../docs/screenshots/director.png", x: dx, y: imgY, w: dw, h: dh });
  s.addText("78 人扫码:无钱包、无 gas、不装任何东西;点击 → 服务端代签 → ~1s 块落链(同步回执 0.7–2s)→ 大屏变色 + 响一个音(四阵营 = 四声部)。", { x: dx, y: imgY + dh + 0.15, w: dw, h: 1.95, fontFace: SANS, fontSize: 12, color: MUTED, margin: 0 });
  s.addText([
    { text: "如实区分:", options: { bold: true, color: ACCENT } },
    { text: " 本图满屏密度为合成层(顶栏已标 DEMO);真实点击、同块 17 方、revert 计费才是链上实证(见 P6)。", options: { color: MUTED } },
  ], { x: M, y: 6.52, w: CW, h: 0.4, fontFace: SANS, fontSize: 12.5, margin: 0 });
  footer(s, 4, TOTAL);
}

/* ============ S5 · PLATFORM PHYSICS ============ */
{
  const s = slide();
  kickerTitle(s, "04 · 平台物理", "我们撞上并量出了 Monad 的 reserve-balance 曲线");
  s.addText([
    { text: "16", options: { fontSize: 66, color: ACCENT, bold: true, breakLine: true } },
    { text: "tx/s 实测峰值 @ 17 条独立车道", options: { fontSize: 15, color: TEXT } },
  ], { x: M, y: 1.62, w: 5.6, h: 1.5, fontFace: SANS, margin: 0, paraSpaceAfter: 2 });
  rowItem(s, M, 3.35, 5.7,
    "每道的物理限速",
    "余额 < 10 MON 的 EOA 被限到 1 tx / 3 块 ≈ 0.83 tx/s——调 GAP_MS 无效,这是链的规则。");
  rowItem(s, M, 4.5, 5.7,
    "实测压在预测上",
    "0.83 × 17 ≈ 14.2 tx/s(理论)对 16 tx/s(实测峰值)——平台物理定律级别的对应,不是 PPT。");
  rowItem(s, M, 5.65, 5.7,
    "撞墙 = 懂链",
    "把「我们没做到 80」讲成「我们测出了墙的形状」:80 tx/s 是配置目标,需每道 ≥ 10 MON(约 400 MON 储备)。", ACCENT);
  // chart
  s.addText("单窗口吞吐上限(tx/s)· 口径见图例", { x: 6.65, y: 1.62, w: 6.2, h: 0.3, fontFace: SANS, fontSize: 13, color: MUTED, bold: true, margin: 0 });
  s.addChart(p.charts.BAR, [{
    name: "tx/s",
    labels: ["理论线\n0.83×17", "实测峰值\n17 车道", "配置目标\n40 车道×2\n(从未实测)"],
    values: [14.2, 16, 80],
  }], {
    x: 6.55, y: 1.95, w: 6.25, h: 3.9, barDir: "col",
    varyColors: true, chartColors: ["6D5BD0", "F5A623", "3B3557"],
    chartArea: { fill: { color: BG } }, plotArea: { fill: { color: BG } },
    catAxisLabelColor: "9CA3AF", valAxisLabelColor: "9CA3AF",
    catAxisLabelFontSize: 11.5, valAxisLabelFontSize: 12,
    valGridLine: { color: "2A2444", size: 0.5 }, catGridLine: { style: "none" },
    valAxisMaxVal: 90, showValue: true, dataLabelPosition: "outEnd",
    dataLabelColor: TEXT, dataLabelFontSize: 14, dataLabelBold: true,
    dataLabelFormatCode: "0.#",
    showLegend: false, barGapWidthPct: 55, showTitle: false,
  });
  s.addText([
    { text: "琥珀 = 实测 16;紫 = 理论 14.2;灰紫 = 配置目标,从未以实测口径宣称。", options: {} },
  ], { x: 6.55, y: 6.0, w: 6.25, h: 0.35, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
  s.addText("数据来源:swarm-live.log(前 30s 253 笔被节点接受、0 失败,均值 8.4 tx/s;第 253 笔后撞限速墙)", { x: 6.55, y: 6.42, w: 6.25, h: 0.5, fontFace: SANS, fontSize: 11.5, color: "6B6485", margin: 0 });
  footer(s, 5, TOTAL);
}

/* ============ S6 · ON-CHAIN EVIDENCE ============ */
{
  const s = slide();
  kickerTitle(s, "05 · 真链上证据", "每一个数字都可以在区块浏览器里复核");
  // three big stats
  const stats = [
    ["373", "笔真落块", "蜂群 362 + 冒烟 1 + 观众同步 10", ACCENT],
    ["17 / 块", "同块 17 个独立 EOA", "区块 #81474005 · ~1s 块 · 全部落块", PRIMARY],
    ["0.7–2s", "观众同步回执", "手机 → 公网 HTTPS 隧道 → 代签 → 落块", PRIMARY],
  ];
  stats.forEach((st, i) => {
    const x = M + i * (4.11 + 0.0);
    panel(s, x, 1.62, 4.0, 2.05);
    s.addText(st[0], { x: x + 0.25, y: 1.82, w: 3.5, h: 0.75, fontFace: SANS, fontSize: 40, color: st[3], bold: true, margin: 0 });
    s.addText(st[1], { x: x + 0.25, y: 2.6, w: 3.55, h: 0.35, fontFace: SANS, fontSize: 16, color: TEXT, bold: true, margin: 0 });
    s.addText(st[2], { x: x + 0.25, y: 2.98, w: 3.55, h: 0.6, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
  });
  panel(s, M, 4.0, CW, 1.35, "120E1E");
  s.addText("现场一条 curl 可复现(docs/EVIDENCE.md):", { x: 0.75, y: 4.15, w: 8, h: 0.3, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
  s.addText("curl -s -X POST https://testnet-rpc.monad.xyz -d '{\"method\":\"eth_getBlockByNumber\", ...}'  →  “17 claims from 17 distinct senders in this block”", { x: 0.75, y: 4.48, w: 11.9, h: 0.75, fontFace: MONO, fontSize: 12, color: "7DD3FC", margin: 0 });
  const links = [
    "浏览器:testnet.monadscan.com/block/81474005 · testnet.monadvision.com/block/81474005",
    "观众端到端回执:tx 0x36f2c5ea…8536 · status SUCCESS · block 79578040 · Claim(cell=1873) · 60,000 gas",
    "计费口径:Monad 按 gasLimit 计费(回执实测 gasUsed == gasLimit)→ 单笔 claim = 60k gas × 110 gwei = 0.0066 MON",
  ];
  links.forEach((t, i) => {
    s.addText(t, { x: M, y: 5.6 + i * 0.42, w: CW, h: 0.4, fontFace: SANS, fontSize: 12.5, color: i === 1 ? TEXT : MUTED, margin: 0 });
  });
  footer(s, 6, TOTAL);
}

/* ============ S7 · VS PRIOR EDITIONS ============ */
{
  const s = slide();
  kickerTitle(s, "06 · 和往届的区别", "不是又一个像素画板(vs 像素战争 #363)");
  const hdr = { fontFace: SANS, fontSize: 14, color: TEXT, bold: true, fill: { color: PANEL2 }, valign: "middle" };
  const lab = { fontFace: SANS, fontSize: 14, color: PRIMARY, bold: true, fill: { color: PANEL }, valign: "middle" };
  const cellA = { fontFace: SANS, fontSize: 13, color: MUTED, fill: { color: BG }, valign: "middle" };
  const cellB = { fontFace: SANS, fontSize: 13.5, color: TEXT, fill: { color: PANEL }, valign: "middle" };
  s.addTable([
    [{ text: "", options: lab }, { text: "合约式冷却玩法(往届常见)", options: hdr }, { text: "Monad Battlefield", options: { ...hdr, color: ACCENT } }],
    [{ text: "计费", options: lab }, { text: "冷却写进合约:被拒的点击照样扣 gas,真金白银打水漂", options: cellA }, { text: "claim 零拒绝 + 服务端代付:每一分钱都变成确认;revert 计费实测可查", options: cellB }],
    [{ text: "呈现", options: lab }, { text: "比美的静态像素画板", options: cellA }, { text: "声画同步的「并行示波器」:四阵营四声部,声音本身就是 TPS", options: cellB }],
    [{ text: "深度", options: lab }, { text: "跑个 demo、讲个体验", options: cellA }, { text: "实测报告:量化 Monad 的 reserve-balance 平台物理曲线", options: cellB }],
  ], { x: M, y: 1.7, w: CW, colW: [1.3, 5.3, 5.73], rowH: [0.5, 0.95, 0.95, 0.95], border: { pt: 0.75, color: LINE }, margin: 0.08 });
  s.addText([
    { text: "诚实备注:", options: { bold: true, color: ACCENT } },
    { text: " ①/③ 的 A/B 对照实测(冷却被拒计费 vs 零拒绝代付)正在由并行小组定稿,见 docs/ab-result.json + EVIDENCE §5 —— 提交前更新,本页不预填数字。", options: { color: MUTED } },
    { text: " ② 满屏密度为合成层(顶栏标 DEMO),链上实证以 P6 为准。", options: { color: MUTED } },
  ], { x: M, y: 5.65, w: CW, h: 0.9, fontFace: SANS, fontSize: 12.5, margin: 0, paraSpaceAfter: 4 });
  footer(s, 7, TOTAL);
}

/* ============ S8 · STACK + ENGINEERING ============ */
{
  const s = slide();
  kickerTitle(s, "07 · 技术与工程", "零新依赖 · 无 Foundry · 一条命令上台");
  const stack = ["Solidity\n(部署态冻结)", "solc-js\n编译", "viem\n多 EOA nonce 中继", "Canvas\n视觉墙", "WebAudio\n四声部", "node:http\n中继/舞台"];
  const bw = 1.86, gap = 0.16, x0 = M, yb = 1.8, hb = 1.15;
  stack.forEach((t, i) => {
    const x = x0 + i * (bw + gap);
    panel(s, x, yb, bw, hb, i === 2 ? PANEL2 : PANEL);
    s.addText(t, { x: x + 0.08, y: yb, w: bw - 0.16, h: hb, fontFace: SANS, fontSize: 12.5, color: i === 2 ? ACCENT : TEXT, bold: true, align: "center", valign: "middle", margin: 0 });
    if (i < stack.length - 1) s.addText("›", { x: x + bw - 0.02, y: yb + 0.3, w: 0.22, h: 0.5, fontFace: SANS, fontSize: 20, color: PRIMARY, align: "center", margin: 0 });
  });
  s.addText("合约刻意只有 ~38 行:把证明面积缩到一行 claim,性能故事全部交给状态划分本身。", { x: M, y: 3.2, w: CW, h: 0.35, fontFace: SANS, fontSize: 14, color: MUTED, margin: 0 });
  const stats8 = [
    ["143", "条单元测试(vitest)"],
    ["6", "道门禁:密钥扫描·tsc·build·vitest·二维码解码·跨设备控场"],
    ["60k", "gas/笔 硬下限实测(50k→0/3,60k→3/3)"],
    ["8 把", "中继 key 轮转,各自 nonce 队列,不 await 回执"],
  ];
  stats8.forEach((st, i) => {
    const x = M + i * 3.08;
    s.addShape(p.shapes.RECTANGLE, { x: x + 0.06, y: 4.12, w: 0.16, h: 0.16, fill: { color: PRIMARY }, line: { type: "none" } });
    s.addText(st[0], { x: x + 0.32, y: 3.92, w: 2.6, h: 0.7, fontFace: SANS, fontSize: 34, color: TEXT, bold: true, margin: 0 });
    s.addText(st[1], { x: x + 0.32, y: 4.62, w: 2.55, h: 0.85, fontFace: SANS, fontSize: 11.5, color: MUTED, margin: 0 });
  });
  s.addText("已验证:观众全链路与回执、同块 17 发送方、二维码真解码。未验证:真机触屏手感、现场投影可读性(仅算术对比度)——如实写进 README。", { x: M, y: 5.85, w: CW, h: 0.65, fontFace: SANS, fontSize: 12, color: "6B6485", margin: 0 });
  footer(s, 8, TOTAL);
}

/* ============ S9 · LINKS ============ */
{
  const s = slide();
  kickerTitle(s, "08 · 演示与复核", "现在就可以打开");
  const rows9 = [
    ["仓库", "github.com/NaIWaniubi/monad-battlefield"],
    ["公网演示", "https://naiwaniubi.github.io/monad-battlefield/   (整屏版 .../full.html · 静态诚实 DEMO 密度)"],
    ["合约", "0xd525ef7ee4072e80765fd61633d80322040afd9d @ Monad Testnet (chainId 10143) · 部署块 79333331"],
    ["并行物证", "https://testnet.monadscan.com/block/81474005  (17 claims · 17 distinct senders · 一条 curl 复现)"],
    ["提交入口", "mojo.devnads.com/events/18"],
  ];
  rows9.forEach((r, i) => {
    const y = 1.75 + i * 0.98;
    s.addText(r[0], { x: M, y, w: 1.9, h: 0.5, fontFace: SANS, fontSize: 16, color: PRIMARY, bold: true, margin: 0 });
    s.addText(r[1], { x: 2.6, y, w: 10.2, h: 0.5, fontFace: MONO, fontSize: 14.5, color: TEXT, margin: 0 });
    if (i < rows9.length - 1) s.addShape(p.shapes.LINE, { x: M, y: y + 0.78, w: CW, h: 0, line: { color: LINE, width: 0.75 } });
  });
  cellCluster(s, W - 2.7, H - 1.9, 5, 3, 0.26, 0.1, { hi: { 4: ACCENT, 6: PRIMARY }, base: "241E3E", baseT: 0 });
  footer(s, 9, TOTAL);
}

/* ===== 对比组通用:四列 VS 表(三冠 + 我们) ===== */
function vsTable(s, headers, rows, y0) {
  const lx = M, lw = 2.35, cw = (CW - lw - 0.3) / 4, rh = 0.86;
  headers.forEach((h, i) => {
    const x = lx + lw + 0.1 + i * cw;
    const me = i === 3;
    if (me) panel(s, x - 0.04, y0 - 0.06, cw - 0.06, rh * rows.length + 0.9, PANEL2);
    s.addText(h, { x, y: y0, w: cw - 0.12, h: 0.62, fontFace: SANS, fontSize: 13.5, color: me ? ACCENT : MUTED, bold: true, align: "center", margin: 0 });
  });
  rows.forEach((r, ri) => {
    const y = y0 + 0.68 + ri * rh;
    s.addText(r[0], { x: lx, y, w: lw, h: rh - 0.1, fontFace: SANS, fontSize: 13.5, color: PRIMARY, bold: true, margin: 0, valign: "top" });
    r.slice(1).forEach((c, ci) => {
      const x = lx + lw + 0.1 + ci * cw;
      s.addText(c, { x, y, w: cw - 0.12, h: rh - 0.1, fontFace: SANS, fontSize: 11.5, color: ci === 3 ? TEXT : MUTED, bold: ci === 3, align: "center", margin: 0, valign: "top" });
    });
  });
}

/* ============ S10 · 对比轴 A:为什么必须是 Monad ============ */
{
  const s = slide();
  kickerTitle(s, "对比 · 上海V3 三冠(一)", "换一个 EVM,他们还成立吗?", 30);
  vsTable(s, ["十一秒 · 升级安全", "半衰期 · x402 定价", "Blockwise ·  Colony 评分", "我们 · 并行负载墙"], [
    ["链绑定度", "任何 EVM 可用", "任何 EVM 可用", "任何 EVM 可用", "离开并行 EVM 即不存在"],
    ["Monad 对其意义", "一条普通链", "一条便宜快链", "一条普通链", "作品的主角本身"],
  ], 1.62);
  s.addText("「Monad 对他们是一条链;对我们,是命题本身。」", { x: M, y: 4.6, w: CW, h: 0.5, fontFace: SANS, fontSize: 21, color: ACCENT, bold: true, align: "center", margin: 0 });
  s.addText("物证:单块 #81474005 收录 17 笔 claim、来自 17 个不同 EOA —— 换任何串行执行环境,这张截图不存在。一条 curl 当场复现。", { x: M, y: 5.25, w: CW, h: 0.6, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  cellCluster(s, W - 2.4, 0.5, 6, 3, 0.22, 0.08, { hi: { 2: ACCENT, 8: PRIMARY, 13: ACCENT }, base: "241E3E", baseT: 0 });
  footer(s, 10, TOTAL);
}

/* ============ S11 · 对比轴 B:谁的 demo 是全场一起写链 ============ */
{
  const s = slide();
  kickerTitle(s, "对比 · 上海V3 三冠(二)", "演示的那 90 秒,谁在写链?", 30);
  vsTable(s, ["十一秒", "半衰期", "Blockwise", "我们"], [
    ["观众动作", "看 / 单人按预设攻击卡", "单人接钱包买一次", "围观 colony 自跑", "全场扫码同时写链"],
    ["同时上链的人", "1", "1", "0", "78 → 1500 可调"],
    ["每笔确认反馈", "—", "普通回执", "—", "同步回执 0.7–2s · 名字上墙"],
  ], 1.62);
  s.addText("投票规则是「现场观众选前三名」—— 投票的人会投给刚才碰过的东西。", { x: M, y: 5.0, w: CW, h: 0.5, fontFace: SANS, fontSize: 19, color: ACCENT, bold: true, align: "center", margin: 0 });
  s.addText("他们最好的互动是「评委点一下」;我们是「这间屋子里每个人都已经是链上的一部分」。", { x: M, y: 5.55, w: CW, h: 0.45, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  cellCluster(s, 0.55, 5.9, 16, 3, 0.2, 0.07, { hi: { 1: "67e8f9", 5: ACCENT, 9: "a78bfa", 14: "fb7185" }, base: "241E3E", baseT: 0 });
  footer(s, 11, TOTAL);
}

/* ============ S12 · 对比轴 C:平台物理,不是形容词 ============ */
{
  const s = slide();
  kickerTitle(s, "对比 · 上海V3 三冠(三)", "安全与成本:形容词 vs 测量值", 28);
  const items = [
    ["实测吞吐曲线", "0.83 tx/s/道 × 17 = 预测 14.2,实测峰值 16 —— 撞的是 Monad reserve-balance(余额<10 MON 限 1tx/3块)的物理线,数据在 docs/EVIDENCE.md", "三冠全部只报过单次成本,没人交曲线"],
    ["Revert 计费实证", "claim(9999) 越界被拒:status=0 仍按 gasLimit 照扣(Monad 特性)。直接判定「合约内冷却」设计的隐性烧钱", "对十一秒式安全成本观的降维:我们把它做成数据"],
    ["A/B 冷却对照 + 自动止付", "cooldown A/B 落块对比 docs/ab-result.json;budget --watch 保险丝到量即停", "三家都没有止付机制"],
    ["结构性安全", "claim 只追加、无余额读、重组不改结果、观众全程零私钥(代付赞助 UX 直说不装)", "与 Blockwise 单写者同层的不变式,且带并行语义"],
  ];
  items.forEach((it, i) => {
    const y = 1.55 + i * 1.32;
    panel(s, M, y, CW, 1.18, i % 2 ? PANEL : PANEL2);
    s.addText(it[0], { x: M + 0.22, y: y + 0.08, w: 2.9, h: 1.0, fontFace: SANS, fontSize: 15.5, color: PRIMARY, bold: true, margin: 0, valign: "top" });
    s.addText(it[1], { x: M + 3.25, y: y + 0.08, w: 6.9, h: 1.05, fontFace: SANS, fontSize: 12, color: TEXT, margin: 0, valign: "top" });
    s.addText(it[2], { x: M + 10.3, y: y + 0.08, w: 2.0, h: 1.05, fontFace: SANS, fontSize: 11, color: ACCENT, margin: 0, valign: "top" });
  });
  footer(s, 12, TOTAL);
}

/* ============ S13 · 我们认输的三行(可信度杠杆) ============ */
{
  const s = slide();
  kickerTitle(s, "诚实条款", "有三件事,他们确实比我们强", 28);
  const rowsB = [
    ["散场之后", "十一秒是 DAO 现在就需要装的升级安全层;我们的墙价值集中在今天这场", "所以我们把它做成可复制的到场证明引擎,而非声称日常刚需"],
    ["线上真交易", "半衰期有真实 USDC 在售、7×24 服务", "我们的『真实』全押在链上可查:373 笔落块每笔能点开"],
    ["工程展示面", "半衰期的五件套+三道CI 曾是这个系列赛场的天花板", "本赛场今天起我们同样具备:CI 四道绿 + 证据自动化 + 事件日时间线"],
  ];
  rowsB.forEach((r, i) => {
    const y = 1.62 + i * 1.34;
    s.addShape(p.shapes.RECTANGLE, { x: M, y: y + 0.04, w: 0.14, h: 1.0, fill: { color: MUTED }, line: { type: "none" } });
    s.addText(r[0], { x: M + 0.35, y, w: 2.2, h: 0.5, fontFace: SANS, fontSize: 15, color: MUTED, bold: true, margin: 0 });
    s.addText(r[1], { x: M + 0.35, y: y + 0.42, w: 7.6, h: 0.85, fontFace: SANS, fontSize: 12.5, color: TEXT, margin: 0, valign: "top" });
    s.addText(r[2], { x: 8.5, y: y + 0.05, w: 4.3, h: 1.1, fontFace: SANS, fontSize: 12, color: ACCENT, margin: 0, valign: "top" });
  });
  s.addText("认输三行,是为了让你相信前面三页的每一行数字。", { x: M, y: 5.9, w: CW, h: 0.5, fontFace: SANS, fontSize: 18, color: TEXT, bold: true, align: "center", margin: 0 });
  footer(s, 13, TOTAL);
}

/* ============ S14 · DEMO VIDEO ============ */
{
  const s = slide();
  kickerTitle(s, "现场演示 · 90 秒", "从一次点击,到一笔真交易", 30);
  const story = __dirname + "/../docs/screenshots/hero-3000.mp4";
  const fb = __dirname + "/../docs/screenshots/fallback-demo.mp4";
  const poster = __dirname + "/../docs/screenshots/final-demo.png";
  const vid = fs.existsSync(story) ? story : (fs.existsSync(fb) ? fb : null);
  if (vid) {
    s.addMedia({ type: "video", path: vid, x: M, y: 1.6, w: 9.35, h: 5.26, cover: fs.existsSync(poster) ? 'data:image/png;base64,' + fs.readFileSync(poster).toString('base64') : undefined });
  } else {
    s.addText("(视频未嵌入:构建时缺少 mp4)", { x: M, y: 3.2, w: 9, h: 0.6, fontFace: SANS, fontSize: 18, color: MUTED, align: "center", margin: 0 });
  }
  const pts = [
    ["点击 → 同步回执", "eth_sendRawTransactionSync,0.7–2s 拿 confirmed+block"],
    ["到场证明", "verify 页:输地址即列你的格子/区块/tx"],
    ["真结算", "奖池按贡献榜真实转账,hash 可查"],
    ["无钱包", "观众零私钥,服务端代付 sponsor UX"],
  ];
  pts.forEach((pt, i) => {
    const y = 1.75 + i * 1.18;
    s.addShape(p.shapes.RECTANGLE, { x: 10.05, y: y + 0.06, w: 0.12, h: 0.12, fill: { color: i === 2 ? ACCENT : PRIMARY }, line: { type: "none" } });
    s.addText(pt[0], { x: 10.28, y, w: 2.6, h: 0.34, fontFace: SANS, fontSize: 13.5, color: TEXT, bold: true, margin: 0 });
    s.addText(pt[1], { x: 10.28, y: y + 0.34, w: 2.6, h: 0.72, fontFace: SANS, fontSize: 10.5, color: MUTED, margin: 0, valign: "top" });
  });
  footer(s, 14, TOTAL);
}

/* ============ S15 · VERIFY GOLDEN ============ */
{
  const s = slide();
  kickerTitle(s, "金证据 · 到场证明", "任何人,输入地址,当场查链上归属", 28);
  const vp = __dirname + "/../docs/screenshots/verify-golden.mp4";
  if (fs.existsSync(vp)) {
    s.addMedia({ type: "video", path: vp, x: M, y: 1.55, w: 6.0, h: 4.56 });
  }
  const txs = [
    ["真结算 #1", "0xd09b90251adec25098db13339a1cc53f32246033f9bbe0c52a06c70565f7fde5"],
    ["真结算 #2", "0xd773135df013a6e9f6e2b78df2eee8a011f5ffd9d5c52890298db3cd266b5714"],
    ["真结算 #3", "0x62a11b9fae1f6c59421d1c084f060705673601ee8e6bfb5e653e4031363fa4dc"],
  ];
  s.addText("实测:362 笔 claim / 21 地址 → 紫方胜 → 3 笔真转账", { x: 6.9, y: 1.6, w: 5.9, h: 0.5, fontFace: SANS, fontSize: 14, color: ACCENT, bold: true, margin: 0 });
  txs.forEach((r, i) => {
    const y = 2.2 + i * 0.95;
    s.addText(r[0], { x: 6.9, y, w: 1.5, h: 0.4, fontFace: SANS, fontSize: 12, color: MUTED, margin: 0 });
    s.addText(r[1], { x: 8.35, y, w: 4.5, h: 0.86, fontFace: MONO, fontSize: 8.5, color: "#8BE9C0", margin: 0, breakLine: true });
  });
  s.addText("MerkleDistributor 原语:26 条测试全绿,链上部署待 gas(透明标注)", { x: 6.9, y: 5.2, w: 5.9, h: 0.5, fontFace: SANS, fontSize: 11, color: MUTED, margin: 0 });
  s.addText("合约验证领取 · 防重领 · 任何人可重算根", { x: 6.9, y: 5.6, w: 5.9, h: 0.4, fontFace: SANS, fontSize: 11, color: TEXT, margin: 0 });
  footer(s, 15, TOTAL);
}

/* ============ S10 · CLOSING ============ */
{
  const s = slide();
  cellCluster(s, 0.5, 0.5, 14, 3, 0.24, 0.09, { hi: { 3: ACCENT, 11: PRIMARY, 19: ACCENT }, base: "241E3E", baseT: 0 });
  s.addText([
    { text: "我们没写一行并行代码。", options: { breakLine: true } },
    { text: "只是把状态切成 2,500 个互不相干的格子。", options: {} },
  ], { x: M, y: 1.85, w: 12.33, h: 1.9, fontFace: SANS, fontSize: 38, color: TEXT, bold: true, align: "center", margin: 0, paraSpaceAfter: 6 });
  s.addText("现场大屏挂着二维码——扫它,点一格:声音和颜色,都是你亲手写进 Monad 的。", { x: M, y: 4.0, w: CW, h: 0.5, fontFace: SANS, fontSize: 19, color: ACCENT, align: "center", margin: 0 });
  s.addText("真落块 373 笔 · 同块 17 EOA · 实测峰值 16 tx/s —— 全部链上可查", { x: M, y: 4.62, w: CW, h: 0.4, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  s.addText("MONAD BATTLEFIELD · 谢谢", { x: M, y: 5.6, w: CW, h: 0.5, fontFace: SANS, fontSize: 16, color: PRIMARY, bold: true, align: "center", charSpacing: 3, margin: 0 });
  footer(s, 16, TOTAL);
}

p.writeFile({ fileName: __dirname + "/monad-battlefield.pptx" }).then(() => console.log("DECK WRITTEN"));
