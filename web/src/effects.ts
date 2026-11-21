/**
 * MONAD BATTLEFIELD · 视觉特效原语（W1）
 *
 * 设计原则：
 *  1. 所有「随机」只在构建期（构造 / resize）发生，运行期绝不调用 Math.random。
 *  2. 所有辉光都用预渲染的径向渐变精灵，不用 shadowBlur（Chromium 上极慢）。
 *  3. 冲击波用定长 SoA（Float32Array / Int32Array / Uint8Array）环形槽，热路径零对象分配。
 *  4. 星尘预渲染成一张可无缝平铺的离屏贴图，运行期只做 translate + pattern fill。
 *
 * 这个文件不碰 GridState / GridRenderer 的接口，只提供「造贴图」和「画特效」的原语。
 */

export type Rgb = { r: number; g: number; b: number };

/** roundRectPath 只要求这几个方法：CanvasRenderingContext2D 和 Path2D 都满足 */
export type PathSink = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  closePath(): void;
};

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const TAU = Math.PI * 2;

/* ───────────────────────────── 构建期工具 ───────────────────────────── */

/** 确定性 PRNG（只在构建期用，保证每次 resize 出来的纹理一致） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim();
  if (h.charCodeAt(0) === 35) h = h.slice(1);
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export function rgbaFromRgb(c: Rgb, alpha: number): string {
  return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
}

/**
 * V-bloom「配色更电」：在渲染层把 rgb 推亮 k 倍（默认 ×1.08，钳到 255）。
 * FACTIONS 常量本身不动 —— 观众页 / 导演台与大屏共用原始色值，只有画布上提亮。
 */
export function boostRgb(c: Rgb, k = 1.08): Rgb {
  const r = c.r * k;
  const g = c.g * k;
  const b = c.b * k;
  return {
    r: r > 255 ? 255 : Math.round(r),
    g: g > 255 ? 255 : Math.round(g),
    b: b > 255 ? 255 : Math.round(b),
  };
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

export function ctx2d(cv: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = cv.getContext("2d");
  if (!c) throw new Error("无法获取离屏 2d context");
  return c;
}

/** 圆角矩形路径（不依赖 ctx.roundRect，老浏览器也能跑） */
export function roundRectPath(
  ctx: PathSink,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * 创建 pattern，并把「贴图像素 → CSS 用户单位」校正到 1:1。
 * 贴图按 dpr 分辨率绘制，pattern 的空间却按用户单位算，所以必须除以 dpr。
 */
export function makePattern(
  ctx: CanvasRenderingContext2D,
  tile: HTMLCanvasElement,
  dpr: number,
): CanvasPattern | null {
  const p = ctx.createPattern(tile, "repeat");
  if (!p) return null;
  const inv = 1 / Math.max(0.5, dpr);
  if (typeof p.setTransform === "function" && typeof DOMMatrix !== "undefined") {
    p.setTransform(new DOMMatrix([inv, 0, 0, inv, 0, 0]));
  }
  return p;
}

/* ───────────────────────────── 精灵生成（构建期） ───────────────────────────── */

/**
 * 已占领格子的精灵：圆角主体 + 体积渐变 + 1px 内发光 + 顶光。
 * 所有尺寸都是「设备像素」，由调用方按 dpr 换算。
 * brightness 0..1 —— 由 heat 分档，档位贴图在 resize 时一次性生成。
 */
export function createCellSprite(
  hex: string,
  sizePx: number,
  radiusPx: number,
  rimPx: number,
  brightness: number,
): HTMLCanvasElement {
  const size = Math.max(4, Math.round(sizePx));
  const cv = makeCanvas(size, size);
  const c = ctx2d(cv);

  const base = hexToRgb(hex);
  const hi = mixRgb(base, WHITE, 0.58);
  const lo = mixRgb(base, BLACK, 0.44);
  const b = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;
  // V-bloom：主体改「半透膜」。实心方块感来自 bodyA 0.13→0.87 的纯填充，
  // 亮度职责现在交给加色光晕贴图（createHaloSprite）里的亮核，膜只留轮廓与体积。
  const bodyA = 0.08 + 0.3 * b;

  const radius = Math.max(0.5, Math.min(radiusPx, size * 0.45));
  const pad = Math.max(0.5, rimPx * 0.5);
  const x = pad;
  const y = pad;
  const w = Math.max(1, size - pad * 2);
  const h = w;

  // 主体：左上亮、右下暗，像一块有厚度的玻璃
  const g = c.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, rgbaFromRgb(hi, bodyA * 0.96));
  g.addColorStop(0.42, rgbaFromRgb(base, bodyA));
  g.addColorStop(1, rgbaFromRgb(lo, bodyA * 0.98));
  c.fillStyle = g;
  c.beginPath();
  roundRectPath(c, x, y, w, h, radius);
  c.fill();

  // 下半部内阴影，给一点体积
  const sh = c.createLinearGradient(x, y + h * 0.5, x, y + h);
  sh.addColorStop(0, "rgba(0,0,0,0)");
  sh.addColorStop(1, "rgba(0,0,0," + (0.14 + 0.12 * (1 - b)) + ")");
  c.fillStyle = sh;
  c.beginPath();
  roundRectPath(c, x, y, w, h, radius);
  c.fill();

  // 1px 内发光：宽而淡的一圈 + 细而亮的一圈
  const inset = Math.max(0.5, rimPx * 0.6);
  const rimR = Math.max(0.5, radius - inset);
  const rimW = Math.max(1, w - inset * 2);

  c.beginPath();
  roundRectPath(c, x + inset, y + inset, rimW, rimW, rimR);
  c.lineWidth = rimPx * 2.6;
  c.strokeStyle = rgbaFromRgb(hi, 0.08 + 0.14 * b);
  c.stroke();

  c.beginPath();
  roundRectPath(c, x + inset, y + inset, rimW, rimW, rimR);
  c.lineWidth = rimPx;
  c.strokeStyle = rgbaFromRgb(hi, 0.30 + 0.46 * b);
  c.stroke();

  // 顶光
  const hg = c.createRadialGradient(
    x + w * 0.3,
    y + h * 0.26,
    0,
    x + w * 0.3,
    y + h * 0.26,
    w * 0.62,
  );
  hg.addColorStop(0, "rgba(255,255,255," + (0.08 + 0.12 * b) + ")");
  hg.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = hg;
  c.beginPath();
  roundRectPath(c, x, y, w, h, radius);
  c.fill();

  return cv;
}

/**
 * 格体辉光（bloom）贴图 —— V-bloom 升级的核心。
 *
 * 一张图里烘好「两层绘制」：
 *   底层：3 圈逐渐放大的圆角矩形，用 lighter 加色叠出来（alpha 0.18 → 0.11 → 0.06），
 *         光晕向外扩散；heat 档位越高，外扩半径越大、光晕越亮。
 *   顶层：一颗更亮的小核心（阵营原色，alpha 最高 0.85 × 档位）。
 *
 * 所有 tier 共用同一张画布边长（HALO_EXTENT × sizePx），运行期每格只需一次
 * drawImage + lighter，零路径、零分配。禁用 ctx.filter / shadowBlur，
 * 「模糊」全部靠多层叠绘模拟。
 */
export const HALO_EXTENT = 2.6;

export function createHaloSprite(
  hex: string,
  sizePx: number,
  radiusPx: number,
  brightness: number,
  expand: number,
  coreAlpha: number,
): HTMLCanvasElement {
  const size = Math.max(4, Math.round(sizePx));
  const box = Math.max(8, Math.round(size * HALO_EXTENT) + 4);
  const cv = makeCanvas(box, box);
  const c = ctx2d(cv);

  const rgb = boostRgb(hexToRgb(hex));
  const halo = mixRgb(rgb, WHITE, 0.25);
  const half = box * 0.5;
  const b = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;

  // 底层：三圈加色光晕，尺寸 1.3 / 1.85 / expand × size，透明度 0.18 → 0.11 → 0.06
  c.globalCompositeOperation = "lighter";
  const scales = [1.3, Math.min(1.85, expand), expand];
  const alphas = [0.18, 0.11, 0.06];
  for (let j = 0; j < 3; j++) {
    const s = size * scales[j];
    const r = Math.max(1, radiusPx * scales[j] * 1.35);
    c.beginPath();
    roundRectPath(c, half - s * 0.5, half - s * 0.5, s, s, r);
    c.fillStyle = rgbaFromRgb(halo, alphas[j] * (0.5 + 0.5 * b));
    c.fill();
  }

  // 顶层：亮核心 —— 原色小块 + 白热中心点
  c.globalCompositeOperation = "source-over";
  const cs = size * 0.62;
  const cr = Math.max(1, radiusPx * 0.8);
  c.beginPath();
  roundRectPath(c, half - cs * 0.5, half - cs * 0.5, cs, cs, cr);
  c.fillStyle = rgbaFromRgb(rgb, coreAlpha);
  c.fill();

  const g = c.createRadialGradient(half, half, 0, half, half, cs * 0.42);
  g.addColorStop(0, "rgba(255,255,255," + (0.22 + 0.42 * b) + ")");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.beginPath();
  roundRectPath(c, half - cs * 0.5, half - cs * 0.5, cs, cs, cr);
  c.fill();

  return cv;
}

/**
 * 整屏扫描光带（V-bloom #6）：1 CSS px 宽、14 CSS px 高的竖向后，
 * 中间亮（0.05）、两端透明的渐变条。运行期横向拉满整屏 drawImage，
 * 每帧只挪 y，零分配、零渐变对象。
 */
export function createScanBand(dpr: number): HTMLCanvasElement {
  const d = Math.max(1, Math.min(dpr, 2));
  const cv = makeCanvas(4 * d, 14 * d);
  const c = ctx2d(cv);
  c.setTransform(d, 0, 0, d, 0, 0);
  const g = c.createLinearGradient(0, 0, 0, 14);
  g.addColorStop(0, "rgba(190,225,255,0)");
  g.addColorStop(0.42, "rgba(200,230,255,0.05)");
  g.addColorStop(0.5, "rgba(225,240,255,0.07)");
  g.addColorStop(0.58, "rgba(200,230,255,0.05)");
  g.addColorStop(1, "rgba(190,225,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 4, 14);
  return cv;
}

/**
 * 外框发光（V-bloom #7）：6px「边框光」，用 3 条 lighter 叠描边模拟外溢，
 * 不用 shadowBlur（每帧就这几笔，开销可忽略）。调用方设 globalCompositeOperation。
 */
export function drawBorderGlow(
  ctx: CanvasRenderingContext2D,
  side: number,
  dim: string,
  mid: string,
  hot: string,
): void {
  const r = Math.min(14, side * 0.02);
  ctx.lineJoin = "round";

  ctx.strokeStyle = dim;
  ctx.lineWidth = 10;
  ctx.beginPath();
  roundRectPath(ctx, 3, 3, side - 6, side - 6, r);
  ctx.stroke();

  ctx.strokeStyle = mid;
  ctx.lineWidth = 4;
  ctx.beginPath();
  roundRectPath(ctx, 2, 2, side - 4, side - 4, r);
  ctx.stroke();

  ctx.strokeStyle = hot;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  roundRectPath(ctx, 1, 1, side - 2, side - 2, r);
  ctx.stroke();
}

/** 软光斑：闪光 / 冲击波原点迸发用（叠加混合） */
export function createGlowSprite(hex: string, sizePx: number): HTMLCanvasElement {
  const size = Math.max(8, Math.round(sizePx));
  const cv = makeCanvas(size, size);
  const c = ctx2d(cv);
  const r = hexToRgb(hex);
  const half = size * 0.5;
  const g = c.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, rgbaFromRgb(r, 0.70));
  g.addColorStop(0.2, rgbaFromRgb(r, 0.42));
  g.addColorStop(0.52, rgbaFromRgb(r, 0.14));
  g.addColorStop(1, rgbaFromRgb(r, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return cv;
}

/** 光环精灵里「亮环」所在半径占整张图的比例，drawImage 缩放时据此反算目标边长 */
export const RING_PEAK = 0.38;

/** 冲击波光环：主环 + 一道回声，中心完全透明 */
export function createRingSprite(hex: string, sizePx: number): HTMLCanvasElement {
  const size = Math.max(16, Math.round(sizePx));
  const cv = makeCanvas(size, size);
  const c = ctx2d(cv);
  const r = hexToRgb(hex);
  const half = size * 0.5;
  const g = c.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, rgbaFromRgb(r, 0));
  g.addColorStop(0.12, rgbaFromRgb(r, 0.02));
  g.addColorStop(RING_PEAK - 0.085, rgbaFromRgb(r, 0.08));
  g.addColorStop(RING_PEAK - 0.03, rgbaFromRgb(r, 0.58));
  g.addColorStop(RING_PEAK, rgbaFromRgb(r, 0.98));
  g.addColorStop(RING_PEAK + 0.03, rgbaFromRgb(r, 0.44));
  g.addColorStop(RING_PEAK + 0.075, rgbaFromRgb(r, 0.10));
  g.addColorStop(RING_PEAK + 0.115, rgbaFromRgb(r, 0));
  g.addColorStop(0.60, rgbaFromRgb(r, 0));
  g.addColorStop(0.64, rgbaFromRgb(r, 0.15));
  g.addColorStop(0.68, rgbaFromRgb(r, 0.05));
  g.addColorStop(0.72, rgbaFromRgb(r, 0));
  g.addColorStop(1, rgbaFromRgb(r, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return cv;
}

/** 白热核心：新 claim 那一瞬间格子里最亮的一层 */
export function createCoreSprite(sizePx: number, radiusPx: number): HTMLCanvasElement {
  const size = Math.max(4, Math.round(sizePx));
  const cv = makeCanvas(size, size);
  const c = ctx2d(cv);
  const radius = Math.max(0.5, Math.min(radiusPx, size * 0.45));
  const g = c.createRadialGradient(
    size * 0.5,
    size * 0.45,
    0,
    size * 0.5,
    size * 0.5,
    size * 0.62,
  );
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.45, "rgba(255,245,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.beginPath();
  roundRectPath(c, 0, 0, size, size, radius);
  c.fill();
  return cv;
}

/* ───────────────────────────── 星尘 ───────────────────────────── */

const STAR_TILE = 320; // 平铺周期（CSS px）

/**
 * 极慢漂移的星尘。
 * 贴图只在 dpr 变化时重建；运行期是「一次 pattern fill + 平移」，
 * 每帧零随机数、零分配。
 */
export class Starfield {
  private dpr = 0;
  private tile: HTMLCanvasElement | null = null;
  private pattern: CanvasPattern | null = null;

  constructor(dpr: number) {
    const d = Math.max(1, Math.min(dpr, 2));
    this.dpr = d;
    this.tile = this.build(d);
  }

  /** resize 时调用；dpr 没变就只重新挂 pattern */
  rebuild(dpr: number, ctx: CanvasRenderingContext2D): void {
    const d = Math.max(1, Math.min(dpr, 2));
    if (d !== this.dpr || !this.tile) {
      this.dpr = d;
      this.tile = this.build(d);
    }
    this.pattern = makePattern(ctx, this.tile, this.dpr);
  }

  /** 运行期：调用方负责 globalCompositeOperation / globalAlpha */
  draw(ctx: CanvasRenderingContext2D, side: number, time: number): void {
    const p = this.pattern;
    if (!p) return;
    const drift = time * 2.2; // 每秒 2.2px，几乎察觉不到在动
    const dx = -(drift % STAR_TILE);
    const dy = -((drift * 0.6) % STAR_TILE);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.fillStyle = p;
    ctx.fillRect(-dx, -dy, side, side);
    ctx.restore();
  }

  private build(dpr: number): HTMLCanvasElement {
    const css = STAR_TILE;
    const cv = makeCanvas(css * dpr, css * dpr);
    const c = ctx2d(cv);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = "lighter";

    const rnd = mulberry32(0x51ed270b);
    for (let i = 0; i < 150; i++) {
      const x = rnd() * css;
      const y = rnd() * css;
      const q = rnd();
      let r = 0.55;
      let a = 0.1;
      let fill = "rgba(226,222,255,";
      if (q > 0.93) {
        r = 1.8;
        a = 0.42;
      } else if (q > 0.68) {
        r = 1.0;
        a = 0.22;
      }
      if (q > 0.9) fill = "rgba(34,211,238,";
      else if (q > 0.82) fill = "rgba(168,85,247,";
      c.fillStyle = fill + a + ")";

      // 九宫格复制：保证平铺接缝处星星连续
      for (let ox = -css; ox <= css; ox += css) {
        for (let oy = -css; oy <= css; oy += css) {
          c.beginPath();
          c.arc(x + ox, y + oy, r, 0, TAU);
          c.fill();
        }
      }
    }
    return cv;
  }
}

/* ───────────────────────────── 冲击波 ───────────────────────────── */

export const MAX_WAVES = 64;
/** V-bloom #3：双层冲击波 —— 内环 2px 实线 0.35s；外环延迟 0.08s、1px、0.45s，半径翻倍 */
export const WAVE_LIFE = 0.53;
export const WAVE_INNER_LIFE = 0.35;
export const WAVE_OUTER_DELAY = 0.08;
export const WAVE_OUTER_LIFE = 0.45;

/**
 * 定长环形槽冲击波池：
 *  - 64 个槽，spawn 覆盖 next 指针处的槽（= 最老的一个），永不分配新对象
 *  - 只存格子索引 + 年龄 + 阵营，resize 后自动跟随新的格子尺寸
 *  - 热路径里不创建任何对象 / 数组 / 闭包
 *  - attachLight() 挂上一块 Float32Array(CELLS) 后，波前扫过的格子会被瞬时点亮，
 *    由渲染层逐帧衰减；扫描只在少量活跃波 × 波前包围盒内进行，零分配
 */
export class Shockwaves {
  private idx = new Int32Array(MAX_WAVES);
  private age = new Float32Array(MAX_WAVES);
  private col = new Uint8Array(MAX_WAVES);
  private next = 0;
  private cell = 0;
  private sideCells = 0;
  private light: Float32Array | null = null;

  constructor() {
    this.idx.fill(-1);
  }

  resize(cell: number, sideCells: number): void {
    this.cell = cell;
    this.sideCells = sideCells;
  }

  /** 渲染层每帧会把这个数组衰减到 0；这里只负责点亮 */
  attachLight(field: Float32Array | null): void {
    this.light = field;
  }

  clear(): void {
    this.idx.fill(-1);
    this.age.fill(0);
    this.next = 0;
  }

  /** cellIndex = 0..2499；color 0 表示无主（用冷白色冲击波） */
  spawn(cellIndex: number, color: number): void {
    const idx = this.idx;
    const age = this.age;
    for (let k = 0; k < MAX_WAVES; k++) {
      if (idx[k] === cellIndex && age[k] < 0.05) return; // 同一格不叠两层
    }
    const slot = this.next;
    this.next = (slot + 1) % MAX_WAVES;
    idx[slot] = cellIndex;
    age[slot] = 0;
    this.col[slot] = color > 0 && color < 5 ? color | 0 : 0;
    if (this.light && cellIndex >= 0 && cellIndex < this.light.length) {
      this.light[cellIndex] = 1; // 新 claim 的格子先亮一下，波前再往外扫
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const idx = this.idx;
    const age = this.age;
    const light = this.light;
    const S = this.sideCells;
    const cell = this.cell;

    for (let k = 0; k < MAX_WAVES; k++) {
      if (idx[k] < 0) continue;
      const a = age[k] + dt;
      if (a >= WAVE_LIFE) {
        idx[k] = -1;
        age[k] = 0;
        continue;
      }
      age[k] = a;

      // 波前点亮：内环半径扫过的格子进 light 场，渲染层逐帧衰减
      if (light && cell > 0 && S > 0 && a < WAVE_INNER_LIFE) {
        const t = a / WAVE_INNER_LIFE;
        const cx = ((idx[k] % S) + 0.5) * cell;
        const cy = (((idx[k] / S) | 0) + 0.5) * cell;
        const r = (0.6 + 5.0 * t) * cell;
        const band = cell * 0.7;
        const amp = 0.55 * (1 - t);
        const gx0 = Math.max(0, Math.floor((cx - r - band) / cell));
        const gx1 = Math.min(S - 1, Math.floor((cx + r + band) / cell));
        const gy0 = Math.max(0, Math.floor((cy - r - band) / cell));
        const gy1 = Math.min(S - 1, Math.floor((cy + r + band) / cell));
        for (let gy = gy0; gy <= gy1; gy++) {
          const py = (gy + 0.5) * cell - cy;
          const rowOff = gy * S;
          for (let gx = gx0; gx <= gx1; gx++) {
            const px = (gx + 0.5) * cell - cx;
            const dd = px * px + py * py;
            if (dd <= band * band) {
              const p = rowOff + gx;
              if (light[p] < amp) light[p] = amp;
            }
          }
        }
      }
    }
  }

  /**
   * 双层冲击波。调用方需已设置 globalCompositeOperation = "lighter"，
   * ringColors 为 5 条预烘 rgba 串（下标 = 阵营）。每帧活跃波通常 < 8 个，
   * arc + stroke 的开销远低于贴图，也更贴合「实线能量环」的观感。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    ringColors: string[],
    glows: HTMLCanvasElement[],
    hype: number,
  ): void {
    const cell = this.cell;
    const S = this.sideCells;
    if (cell <= 0 || S <= 0) return;
    const boost = 1 + 0.3 * hype;

    ctx.lineCap = "round";
    for (let k = 0; k < MAX_WAVES; k++) {
      const i = this.idx[k];
      if (i < 0) continue;
      const a = this.age[k];

      const cx = ((i % S) + 0.5) * cell;
      const cy = (((i / S) | 0) + 0.5) * cell;

      // 内环：2px 实线，0.35s 衰减，峰值 alpha 0.9
      if (a < WAVE_INNER_LIFE) {
        const t = a / WAVE_INNER_LIFE;
        const fade = 1 - t;
        const r = (0.6 + 5.0 * t) * cell;
        ctx.strokeStyle = ringColors[this.col[k]];
        ctx.globalAlpha = Math.min(1, fade * fade * 0.9 * boost);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
      }

      // 外环：延迟 0.08s 启动，1px 半透明 0.6，0.45s 衰减，半径 = 内环两倍
      if (a >= WAVE_OUTER_DELAY) {
        const t2 = (a - WAVE_OUTER_DELAY) / WAVE_OUTER_LIFE;
        if (t2 < 1) {
          const fade2 = 1 - t2;
          const r2 = 2 * (0.6 + 5.0 * t2) * cell;
          ctx.strokeStyle = ringColors[this.col[k]];
          ctx.globalAlpha = Math.min(1, fade2 * fade2 * 0.6 * boost);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, r2, 0, TAU);
          ctx.stroke();
        }
      }

      // 原点迸发：只有生命周期前 28% 有
      const t = a / WAVE_INNER_LIFE;
      if (a < WAVE_INNER_LIFE * 0.28) {
        const it = t / 0.28;
        const is = cell * (1.4 + it * 2.8);
        const a2 = (1 - it) * (1 - it) * 0.9 * boost;
        ctx.globalAlpha = a2 > 1 ? 1 : a2;
        ctx.drawImage(glows[this.col[k]], cx - is * 0.5, cy - is * 0.5, is, is);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/* ───────────────────────────── 全屏叠加层 ───────────────────────────── */

/**
 * vignette + 扫描线，一次性预渲染成一张透明贴图。
 * 每帧只 drawImage 一次，绝不每帧建径向渐变。
 */
export function createOverlayCanvas(sideCss: number, dpr: number): HTMLCanvasElement {
  const side = Math.max(1, sideCss);
  const cv = makeCanvas(side * dpr, side * dpr);
  const c = ctx2d(cv);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 径向 vignette
  const half = side * 0.5;
  const g = c.createRadialGradient(half, side * 0.47, side * 0.24, half, side * 0.5, side * 0.82);
  g.addColorStop(0, "rgba(3,2,8,0)");
  g.addColorStop(0.55, "rgba(3,2,8,0.10)");
  g.addColorStop(0.82, "rgba(2,1,6,0.36)");
  g.addColorStop(1, "rgba(1,1,4,0.70)");
  c.fillStyle = g;
  c.fillRect(0, 0, side, side);

  // 顶 / 底再压一点，把视线收进中间
  const v = c.createLinearGradient(0, 0, 0, side);
  v.addColorStop(0, "rgba(2,1,6,0.24)");
  v.addColorStop(0.14, "rgba(2,1,6,0)");
  v.addColorStop(0.86, "rgba(2,1,6,0)");
  v.addColorStop(1, "rgba(2,1,6,0.28)");
  c.fillStyle = v;
  c.fillRect(0, 0, side, side);

  // 扫描线：极淡
  c.fillStyle = "rgba(4,2,10,0.10)";
  for (let y = 0; y < side; y += 3) c.fillRect(0, y, side, 1);

  // 内描边，让画面像一块「屏幕里的实体」
  c.strokeStyle = "rgba(168,130,255,0.10)";
  c.lineWidth = 1;
  c.beginPath();
  roundRectPath(c, 0.5, 0.5, side - 1, side - 1, 14);
  c.stroke();

  return cv;
}
