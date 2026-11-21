/**
 * MONAD BATTLEFIELD · 观众页（W3）
 *
 * 目标：78 个人在手机上单手点一下，格子就归他了。
 *
 * 设计约束：
 *   - 不引第三方库（纯 TS + CSS），也不把 viem 拖进手机端 ——
 *     78 台手机各自连 RPC 会同时压垮节点和 4G，所以全部走中继。
 *   - 单点即抢：pointerdown 定位 → pointerup 提交，乐观高亮先上屏。
 *   - 失败绝不静默：红条 + 震动 + 冷却倒计时，用户永远知道自己那一格到底成没成。
 *   - 50×50 在手机上每格只有 ~7px，所以按下去会弹出放大镜（loupe），
 *     让「点哪格」变成确定的事实而不是猜。
 *
 * 尺寸/颜色与大屏共享：SIDE / CELLS / FACTIONS 直接 import 自 grid.ts（冻结接口）。
 */

import { CELLS, FACTIONS, SIDE } from "./grid";
import { shouldFireHold } from "./metrics";

/* ────────────────────────────────────────────────────────────
 * 0. 环境 / 配置
 * ──────────────────────────────────────────────────────────── */

type Config = {
  contract: `0x${string}`;
  chainId: number;
  rpc: string;
  joinUrl: string;
  factionNames: string[];
  error?: string;
};

type ClaimResp = {
  ok: boolean;
  txHash?: string | null;
  queue?: number;
  error?: string;
  detail?: string;
  retryAfterMs?: number;
  /** B-sync：中继走了 eth_sendRawTransactionSync 并探测到回执时为 true（旧中继不返回此字段 → undefined，按未确认处理） */
  confirmed?: boolean;
  /** 同步回执里的区块号；拿不到 = null（已确认但没有区块信息） */
  blockNumber?: number | null;
  /** 同步回执显示交易在链上但被合约拒绝（这一格没生效） */
  reverted?: boolean;
  /**
   * E-fixes#9：中继侧量的 tap→链上确认耗时（ms，sync 路径才有）。
   * 口径：中继收到请求 → 拿到同步回执，**不含**画面同步，也不含手机→中继的上行。
   */
  confirmMs?: number;
};

type StatsResp = {
  queued: number;
  sent: number;
  failed: number;
  tps: number;
  keys: number;
  /** E-fixes#5：当前「没 gas 停用」的中继钱包数。>0 = 链上通道干涸，弹持久横幅 */
  dryKeys?: number;
  uptimeSec: number;
  /** G-cooldown：中继开着「演示对照模式」（每格 3s 服务端冷却）时为 true */
  cooldownMode?: boolean;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const elFactions = $<HTMLDivElement>("factions");
const elStage = $<HTMLElement>("stage");
const elCanvas = $<HTMLCanvasElement>("grid");
const elFaction = $<HTMLSpanElement>("m-faction");
const elOccupied = $<HTMLElement>("m-occupied");
const elEmptyHint = $<HTMLDivElement>("empty-hint");
const elMine = $<HTMLSpanElement>("m-mine");
const elQueue = $<HTMLSpanElement>("m-queue");
const elBanner = $<HTMLDivElement>("banner");
const elErr = $<HTMLDivElement>("err");
const elTip = $<HTMLSpanElement>("tip");
const elLast = $<HTMLSpanElement>("last");
const elCool = $<HTMLDivElement>("cooldown");

/** v3：观众代号输入框（值由 LS_NICK 的 loadNick 填充，见文件后部） */
const elNick = $<HTMLInputElement>("nick");

/** 中继的 baseURL：同源优先；vite dev（:5180）跑的时候靠 ?relay= 或默认 8791 */
const params = new URLSearchParams(location.search);
const RELAY_OVERRIDE = (params.get("relay") ?? "").trim().replace(/\/$/, "");

let apiBase = RELAY_OVERRIDE;
let cfg: Config | null = null;
let offline = false;

/* ────────────────────────────────────────────────────────────
 * 1. 本地持久化（阵营 / clientId / 今日战绩）
 * ──────────────────────────────────────────────────────────── */

const LS_FACTION = "mbf.faction";
const LS_CLIENT = "mbf.clientId";
const LS_MINE = "mbf.mine";

/**
 * v3「人肉车道」的观众代号。默认自动生成「玩家·XXXX」，可改，
 * 随每次 claim 提交 —— 中继把它写进该格标签，大屏的署名墙读到的都是真人。
 */
const LS_NICK = "mbf.nick";

function defaultNick(): string {
  const buf = new Uint8Array(3);
  crypto.getRandomValues(buf);
  return (
    "玩家·" +
    Array.from(buf, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
      .slice(0, 6)
  );
}

function loadNick(): string {
  let n = lsGet(LS_NICK)?.trim();
  if (!n || n.length > 16) {
    n = defaultNick();
    lsSet(LS_NICK, n);
  }
  return n;
}

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 无痕模式 / 存储满：不影响参战 */
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadMine(): number {
  try {
    const raw = lsGet(LS_MINE);
    if (!raw) return 0;
    const o = JSON.parse(raw) as { day?: string; n?: number };
    if (o.day !== todayKey()) return 0;
    return Math.max(0, Math.floor(Number(o.n ?? 0)));
  } catch {
    return 0;
  }
}

function saveMine(n: number) {
  lsSet(LS_MINE, JSON.stringify({ day: todayKey(), n }));
}

function clientId(): string {
  let id = lsGet(LS_CLIENT);
  if (!id || id.length < 8) {
    const buf = new Uint8Array(9);
    crypto.getRandomValues(buf);
    id = Array.from(buf, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
    lsSet(LS_CLIENT, id);
  }
  return id;
}

let mine = loadMine();
let faction = 0;
/** v3：观众代号，随每次 claim 提交（写进大屏的署名墙） */
let nick = loadNick();

/* ────────────────────────────────────────────────────────────
 * 2. 网格状态 + 渲染
 * ──────────────────────────────────────────────────────────── */

const color = new Uint8Array(CELLS); // 0 = 空，1..4 = 我方/已知颜色
const heat = new Uint8Array(CELLS); // 本地已知热度（0..255）
const flash = new Float32Array(CELLS); // 1 → 0 衰减

// 与主屏一致的哑光材质色板（旧的霓虹色在大屏旁边会显得廉价）
const RGB: Array<[number, number, number]> = [
  [0, 0, 0],
  [139, 123, 216], // 紫 #8B7BD8
  [74, 157, 181],  // 青 #4A9DB5
  [201, 162, 39],  // 琥珀 #C9A227
  [181, 82, 95],   // 绯 #B5525F
];

const RGB_HEX = ["", "#8B7BD8", "#4A9DB5", "#C9A227", "#B5525F"];

for (let i = 1; i < RGB.length; i++) {
  const hex = FACTIONS[i]?.hex;
  if (typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex.slice(1), 16);
    RGB[i] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
}

const ctx = elCanvas.getContext("2d", { alpha: false });
if (!ctx) throw new Error("无法获取 2d context");

/** 静态层：所有格子画在这块离屏画布上，主循环只做一次 blit */
let base: HTMLCanvasElement | null = null;
let baseCtx: CanvasRenderingContext2D | null = null;

let dpr = 1;
let cssSize = 0; // canvas 的 CSS 边长（正方形）
let cellPx = 0; // 每格 CSS 像素
let cellDev = 0; // 每格设备像素
/** 上次布局时容器可用的那一边（用于判断「真的需要重排」） */
let lastAvail = 0;

/** 正在闪的格子（最多留 24 个，手机上限流） */
const flashing: number[] = [];
let rafId = 0;
let hover = -1; // 手指按住的格
let hoverExpire = 0; // 按下结束后的高亮保留到何时

function buildBase() {
  base = document.createElement("canvas");
  base.width = Math.max(1, Math.round(cssSize * dpr));
  base.height = base.width;
  baseCtx = base.getContext("2d", { alpha: false });
  if (!baseCtx) return;
  baseCtx.fillStyle = "#0B0817";
  baseCtx.fillRect(0, 0, base.width, base.height);
  for (let i = 0; i < CELLS; i++) paintCell(i, false);
}

/** 单格重绘（增量）—— 只有变了的格子才付这笔钱 */
function paintCell(id: number, blit = true) {
  if (!baseCtx || !base) return;
  const x = (id % SIDE) * cellDev;
  const y = Math.floor(id / SIDE) * cellDev;
  const gap = Math.max(1, cellDev * 0.14);
  const size = Math.max(1, cellDev - gap);

  const c = color[id];
  if (c === 0) {
    baseCtx.fillStyle = "#12101F";
  } else {
    const [r, g, b] = RGB[c] ?? RGB[1];
    // heat 分层：0 → 0.52，8+ → 1.0，让被反复抢的格子明显更亮
    const t = 0.52 + 0.48 * Math.min(1, heat[id] / 8);
    baseCtx.fillStyle = `rgb(${Math.round(r * t)},${Math.round(g * t)},${Math.round(b * t)})`;
  }
  baseCtx.fillRect(x, y, size, size);

  if (blit) drawFrame();
}

function layout() {
  const rect = elStage.getBoundingClientRect();
  const avail = Math.max(80, Math.min(rect.width, rect.height));
  const nextDpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  // 尺寸和 dpr 都没变：没必要重建 2500 格的离屏图层（横屏 ResizeObserver 会频繁回调）
  if (Math.abs(avail - lastAvail) < 1 && nextDpr === dpr && base) return;

  lastAvail = avail;
  dpr = nextDpr;
  cssSize = Math.floor(avail);
  cellPx = cssSize / SIDE;
  cellDev = (cssSize * dpr) / SIDE;

  elCanvas.style.width = `${cssSize}px`;
  elCanvas.style.height = `${cssSize}px`;
  elCanvas.width = Math.round(cssSize * dpr);
  elCanvas.height = Math.round(cssSize * dpr);

  buildBase();
  drawFrame();
}

function drawFrame() {
  if (!ctx || !base) return;
  ctx.fillStyle = "#07050F";
  ctx.fillRect(0, 0, elCanvas.width, elCanvas.height);
  ctx.drawImage(base, 0, 0);

  // 冲击闪烁
  const now = performance.now();
  let alive = 0;
  for (let i = 0; i < flashing.length; i++) {
    const id = flashing[i];
    const f = flash[id];
    if (f <= 0.01) continue;
    flashing[alive++] = id;
    const x = (id % SIDE) * cellDev;
    const y = Math.floor(id / SIDE) * cellDev;
    ctx.globalAlpha = Math.min(1, f) * 0.85;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(x, y, Math.max(1, cellDev - Math.max(1, cellDev * 0.14)), Math.max(1, cellDev - Math.max(1, cellDev * 0.14)));
  }
  flashing.length = alive;
  ctx.globalAlpha = 1;

  // 我方领地描边：一眼看出哪些格子是我的
  ctx.strokeStyle = "rgba(168,85,247,0.0)";

  // 按下位置：十字准星 + 放大镜
  if (hover >= 0 && (pointerDown || now < hoverExpire)) {
    drawHover(hover, now);
  }
}

function drawHover(id: number, now: number) {
  if (!ctx) return;
  const cx = id % SIDE;
  const cy = Math.floor(id / SIDE);
  const x = cx * cellDev;
  const y = cy * cellDev;
  const s = Math.max(1, cellDev);

  // 准星：整行整列各一条极细线，成本 O(1)
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(x + s / 2, 0);
  ctx.lineTo(x + s / 2, elCanvas.height);
  ctx.moveTo(0, y + s / 2);
  ctx.lineTo(elCanvas.width, y + s / 2);
  ctx.stroke();

  // 选中格白框（呼吸）
  const pulse = 0.55 + 0.45 * Math.sin(now / 140);
  ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.45 * pulse})`;
  ctx.lineWidth = Math.max(2, dpr * 2);
  ctx.strokeRect(x - 1, y - 1, s + 2, s + 2);

  // 放大镜：以手指为中心取 7×7，画在手指上方的角落
  const span = 7;
  const block = Math.min(cssSize * 0.42, 168);
  const px = block / span;
  const bx = cx < SIDE / 2 ? elCanvas.width - block - 8 * dpr : 8 * dpr;
  const by = cy < SIDE / 2 ? elCanvas.height - block - 8 * dpr : 8 * dpr;

  ctx.save();
  ctx.fillStyle = "rgba(7,5,15,0.92)";
  ctx.fillRect(bx - 2 * dpr, by - 2 * dpr, block + 4 * dpr, block + 4 * dpr);
  ctx.strokeStyle = "rgba(168,85,247,0.85)";
  ctx.lineWidth = Math.max(1, dpr * 1.5);
  ctx.strokeRect(bx - 2 * dpr, by - 2 * dpr, block + 4 * dpr, block + 4 * dpr);

  const x0 = Math.max(0, Math.min(SIDE - span, cx - 3));
  const y0 = Math.max(0, Math.min(SIDE - span, cy - 3));
  const gap = Math.max(1, px * 0.12);
  for (let r = 0; r < span; r++) {
    for (let c = 0; c < span; c++) {
      const ii = (y0 + r) * SIDE + (x0 + c);
      const cc = color[ii];
      const tint = cc === 0 ? [18, 16, 31] : RGB[cc];
      const t = cc === 0 ? 1 : 0.52 + 0.48 * Math.min(1, heat[ii] / 8);
      ctx.fillStyle = `rgb(${Math.round(tint[0] * t)},${Math.round(tint[1] * t)},${Math.round(tint[2] * t)})`;
      ctx.fillRect(bx + c * px, by + r * px, px - gap, px - gap);
    }
  }
  // 放大镜里的中心格
  const hx = bx + (cx - x0) * px;
  const hy = by + (cy - y0) * px;
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = Math.max(1.5, dpr * 1.5);
  ctx.strokeRect(hx, hy, px, px);

  // 坐标
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
  ctx.fillText(`${String.fromCharCode(65 + (cx % 26))}${cy + 1}`, bx, by - 5 * dpr);
  ctx.restore();
}

function tickFlash() {
  let any = false;
  for (let i = 0; i < flashing.length; i++) {
    const id = flashing[i];
    flash[id] -= 0.045;
    if (flash[id] > 0.01) any = true;
    else flash[id] = 0;
  }
  if (hover >= 0 || performance.now() < hoverExpire) any = true;
  drawFrame();
  rafId = any ? requestAnimationFrame(tickFlash) : 0;
}

function kick() {
  if (!rafId) rafId = requestAnimationFrame(tickFlash);
}

/* ────────────────────────────────────────────────────────────
 * 3. 反馈（红条 / 震动 / 排队）
 * ──────────────────────────────────────────────────────────── */

let errTimer = 0;

const ERR_TEXT: Record<string, string> = {
  rate_limited: "手太快了 · 缓一秒再抢",
  /** E-fixes#6：IP 第二桶（脚本刷量才会撞；真人点不到这条） */
  too_many: "这一片的请求太快了 · 缓一会儿再抢",
  queue_full: "中继排队已满 · 稍等",
  send_failed: "上链失败 · 再点一次",
  not_deployed: "合约未部署 · 这一格没上链",
  relayer_unfunded: "中继钱包没 gas · 找工作人员",
  no_relayer_available: "中继忙不过来 · 再点一次",
  network: "网络断了 · 检查 Wi-Fi",
  no_faction: "先选阵营",
  invalid_cell: "格子无效",
  invalid_faction: "阵营无效",
  reverted: "交易在链上 · 但这一格没生效 · 再点一次",
  /** G-cooldown 对照模式：兜底文案（claim() 有专属中性分支，漏网到这也不裸显 code）。
   *  这是演示特性不是故障 —— 服务端在发 tx 前拦下，一克 gas 都没烧。 */
  cooldown_3s: "对照模式 · 这一格 3s 内刚点过 · 未上链（省 gas）",
};

function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 桌面/被策略禁用：无所谓 */
  }
}

function showError(code: string, extra?: string) {
  const text = ERR_TEXT[code] ?? (extra ? `${code} · ${extra.slice(0, 60)}` : code);
  elErr.hidden = false;
  elErr.textContent = text;
  // 重启动画
  elErr.classList.remove("pop");
  void elErr.offsetWidth;
  elErr.classList.add("pop");

  buzz([0, 45, 40, 65]);

  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => {
    elErr.hidden = true;
  }, 3200);
}

function setBanner(text: string | null) {
  if (!text) {
    elBanner.hidden = true;
    elBanner.textContent = "";
    return;
  }
  elBanner.hidden = false;
  elBanner.textContent = text;
}

/**
 * E-fixes#5（C3 T2）：干涸是「暂存」不是「失败」。
 *
 * 原来第 31 笔开始红条 3.2s 闪一下「中继钱包没 gas」，观众继续点、继续吃 503，
 * 界面却回到一切正常的假象。现在：/api/stats 的 dryKeys>0（或 claim 直接返回
 * relayer_unfunded）→ 走 setBanner 的**持久**横幅（不是 showError 那条自动消失的），
 * 明说点击被记下、可以找工作人员续气。补上 gas 后下一轮 poll 自动撤掉。
 */
const DRY_BANNER = "链上通道暂满 · 你的点击已记下 · 可找工作人员续气";
/** 干涸横幅是否由我们挂上（撤的时候只撤自己挂的，不抢「失联/未部署」横幅的位） */
let dryBannerActive = false;

/**
 * G-cooldown · 顶栏「对照模式」小字（演示差异化，与往届 #363 千人像素战争对照）。
 *
 * join.html 不在本次改动范围内（文件域只给了 join.ts 的顶栏 + claim 映射），
 * 所以这个 badge 沿用 main.ts 的先例：动态 createElement + 内联样式，挂进 #hud。
 * 只有 statsBody 报 cooldownMode=true（中继以 COOLDOWN_MODE=1 起）时才出现 ——
 * 关开关时它永远 hidden，对现行为零影响。文案点明这是**服务端在发 tx 前拦截**、
 * 省 gas，正是 #363 合约冷却（被拒也烧 gas）的对照面（见 docs/ab-result.json）。
 */
const elCdMode = document.createElement("span");
elCdMode.id = "cooldown-mode";
elCdMode.style.cssText =
  "font-size:10px;opacity:.72;letter-spacing:.02em;padding:1px 6px;border:1px solid rgba(168,85,247,.5);border-radius:6px;color:#c9a4ff;white-space:nowrap;";
elCdMode.hidden = true;
elCdMode.textContent = "对照模式·同格3s冷却";
function setCooldownBadge(on: unknown) {
  // 关（mode=0 / stats 没这字段）：只隐藏，从不抢挂 DOM —— 现行为零变化
  if (on !== true) {
    elCdMode.hidden = true;
    return;
  }
  // 开：首次挂进顶栏，之后复用同一节点
  if (!elCdMode.isConnected) {
    const hud = document.getElementById("hud");
    if (hud) hud.appendChild(elCdMode);
  }
  elCdMode.hidden = false;
}

/* ────────────────────────────────────────────────────────────
 * 4. 网络
 * ──────────────────────────────────────────────────────────── */

/** 传入完整 URL（调用方自己拼 base）—— 这里不再二次拼接，否则会出现 base+base 的坏地址 */
async function getJSON<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * B-sync：观众单次点击默认要同步回执（sync:true）—— 中继会等交易落块、
 * 把「已上链 @block N」当场带回手机。
 * - 同步路径只给「一次一下」的点击用。按住连点（人肉车道）逐笔传 sync=false，
 *   蜂群/静默墙在服务端本来也不走 sync —— 吞吐路径不动，这是铁律。
 * - 服务端任何同步失败都自动降级回普通发送（confirmed 缺省/为 false），
 *   所以这里的超时略放宽（15s）以覆盖「等一个块」的最长合理延迟；
 *   真超时也只是回到今天的「未确认」体验，UI 不会卡死。
 */
async function postClaim(cell: number, sync: boolean): Promise<ClaimResp> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), sync ? 15_000 : 8_000);
  try {
    const r = await fetch(`${apiBase}/api/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // v3：代号随 claim 一起上中继 —— 它会被写进该格的标签（大屏署名墙）
      body: JSON.stringify({
        cell,
        faction,
        clientId: clientId(),
        nick,
        ...(sync ? { sync: true } : {}),
      }),
      signal: ac.signal,
    });
    const data = (await r.json().catch(() => ({ ok: false, error: "bad_response" }))) as ClaimResp;
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** 找中继：同源 → ?relay= → 当前主机 8791 */
async function loadConfig() {
  const candidates = [
    RELAY_OVERRIDE,
    "",
    `http://${location.hostname || "127.0.0.1"}:8791`,
  ].filter((v, i, a) => v !== null && a.indexOf(v) === i);

  let lastErr: unknown = null;
  for (const base of candidates) {
    try {
      const c = await getJSON<Config>(`${base}/api/config`, 4000);
      if (!c || typeof c.contract !== "string") throw new Error("bad config");
      apiBase = base;
      cfg = c;
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("config unreachable");
}

/* ────────────────────────────────────────────────────────────
 * 5. 阵营选择
 * ──────────────────────────────────────────────────────────── */

const NAMES = ["紫", "青", "琥珀", "绯"];

function renderFactions(names: string[]) {
  elFactions.innerHTML = "";
  for (let i = 1; i <= 4; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `faction f${i}`;
    btn.dataset.faction = String(i);
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    const label = names[i - 1] ?? NAMES[i - 1];
    btn.innerHTML = `<span class="sw"></span><span class="nm">${label}</span><span class="tick">✓</span>`;
    btn.addEventListener("click", () => selectFaction(i));
    elFactions.appendChild(btn);
  }
  syncFactionUI();
}

function selectFaction(f: number) {
  if (f < 1 || f > 4) return;
  faction = f;
  lsSet(LS_FACTION, String(f));
  document.documentElement.style.setProperty("--me", FACTIONS[f]?.hex ?? "#A855F7");
  setPicker(false); // 选完收起
  buzz(18);
  setBanner(null);
}

function syncFactionUI() {
  for (const el of Array.from(elFactions.querySelectorAll<HTMLButtonElement>(".faction"))) {
    const on = Number(el.dataset.faction) === faction;
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }
  elFaction.textContent = faction ? (FACTIONS[faction]?.name ?? NAMES[faction - 1]) : "未选";
  elTip.textContent = pickerOpen ? "选一个阵营" : "点哪格抢哪格 · 点上方阵营可换";
  document.body.classList.toggle("has-faction", faction > 0 && !pickerOpen);
}

/* ── 阵营选择器的展开 / 收起 ──────────────────────────────
 * 选完就收起把屏幕让给网格；但必须留一条回去的路 ——
 * 现场经常有人选错阵营，不能逼他清 localStorage 或刷新。
 */
let pickerOpen = true;

function setPicker(open: boolean) {
  pickerOpen = open;
  syncFactionUI();
}

/* ────────────────────────────────────────────────────────────
 * 6. 抢格子
 * ──────────────────────────────────────────────────────────── */

let pointerDown = false;
let cdUntil = 0; // 限频本地冷却
let cdTimer = 0;
let inflight = 0;
/** v3 人肉车道：按住连点的计时器；以及上一次真正发车的时刻（节流锚点） */
let holdTimer = 0;
let lastFiredAt = 0;

function startCooldown(ms: number) {
  cdUntil = Date.now() + ms;
  elCool.hidden = false;
  clearInterval(cdTimer);
  const tick = () => {
    const left = cdUntil - Date.now();
    if (left <= 0) {
      clearInterval(cdTimer);
      elCool.hidden = true;
      return;
    }
    elCool.textContent = `缓 ${(left / 1000).toFixed(1)}s`;
  };
  tick();
  cdTimer = window.setInterval(tick, 100);
}

async function claim(id: number, sync = true) {
  if (id < 0 || id >= CELLS) return;

  // E-fixes#4①（C3 T1）：同格 in-flight 去重短路 —— 一笔还在途（最长 15s）时
  // 双击/连点同一格不再发第二笔真交易。合约 last-write-wins 版图无害，
  // 但每一笔重复都是 0.0066 MON 白烧（弱网重试正是重复烧钱的高发段）。
  if (pendingLocal.has(id)) return;

  if (!faction) {
    showError("no_faction");
    elFactions.classList.remove("shake");
    void elFactions.offsetWidth;
    elFactions.classList.add("shake");
    return;
  }
  if (Date.now() < cdUntil) {
    showError("rate_limited");
    return;
  }

  // v3 人肉车道：记一笔节流锚点。按住时每 1s 才真正发一次（服务端限频是第二道闸）
  lastFiredAt = Date.now();

  // 乐观更新：先让手指看到反馈，再等网络
  const prevColor = color[id];
  const prevHeat = heat[id];
  color[id] = faction;
  heat[id] = Math.min(255, prevHeat + 1);
  flash[id] = 1;
  if (!flashing.includes(id)) flashing.push(id);
  paintCell(id);
  kick();

  mine++;
  elMine.textContent = String(mine);
  saveMine(mine);
  pendingLocal.add(id);

  inflight++;
  const t0 = performance.now();
  // E-fixes#4①：请求超时（AbortError）不回滚 —— 中继收到即已排队/发送，
  // 回滚会造成「手机说失败、大屏亮了、刷新后格子又冒出来」的当场穿帮。
  // 这一格的最终裁决交给链上真相（下一轮 syncGrid 对账后从 pendingLocal 摘除）。
  let keepPending = false;
  try {
    const r = await postClaim(id, sync);
    const dt = performance.now() - t0;

    if (r.ok) {
      if (typeof r.queue === "number") elQueue.textContent = String(r.queue);

      // B-sync：拿到同步回执 —— 这一次「已上链」是当场兑现的承诺：
      // 交易哈希 + 区块号来自节点的 sendRawTransactionSync 回执，不是中继口头保证。
      if (r.confirmed && !r.reverted) {
        // E-fixes#9：本次 tap→链上确认（中继侧计时，不含画面同步）。
        // 只挂在 confirmed 分支 —— 降级发送的 elapsed 不是「确认」，不许冒充。
        const lat = typeof r.confirmMs === "number" ? ` · 本次确认 ${(r.confirmMs / 1000).toFixed(1)}s` : "";
        if (typeof r.blockNumber === "number") {
          elLast.textContent = `#${id} ✓ 已上链 · block #${r.blockNumber}${lat}`;
        } else if (r.txHash) {
          elLast.textContent = `#${id} ✓ 已确认 · tx ${r.txHash.slice(0, 10)}…${lat}`;
        } else {
          elLast.textContent = `#${id} ✓ 已上链${lat}`;
        }
        buzz([0, 14, 50, 14]); // 双击短震：和「已提交」的单震区分开
        return;
      }

      // 回执说这笔在链上但没生效（合约拒绝）→ 乐观更新必须回滚，如实报错
      if (r.reverted) {
        color[id] = prevColor;
        heat[id] = prevHeat;
        paintCell(id);
        mine = Math.max(0, mine - 1);
        elMine.textContent = String(mine);
        saveMine(mine);
        elLast.textContent = `#${id} 回执：未生效`;
        showError("reverted", r.txHash ?? undefined);
        return;
      }

      // 没拿到确认（旧中继 / 爆发降级 / 同步失败已转普通发送）：
      // 只能说「已提交」：r.ok 代表中继接收并 broadcast 了，
      // 还没落块，也可能随后 revert。写「已上链」是当下无法兑现的承诺
      // （原审查发现：手机会写「已上链」，刷新后那格却不见了 —— 因为它其实没成）。
      elLast.textContent = `#${id} 已提交 ${dt < 400 ? "· " + Math.round(dt) + "ms" : ""}`;
      buzz(12);
      return;
    }

    // 失败：回滚这一格，让画面和链上一致
    color[id] = prevColor;
    heat[id] = prevHeat;
    paintCell(id);
    mine = Math.max(0, mine - 1);
    elMine.textContent = String(mine);
    saveMine(mine);

    const code = r.error ?? "send_failed";
    // G-cooldown 演示对照模式：同格 3s 内重复点击被服务端**在发 tx 前**拦下，
    // 这是刻意的对照特性不是故障 —— 不闪红条、不进全局冷却条
    // （startCooldown 是每 clientId 的语义，服务端冷却是每格的；混用会误伤别的格），
    // 只写一行中性的「最近一次」状态。
    if (code === "cooldown_3s") {
      elLast.textContent = `#${id} 对照模式 · 同格3s内已点 · 未发交易`;
      buzz(6);
      return;
    }
    if (code === "rate_limited") startCooldown(Math.max(1200, r.retryAfterMs ?? 4000));
    // E-fixes#5：池子干涸 —— 即时挂持久横幅，不靠等下一轮 poll 的 2s。
    // showError 的红条照样闪（这一笔确实没走），但「暂存」状态留在页面上不走。
    if (code === "relayer_unfunded") {
      setBanner(DRY_BANNER);
      dryBannerActive = true;
    }
    showError(code, r.detail);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    if (aborted) {
      // E-fixes#4①（C3 T1）：sync 请求超时 ≠ 失败。中继极可能已把交易发给节点
      // （节点接收即返回）。旧代码回滚乐观涂色 + 报「网络断了」——
      // 于是手机说失败、大屏亮了、刷新格子又出现：当场流失观众的正好发点。
      // 现在：画面保留，文案改「已发送 · 确认中」，本格留在 pendingLocal
      // 里由链上真相对账（syncGrid 看到快照里有它就摘除）。
      keepPending = true;
      elLast.textContent = `#${id} 已发送 · 确认中`;
      buzz(12);
      return;
    }
    // 真·连不上（fetch 直接抛，请求根本没到中继）：回滚这一格
    color[id] = prevColor;
    heat[id] = prevHeat;
    paintCell(id);
    mine = Math.max(0, mine - 1);
    elMine.textContent = String(mine);
    saveMine(mine);

    showError("network");
  } finally {
    inflight--;
    if (!keepPending) pendingLocal.delete(id);
  }
}

/* ── v3 人肉车道：按住不放，每秒抢一格 ───────────────────────
 * 为什么值得做：78 个观众同时按住，就是 78 条真人车道 ——
 * 叠加蜂群的 40 条机器人车道，总吞吐不再是"机器人的表演"，
 * 而是大屏顶上那行字能诚实写的「真人 78%」。投票人自己推过屏幕，这票就跑不掉。
 *
 * 节流两层：客户端 1s/次（shouldFireHold），服务端 6 次/10s（RL_LIMIT）。
 * 在途超过 4 笔就歇一歇：观众手机的 4G 上 5 个并发 fetch 会互相排队，
 * 画面反而变卡 —— 「快」不等于「堆」。
 */
function startHold() {
  stopHold();
  holdTimer = window.setInterval(() => {
    if (document.hidden || inflight >= 4) return;
    const id = hover >= 0 ? hover : -1;
    if (id < 0) return;
    if (!shouldFireHold(Date.now(), lastFiredAt, 1000)) return;
    // B-sync：按住连点 = 吞吐车道，逐笔不开同步回执（sync=false）。
    // 同步确认只属于「一次一下」的点击 —— 蜂群吞吐不许被拖慢。
    void claim(id, false);
  }, 300);
}

function stopHold() {
  if (holdTimer) {
    clearInterval(holdTimer);
    holdTimer = 0;
  }
}

/* ────────────────────────────────────────────────────────────
 * 7. 指针 → 格子
 * ──────────────────────────────────────────────────────────── */

function cellFromEvent(e: PointerEvent): number {
  const r = elCanvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  if (x < 0 || y < 0 || x > r.width || y > r.height) return -1;
  const cx = Math.min(SIDE - 1, Math.max(0, Math.floor((x / r.width) * SIDE)));
  const cy = Math.min(SIDE - 1, Math.max(0, Math.floor((y / r.height) * SIDE)));
  return cy * SIDE + cx;
}

elCanvas.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    pointerDown = true;
    hover = cellFromEvent(e);
    try {
      elCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* 老浏览器：无 capture 也能用 */
    }
    startHold(); // v3：按住不放 = 人肉车道，每秒抢一格
    kick();
  },
  { passive: false },
);

elCanvas.addEventListener(
  "pointermove",
  (e) => {
    if (!pointerDown) return;
    e.preventDefault();
    const id = cellFromEvent(e);
    if (id !== hover) {
      hover = id;
      kick();
    }
  },
  { passive: false },
);

function endPointer(e: PointerEvent) {
  if (!pointerDown) return;
  pointerDown = false;
  stopHold(); // v3：人肉车道收尾（松手那一下照旧单独发一次）
  const id = cellFromEvent(e);
  const target = id >= 0 ? id : hover;
  hover = -1;
  hoverExpire = performance.now() + 380;
  if (target >= 0) void claim(target);
  kick();
}

elCanvas.addEventListener("pointerup", endPointer);
elCanvas.addEventListener("pointercancel", () => {
  pointerDown = false;
  stopHold();
  hover = -1;
});

// 触屏长按菜单 / 双击缩放 / 页面回弹都关掉，抢格子要跟手
elCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.target === elCanvas) e.preventDefault();
  },
  { passive: false },
);

/* ────────────────────────────────────────────────────────────
 * 8. 轮询 / 启动
 * ──────────────────────────────────────────────────────────── */

let pollTimer = 0;
/** 版图变化后由 syncGrid 调用，重算占比条 */
let shareRefresh: (() => void) | null = null;

/** /api/state 的响应：只含已占领格子，[id, color, heat] */
type GridSnapshot = {
  cells: [number, number, number][];
  occupied: number;
  total: number;
  claims: number;
  block: number | null;
};

let lastSyncedClaims = -1;
let lastSyncedBlock: number | null = null;
/** 本机乐观更新但还没被链上确认的格子；同步时不许被旧快照覆盖 */
const pendingLocal = new Set<number>();

/**
 * 拉一次全局版图。
 *
 * 为什么必须这么做：手机页原来是「单机游戏」——
 * 只统计本机这次会话点过的格子，从不读别人的，
 * 于是点一下显示「己方 100%」，而大屏上是四块大陆，两边说的不是同一件事。
 * 现在三端共享中继缓存的同一份版图。
 */
async function syncGrid() {
  let snap: GridSnapshot;
  try {
    snap = await getJSON<GridSnapshot>(`${apiBase}/api/state`, 4000);
  } catch {
    return; // 网络抖动：保留现有画面，下一轮再试
  }
  // 没变化就不重绘（78 台手机 × 每 2 秒重画 2500 格是浪费）
  if (snap.claims === lastSyncedClaims && snap.block === lastSyncedBlock) return;
  lastSyncedClaims = snap.claims;
  lastSyncedBlock = snap.block;

  // 重建整张图。
  // E-fixes#4②（C3 T3）：本机在途的格子保留乐观色 —— 旧代码 fill(0) 重建后
  // 把 pendingLocal 整锅清空、从不逐格查 has()：在途点击（最长 15s）每 2s 被
  // 下一轮旧快照抹掉一次再画回来，弱网下「自己那格一闪一闪」。
  // 新纪律：快照里出现同一格 = 链上/中继真相已含它 → 摘除 pending，快照色接管；
  // 还在途的（快照没有 = 可能根本没成，也可能索引慢）→ 保留本机乐观色，下轮再对账。
  const keepOptimistic = new Map<number, readonly [number, number]>();
  for (const id of pendingLocal) keepOptimistic.set(id, [color[id], heat[id]]);

  color.fill(0);
  heat.fill(0);
  for (const [id, c, h] of snap.cells) {
    if (id < 0 || id >= CELLS) continue;
    color[id] = c;
    heat[id] = h;
    pendingLocal.delete(id); // 对账完成：链上见得到它了
  }
  for (const [id, k] of keepOptimistic) {
    if (!pendingLocal.has(id)) continue; // 上面已被快照摘除，别画蛇添足
    color[id] = k[0];
    heat[id] = k[1];
  }

  // buildBase 会把 2500 格全部重画一遍，再让主循环 blit 一次。
  // 每 2s 最多一次，且只在 claims/block 真的变了时才走这里。
  buildBase();
  kick();
  if (elOccupied) {
    elOccupied.textContent = String(snap.occupied);
    elOccupied.parentElement?.setAttribute("title", `${snap.occupied} / ${snap.total} 格已占领 · 累计 ${snap.claims} 笔 claim`);
  }
  // 空棋盘要说明白「还没人开始」，否则最先扫码的人以为页面坏了，不会点第一下
  if (elEmptyHint) elEmptyHint.hidden = snap.occupied > 0;
  shareRefresh?.();
}

async function poll() {
  if (document.hidden) return;
  try {
    const s = await getJSON<StatsResp>(`${apiBase}/api/stats`, 4000);
    elQueue.textContent = String(s.queued ?? 0);
    const tps = Math.round((s.tps ?? 0) * 10) / 10;
    elQueue.title = `${tps} tps · ${s.keys} keys · dry ${s.dryKeys ?? 0} · sent ${s.sent} · failed ${s.failed}`;
    // G-cooldown：顶栏小字实时跟随中继开关（评委现场切 COOLDOWN_MODE 肉眼可见）
    setCooldownBadge(s.cooldownMode);
    if (offline) {
      offline = false;
      setBanner(cfg?.error === "not_deployed" ? "合约未部署 · 现在点不会上链" : null);
    }
    // E-fixes#5：干涸持久横幅。优先级：未部署（点了根本不会上链）> 通道暂满 > 清除。
    // 只撤自己挂的那条（dryBannerActive），不抢「失联」横幅的位。
    if (cfg?.error !== "not_deployed") {
      if ((s.dryKeys ?? 0) > 0) {
        setBanner(DRY_BANNER);
        dryBannerActive = true;
      } else if (dryBannerActive) {
        setBanner(null);
        dryBannerActive = false;
      }
    }
    if (cfg?.error !== "not_deployed") await syncGrid();
  } catch {
    offline = true;
    elQueue.textContent = "?";
    setBanner("与中继失联 · 正在重连");
  }
}

async function boot() {
  // 先按本地记忆把 UI 画出来，网络慢也不白屏
  renderFactions(NAMES);
  const saved = Number(lsGet(LS_FACTION) ?? 0);
  // 有记忆就直接进战场；没有就把选择器打开
  setPicker(!(saved >= 1 && saved <= 4));
  if (saved >= 1 && saved <= 4) {
    faction = saved;
    document.documentElement.style.setProperty("--me", FACTIONS[saved]?.hex ?? "#A855F7");
    syncFactionUI();
  }
  elMine.textContent = String(mine);
  elQueue.textContent = "–";

  // v3：代号回填 + 变更持久化（改动在 blur 时生效；清空则恢复既有代号，不留空值）
  elNick.value = nick;
  elNick.addEventListener("change", () => {
    const v = elNick.value.trim().slice(0, 16);
    if (v) {
      nick = v;
      lsSet(LS_NICK, v);
    } else {
      elNick.value = nick;
    }
  });

  layout();
  new ResizeObserver(() => layout()).observe(elStage);
  window.addEventListener("orientationchange", () => setTimeout(layout, 250));

  try {
    await loadConfig();
    const names = cfg?.factionNames?.length === 4 ? cfg.factionNames : NAMES;
    renderFactions(names);
    if (saved >= 1 && saved <= 4) {
      faction = saved;
      document.documentElement.style.setProperty("--me", FACTIONS[saved]?.hex ?? "#A855F7");
      syncFactionUI();
    }

    if (cfg?.error === "not_deployed") {
      setBanner("合约未部署 · 现在点不会上链");
    }
  } catch {
    offline = true;
    setBanner("连不上中继 · 检查网络后刷新");
  }

  mountShare();

  void poll();
  pollTimer = window.setInterval(poll, 2000);

  // 点「我方」那一块 = 重新选阵营（现场选错的人有救）
  const factionChip = elFaction.closest(".meter") as HTMLElement | null;
  factionChip?.addEventListener("click", () => {
    setPicker(!pickerOpen);
    buzz(10);
  });
  factionChip?.style.setProperty("cursor", "pointer");

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });

  // 首次触摸解锁震动（某些安卓需要一次用户手势）
  window.addEventListener(
    "pointerdown",
    () => {
      buzz(8);
    },
    { once: true },
  );
}

/* ────────────────────────────────────────────────────────────
 * 领土占比条：把棋盘上方的留白变成信息
 * ──────────────────────────────────────────────────────────── */

function mountShare() {
  const host = document.getElementById("share");
  if (!host) return;

  const rows: { fill: HTMLElement; num: HTMLElement }[] = [];

  for (let f = 1; f <= 4; f++) {
    const row = document.createElement("div");
    row.className = "share-row";
    row.innerHTML =
      `<span class="share-bar"><span class="share-fill" style="background:${RGB_HEX[f]}"></span></span>` +
      `<span class="share-num">0%</span>`;
    host.appendChild(row);
    rows.push({
      fill: row.querySelector(".share-fill") as HTMLElement,
      num: row.querySelector(".share-num") as HTMLElement,
    });
  }

  const update = () => {
    const c = [0, 0, 0, 0, 0];
    for (let i = 0; i < CELLS; i++) {
      const v = color[i];
      if (v > 0 && v <= 4) c[v]++;
    }
    const total = c[1] + c[2] + c[3] + c[4];
    for (let f = 1; f <= 4; f++) {
      const pct = total > 0 ? (c[f] / total) * 100 : 0;
      rows[f - 1].fill.style.width = pct.toFixed(1) + "%";
      // 一格都没占领时显示「—」而不是「0%」：0% 读起来像「我方被打光了」，实际是还没开始
      rows[f - 1].num.textContent = total > 0 ? Math.round(pct) + "%" : "—";
    }
  };

  update();
  // 版图同步后由 syncGrid 调这里重算。
  // 这个定时器是兜底（900ms），syncGrid 会显式调 shareRefresh。
  shareRefresh = update;
  window.setInterval(update, 900);
}

boot().catch((e) => {
  console.error(e);
  setBanner("页面初始化失败 · 刷新试试");
});
