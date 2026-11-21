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
// ---- brand ----
const CN_NAME = "落格";
const EN_NAME = "Alight";
const TEAM_NAME = "落格实验室 Alight Labs";
const TAGLINE_CN = "无钱包、无 gas,点一格落一笔真交易 —— 屏幕上每一次变色,都是一笔可查的链上交易";

// ---- helpers ----
function slide(n) {
  const s = p.addSlide();
  s.background = { color: BG };
  // left edge accent rail
  s.addShape(p.shapes.RECTANGLE, { x: 0, y: 0, w: 0.055, h: H, fill: { color: PRIMARY, transparency: 72 }, line: { type: "none" } });
  // faint top hairline
  s.addShape(p.shapes.RECTANGLE, { x: 0, y: 0, w: W, h: 0.012, fill: { color: PRIMARY, transparency: 84 }, line: { type: "none" } });
  return s;
}
function footer(s, i, total) {
  s.addShape(p.shapes.RECTANGLE, { x: M, y: H - 0.52, w: CW, h: 0.008, fill: { color: LINE, transparency: 25 }, line: { type: "none" } });
  s.addText("MONAD BATTLEFIELD", { x: M, y: H - 0.42, w: 2.4, h: 0.28, fontFace: SANS, fontSize: 10, color: "6B6485", bold: true, charSpacing: 2.5, margin: 0 });
  s.addText("2026-11-21 · 广州 Monad Blitz", { x: M + 2.45, y: H - 0.42, w: 4.2, h: 0.28, fontFace: SANS, fontSize: 10, color: "4E4762", margin: 0 });
  s.addText(String(i).padStart(2, "0"), { x: W - 1.62, y: H - 0.46, w: 0.55, h: 0.34, fontFace: SANS, fontSize: 13, color: PRIMARY, bold: true, align: "right", margin: 0 });
  s.addText(" / " + total, { x: W - 1.05, y: H - 0.42, w: 0.6, h: 0.28, fontFace: SANS, fontSize: 10, color: "4E4762", margin: 0 });
}
function kickerTitle(s, kicker, title, titleSize) {
  // kicker pill
  const kw = Math.min(7.4, 0.34 + kicker.length * 0.175);
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: M, y: 0.4, w: kw, h: 0.34, fill: { color: PANEL2, transparency: 12 }, line: { color: "4A3F73", width: 0.6 }, rectRadius: 0.16 });
  s.addText(kicker, { x: M + 0.14, y: 0.4, w: kw - 0.2, h: 0.34, fontFace: SANS, fontSize: 10, color: "C4B5FD", bold: true, charSpacing: 1.2, margin: 0, valign: "middle" });
  // title + accent underline
  s.addText(title, { x: M, y: 0.82, w: 11.4, h: 0.72, fontFace: SANS, fontSize: titleSize || 30, color: TEXT, bold: true, margin: 0 });
  s.addShape(p.shapes.RECTANGLE, { x: M, y: 1.5, w: 1.15, h: 0.045, fill: { color: ACCENT }, line: { type: "none" } });
}
// signature motif: cluster of "cells" (one cell = one storage slot)
function cellCluster(s, x, y, cols, rows, cell, gap, opt) {
  opt = opt || {};
  const step = cell + gap;
  const hi = opt.hi || {};
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
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: color || PANEL }, line: { color: LINE, width: 0.6 }, rectRadius: 0.08 });
}
const TOTAL = 19;

/* ============ S1 · COVER ============ */
{
  const s = slide();
  // right-half cell field
  cellCluster(s, 7.15, 0.9, 14, 14, 0.32, 0.11, {
    base: "241E3E", baseT: 0,
    hi: { 5: PRIMARY, 18: ACCENT, 33: PRIMARY, 47: PDIM, 60: ACCENT, 74: PRIMARY, 91: PRIMARY, 108: ACCENT, 122: PRIMARY, 140: ACCENT, 15: PDIM, 96: PDIM }, hiT: 8,
  });
  s.addShape(p.shapes.RECTANGLE, { x: 6.4, y: 0, w: 1.6, h: H, fill: { color: BG, transparency: 45 }, line: { type: "none" } });
  // top: event line
  s.addText("GUANGZHOU MONAD BLITZ · 黑客松路演 · 2026-11-21", { x: M, y: 0.78, w: 7.6, h: 0.3, fontFace: SANS, fontSize: 12.5, color: PRIMARY, charSpacing: 2, bold: true, margin: 0 });
  // team chip
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: M, y: 1.16, w: 3.55, h: 0.36, fill: { color: PANEL2 }, line: { color: "4A3F73", width: 0.6 }, rectRadius: 0.18 });
  s.addText("TEAM · " + TEAM_NAME, { x: M + 0.16, y: 1.16, w: 3.3, h: 0.36, fontFace: SANS, fontSize: 10.5, color: "C4B5FD", bold: true, charSpacing: 1.2, margin: 0, valign: "middle" });
  // names
  s.addText(CN_NAME, { x: M, y: 1.62, w: 7.0, h: 1.0, fontFace: SANS, fontSize: 58, color: TEXT, bold: true, margin: 0 });
  s.addText(EN_NAME, { x: M, y: 2.6, w: 7.0, h: 0.62, fontFace: SANS, fontSize: 27, color: PRIMARY, bold: true, charSpacing: 1.5, margin: 0 });
  s.addText("MONAD BATTLEFIELD · 产品代号", { x: M + 3.1, y: 2.78, w: 3.6, h: 0.32, fontFace: SANS, fontSize: 11, color: "6B6485", margin: 0 });
  // tagline
  s.addText(TAGLINE_CN, { x: M, y: 3.5, w: 6.7, h: 0.9, fontFace: SANS, fontSize: 21, color: TEXT, bold: true, margin: 0 });
  // three support chips
  const chips = [["2500 格", "独立 slot · 写集零重叠"], ["17 笔/块", "17 个不同 EOA 同块"], ["0.8s / 16 tx/s", "同步回执 P50 · 17 道峰值"]];
  chips.forEach((c, i) => {
    const x = M + i * 2.28;
    s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y: 4.62, w: 2.14, h: 0.86, fill: { color: PANEL, transparency: 8 }, line: { color: LINE, width: 0.6 }, rectRadius: 0.08 });
    s.addText(c[0], { x: x + 0.14, y: 4.68, w: 1.86, h: 0.38, fontFace: SANS, fontSize: 17, color: ACCENT, bold: true, margin: 0 });
    s.addText(c[1], { x: x + 0.14, y: 5.04, w: 1.9, h: 0.38, fontFace: SANS, fontSize: 9.5, color: MUTED, margin: 0 });
  });

  s.addText("github.com/NaIWaniubi/monad-battlefield  ·  monabattlefield.pages.dev", { x: M, y: 5.86, w: 8.5, h: 0.3, fontFace: MONO, fontSize: 11, color: MUTED, margin: 0 });
  const qrP = __dirname + "/qr-join.png";
  if (fs.existsSync(qrP)) {
    s.addImage({ path: qrP, x: W - 2.35, y: H - 3.05, w: 1.75, h: 1.75 });
    s.addText("扫码体验(演示版)", { x: W - 2.5, y: H - 1.08, w: 2.05, h: 0.3, fontFace: SANS, fontSize: 10, color: MUTED, align: "center", margin: 0 });
  }
  footer(s, 1, TOTAL);
}

/* ============ S1B · 痛点与需求 ============ */
{
  const s = slide();
  kickerTitle(s, "01 · 痛点与需求", "现场互动最贵的三个坑,我们逐条填掉", 29);
  const rows = [
    ["假互动", "观众只能看大屏;想动手先装钱包、抄助记词、备 gas —— 多半人当场放弃。", "点一格即发真交易:无钱包、无 gas,0.8 秒回执上屏。"],
    ["成本与延迟", "被拒的点击也照扣 gas(Monad 按 gasLimit 计费),单笔 0.0066 MON;等确认那几秒,现场就冷了。", "服务端代发 + 每格独立 slot:同块落链不等确认,0.8 秒回执。"],
    ["缺物证", "人人都在报 TPS,没人能指出某个块里有多少个不同发送方同时在写。", "块 #81474005:17 笔来自 17 个 EOA,一条 curl 可查。"],
  ];
  const y0 = 1.78, rh = 1.42;
  s.addText("痛点", { x: M, y: 1.52, w: 1.5, h: 0.3, fontFace: SANS, fontSize: 11, color: MUTED, bold: true, charSpacing: 2, margin: 0 });
  s.addText("现状与证据", { x: M + 1.72, y: 1.52, w: 5.4, h: 0.3, fontFace: SANS, fontSize: 11, color: MUTED, bold: true, charSpacing: 2, margin: 0 });
  s.addText("我们的解法", { x: M + 7.5, y: 1.52, w: 4.6, h: 0.3, fontFace: SANS, fontSize: 11, color: ACCENT, bold: true, charSpacing: 2, margin: 0 });
  rows.forEach((r, i) => {
    const y = y0 + i * rh;
    panel(s, M, y, CW, rh - 0.16, i % 2 ? PANEL : PANEL2);
    s.addShape(p.shapes.RECTANGLE, { x: M, y: y + 0.1, w: 0.06, h: rh - 0.36, fill: { color: i === 1 ? "FB7185" : PRIMARY }, line: { type: "none" } });
    s.addText(r[0], { x: M + 0.24, y: y + 0.12, w: 1.42, h: 0.9, fontFace: SANS, fontSize: 15, color: TEXT, bold: true, margin: 0, valign: "middle" });
    s.addText(r[1], { x: M + 1.72, y: y + 0.12, w: 5.55, h: rh - 0.4, fontFace: SANS, fontSize: 11.5, color: MUTED, margin: 0, valign: "middle" });
    s.addText(r[2], { x: M + 7.5, y: y + 0.12, w: 4.55, h: rh - 0.4, fontFace: SANS, fontSize: 11.5, color: TEXT, bold: true, margin: 0, valign: "middle" });
  });
  s.addText("需求侧:主办方 / 品牌方 / 课堂要的不是 H5 动画,而是『当场可查』的到场证明 —— 我们把每一次点击都做成可验证的链上凭证。", { x: M, y: 6.28, w: CW, h: 0.5, fontFace: SANS, fontSize: 12.5, color: ACCENT, bold: true, margin: 0 });
  footer(s, 2, TOTAL);
}

/* ============ S2 · PROBLEM + KILLER LINE ============ */
{
  const s = slide();
  kickerTitle(s, "01 · 问题", "如何让不带钱包的观众,每人亲手为并行出一笔交易?", 26);
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
  footer(s, 3, TOTAL);
}

/* ============ S2B · DEMO VIDEO (early) ============ */
{
  const s = slide();
  kickerTitle(s, "现场演示 · 循环动图", "从一次点击,到一笔真交易", 30);
  const gifA = __dirname + "/../docs/screenshots/demo-loop.gif";
  if (fs.existsSync(gifA)) {
    s.addImage({ path: gifA, x: M, y: 1.6, w: 9.35, h: 5.26 });
  }
  const pts2 = [
    ["3000 模拟观众", "顶栏 DEMO 标注,合成密度"],
    ["真·链上部分", "373 落块 / 17 EOA 同块"],
    ["你也能查", "verify 页输地址即出"],
  ];
  pts2.forEach((t2, i) => {
    const y = 2.0 + i * 1.35;
    s.addShape(p.shapes.RECTANGLE, { x: 10.05, y: y + 0.06, w: 0.12, h: 0.12, fill: { color: i === 1 ? ACCENT : PRIMARY }, line: { type: "none" } });
    s.addText(t2[0], { x: 10.28, y, w: 2.7, h: 0.34, fontFace: SANS, fontSize: 13, color: TEXT, bold: true, margin: 0 });
    s.addText(t2[1], { x: 10.28, y: y + 0.32, w: 2.7, h: 0.7, fontFace: SANS, fontSize: 10.5, color: MUTED, margin: 0, valign: "top" });
  });
  footer(s, 4, TOTAL);
}

/* ============ S2C · 界面画廊(多图,等比) ============ */
{
  const s = slide();
  kickerTitle(s, "产品实拍 · 四个界面", "大屏、手机、裁判台、验证页 —— 全是真页面", 28);
  // PNG 尺寸探针(IHDR),保证等比放置不拉伸
  const pngSize = (fp) => { const b = fs.readFileSync(fp); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  const shots = [
    ["大屏主视图", "2500 格 · 实时 TPS · 四阵营领土", "final2-demo.png"],
    ["手机参战页", "无钱包 · 无 gas · 点一下即发交易", "final-join-tapped.png"],
    ["裁判台 Director", "阵营配比 / 起停 / 预算熔断", "final-director.png"],
    ["到场证明 Verify", "输地址 → 命中格子 / 区块 / tx", "final-verify.png"],
  ];
  const cw = 6.0, ch = 2.42, gx = 0.33, gy = 0.18, capH = 0.34;
  shots.forEach((sh, i) => {
    const col = i % 2, row = (i / 2) | 0;
    const x = M + col * (cw + gx), y = 1.66 + row * (ch + gy);
    panel(s, x, y, cw, ch, "120E1F");
    const fp = __dirname + "/../docs/screenshots/" + sh[2];
    if (fs.existsSync(fp)) {
      const d = pngSize(fp);
      const bw = cw - 0.2, bh = ch - capH - 0.24;
      const k = Math.min(bw / d.w, bh / d.h);
      const iw = d.w * k, ih = d.h * k;
      s.addImage({ path: fp, x: x + (cw - iw) / 2, y: y + 0.1 + (bh - ih) / 2, w: iw, h: ih });
    }
    s.addText(sh[0] + "  ·  " + sh[1], { x: x + 0.16, y: y + ch - capH - 0.02, w: cw - 0.32, h: capH, fontFace: SANS, fontSize: 10.5, color: "C4B5FD", bold: true, margin: 0, valign: "middle" });
  });
  footer(s, 5, TOTAL);
}

/* ============ S3 · WHY MONAD(能力 + 致谢) ============ */
{
  const s = slide();
  kickerTitle(s, "02 · 为什么是 Monad(也是感谢)", "没有这几件事,这个作品在架构上就不成立", 28);
  rowItem(s, M, 1.72, 6.05,
    "① 并行执行:同块容纳多个独立发送方",
    "我们量到的物证:块 #81474005 内 17 笔 claim 来自 17 个不同 EOA。乐观并行执行 + 零重叠写集 ⇒ 互不重执行。");
  rowItem(s, M, 2.92, 6.05,
    "② 亚秒出块 + 同步回执",
    "抽样 20 块 ≈ 0.30 s/块;eth_sendRawTransactionSync 让手机 P50 0.8s 直接拿到 confirmed + blockNumber,现场不用「等确认」。");
  rowItem(s, M, 4.12, 6.05,
    "③ 低费用且计费可预测",
    "按 gasLimit 计费、价格稳定在 ~102 gwei:每笔 60,000 gas = 0.0066 MON,373 笔真落块总成本 ≈ 2.5 MON —— 一场活动跑得起。");
  rowItem(s, M, 5.32, 6.05,
    "④ 平台规则也是可测的物理量",
    "储备余额 <10 MON 限 1 tx/3 块,被我们量成 0.83 tx/s/道;17 道预测 14.2、实测峰值 16 —— 撞的是余额规则,不是链的天花板。", ACCENT);
  panel(s, 7.0, 1.72, 5.83, 3.55, "120E1F");
  s.addText("Monad 给这个作品的三件礼物", { x: 7.25, y: 1.9, w: 5.3, h: 0.32, fontFace: SANS, fontSize: 13, color: ACCENT, bold: true, margin: 0 });
  const gifts = [
    ["并行 EVM", "状态只要彼此独立,吞吐就随发送方数量扩展 —— 所以我们才敢让全场同时点。"],
    ["亚秒确认", "点击到上屏小于一个块的等待,现场节奏才是「即时」的,而不是「稍后」。"],
    ["便宜且可预测", "0.0066 MON/笔 让我们能用真钱跑 373 笔实盘,而不是只跑演示。"],
  ];
  gifts.forEach((g, i) => {
    const y = 2.3 + i * 0.95;
    s.addShape(p.shapes.RECTANGLE, { x: 7.25, y: y + 0.06, w: 0.1, h: 0.1, fill: { color: i === 1 ? ACCENT : PRIMARY }, line: { type: "none" } });
    s.addText(g[0], { x: 7.48, y, w: 5.1, h: 0.3, fontFace: SANS, fontSize: 12.5, color: TEXT, bold: true, margin: 0 });
    s.addText(g[1], { x: 7.48, y: y + 0.3, w: 5.1, h: 0.55, fontFace: SANS, fontSize: 10.5, color: MUTED, margin: 0 });
  });
  panel(s, 7.0, 5.42, 5.83, 1.3, "1F1936");
  s.addText("说句实话", { x: 7.25, y: 5.52, w: 5.3, h: 0.3, fontFace: SANS, fontSize: 12, color: ACCENT, bold: true, margin: 0 });
  s.addText("我们没跑到 Monad 的极限 —— 先撞到的是自己的余额与车道数。这恰恰说明:链还有余量,瓶颈在我们这边。", { x: 7.25, y: 5.84, w: 5.3, h: 0.8, fontFace: SANS, fontSize: 11, color: TEXT, margin: 0 });
  s.addText("谢谢 Monad Blitz 广州 —— 给了我们一天时间,和一个真的能把并行跑给你看的平台。", { x: M, y: 6.62, w: CW, h: 0.34, fontFace: SANS, fontSize: 13, color: "C4B5FD", bold: true, align: "center", margin: 0 });
  footer(s, 6, TOTAL);
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
  s.addText("观众扫码:无钱包、无 gas、不装任何东西;点击 → 服务端代签 → ~1s 块落链(同步回执 0.7–2s)→ 大屏变色 + 响一个音(四阵营 = 四声部)。", { x: dx, y: imgY + dh + 0.15, w: dw, h: 1.95, fontFace: SANS, fontSize: 12, color: MUTED, margin: 0 });
  s.addText([
    { text: "如实区分:", options: { bold: true, color: ACCENT } },
    { text: " 本图满屏密度为合成层(顶栏已标 DEMO);真实点击、同块 17 方、revert 计费才是链上实证(见 P6)。", options: { color: MUTED } },
  ], { x: M, y: 6.52, w: CW, h: 0.4, fontFace: SANS, fontSize: 12.5, margin: 0 });
  footer(s, 7, TOTAL);
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
  footer(s, 8, TOTAL);
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
  footer(s, 9, TOTAL);
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
    ["333", "条单元测试 / 20 文件(vitest 全绿)"],
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
  footer(s, 10, TOTAL);
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
  footer(s, 11, TOTAL);
}

/* ============ S9B · 性能剖面:9 个实测量 ============ */
{
  const s = slide();
  kickerTitle(s, "性能剖面 · 实测数据", "九个数字,每一个都能当场复现", 30);
  const rows = [
    ["单格 claim gas", "60,000", "二分实测:50k → 0/3 落块,60k → 3/3 落块"],
    ["单笔成本", "0.0066 MON", "60,000 gas × 110 gwei(docs/COST.md)"],
    ["单道吞吐", "0.83 tx/s", "reserve<10 MON ⇒ 平台限 1 tx/3 块(实测)"],
    ["17 道峰值", "16 tx/s", "预测 0.83×17≈14.2 → 实测 16(swarm-live.log)"],
    ["同块并行", "17 独立 EOA", "块 #81474005,一条 curl 复现"],
    ["真落块总量", "373 笔", "蜂群 362 + 冒烟 1 + 观众同步 10"],
    ["观众同步回执", "P50 0.8s", "eth_sendRawTransactionSync(0.7–2s)"],
    ["合约体量", "676 B runtime", "2500 slots · 38 行 · 单一 revert 分支"],
    ["测试与门禁", "333 条 / 20 文件", "vitest 全绿 + CI 四道"],
  ];
  const y0 = 1.66, rh = 0.42, lx = M, wLab = 3.0, wVal = 2.7, wHow = CW - wLab - wVal - 0.3;
  s.addShape(p.shapes.RECTANGLE, { x: lx, y: y0 - 0.06, w: CW, h: 0.4, fill: { color: PANEL2 }, line: { type: "none" } });
  s.addText("指标", { x: lx + 0.1, y: y0 - 0.06, w: wLab, h: 0.4, fontFace: SANS, fontSize: 12, color: TEXT, bold: true, margin: 0, valign: "middle" });
  s.addText("实测值", { x: lx + wLab + 0.1, y: y0 - 0.06, w: wVal, h: 0.4, fontFace: SANS, fontSize: 12, color: TEXT, bold: true, align: "center", margin: 0, valign: "middle" });
  s.addText("测法与复现路径", { x: lx + wLab + wVal + 0.2, y: y0 - 0.06, w: wHow, h: 0.4, fontFace: SANS, fontSize: 12, color: TEXT, bold: true, margin: 0, valign: "middle" });
  rows.forEach((r, i) => {
    const y = y0 + 0.4 + i * rh;
    s.addText(r[0], { x: lx + 0.1, y, w: wLab, h: rh, fontFace: SANS, fontSize: 12, color: PRIMARY, bold: true, margin: 0, valign: "middle" });
    s.addText(r[1], { x: lx + wLab + 0.1, y, w: wVal, h: rh, fontFace: SANS, fontSize: 12.5, color: ACCENT, bold: true, align: "center", margin: 0, valign: "middle" });
    s.addText(r[2], { x: lx + wLab + wVal + 0.2, y, w: wHow, h: rh, fontFace: MONO, fontSize: 10, color: MUTED, margin: 0, valign: "middle" });
    s.addShape(p.shapes.LINE, { x: lx, y: y + rh - 0.02, w: CW, h: 0, line: { color: LINE, width: 0.5 } });
  });
  panel(s, M, 5.92, CW, 0.95, PANEL2);
  s.addText("平台背景(刚采样):20 块跨度 6 秒 ≈ 0.30 s/块;gasPrice 102 gwei;抽样 5 块共 14 笔。", { x: M + 0.2, y: 5.98, w: CW - 0.4, h: 0.32, fontFace: SANS, fontSize: 11, color: MUTED, margin: 0 });
  s.addText("我们一个活动打出的 16 tx/s ≈ 当时全网自然流量(约 2 tx/s 量级)的 7 倍 —— 不是压测脚本,是 2500 个格子被真人点击。", { x: M + 0.2, y: 6.33, w: CW - 0.4, h: 0.42, fontFace: SANS, fontSize: 12, color: ACCENT, bold: true, margin: 0 });
  footer(s, 12, TOTAL);
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
  kickerTitle(s, "维度① 链绑定 · 上海V3 冠亚季", "换一个 EVM,他们还成立吗?", 30);
  vsTable(s, ["第1名 十一秒·升级安全", "第2名 半衰期·x402", "第3名 Blockwise", "我们·并行负载墙"], [
    ["链绑定度", "任何 EVM 可用", "任何 EVM 可用", "任何 EVM 可用", "离开并行 EVM 即不存在"],
    ["Monad 对其意义", "一条普通链", "一条便宜快链", "一条普通链", "作品的主角本身"],
    ["换链后的命运", "装上即可用(与并行无关)", "可搬到任何有 USDC 的链", "agent 群落随便搬", "整个作品不成立"],
  ], 1.62);
  s.addText("「Monad 对他们是一条链;对我们,是命题本身。」", { x: M, y: 4.6, w: CW, h: 0.5, fontFace: SANS, fontSize: 21, color: ACCENT, bold: true, align: "center", margin: 0 });
  s.addText("物证:单块 #81474005 收录 17 笔 claim、来自 17 个不同 EOA —— 换任何串行执行环境,这张截图不存在。一条 curl 当场复现。", { x: M, y: 5.25, w: CW, h: 0.6, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  cellCluster(s, W - 2.4, 0.5, 6, 3, 0.22, 0.08, { hi: { 2: ACCENT, 8: PRIMARY, 13: ACCENT }, base: "241E3E", baseT: 0 });
  footer(s, 13, TOTAL);
}

/* ============ S11 · 对比轴 B:谁的 demo 是全场一起写链 ============ */
{
  const s = slide();
  kickerTitle(s, "维度② 参与密度 · 上海V3 冠亚季", "演示的那 90 秒,谁在写链?", 30);
  vsTable(s, ["第1名 十一秒", "第2名 半衰期", "第3名 Blockwise", "我们"], [
    ["观众动作", "看 / 单人按预设攻击卡", "单人接钱包买一次", "围观 colony 自跑", "全场扫码同时写链"],
    ["同时上链的人", "1", "1", "0", "不限 · 10–20000 可调"],
    ["每笔确认反馈", "—", "普通回执", "—", "同步回执 0.7–2s · 名字上墙"],
  ], 1.62);
  s.addText("投票规则是「现场观众选前三名」—— 投票的人会投给刚才碰过的东西。", { x: M, y: 5.0, w: CW, h: 0.5, fontFace: SANS, fontSize: 19, color: ACCENT, bold: true, align: "center", margin: 0 });
  s.addText("他们最好的互动是「评委点一下」;我们是「这间屋子里每个人都已经是链上的一部分」。", { x: M, y: 5.5, w: CW, h: 0.45, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  cellCluster(s, 0.55, 6.05, 16, 3, 0.2, 0.07, { hi: { 1: "67e8f9", 5: ACCENT, 9: "a78bfa", 14: "fb7185" }, base: "241E3E", baseT: 0 });
  footer(s, 14, TOTAL);
}

/* ============ S12 · 对比轴 C:平台物理,不是形容词 ============ */
{
  const s = slide();
  kickerTitle(s, "维度③ 安全与成本 · 上海V3 冠亚季", "安全与成本:形容词 vs 测量值", 28);
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
  footer(s, 15, TOTAL);
}

/* ============ S13B · 独占能力矩阵(五条硬指标,三家公开材料都没有) ============ */
{
  const s = slide();
  kickerTitle(s, "维度④ 独占能力 · 上海V3 冠亚季", "这五条,第1/2/3 名的公开材料里都找不到", 28);
  const heads = ["第1名 十一秒", "第2名 半衰期", "第3名 Blockwise", "我们 · 本届"];
  const lx = M, lw = 2.55, cw = (CW - lw - 0.2) / 4, rh = 0.62, y0 = 1.62;
  heads.forEach((h, i) => {
    const x = lx + lw + 0.1 + i * cw;
    const me = i === 3;
    if (me) panel(s, x - 0.05, y0 - 0.07, cw - 0.05, rh * 5 + 0.68, PANEL2);
    s.addText(h, { x, y: y0, w: cw - 0.12, h: 0.45, fontFace: SANS, fontSize: 12.5, color: me ? ACCENT : MUTED, bold: true, align: "center", margin: 0 });
  });
  const mRows = [
    ["同块多发送方物证", "—", "—", "—", "✓ 17 EOA / 1 块 · #81474005"],
    ["平台物理曲线(预测→实测)", "—", "—", "—", "✓ 0.83×17≈14.2 → 实测 16"],
    ["Revert 照扣实证", "—", "—", "—", "✓ status=0 照扣"],
    ["自动止付 / 预算保险丝", "—", "—", "—", "✓ budget --watch 到量即停"],
    ["到场证明当场可验", "—", "—", "—", "✓ /verify 纯前端扫块"],
  ];
  mRows.forEach((r, ri) => {
    const y = y0 + 0.5 + ri * rh;
    s.addText(r[0], { x: lx, y, w: lw, h: rh - 0.08, fontFace: SANS, fontSize: 13, color: PRIMARY, bold: true, margin: 0, valign: "middle" });
    r.slice(1).forEach((c, ci) => {
      const x = lx + lw + 0.1 + ci * cw;
      const me = ci === 3;
      s.addText(c, { x, y, w: cw - 0.12, h: rh - 0.08, fontFace: SANS, fontSize: me ? 11.5 : 13, color: me ? TEXT : "5B5473", bold: me, align: "center", margin: 0, valign: "middle" });
    });
    if (ri < mRows.length - 1) s.addShape(p.shapes.LINE, { x: lx, y: y + rh - 0.06, w: CW, h: 0, line: { color: LINE, width: 0.75 } });
  });
  s.addText("他们各有一块最硬的:安全产品(十一秒)· 真实支付(半衰期)· 单写者不变式(Blockwise)。", { x: M, y: 5.42, w: CW, h: 0.42, fontFace: SANS, fontSize: 15, color: MUTED, align: "center", margin: 0 });
  s.addText("这五条 + 那三块能拼在同一张桌上的,只有我们。", { x: M, y: 5.86, w: CW, h: 0.45, fontFace: SANS, fontSize: 20, color: ACCENT, bold: true, align: "center", margin: 0 });
  s.addText("— = 其公开仓库/材料未见,不以「未见」断言其不存在。数据:docs/BENCH-EVENT17.md + EVIDENCE.md", { x: M, y: 6.42, w: CW, h: 0.35, fontFace: SANS, fontSize: 10.5, color: "6B6485", align: "center", margin: 0 });
  footer(s, 16, TOTAL);
}

/* ============ S14 · DEMO VIDEO ============ */
{
  const s = slide();
  kickerTitle(s, "现场演示 · 循环动图", "从一次点击,到一笔真交易", 30);
  const gifB = __dirname + "/../docs/screenshots/demo-loop.gif";
  if (fs.existsSync(gifB)) {
    s.addImage({ path: gifB, x: M, y: 1.6, w: 9.35, h: 5.26 });
  } else {
    s.addText("(动图未嵌入:构建时缺少 demo-loop.gif)", { x: M, y: 3.2, w: 9, h: 0.6, fontFace: SANS, fontSize: 18, color: MUTED, align: "center", margin: 0 });
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
  footer(s, 17, TOTAL);
}

/* ============ S15 · VERIFY GOLDEN ============ */
{
  const s = slide();
  kickerTitle(s, "金证据 · 到场证明", "任何人,输入地址,当场查链上归属", 28);
  const vp = __dirname + "/../docs/screenshots/verify-loop.gif";
  if (fs.existsSync(vp)) {
    s.addImage({ path: vp, x: M, y: 1.55, w: 5.0, h: 4.5 });
    s.addText("循环动图 · 输入地址 → 命中 3 笔", { x: M, y: 6.1, w: 5.0, h: 0.32, fontFace: SANS, fontSize: 11, color: "6B6485", margin: 0 });
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
  footer(s, 18, TOTAL);
}

/* ============ S10 · CLOSING ============ */
{
  const s = slide();
  cellCluster(s, 0.5, 0.5, 14, 3, 0.24, 0.09, { hi: { 3: ACCENT, 11: PRIMARY, 19: ACCENT }, base: "241E3E", baseT: 0 });
  s.addText([
    { text: "我们没写一行并行代码。", options: { breakLine: true } },
    { text: "只是把状态切成 2,500 个互不相干的格子。", options: {} },
  ], { x: M, y: 1.85, w: 12.33, h: 1.9, fontFace: SANS, fontSize: 38, color: TEXT, bold: true, align: "center", margin: 0, paraSpaceAfter: 6 });
  s.addText("散场可以扫码点一格:那一声、那一格颜色,是你亲手写进 Monad 的。", { x: M, y: 4.0, w: CW, h: 0.5, fontFace: SANS, fontSize: 19, color: ACCENT, align: "center", margin: 0 });
  s.addText("真落块 373 笔 · 同块 17 EOA · 实测峰值 16 tx/s —— 全部链上可查", { x: M, y: 4.62, w: CW, h: 0.4, fontFace: SANS, fontSize: 13.5, color: MUTED, align: "center", margin: 0 });
  s.addText("落格 ALIGHT · 谢谢 Monad Blitz 广州", { x: M, y: 5.42, w: CW, h: 0.5, fontFace: SANS, fontSize: 16, color: PRIMARY, bold: true, align: "center", charSpacing: 2, margin: 0 });
  s.addText("并行不是我们发明的,是 Monad 给的前提 —— 我们只是把它变成了一场看得见的活动。", { x: M, y: 5.95, w: CW, h: 0.4, fontFace: SANS, fontSize: 12.5, color: "C4B5FD", align: "center", margin: 0 });
  footer(s, 19, TOTAL);
}

p.writeFile({ fileName: __dirname + "/monad-battlefield.pptx" }).then(() => console.log("DECK WRITTEN"));
