/**
 * MONAD BATTLEFIELD · 50×50 战场网格（W1）
 *
 * 目标：1080p 投影下不像表格，而像「一块活的生物组织」。
 *
 * 渲染分层（V-bloom 科幻能量场版；每帧都是 O(1) 次全屏合成 + 少量脏格重绘）：
 *   ┌ bg       离屏·不透明 背景渐变 + 星云 + 2500 个空格子（resize 时生成一次）
 *   ├ field    主画布        背景能量场：4 个阵营色大光晕 sin 漂移（每帧 4 次 drawImage）
 *   ├ star     离屏·平铺     星尘 pattern，运行期只做 translate（构建期生成一次）
 *   ├ bloom    离屏·50×50    每格一个像素的「领地热场」，放大后叠加，形成组织辉光
 *   ├ halos    主画布        格体辉光：加色光晕 3 圈 + 亮核，每格一次 drawImage（lighter）；
 *   │                       W-perf：满 occupancy（≥800 格）时改在半分辨率离屏叠完一次合成
 *   ├ cells    离屏·透明     已占领格半透膜（增量维护：只有变了的格子才重画）
 *   ├ waveLt   主画布        冲击波波前扫过格子的瞬时提亮（Float32Array 光场逐帧衰减）
 *   ├ breath   主画布        热区呼吸：heat≥4 格子 0.5s 周期 ±0.08 搏动
 *   ├ flash    主画布        正在闪的格子（数量 ≈ claim 速率 × 0.42s）
 *   ├ waves    主画布        双层冲击波环（内 2px/0.35s + 外 1px/延迟 0.08s/0.45s，≤64 槽）
 *   ├ links    主画布        同阵营能量边：1.5–3px 随 heat 分档，端点 0.4 / 中点 0.9
 *   ├ border   主画布        外框发光：6px 三段 lighter 描边，颜色 = 最旺阵营
 *   ├ scan     主画布        整屏扫描光带：~14px、opacity≈0.05、4 秒一轮
 *   └ overlay  离屏           vignette + 扫描线（resize 时生成一次）
 *
 * 热路径纪律：不 new 对象 / 数组 / 闭包，不调用 Math.random，不用 shadowBlur / ctx.filter。
 * 配色在画布上统一 ×1.08 推亮（boostRgb），FACTIONS 常量保持原值供观众页 / 导演台共用。
 */

import {
  boostRgb,
  createCellSprite,
  createCoreSprite,
  createGlowSprite,
  createHaloSprite,
  createOverlayCanvas,
  createScanBand,
  ctx2d,
  drawBorderGlow,
  HALO_EXTENT,
  hexToRgb,
  makeCanvas,
  mixRgb,
  mulberry32,
  rgbaFromRgb,
  roundRectPath,
  Shockwaves,
  Starfield,
} from "./effects";
import { decayFactor } from "./metrics";

const TAU = Math.PI * 2;

export const SIDE = 50;
export const CELLS = SIDE * SIDE;

/** 索引 0 = 未占领，1..4 = 四个阵营 */
export const FACTIONS: Array<{ name: string; hex: string }> = [
  { name: "—", hex: "#000000" },
  { name: "紫", hex: "#8B7BD8" },
  { name: "青", hex: "#4A9DB5" },
  { name: "琥珀", hex: "#C9A227" },
  { name: "绯", hex: "#B5525F" },
];

/* ── GridState（接口冻结，行为与 v1 完全一致） ───────────────────── */

export class GridState {
  readonly color = new Uint8Array(CELLS);
  readonly heat = new Uint32Array(CELLS);
  readonly flash = new Float32Array(CELLS);
  /**
   * v3「热的土地」：每格最近一次 claim 到现在的秒数。
   * Infinity = 未知（中继没缓存过它的时间戳）→ 呈现层按全亮处理。
   */
  readonly age = new Float64Array(CELLS).fill(Infinity);
  /**
   * v3「格子上的名字」：最近一次 claim 的署名（观众昵称），null = 没有署名。
   * 只被中继代付的 claim 写；蜂群不署名，所以大屏上能看到的是人，不是机器人。
   */
  readonly labelOf = new Array<string | null>(CELLS).fill(null);
  total = 0;

  apply(id: number, color: number, heat: number, ageSec = Infinity) {
    if (!Number.isFinite(id) || id < 0 || id >= CELLS) return;
    this.color[id] = color > 4 ? 0 : color;
    this.heat[id] = heat;
    this.flash[id] = 1;
    this.age[id] = Number.isFinite(ageSec) && ageSec >= 0 ? ageSec : Infinity;
    this.total++;
  }

  /** v3：中继快照带来的署名。只接受非空字符串，防空串把标签清成假干净 */
  setLabel(id: number, nick: string) {
    if (!Number.isFinite(id) || id < 0 || id >= CELLS) return;
    const t = (nick ?? "").trim().slice(0, 16);
    this.labelOf[id] = t.length > 0 ? t : null;
  }

  reset() {
    this.color.fill(0);
    this.heat.fill(0);
    this.flash.fill(0);
    this.age.fill(Infinity);
    for (let i = 0; i < CELLS; i++) this.labelOf[i] = null;
    this.total = 0;
  }
}

/* ── 渲染常量 ───────────────────────────────────────────────────── */

/** 已占领格按 heat 分 6 档亮度，贴图提前烘好，运行期只选档 */
const TIERS = 6;
/** heat >= 40 就是最高档 */
const HEAT_MAX = 40;
/** flash 从 1 衰减到 0 的速率（/秒）→ 约 0.42s */
const FLASH_DECAY = 2.4;
/** 单帧最多触发几个冲击波，防止历史回放一次性炸出几百个环 */
const MAX_SPAWN_PER_FRAME = 8;
/** 热区呼吸门槛：被反复抢（heat≥4）的格子搏动（V-bloom #5） */
const HEAT_BREATH = 4;
/** 呼吸格上限：极端全图热点时钳住每帧绘制量 */
const HOT_CAP = 400;
/** 波前光场衰减速率（/秒）→ 约 0.45s 归零 */
const LIGHT_DECAY = 2.2;
/** 冲击波重音频率（个/秒）——与交易量无关，保证画面密度恒定 */
const WAVE_PER_SEC = 8;
/** 设备像素比上限：投影机 / 普通屏 1，Retina 2，再高只会掉帧 */
const DPR_CAP = 2;

/** 署名墙：最多同时画多少个名字（再密就糊成一片，读不出字） */
export const LABEL_CAP = 36;
/** 署名「新鲜窗口」：只有最近 LABEL_WINDOW 秒内有 claim 的格子才配一个名字 */
export const LABEL_WINDOW = 30;
/** 候选集多久重扫一次（秒）。到期淡出靠每帧判定，这里只是把新名字补进来 / 重新洗牌 */
const LABEL_REFRESH = 0.4;
/**
 * W-visual：labelVersion 变化后最少间隔多久才允许重扫（秒）。
 * demo 的 crowd 流每有 claim 的帧都 ++labelVersion，原来版本门会让 rebuildLabels
 * 每帧全表重扫 + 几十次 measureText + 分配排序数组；周期重扫（LABEL_REFRESH）
 * 本来就保证新名字 ≤0.4s 上墙，版本门只需要「别慢于半秒」→ 0.15s 足够，
 * 把满屏时最贵的一档每帧开销省掉，画面无感。
 */
const LABEL_PUSH_SCAN = 0.15;
/** 名字临期淡出的时长（秒），看起来像署名「冷却」掉，而不是啪一下消失 */
const LABEL_FADE = 0.7;
/**
 * W-perf：格体辉光的半分辨率批量合成层。
 * 实拍：crowd=240 满 occupancy ~47fps、crowd=1500 ~42fps、空墙 159fps ——
 * 每帧固定的全屏合成只占 ~6ms，剩下全是 2500 格 halo 的逐格 drawImage(lighter)。
 * halo 本来就是「软光斑」：在 1/2 分辨率离屏里加色叠完、一次拉伸合成回来，
 * 视觉几乎无损（光晕更糊一点=更像辉光），面积成本降到 ~1/4。
 * 低于阈值（开局 / 真实链上稀疏）走原直绘路径，保留早期画面的锐度。
 */
const HALO_BATCH_MIN = 800;
const HALO_BATCH_SCALE = 0.5;

/**
 * 纯函数：从格子数组里挑出「该画署名」的格子 —— 不碰 DOM，供渲染层与单测共用同一份规则。
 *
 * 入选条件（全部满足）：
 *   · 已占领：color ∈ 1..4
 *   · 有署名：labelOf 非 null 且去掉空白后非空串
 *   · 最近 claim：age 是有限数且 age < window（Infinity = 读不到时间戳，不配当「最近」）
 * 超过 cap 时保留最新（age 最小）的 cap 个，返回按 age 升序的索引数组。
 */
export function selectLabelCells(
  color: ArrayLike<number>,
  labelOf: ArrayLike<string | null>,
  age: ArrayLike<number>,
  opts: { cap?: number; window?: number } = {},
): number[] {
  const cap = opts.cap ?? LABEL_CAP;
  const window = opts.window ?? LABEL_WINDOW;
  const n = Math.min(color.length, labelOf.length, age.length);

  const chosen: number[] = [];
  const ages: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = color[i];
    if (c < 1 || c > 4) continue;
    const lab = labelOf[i];
    if (lab == null || lab.trim() === "") continue;
    const a = age[i];
    if (!Number.isFinite(a) || a >= window) continue;
    chosen.push(i);
    ages.push(a);
  }

  if (chosen.length <= 1) return chosen;

  const limit = Math.min(cap, chosen.length);
  const order = chosen.map((_, k) => k);
  order.sort((x, y) => ages[x] - ages[y]);
  const picked = new Array<number>(limit);
  for (let k = 0; k < limit; k++) picked[k] = chosen[order[k]];
  return picked;
}

/**
 * W-visual「有效年龄」：把来源端（中继 / crowd）报的 age 换算成此刻的真实年龄。
 *
 * 数据源的纪律缺口在 demo 模式暴露得很彻底：main.ts 的 crowd 分支对每次 claim 调
 * `state.apply(..., 0)`，之后没有任何人推进 `GridState.age` —— 年龄永远等于 0。
 * 于是 selectLabelCells 的 `age < LABEL_WINDOW` 恒真，候选按 index 稳定排序取前 36，
 * 署名墙被钉死在最顶行；LABEL_FADE 淡出也永不触发（实拍 rowHistogram=100% 第 0 行）。
 * 修在呈现层：观察值没变 → 按渲染时钟自然老化；观察值一变（中继推进 / 重新 claim，
 * 后者由 updateCells 的 f>=0.999 分支强制重定基准）→ 以新值为基准。
 * 纯函数、类型化数组进、热路径零分配；单测（tests/grid-effage.test.ts）跑的就是这条。
 */
export function trackAgeAt(
  observed: number,
  i: number,
  mirror: Float64Array,
  base: Float64Array,
  eff: Float64Array,
  now: number,
): number {
  const m = mirror[i];
  if (!(m === observed)) {
    // NaN !== 一切 → 首次观察自动建基准;值跳变 → 重定基准
    mirror[i] = observed;
    base[i] = now;
  }
  if (observed === Infinity) {
    eff[i] = observed;
    return observed;
  }
  const e = observed + (now - base[i]);
  eff[i] = e;
  return e;
}

/** 把名字裁到 maxPx 宽，放不下逐字缩并加省略号。只在重扫候选时调用，不进每帧热路径。 */
function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
): string {
  if (maxPx <= 2) return "";
  if (ctx.measureText(text).width <= maxPx) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxPx) {
    s = s.slice(0, -1);
  }
  return s.length > 1 ? s + "…" : s;
}

export class GridRenderer {
  private ctx: CanvasRenderingContext2D;
  private side = 0;
  private dpr = 1;
  private cell = 0;
  private gap = 0;
  private inner = 0;

  /* 离屏图层 */
  private bg: HTMLCanvasElement | null = null;
  private cellsCv: HTMLCanvasElement | null = null;
  private cellsCtx: CanvasRenderingContext2D | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private bloom: HTMLCanvasElement | null = null;
  private bloomCtx: CanvasRenderingContext2D | null = null;
  private bloomImg: ImageData | null = null;
  private bloomDirty = true;

  /* 精灵 */
  private sprites: HTMLCanvasElement[][] = []; // [faction][tier]
  // 逐格 flash 改成描边后，hot/core 预烘贴图已废弃（见 drawFlashes）
  /** 冲击波令牌（见 updateCells）：固定频率放环，不随交易量增长 */
  private waveTokens = 0;
  /**
   * v3「静默墙」落点：还欠几圈涟漪。queueBurst() 只记账，
   * 真正放环在 draw() 里按令牌节流排掉 —— 与普通 claim 用同一把节流锁，
   * 不然爆发瞬间 90 个环会糊满整屏（那是最丑的故障形态）。
   */
  private pendingSpawn = 0;
  /**
   * v3：署名图版本。main 合并 /api/state 的 tags 后 +1；
   * 版本号变化是「补进新名字」的触发条件之一（另外两个是 resize 和定时重扫）。
   * 注意：它不再用来「跳过整帧的署名绘制」——主画布每帧都被背景盖满，
   * 跳过会让名字只活一帧就消失（见 drawLabels）。
   */
  labelVersion = 0;
  /** 署名候选缓冲（定长，热路径不扩容）：索引 / 文案 / 到期时刻，labelN 是当前有效条数 */
  private labelIdx = new Int32Array(LABEL_CAP);
  private labelStr: string[] = new Array(LABEL_CAP).fill("");
  private labelExpire = new Float64Array(LABEL_CAP);
  private labelN = 0;
  private lastLabelScan = -1;
  /**
   * W-visual「有效年龄」缓冲：mirror = 上次观察到的来源 age;
   * base = 该观察值落地时的渲染时钟;eff = 此刻真实年龄。
   * 热路径(署名 / tier 衰减)只读 eff,不再读来源那个会钉死的 age。
   */
  private ageMirror = new Float64Array(CELLS).fill(NaN);
  private ageBase = new Float64Array(CELLS);
  private effAge = new Float64Array(CELLS).fill(Infinity);
  private builtVersion = -1;
  private builtResize = -1;
  private resizeCount = 0;
  /** 亮版阵营色（署名 / 小旗用），构造期烘一次 */
  private labelInk: string[] = [];
  private glows: HTMLCanvasElement[] = []; // [0..4] 冲击波原点迸发 / 波前点亮 / 热区呼吸用
  /** V-bloom：格体加色光晕贴图 [faction][tier]，内嵌亮核（0.85 alpha 顶） */
  private halos: HTMLCanvasElement[][] = [];
  /** 冲击波环描边色（预烘 rgba 串，热路径零拼串） */
  private ringColor: string[] = [];
  /** 能量边：端点 alpha 0.4 / 中点 alpha 0.9 */
  private edgeEnd: string[] = [];
  private edgeMid: string[] = [];
  /** 外框发光三段（dim/mid/hot × faction），以及推亮后的阵营 hex（贴图用） */
  private borderDim: string[] = [];
  private borderMid: string[] = [];
  private borderHot: string[] = [];
  private hexBoost: string[] = [];
  /** 背景能量场：4 个柔和大头光晕贴图（构建期 512px，运行期拉伸 drawImage） */
  private fieldSprites: HTMLCanvasElement[] = [];
  /** 整屏扫描光带贴图 */
  private scanBand: HTMLCanvasElement | null = null;
  /** W-perf：满 occupancy 时 halo 的半分辨率批量合成层（resize 时创建，见 HALO_BATCH_* 注释） */
  private haloBatch: HTMLCanvasElement | null = null;
  private haloBatchCtx: CanvasRenderingContext2D | null = null;

  /* 运行时状态 */
  private stars: Starfield | null = null;
  private waves = new Shockwaves();
  /** 每格在 cells 图层里的当前内容指纹：-1 = 空，其余 = (faction << 3) | tier */
  private layKey = new Int32Array(CELLS);
  /** 本帧需要叠加闪光的格子（预分配，不动态扩容） */
  private dyn = new Int32Array(CELLS);
  private dynN = 0;
  /** 本帧所有已占领格（光晕层每帧要画，用同一把列表避免二次全表扫描） */
  private dynHalo = new Int32Array(CELLS);
  private dynHaloN = 0;
  /** 冲击波扫过后的瞬时提亮场（V-bloom #3），逐帧衰减到 0 */
  private waveLight = new Float32Array(CELLS);
  private dynLight = new Int32Array(CELLS);
  private dynLightN = 0;
  /** 热区呼吸（heat≥4，V-bloom #5）的格子列表；数量被 HOT_CAP 钳住 */
  private dynHot = new Int32Array(CELLS);
  private dynHotN = 0;
  /** 本帧各阵营 heat 总和 → 外框发光取最旺阵营 */
  private heatSum = new Float64Array(FACTIONS.length);
  private hottest = 0;
  private lastPulse = -1;
  private time = 0;
  private hype = 0;

  /* 预生成的字符串 / 调色板（避免热路径拼字符串） */
  private palette = new Uint8Array(FACTIONS.length * 3);
  private hypeGrad: CanvasGradient | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法获取 2d context");
    this.ctx = ctx;

    this.layKey.fill(-1);

    // 阵营色 → 调色板 / 能量边 / 光环 / 外框（只算一次，不进热循环）。
    // V-bloom #8：画布上一律用 ×1.08 推亮版；FACTIONS 常量保持原值（观众页共用）。
    const WHITE = { r: 255, g: 255, b: 255 };
    for (let f = 0; f < FACTIONS.length; f++) {
      const raw = f === 0 ? hexToRgb("#E9E4FF") : hexToRgb(FACTIONS[f].hex);
      const rgb = boostRgb(raw);
      this.palette[f * 3] = rgb.r;
      this.palette[f * 3 + 1] = rgb.g;
      this.palette[f * 3 + 2] = rgb.b;
      this.hexBoost.push(
        "#" +
          ((1 << 24) | (rgb.r << 16) | (rgb.g << 8) | rgb.b).toString(16).slice(1),
      );

      const edge = mixRgb(rgb, WHITE, 0.35);
      const mid = mixRgb(rgb, WHITE, 0.62);
      this.edgeEnd.push(rgbaFromRgb(edge, 0.4)); // 端点 alpha 0.4
      this.edgeMid.push(rgbaFromRgb(mid, 0.9)); // 中点 alpha 0.9
      this.ringColor.push(rgbaFromRgb(mid, 1));

      // 外框三段光（dim/mid/hot 用 globalAlpha 调制前先烘进串里）
      this.borderDim.push(rgbaFromRgb(edge, 0.34));
      this.borderMid.push(rgbaFromRgb(mid, 0.5));
      this.borderHot.push(rgbaFromRgb(mixRgb(rgb, WHITE, 0.82), 0.9));

      // 署名的「亮版阵营色」：比连线更冲白一点，压在亮格上也读得清
      const ink = mixRgb(rgb, WHITE, 0.62);
      this.labelInk.push(rgbaFromRgb(ink, 0.96));
    }

    // 背景能量场贴图：512px 柔和大光晕，运行期拉伸到 ~1.2×side，内存恒定
    for (let f = 1; f <= 4; f++) {
      this.fieldSprites.push(createGlowSprite(this.hexBoost[f], 512));
    }

    this.waves.attachLight(this.waveLight);
    this.resize();
  }

  /** 容器尺寸 / dpr 变了就返回 true —— 每帧兜底检查，不依赖 ResizeObserver 的一次性回调 */
  needsResize(): boolean {
    const rect = this.container.getBoundingClientRect();
    const side = Math.floor(Math.min(rect.width, rect.height) || 0);
    if (side > 0 && Math.abs(side - this.side) > 2) return true;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    return Math.abs(dpr - this.dpr) > 0.01;
  }

  /** 用容器的实际可用空间算边长，再显式写回 canvas 的 CSS 尺寸 —— 不靠 CSS 推算 */
  resize(): void {
    const rect = this.container.getBoundingClientRect();
    const side = Math.max(240, Math.floor(Math.min(rect.width, rect.height) || 600));
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (side === this.side && Math.abs(dpr - this.dpr) < 0.01 && this.bg) return;

    this.side = side;
    this.dpr = dpr;

    this.canvas.style.width = side + "px";
    this.canvas.style.height = side + "px";
    const px = Math.max(1, Math.round(side * dpr));
    this.canvas.width = px;
    this.canvas.height = px;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    this.cell = side / SIDE;
    this.gap = Math.max(0.5, Math.min(1.6, this.cell * 0.075));
    this.inner = this.cell - this.gap;

    this.buildBackground(px);
    this.buildCells(px);
    this.overlay = createOverlayCanvas(side, dpr);
    this.buildBloom();
    this.buildSprites();
    this.buildHypeGradient();
    this.scanBand = createScanBand(dpr);

    // W-perf：halo 半分辨率合成层（见 HALO_BATCH_* 注释）。
    // 变换设成 dpr×0.5 → 离屏的 CSS 像素坐标与主画布完全同构，
    // 两条 drawImage 路径共用同一套矩形运算；合成时整图拉伸回 side。
    const bw = Math.max(1, Math.round(px * HALO_BATCH_SCALE));
    this.haloBatch = makeCanvas(bw, bw);
    const bc = ctx2d(this.haloBatch);
    bc.setTransform(dpr * HALO_BATCH_SCALE, 0, 0, dpr * HALO_BATCH_SCALE, 0, 0);
    bc.imageSmoothingEnabled = true;
    this.haloBatchCtx = bc;

    this.waves.resize(this.cell, SIDE);

    const stars = new Starfield(dpr);
    stars.rebuild(dpr, this.ctx);
    this.stars = stars;

    this.layKey.fill(-1);
    this.bloomDirty = true;
    this.resizeCount++; // 方格尺寸变了 → 署名候选的裁剪宽度要重算，逼 drawLabels 重建
  }

  /* ── 构造期：离屏图层 ─────────────────────────────────────────── */

  /** 背景 + 星云 + 2500 个空格子（一次性，resize 才重建） */
  private buildBackground(px: number): void {
    const side = this.side;
    const dpr = this.dpr;
    const cv = makeCanvas(px, px);
    const c = ctx2d(cv);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = c.createLinearGradient(0, 0, side * 0.28, side);
    bg.addColorStop(0, "#130B26");
    bg.addColorStop(0.48, "#0B0717");
    bg.addColorStop(1, "#05030C");
    c.fillStyle = bg;
    c.fillRect(0, 0, side, side);

    // 中央星云：让网格像浮在深处的能量团里
    const neb = c.createRadialGradient(side * 0.5, side * 0.44, 0, side * 0.5, side * 0.5, side * 0.72);
    neb.addColorStop(0, "rgba(124,58,237,0.17)");
    neb.addColorStop(0.34, "rgba(76,29,149,0.10)");
    neb.addColorStop(0.72, "rgba(20,10,40,0.05)");
    neb.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = neb;
    c.fillRect(0, 0, side, side);

    // 两个角落的冷暖反差
    const warm = c.createRadialGradient(side * 0.14, side * 0.86, 0, side * 0.14, side * 0.86, side * 0.5);
    warm.addColorStop(0, "rgba(244,63,94,0.055)");
    warm.addColorStop(1, "rgba(244,63,94,0)");
    c.fillStyle = warm;
    c.fillRect(0, 0, side, side);

    const cool = c.createRadialGradient(side * 0.88, side * 0.12, 0, side * 0.88, side * 0.12, side * 0.55);
    cool.addColorStop(0, "rgba(34,211,238,0.05)");
    cool.addColorStop(1, "rgba(34,211,238,0)");
    c.fillStyle = cool;
    c.fillRect(0, 0, side, side);

    // 空格子：用 3 个 Path2D 分组批量填充（2500 个独立 fill 在 resize 时会明显卡）
    const cell = this.cell;
    const gap = this.gap;
    const inner = this.inner;
    const g2 = gap * 0.5;
    const radius = Math.max(0.5, cell * 0.10);
    const rnd = mulberry32(0x0badf00d);
    const paths: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];

    for (let y = 0; y < SIDE; y++) {
      const y0 = y * cell + g2;
      for (let x = 0; x < SIDE; x++) {
        const g = (rnd() * 3) | 0;
        roundRectPath(paths[g], x * cell + g2, y0, inner, inner, radius);
      }
    }

    c.fillStyle = "rgba(186,176,255,0.020)";
    c.fill(paths[0]);
    c.fillStyle = "rgba(186,176,255,0.032)";
    c.fill(paths[1]);
    c.fillStyle = "rgba(186,176,255,0.046)";
    c.fill(paths[2]);

    // 极淡的 1px 内发光边（空格子也有）
    c.strokeStyle = "rgba(150,130,240,0.05)";
    c.lineWidth = 1;
    c.stroke(paths[0]);
    c.stroke(paths[1]);
    c.stroke(paths[2]);

    // 网格外框的一点冷光，把整块「组织」托起来
    c.strokeStyle = "rgba(168,130,255,0.10)";
    c.lineWidth = 1;
    c.beginPath();
    roundRectPath(c, 0.5, 0.5, side - 1, side - 1, 14);
    c.stroke();

    this.bg = cv;
  }

  /** 已占领格图层（透明，增量维护） */
  private buildCells(px: number): void {
    const cv = makeCanvas(px, px);
    const c = ctx2d(cv);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.imageSmoothingEnabled = true;
    this.cellsCv = cv;
    this.cellsCtx = c;
  }

  /** 50×50 的领地热场：一个像素 = 一个格子 */
  private buildBloom(): void {
    const cv = makeCanvas(SIDE, SIDE);
    const c = ctx2d(cv);
    this.bloom = cv;
    this.bloomCtx = c;
    this.bloomImg = c.createImageData(SIDE, SIDE);
    this.bloomDirty = true;
  }

  /** 所有格子 / 光晕 / 冲击波精灵，按当前方格尺寸烘一次 */
  private buildSprites(): void {
    const dpr = this.dpr;
    const sizePx = Math.max(4, Math.round(this.inner * dpr));
    const radiusPx = Math.max(1, this.cell * 0.10 * dpr);
    const rimPx = Math.max(1, Math.round(dpr)); // 1 CSS px 的内发光

    this.sprites = [];
    for (let f = 0; f < FACTIONS.length; f++) {
      const row: HTMLCanvasElement[] = [];
      for (let t = 0; t < TIERS; t++) {
        const b = 0.28 + 0.72 * (t / (TIERS - 1));
        row.push(createCellSprite(this.hexBoost[f], sizePx, radiusPx, rimPx, b));
      }
      this.sprites.push(row);
    }
    // 逐格 flash 已改成画描边（见 drawFlashes），不再需要预烘的 hot/core 贴图

    // V-bloom #1：格体光晕。heat 档位 → 外扩半径 1.5→2.25 格、亮核 alpha 0.42→0.85。
    // 所有贴图同一边长（HALO_EXTENT），运行期一次 drawImage 完成两层叠绘。
    this.halos = [];
    for (let f = 0; f < FACTIONS.length; f++) {
      const row: HTMLCanvasElement[] = [];
      for (let t = 0; t < TIERS; t++) {
        const q = t / (TIERS - 1);
        row.push(
          createHaloSprite(
            this.hexBoost[f],
            sizePx,
            radiusPx,
            0.35 + 0.65 * q, // 光晕强度随 heat
            1.5 + 0.75 * q, // 光晕半径随 heat
            0.42 + 0.43 * q, // 亮核 alpha，顶档 ≈0.85
          ),
        );
      }
      this.halos.push(row);
    }

    this.glows = [];
    const glowPx = Math.max(32, Math.round(this.cell * 3 * dpr));
    for (let f = 0; f < FACTIONS.length; f++) {
      this.glows.push(createGlowSprite(this.hexBoost[f], glowPx));
    }
  }

  /** hype 模式的中央提亮渐变（resize 时建一次） */
  private buildHypeGradient(): void {
    const side = this.side;
    const g = this.ctx.createRadialGradient(
      side * 0.5,
      side * 0.45,
      0,
      side * 0.5,
      side * 0.45,
      side * 0.66,
    );
    g.addColorStop(0, "rgba(132,96,255,0.90)");
    g.addColorStop(0.55, "rgba(96,78,220,0.42)");
    g.addColorStop(1, "rgba(60,40,140,0)");
    this.hypeGrad = g;
  }

  /** v3「静默墙」落点：把 n 圈涟漪记进欠账（上限 240），draw() 每帧按令牌排掉 */
  queueBurst(count = 90) {
    this.pendingSpawn += Math.max(0, Math.min(240, Math.floor(Number.isFinite(count) ? count : 0)));
  }

  /* ── 每帧 ─────────────────────────────────────────────────────── */

  draw(
    state: GridState,
    dt: number,
    opts?: { pulseId?: number; mode?: "normal" | "hype" },
  ): void {
    const side = this.side;
    const cellsCv = this.cellsCv;
    if (!this.bg || !cellsCv || side <= 0) return;

    const d = dt > 0 ? (dt < 0.05 ? dt : 0.05) : 0;
    this.time += d;

    // hype 平滑过渡，导演台切模式时不会硬跳
    const target = opts && opts.mode === "hype" ? 1 : 0;
    this.hype += (target - this.hype) * (d > 0 ? Math.min(1, d * 5) : 1);
    if (this.hype < 0) this.hype = 0;
    else if (this.hype > 1) this.hype = 1;
    const hype = this.hype;

    // 主控显式指定的脉冲（可选）；不传也没关系，下面会从 flash 自动识别
    const pid = opts && typeof opts.pulseId === "number" ? opts.pulseId | 0 : -1;
    if (pid >= 0 && pid < CELLS && pid !== this.lastPulse) {
      this.lastPulse = pid;
      this.waves.spawn(pid, state.color[pid]);
    }

    // 1) 唯一的 O(n) 逐格循环：更新计数、维护 cells 图层、收集本帧闪格
    this.updateCells(state, d);

    // 2) 背景（不透明，一次盖满）
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0, side, side);

    // 2.5) 背景能量场（V-bloom #4）：4 个阵营色大光晕绕网格中心 sin 漂移，
    // 每帧 4 次拉伸 drawImage，贴图构建期烘死，画面从此不「死黑」。
    this.drawEnergyField(hype);

    // 3) 星尘
    if (this.stars) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.72 + 0.28 * hype;
      this.stars.draw(ctx, side, this.time);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // 4) 领地热场（低分辨率放大 → 组织辉光）
    this.drawBloom(hype);

    // 5) 格体光晕（V-bloom #1，lighter）：3 圈渐放大圆角矩形 + 顶置亮核，
    // 全部烘在一张贴图里，每格每帧一次 drawImage，零路径零分配
    this.drawHalos(hype);

    // 6) 已占领格（半透膜主体，source-over，增量维护）
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(cellsCv, 0, 0, side, side);

    // 6.5) 冲击波扫过格子的瞬时提亮（V-bloom #3 的 Float32Array 光场）
    this.drawWaveLight(state);

    // 6.6) 热区呼吸（V-bloom #5）：heat≥4 的格子 0.5s 周期搏动
    this.drawHeatBreath(state);

    // 7) 正在闪的格子
    ctx.globalCompositeOperation = "source-over";
    this.drawFlashes(state, hype);

    // v3「静默墙」：把欠下的涟漪按令牌排掉（每帧至多 MAX_SPAWN_PER_FRAME 圈，
    // 且共用普通 claim 那把令牌锁 —— 不另开一条不受节流的高速路）
    if (this.pendingSpawn > 0) {
      const rnd = mulberry32((Math.floor(this.time * 60) * 7919) | 0);
      let budget = MAX_SPAWN_PER_FRAME;
      while (budget-- > 0 && this.pendingSpawn > 0 && this.waveTokens >= 1) {
        const cellId = (rnd() * CELLS) | 0;
        this.waves.spawn(cellId, state.color[cellId]);
        this.waveTokens -= 1;
        this.pendingSpawn--;
      }
      if (this.pendingSpawn > 0) this.waveTokens = Math.max(this.waveTokens, 1.2);
    }

    // v3「格子上的名字」：最近署名的占领格（候选按 LABEL_REFRESH/LABEL_PUSH_SCAN 节流重扫）
    this.drawLabels(state);

    // 8) 冲击波（双层环 + 原点迸发）
    ctx.globalCompositeOperation = "lighter";
    this.waves.draw(ctx, this.ringColor, this.glows, hype);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // 9) 同阵营能量边（V-bloom #2）
    this.drawLinks(state, hype);

    // 10) hype：已占领格再加一层（+22% 亮度），并整体提亮中心
    if (hype > 0.004) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.22 * hype;
      ctx.drawImage(cellsCv, 0, 0, side, side);
      if (this.hypeGrad) {
        ctx.globalAlpha = 0.1 * hype;
        ctx.fillStyle = this.hypeGrad;
        ctx.fillRect(0, 0, side, side);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // 10.5) 外框发光（V-bloom #7）：6px 边框光，颜色 = 当前最旺阵营，三段 lighter 叠描边
    if (this.hottest > 0) {
      ctx.globalCompositeOperation = "lighter";
      drawBorderGlow(
        ctx,
        side,
        this.borderDim[this.hottest],
        this.borderMid[this.hottest],
        this.borderHot[this.hottest],
      );
      ctx.globalCompositeOperation = "source-over";
    }

    // 10.6) 整屏扫描光带（V-bloom #6）：~12px 高、opacity ~0.05，4 秒一轮自上而下
    const band = this.scanBand;
    if (band) {
      const bh = 14;
      const y = ((this.time * 0.25) % 1) * (side + bh * 2) - bh;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1;
      ctx.drawImage(band, 0, y, side, bh);
      ctx.globalCompositeOperation = "source-over";
    }

    // 11) vignette + 扫描线（hype 时少压一点 → 对比更强）
    if (this.overlay) {
      ctx.globalAlpha = 1 - 0.22 * hype;
      ctx.drawImage(this.overlay, 0, 0, side, side);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 逐格扫描：衰减 flash、识别新 claim、维护已占领格图层、收集本帧闪格。
   * 这是唯一每个 cell 都会走一遍的地方，全部用预分配数组和局部变量。
   */
  private updateCells(state: GridState, d: number): void {
    const cellsCtx = this.cellsCtx;
    if (!cellsCtx) return;

    const color = state.color;
    const heat = state.heat;
    const flash = state.flash;
    const layKey = this.layKey;
    const dyn = this.dyn;
    const sprites = this.sprites;
    const cell = this.cell;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const waveLight = this.waveLight;
    const dynHalo = this.dynHalo;
    const dynLight = this.dynLight;
    const dynHot = this.dynHot;
    const heatSum = this.heatSum;

    let dynN = 0;
    let dynHaloN = 0;
    let dynLightN = 0;
    let dynHotN = 0;
    let dirty = false;
    let budget = MAX_SPAWN_PER_FRAME;
    heatSum[0] = 0;
    heatSum[1] = 0;
    heatSum[2] = 0;
    heatSum[3] = 0;
    heatSum[4] = 0;

    // 冲击波是「重音」，不是「底色」：固定每秒 WAVE_PER_SEC 个，不随交易量增长。
    // 原来每笔 claim 都想放一圈（直径 8 格的环），演示跑 80 tx/s 时
    // 屏幕上同时挂着二十几圈，投影上就是一层乱飘的圆环，把版图盖住了 ——
    // 「会闪的马赛克」有一大半是这些环造成的。
    this.waveTokens = Math.min(2, this.waveTokens + d * WAVE_PER_SEC);

    let idx = 0;
    for (let y = 0; y < SIDE; y++) {
      const py = y * cell + gap2;
      for (let x = 0; x < SIDE; x++, idx++) {
        let c = color[idx];
        if (c > 4) c = 0; // 防御：非法阵营按空格处理

        let f = flash[idx];
        if (f > 0) {
          if (f >= 0.999) {
            // W-visual：新 claim —— 重锚定本格年龄基准。
            // main.ts 的 crowd 分支把 apply 的 age 写死 0,观察值不变时
            // 分不清「刚被 claim」和「三分钟前就钉死的那个 0」;
            // 但 apply 会把 flash 置 1,f>=0.999 就是它的事件源新鲜信号。
            this.ageMirror[idx] = state.age[idx];
            this.ageBase[idx] = this.time;
          }
          if (f >= 0.999 && budget > 0 && this.waveTokens >= 1) {
            // 新 claim：apply() 把 flash 设成 1，这里只看得见一次
            this.waves.spawn(idx, c);
            budget--;
            this.waveTokens -= 1;
          }
          f -= d * FLASH_DECAY;
          if (f < 0) f = 0;
          flash[idx] = f;
        }

        // 波前光场逐帧衰减（不管这格有没有被占，衰减总要对）
        const wl = waveLight[idx];
        if (wl > 0) {
          const nd = wl - d * LIGHT_DECAY;
          if (nd <= 0) waveLight[idx] = 0;
          else {
            waveLight[idx] = nd;
            dynLight[dynLightN++] = idx;
          }
        }

        if (c === 0) {
          if (layKey[idx] !== -1) {
            cellsCtx.clearRect(x * cell + gap2, py, inner, inner);
            layKey[idx] = -1;
            dirty = true;
          }
          continue;
        }

        // 已占领格：进光晕名单 + 累计阵营热度供外框选最旺者
        dynHalo[dynHaloN++] = idx;
        heatSum[c] += heat[idx];
        // 热区呼吸名单（V-bloom #5）：heat≥4 反复被抢的主战场
        if (heat[idx] >= HEAT_BREATH && dynHotN < HOT_CAP) dynHot[dynHotN++] = idx;

        // heat → 档位（0..5）；v3「热的土地」：年龄把档位往下压，冷了就暗
        // 注意别叫 f：下面第 472 行已有 `let f = flash[idx]`（闪烁衰减值）
        // W-visual：用「有效年龄」——demo 的来源 age 恒 0,直接用它格子永不冷却,
        // 署名墙也会被钉死(见 trackAgeAt 注释)。中继推进 age 时以新值重定基准,
        // 不重复计时;未知(Infinity)仍按全亮处理。
        const ag = trackAgeAt(
          state.age[idx],
          idx,
          this.ageMirror,
          this.ageBase,
          this.effAge,
          this.time,
        );
        const dim = ag === Infinity ? 1 : decayFactor(ag);
        let tier = heat[idx] >= HEAT_MAX ? TIERS - 1 : ((heat[idx] * (TIERS / HEAT_MAX)) | 0);
        if (tier < 0) tier = 0;
        else if (tier >= TIERS) tier = TIERS - 1;
        if (dim < 1) tier = Math.max(0, Math.round(tier * dim)); // 只压暗、不提亮；未知年龄不变

        const key = (c << 3) | tier;
        if (layKey[idx] !== key) {
          const px = x * cell + gap2;
          cellsCtx.clearRect(px, py, inner, inner);
          cellsCtx.drawImage(sprites[c][tier], px, py, inner, inner);
          layKey[idx] = key;
          dirty = true;
        }

        if (f > 0) dyn[dynN++] = idx;
      }
    }

    this.dynN = dynN;
    this.dynHaloN = dynHaloN;
    this.dynLightN = dynLightN;
    this.dynHotN = dynHotN;
    if (dirty) this.bloomDirty = true;

    // 外框发光取本帧 heat 总和最大的阵营（全空时为 0 → 不画）
    let hot = 0;
    let hotSum = 0;
    for (let f2 = 1; f2 <= 4; f2++) {
      if (heatSum[f2] > hotSum) {
        hotSum = heatSum[f2];
        hot = f2;
      }
    }
    this.hottest = hot;

    this.waves.update(d);
  }

  /**
   * 正在闪的格子：只画**一圈亮边**，不再整格加色 + 1.5× 外发光核。
   *
   * 为什么改：原来每格 flash 都是「整块 hot 贴图 + 1.5 倍大小的核心」，
   * 用 lighter 加色混合叠上去，持续 0.42s。演示跑 80 tx/s 时，
   * 同一时刻有 ~34 格在发光，核心互相压到邻居头上 ——
   * 投影上看起来是「一张会闪的马赛克」，而不是「一块块领地在被争夺」。
   * 版图才是这个项目要讲的东西，闪烁不该盖过它。
   *
   * 现在：格子主体永远保留阵营色（领土可读），只有边缘闪一下表示「刚易主」。
   * 细边不重叠，所以并发再高也不会糊成一片。
   * 「英雄脉冲」（最近一笔）另有 this.waves 的冲击波，不需要靠核心发光。
   */
  private drawFlashes(state: GridState, hype: number): void {
    const n = this.dynN;
    if (n === 0) return;

    const ctx = this.ctx;
    const flash = state.flash;
    const color = state.color;
    const dyn = this.dyn;
    const cell = this.cell;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const boost = 1 + 0.25 * hype;
    const lw = Math.max(1, cell * 0.16);

    ctx.lineWidth = lw;
    for (let k = 0; k < n; k++) {
      const i = dyn[k];
      const f = flash[i];
      if (f <= 0) continue;
      const c = color[i];
      if (c < 1 || c > 4) continue;

      const x = (i % SIDE) * cell + gap2;
      const y = ((i / SIDE) | 0) * cell + gap2;
      const e = f * f;

      // 半宽内缩，让描边完全落在格子里，不压邻居
      const inset = lw * 0.5;
      ctx.globalAlpha = Math.min(1, e * 0.85 * boost);
      ctx.strokeStyle = `rgb(${Math.round(255 * (0.55 + 0.45 * e))},${Math.round(
        255 * (0.55 + 0.45 * e),
      )},${Math.round(255 * (0.6 + 0.4 * e))})`;
      ctx.strokeRect(x + inset, y + inset, inner - lw, inner - lw);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 背景能量场（V-bloom #4）：以网格中心为焦点，4 个阵营色的柔和大光晕
   * 沿 sin/cos 缓慢漂移、呼吸，opacity 在 0.06–0.12 之间浮动。
   * 贴图是构建期烘好的 512px 径向渐变，每帧只有 4 次拉伸 drawImage。
   */
  private drawEnergyField(hype: number): void {
    const side = this.side;
    if (side <= 0 || this.fieldSprites.length < 4) return;
    const ctx = this.ctx;
    const t = this.time;
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 4; k++) {
      const cx = side * (0.5 + 0.17 * Math.sin(t * 0.13 + k * 1.9));
      const cy = side * (0.5 + 0.14 * Math.cos(t * 0.1 + k * 1.3));
      const s = side * (1.15 + 0.08 * Math.sin(t * 0.07 + k * 2.4));
      const a = (0.085 + 0.035 * Math.sin(t * 0.23 + k * 1.7)) * (1 + 0.25 * hype);
      ctx.globalAlpha = a > 0.14 ? 0.14 : a;
      ctx.drawImage(this.fieldSprites[k], cx - s * 0.5, cy - s * 0.5, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * 格体辉光（V-bloom #1）：每个已占领格一次 drawImage。
   * 贴图为「底层 3 圈加色光晕 + 顶层亮核」的预烘合成，heat 档位决定
   * 外扩半径与亮核亮度（tier 越大光越散、核越亮 —— 烘在贴图里）。
   */
  private drawHalos(hype: number): void {
    const n = this.dynHaloN;
    if (n === 0) return;
    const ctx = this.ctx;
    const layKey = this.layKey;
    const halos = this.halos;
    const cell = this.cell;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const hs = inner * HALO_EXTENT;
    const half = hs * 0.5;
    const dynHalo = this.dynHalo;

    // W-perf：满 occupancy 时改在半分辨率离屏里加色叠光，再一次拉伸合成回主画布。
    // lighter 是线性叠加、alpha 对叠加可交换：离屏按 alpha 1 叠、主画布按 ga 合成，
    // 与逐格 alpha ga 直绘数学等价；光晕本身是模糊团，降半分辨率肉眼不可辨。
    // 阈值以下（开局 / 真实链上稀疏 / resize 前）保持逐格直绘，画面锐度不变。
    const batch = n >= HALO_BATCH_MIN ? this.haloBatch : null;
    const bctx = batch ? this.haloBatchCtx : null;
    const g: CanvasRenderingContext2D = bctx ?? ctx;
    const ga = 0.9 + 0.25 * hype; // 注意：globalAlpha > 1 会被 Canvas 静默忽略
    if (bctx) bctx.clearRect(0, 0, this.side + 2, this.side + 2);

    g.globalCompositeOperation = "lighter";
    g.globalAlpha = bctx ? 1 : ga > 1 ? 1 : ga;
    for (let k = 0; k < n; k++) {
      const i = dynHalo[k];
      const key = layKey[i];
      if (key < 0) continue;
      const row = halos[key >> 3];
      if (!row) continue;
      const cx = (i % SIDE) * cell + gap2 + inner * 0.5;
      const cy = (((i / SIDE) | 0) * cell) + gap2 + inner * 0.5;
      g.drawImage(row[key & 7], cx - half, cy - half, hs, hs);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";

    if (bctx && batch) {
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = ga > 1 ? 1 : ga;
      ctx.drawImage(batch, 0, 0, this.side, this.side);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  /** 冲击波波前扫过的格子：用同阵营软光斑按光场强度瞬时提亮（V-bloom #3） */
  private drawWaveLight(state: GridState): void {
    const n = this.dynLightN;
    if (n === 0) return;
    const ctx = this.ctx;
    const cell = this.cell;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const waveLight = this.waveLight;
    const dynLight = this.dynLight;
    const color = state.color;
    const s = inner * 1.55;

    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < n; k++) {
      const i = dynLight[k];
      const a = waveLight[i];
      if (a <= 0) continue;
      const c = color[i];
      const gl = this.glows[c >= 1 && c <= 4 ? c : 0];
      if (!gl) continue;
      const cx = (i % SIDE) * cell + gap2 + inner * 0.5;
      const cy = (((i / SIDE) | 0) * cell) + gap2 + inner * 0.5;
      ctx.globalAlpha = a > 0.75 ? 0.75 : a;
      ctx.drawImage(gl, cx - s * 0.5, cy - s * 0.5, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** 热区呼吸（V-bloom #5）：heat≥4 的格子以 0.5s 周期做 ±0.08 的加色明暗搏动 */
  private drawHeatBreath(state: GridState): void {
    const n = this.dynHotN;
    if (n === 0) return;
    const ctx = this.ctx;
    const cell = this.cell;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const dynHot = this.dynHot;
    const color = state.color;
    const s = inner * 1.3;
    const w = (TAU / 0.5) * this.time;

    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < n; k++) {
      const i = dynHot[k];
      const a = 0.1 + 0.08 * Math.sin(w + (i % 37) * 0.42);
      const c = color[i];
      const gl = this.glows[c >= 1 && c <= 4 ? c : 0];
      if (!gl) continue;
      const cx = (i % SIDE) * cell + gap2 + inner * 0.5;
      const cy = (((i / SIDE) | 0) * cell) + gap2 + inner * 0.5;
      ctx.globalAlpha = a;
      ctx.drawImage(gl, cx - s * 0.5, cy - s * 0.5, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * v3「格子上的名字」：把最近署名的占领格写成一面面插在小格上的小旗 / 水印。
   * 只有中继代付的 claim 才带名 —— 大屏上能读到的每一个字都是真人，蜂群匿名。
   *
   * 关键纪律：
   *   · 主画布每帧被不透明背景盖满，所以署名必须**每帧重画**（旧代码用版本门控整段
   *     early-return，名字只活一帧就消失 —— 那是 bug，这里改成每帧绘制、版本只决定何时重扫候选）。
   *   · 只画「有署名 + 已占领 + 最近 LABEL_WINDOW 秒内 claim」的格子（selectLabelCells）。
   *   · 候选文案（含截断）只在重扫时算一次塞进定长缓冲，热路径不 new、不 measureText。
   */
  private drawLabels(state: GridState): void {
    const cell = this.cell;
    if (!cell || cell < 13) {
      this.labelN = 0; // 格太小字会糊成一团，宁可不写
      this.lastLabelScan = -1;
      return;
    }

    // 重扫候选：resize 变了 / 周期到了 / 版本变了且距上次扫描至少 LABEL_PUSH_SCAN。
    // W-visual：crowd 的 demo 流每帧 ++labelVersion，版本门不再直通每帧全表重扫
    // （每帧 rebuild = 2500 扫描 + 最多 36×多次 measureText + 排序分配，实测是
    // 满屏时最贵的署名开销）。周期门仍保证新名字 ≤0.4s 上墙，肉眼无差。
    if (
      this.resizeCount !== this.builtResize ||
      this.time - this.lastLabelScan >= LABEL_REFRESH ||
      (this.labelVersion !== this.builtVersion &&
        this.time - this.lastLabelScan >= LABEL_PUSH_SCAN)
    ) {
      this.rebuildLabels(state);
    }

    const n = this.labelN;
    if (n === 0) return;

    const ctx = this.ctx;
    const gap2 = this.gap * 0.5;
    const inner = this.inner;
    const fontPx = Math.max(8, Math.round(cell * 0.34));
    ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";

    const pad = Math.max(1, cell * 0.06);
    const poleW = Math.max(1.5, cell * 0.07);
    const idxs = this.labelIdx;
    const strs = this.labelStr;
    const exps = this.labelExpire;

    for (let k = 0; k < n; k++) {
      const remain = exps[k] - this.time;
      if (remain <= 0) continue; // 已到期：这帧不画，留给下次重扫压缩
      const i = idxs[k];
      const x = (i % SIDE) * cell + gap2;
      const y = ((i / SIDE) | 0) * cell + gap2;
      const a = remain < LABEL_FADE ? remain / LABEL_FADE : 1; // 临期淡出
      ctx.globalAlpha = a;

      const ink = this.labelInk[state.color[i]] ?? "rgba(255,255,255,0.96)";
      // 小旗的旗杆：一格宽的亮色竖条
      ctx.fillStyle = ink;
      ctx.fillRect(x + pad, y + pad, poleW, inner - pad * 2);

      // 名字：暗底描一遍再压亮色，亮格上也能读（不用 shadowBlur）
      const tx = x + pad + poleW + pad;
      const ty = y + pad;
      const s = strs[k];
      if (s.length > 0) {
        ctx.fillStyle = "rgba(8,5,18,0.5)";
        ctx.fillText(s, tx + 0.7, ty + 0.7);
        ctx.fillStyle = ink;
        ctx.fillText(s, tx, ty);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** 重扫候选：选出格子、按当前方格宽裁好文案、算到期时刻，写进定长缓冲 */
  private rebuildLabels(state: GridState): void {
    this.builtVersion = this.labelVersion;
    this.builtResize = this.resizeCount;
    this.lastLabelScan = this.time;

    const cell = this.cell;
    const inner = this.inner;
    const pad = Math.max(1, cell * 0.06);
    const poleW = Math.max(1.5, cell * 0.07);
    const fontPx = Math.max(8, Math.round(cell * 0.34));

    const ctx = this.ctx;
    ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;

    // W-visual：选择与到期都吃「有效年龄」（updateCells 每帧刷新）。
    // 直接吃来源 age 的话，demo 的恒 0 会让所有历史格永远新鲜：
    // 候选按 index 稳定排序截断 → 墙钉死顶行、淡出永不触发（实拍 rowHistogram 全 0 行）。
    const chosen = selectLabelCells(state.color, state.labelOf, this.effAge);
    // 文字可用宽 = 格内宽 - 左pad - 旗宽 - 旗与字间距 - 右pad
    const avail = inner - pad - poleW - pad - pad;

    const idxs = this.labelIdx;
    const strs = this.labelStr;
    const exps = this.labelExpire;

    let n = 0;
    for (let k = 0; k < chosen.length && n < LABEL_CAP; k++) {
      const i = chosen[k];
      const raw = state.labelOf[i];
      if (raw == null) continue;
      idxs[n] = i;
      strs[n] = truncateToWidth(ctx, raw.trim(), avail);
      exps[n] = this.time + Math.max(0, LABEL_WINDOW - this.effAge[i]);
      n++;
    }
    this.labelN = n;
  }

  /**
   * 同阵营能量边（V-bloom #2）：相邻同色格缝里的一段发光短线。
   *   · 宽度 1.5–3px 随两侧 heat 平均值分三档（档位 = 每帧最多 24 条批量描边）；
   *   · 「端点暗、中点亮」用两次描边模拟渐变（端点串 alpha 0.4 拉满整段，
   *     中点串 alpha 0.9 只画中心 45%），全程零 gradient 对象；
   *   · 只比较右 / 下邻居，每条边只画一次。
   * 每档一条路径批量 stroke：每帧 ≤ 24 次扫描 × 2500 次整数比较，可忽略。
   */
  private drawLinks(state: GridState, hype: number): void {
    const color = state.color;
    const heat = state.heat;
    const cell = this.cell;
    const seg = this.gap * 0.5 + 0.9;
    const midSeg = seg * 0.45;
    const ctx = this.ctx;
    const a = Math.min(1, 0.9 + 0.25 * hype);

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.globalAlpha = a;

    for (let f = 1; f <= 4; f++) {
      for (let b = 0; b < 3; b++) {
        const lw = b === 0 ? 1.5 : b === 1 ? 2.25 : 3;
        const lo = b === 0 ? 0 : b === 1 ? 8 : 20;
        const hi = b === 2 ? Infinity : lo === 0 ? 8 : 20;

        // 整段：暗端点底光
        let any = false;
        ctx.beginPath();
        let idx = 0;
        for (let y = 0; y < SIDE; y++) {
          const cy = (y + 0.5) * cell;
          for (let x = 0; x < SIDE; x++, idx++) {
            if (color[idx] !== f) continue;
            if (x + 1 < SIDE && color[idx + 1] === f) {
              const h = (heat[idx] + heat[idx + 1]) * 0.5;
              if (h >= lo && h < hi) {
                const bx = (x + 1) * cell;
                ctx.moveTo(bx - seg, cy);
                ctx.lineTo(bx + seg, cy);
                any = true;
              }
            }
            if (y + 1 < SIDE && color[idx + SIDE] === f) {
              const h = (heat[idx] + heat[idx + SIDE]) * 0.5;
              if (h >= lo && h < hi) {
                const by = (y + 1) * cell;
                const cxm = (x + 0.5) * cell;
                ctx.moveTo(cxm, by - seg);
                ctx.lineTo(cxm, by + seg);
                any = true;
              }
            }
          }
        }
        if (!any) continue;

        ctx.strokeStyle = this.edgeEnd[f];
        ctx.lineWidth = lw;
        ctx.stroke();

        // 中心段：亮核，叠出「中点亮、两端暗」的能量渐变
        ctx.beginPath();
        idx = 0;
        for (let y = 0; y < SIDE; y++) {
          const cy = (y + 0.5) * cell;
          for (let x = 0; x < SIDE; x++, idx++) {
            if (color[idx] !== f) continue;
            if (x + 1 < SIDE && color[idx + 1] === f) {
              const h = (heat[idx] + heat[idx + 1]) * 0.5;
              if (h >= lo && h < hi) {
                const bx = (x + 1) * cell;
                ctx.moveTo(bx - midSeg, cy);
                ctx.lineTo(bx + midSeg, cy);
              }
            }
            if (y + 1 < SIDE && color[idx + SIDE] === f) {
              const h = (heat[idx] + heat[idx + SIDE]) * 0.5;
              if (h >= lo && h < hi) {
                const by = (y + 1) * cell;
                const cxm = (x + 0.5) * cell;
                ctx.moveTo(cxm, by - midSeg);
                ctx.lineTo(cxm, by + midSeg);
              }
            }
          }
        }
        ctx.strokeStyle = this.edgeMid[f];
        ctx.lineWidth = Math.max(1, lw * 0.7);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * 领地热场：50×50 的 ImageData 每格一个像素，放大后以叠加混合铺满。
   * 只在图层脏了才重建（putImageData 4KB，可忽略）。
   */
  private drawBloom(hype: number): void {
    const cv = this.bloom;
    const bctx = this.bloomCtx;
    const img = this.bloomImg;
    if (!cv || !bctx || !img) return;

    if (this.bloomDirty) {
      const data = img.data;
      const layKey = this.layKey;
      const pal = this.palette;
      for (let i = 0, p = 0; i < CELLS; i++, p += 4) {
        const key = layKey[i];
        if (key < 0) {
          data[p + 3] = 0;
          continue;
        }
        const c = key >> 3;
        const tier = key & 7;
        data[p] = pal[c * 3];
        data[p + 1] = pal[c * 3 + 1];
        data[p + 2] = pal[c * 3 + 2];
        data[p + 3] = 16 + tier * 22; // 16..126
      }
      bctx.putImageData(img, 0, 0);
      this.bloomDirty = false;
    }

    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.34 * (0.72 + 0.28 * hype);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cv, 0, 0, this.side, this.side);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}
