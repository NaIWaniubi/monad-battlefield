/// <reference types="vite/client" />
import { withFailover, currentRpc, LOG_CHUNK } from "./rpc";
import { ABI } from "./abi";
import deploy from "./deploy.json";
import { CELLS, FACTIONS, SIDE, GridRenderer, GridState } from "./grid";
import { BattleAudio } from "./audio";
import { burnRatePerSecond } from "./metrics";
import { CROWD_DEFAULT, Crowd, parseCrowdSize } from "./crowd.js";

/* ── 配置 ───────────────────────────────────────────── */
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const ETH_PRICE = Number(import.meta.env.VITE_ETH_PRICE ?? 3000);
const GWEI = Number(import.meta.env.VITE_GAS_PRICE_GWEI ?? 110);
const GAS_PER_TX = Number(import.meta.env.VITE_GAS_PER_TX ?? 60_000);
/**
 * 观众页地址。三层优先级：环境变量 > 中继算出的局域网地址 > 本页 origin。
 *
 * 不能直接用 location.origin：主讲人在自己电脑上开 http://localhost:5180，
 * 二维码就会编码 localhost —— 78 台手机一台都扫不开，而这场比赛由观众投票决定。
 * 中继监听 0.0.0.0，它知道本机能被局域网访问的地址，问它要。
 */
const AUDIENCE_OVERRIDE = (import.meta.env.VITE_AUDIENCE_URL ?? "").trim();
/**
 * 中继候选地址，按顺序试。
 * 第一条「同源」最关键：本页既然是中继发出来的，`/api/*` 就一定在同一个 origin 上，
 * 不管中继跑在 8791、8792 还是隧道域名 —— 写死端口会在换端口当天失效（已踩过）。
 */
const RELAY_CANDIDATES = [
  (import.meta.env.VITE_RELAY_URL ?? "").trim(),
  "",
  `http://${location.hostname || "localhost"}:8791`,
]
  .filter((v, i, a) => a.indexOf(v) === i)
  .map((v) => v.replace(/\/$/, ""));

/** 依次试候选中继，第一个答对的胜出；全挂返回 null。 */
async function relayGet<T>(path: string): Promise<T | null> {
  for (const base of RELAY_CANDIDATES) {
    try {
      const r = await fetch(`${base}${path}`, { cache: "no-store" });
      if (!r.ok) continue;
      return (await r.json()) as T;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 已经确定能用的中继地址（relayGet 成功后记住，给需要 POST / 轮询的地方用） */
let relayBase = "";
async function probeRelayBase() {
  if (relayBase) return relayBase;
  for (const base of RELAY_CANDIDATES) {
    try {
      const r = await fetch(`${base}/health`, { cache: "no-store" });
      if (r.ok) {
        relayBase = base;
        return base;
      }
    } catch {
      /* 试下一个 */
    }
  }
  return "";
}

/**
 * 控场通道要的是**能答 /api/director 的**地址，不是能答 /health 的。
 * 两者在开发态可能落在不同服务上（vite 5180 有 /health 代理吗？没有），
 * 所以这里直接拿 /api/director 探活，探到就锁住这个 base。
 */
/**
 * 控场通道要的是**能答 /api/director 的**地址，不是能答 /health 的。
 *
 * 关键陷阱：候选里有一项是空串，表示「同源」（`${""}/api/director` 就是
 * `/api/director`）。空串本身是合法的成功答案，但它 falsy ——
 * 用 `if (directorBase) return` 判"探过没有"会让空串每次都被当成"还没探"，
 * 而 `if (!base) return` 又会把成功探到的同源直接丢掉。
 * 所以用 null 表示未探、"" 表示同源。
 */
let directorBase: string | null = null;
async function probeDirectorBase(): Promise<string | null> {
  if (directorBase !== null) return directorBase;
  const tried: string[] = [];
  for (const base of RELAY_CANDIDATES) {
    tried.push(base || "(same-origin)");
    try {
      const r = await fetch(`${base}/api/director?since=0`, { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean };
        if (j && j.ok) {
          directorBase = base;
          (window as any).__dirBase = base || "(same-origin)";
          return base;
        }
      }
    } catch {
      /* 试下一个 */
    }
  }
  (window as any).__dirTried = tried;
  return null;
}
/**
 * v3「静默墙」倒计时。与中继 server/index.mjs 的 BURST_SILENCE_MS 同值 ——
 * 但两边各数各的：中继数到点自己点火上链，大屏数到点放声音与涟漪。
 * 它们只共享「同一刻起跳」，不共享时钟，所以差几十毫秒完全无所谓。
 */
const SILENCE_MS = 5200;

let audienceUrl = AUDIENCE_OVERRIDE || `${location.origin}/join.html`;

const CONTRACT = deploy.address as `0x${string}`;
const START_BLOCK = BigInt(deploy.startBlock ?? 0);
const DEPLOYED = CONTRACT !== "0x0000000000000000000000000000000000000000";
/** ?demo=1 用本地合成流驱动大屏，不连链 —— 排练和断网兜底 */
const DEMO = new URLSearchParams(location.search).has("demo");

/* ── DOM ────────────────────────────────────────────── */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("grid");
const stage = canvas.parentElement as HTMLElement;
const elTps = $<HTMLDivElement>("tps");
const elTpsSub = $<HTMLDivElement>("tps-sub");
const elTotal = $<HTMLDivElement>("total");
const elElapsed = $<HTMLDivElement>("elapsed");
const elEth = $<HTMLDivElement>("ethcost");
const elEthNote = $<HTMLDivElement>("ethnote");
const elClaim = $<HTMLDivElement>("claimline");
const elConn = $<HTMLDivElement>("conn");
const elFooterAddr = $<HTMLSpanElement>("footer-addr");
const btnSound = $<HTMLButtonElement>("sound");
const btnFull = $<HTMLButtonElement>("fullscreen");
const qrWrap = $<HTMLDivElement>("qrwrap");
const qrImg = $<HTMLImageElement>("qr");
const qrUrl = $<HTMLDivElement>("qrurl");
const qrWarn = $<HTMLDivElement>("qrwarn");
const qrWarnUrl = $<HTMLElement>("qrwarn-url");
const qrWarnFix = $<HTMLElement>("qrwarn-fix");

/** v3「静默墙」：中央倒计时大字（hidden 到爆发指令到达才显示） */
const elSilence = $<HTMLDivElement>("silence");
const elSilenceNum = $<HTMLElement>("silence-num");

/** v3「实时主网账单」：每秒燃烧的主网等值 USD（HUD 每帧跟 TPS 一起更新） */
const elBurn = $<HTMLElement>("burnrate");

/**
 * E-fixes#9（C2#2 诚实版，替代 WS 方案）：TOTAL TX 下方一行小字
 * 「tap→confirm P50/P95」。数据来自中继 /api/stats（sync 回执的滚动窗口）。
 * index.html / style.css 归别人所有不许动 —— 元素在这里动态建插，样式内联。
 * 口径必须自己写进文案：这是 tap→链上确认，不含大屏画面同步（3s 轮询），
 * 无样本时显示「—」，绝不编一个 0ms 假快。
 */
const elLat = document.createElement("div");
elLat.style.cssText = "font-size:10.5px;opacity:.62;letter-spacing:.02em;margin-top:2px;";
elTotal.parentElement?.insertAdjacentElement("afterend", elLat);
/** /api/stats 最近一轮的确认延迟样本（null = 中继还没收到过 sync 回执） */
let lastLat: { p50: number | null; p95: number | null; n: number } = { p50: null, p95: null, n: 0 };
const latMs = (v: number | null) => (v == null ? "—" : (v / 1000).toFixed(1) + "s");

/* ── 状态 ───────────────────────────────────────────── */
const state = new GridState();
const renderer = new GridRenderer(canvas, stage);
const audio = new BattleAudio();

let stamps: number[] = [];
const startedAt = Date.now();
let lastClaim: { id: number; color: number; heat: number; who: string } | null = null;
let lastFrame = performance.now();
/** 最近一次 claim 的格子，交给渲染器做冲击波 */
let lastPulseId = -1;
/** 导演台推来的演出模式 */
let hypeMode: "normal" | "hype" = "normal";

/* demo 模式的合成流：跟 rAF 同步发射，避免 setInterval 被后台节流 */
const DEMO_RATE = 80; // claims / second
let demoEmit: (() => void) | null = null;
let demoAcc = 0;
let hudAcc = 0;

/**
 * K-crowd：78→240 可调的虚拟观众团。只在 DEMO 分支里 new，
 * 非 demo 模式恒为 null —— frame() 里的 crowd 块对真实模式零开销。
 */
let crowd: Crowd | null = null;

/* ── 领土占比条（替代旧图例） ─────────────────────── */
const elShare = $<HTMLDivElement>("share");
const shareRows: { fill: HTMLElement; num: HTMLElement }[] = [];

for (let i = 1; i < FACTIONS.length; i++) {
  const row = document.createElement("div");
  row.className = "share-row";
  row.innerHTML =
    `<span class="share-swatch" style="background:${FACTIONS[i].hex}"></span>` +
    `<span class="share-track"><span class="share-fill" style="background:${FACTIONS[i].hex}"></span></span>` +
    `<span class="share-num">0%</span>`;
  elShare.appendChild(row);
  shareRows.push({
    fill: row.querySelector(".share-fill") as HTMLElement,
    num: row.querySelector(".share-num") as HTMLElement,
  });
}

function updateShare() {
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < CELLS; i++) {
    const c = state.color[i];
    if (c > 0 && c <= 4) counts[c]++;
  }
  const occupied = counts[1] + counts[2] + counts[3] + counts[4];
  for (let f = 1; f <= 4; f++) {
    const pct = occupied > 0 ? (counts[f] / occupied) * 100 : 0;
    shareRows[f - 1].fill.style.width = pct.toFixed(1) + "%";
    shareRows[f - 1].num.textContent = Math.round(pct) + "%";
  }
}

/* ── 事件 → 状态 ─────────────────────────────────────── */
/**
 * 只描述我们真正读的字段。
 * 不用 viem 的 Log<…> 泛型：它要拿到具体 ABI event 类型才会带上 args，
 * 而这里的 ABI 是运行时 JSON（as any），泛型推不出来，只会退化成没有 args 的那一支。
 */
type ClaimLog = {
  args?: { id?: bigint | number; color?: bigint | number; heat?: bigint | number; who?: string };
};

/**
 * E-fixes#1（C4#6）：`live` 决定这次 claim 算不算「此刻的实时流量」。
 *
 * 顶栏 TPS 数的是「这一秒世界在动多快」。历史回放（loadHistory）一次灌进来
 * 几百条旧事件、中继快照合并（mergeState）每 3s 补一批 —— 它们都是**已经发生完**
 * 的事，当"本秒"数会把开机 TPS 顶成假高峰（回放 600 块瞬间显示几百 tx/s），
 * 主讲人还没开口，第一行数字就先把「Measured, not estimated」戳穿了。
 *   live=true  ：watch/stream 回调的链上新事件、demo 合成流、crowd 虚拟观众 —— 是"现在"。
 *   live=false ：loadHistory 回放、boot 四角播种 —— 是"历史"，上色但不计流量。
 */
function applyClaim(log: ClaimLog, live = true) {
  const a = log.args;
  if (a?.id === undefined) return;
  const id = Number(a.id);
  const color = Number(a.color ?? 0);
  const heat = Number(a.heat ?? 0);

  state.apply(id, color, heat);
  if (live) stamps.push(performance.now());
  lastClaim = { id, color, heat, who: String(a.who ?? "") };
  lastPulseId = id;

  audio.note(id, heat, color);
}

/* ── 历史回放（reconcile 的兜底） ─────────────────────── */
async function loadHistory() {
  const latest = await withFailover((c) => c.getBlockNumber());
  // 只回放最近 200 块：全量历史要几百个 chunk，启动会卡住。
  // 大屏要的是「现在在动」，不是考古。
  const RECENT = 600n;
  let from = latest - RECENT > START_BLOCK ? latest - RECENT : START_BLOCK;
  let guard = 0;

  while (from <= latest && guard < 20) {
    guard++;
    const to = from + LOG_CHUNK > latest ? latest : from + LOG_CHUNK;
    try {
      const logs = (await withFailover((c) =>
        c.getLogs({
          address: CONTRACT,
          abi: ABI,
          eventName: "Claim",
          fromBlock: from,
          toBlock: to,
        } as any),
      )) as unknown as ClaimLog[];
      // E-fixes#1：回放是历史 —— 上色、发光，一笔都不许当「本秒」计数
      for (const l of logs) applyClaim(l, false);
    } catch {
      /* 单个 chunk 失败不致命，跳过继续 */
    }
    from = to + 1n;
  }
  return latest;
}

/* ── 实时订阅 ────────────────────────────────────────── */
let unwatch: (() => void) | null = null;

function subscribe() {
  try {
    unwatch?.();
  } catch {
    /* ignore */
  }
  void withFailover(async (c) => {
    unwatch = c.watchContractEvent({
      address: CONTRACT,
      abi: ABI as any,
      eventName: "Claim",
      poll: true,
      pollingInterval: 1200,
      onLogs: (logs: unknown[]) => {
        // 事件订阅是唯一的「此刻」来源：live=true 照旧进 TPS 窗口
        for (const l of logs as unknown as ClaimLog[]) applyClaim(l, true);
        elConn.classList.remove("dead");
        // demo 模式下链上通道也接上了 —— 标清楚，否则观众分不清自己在看合成还是真交易
        elConn.textContent = `${DEMO ? "DEMO+链上" : "实时"} · ${currentRpc().replace("https://", "")}`;
      },
      onError: () => {
        elConn.classList.add("dead");
        elConn.textContent = "连接中断 · 换节点重试";
        setTimeout(subscribe, 3000);
      },
    } as any);
    return true;
  }).catch(() => {
    elConn.classList.add("dead");
    elConn.textContent = "所有 RPC 不可用 · 3s 后重试";
    setTimeout(subscribe, 3000);
  });
}

/* ── 渲染循环 ────────────────────────────────────────── */
function frame(now: number) {
  const rawDt = (now - lastFrame) / 1000;
  const dt = Math.min(0.05, rawDt);
  lastFrame = now;

  if (crowd) {
    const claims = crowd.step(dt);
    for (const c of claims) {
      // ageSec=0：就是此刻发生的 claim。省略第 4 参的话 apply 会把 age 置 Infinity，
      // selectLabelCells 只给有限 age 的格子署名 —— 署名墙上名字会全部消失。
      state.apply(c.cell, c.faction, 1 + Math.floor(Math.random() * 4), 0);
      state.setLabel(c.cell, c.nick);
      stamps.push(performance.now());
      lastPulseId = c.cell;
      if (audio.ready) audio.note(c.cell, 1, c.faction);
    }
    if (claims.length > 0) renderer.labelVersion++;
  }

  if (renderer.needsResize()) renderer.resize();

  // HUD 跟渲染同频驱动：后台标签页会节流 setInterval，导致「画面在动但数字不动」
  hudAcc += rawDt;
  if (hudAcc >= 0.2) {
    hudAcc = 0;
    tickHud();
  }

  renderer.draw(state, dt, { pulseId: lastPulseId, mode: hypeMode });
  requestAnimationFrame(frame);
}

/* ── 导演台（另一个屏幕/平板 → BroadcastChannel） ──────── */
type DirectorMsg =
  | { type: "mute"; muted: boolean }
  | { type: "banner"; text: string }
  | { type: "mode"; mode: "normal" | "hype" }
  | { type: "reset" }
  | { type: "fullscreen" }
  | { type: "stinger"; kind: "capture" | "start" | "end" | "burst" }
  /** v3「静默墙」：安静 SILENCE_MS，然后一声齐鸣 + 一屏涟漪（中继同时点火上链） */
  | { type: "burst"; count?: number };

const elBanner = document.getElementById("banner-bar");

function connectDirector() {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel("battlefield");
  } catch {
    /* 同屏通道不可用：还有中继轮询兜底 */
  }

  const apply = (msg: DirectorMsg) => {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "mute": {
        // 导演台是「绝对指令」：直接对齐，不靠 toggle 猜状态
        if (audio.ready && audio.isMuted !== msg.muted) audio.toggle();
        else if (!audio.ready && !msg.muted) void audio.enable();
        btnSound.querySelector(".ctl-label")!.textContent = msg.muted ? "静音" : "声音";
        break;
      }
      case "banner": {
        if (!elBanner) return;
        const text = (msg.text ?? "").slice(0, 120);
        elBanner.textContent = text;
        elBanner.classList.toggle("show", text.length > 0);
        break;
      }
      case "mode": {
        hypeMode = msg.mode === "hype" ? "hype" : "normal";
        document.body.classList.toggle("hype", hypeMode === "hype");
        break;
      }
      case "reset": {
        state.reset();
        stamps = [];
        lastClaim = null;
        lastPulseId = -1;
        elTotal.textContent = "0";
        break;
      }
      case "fullscreen": {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
        break;
      }
      case "burst": {
        // v3「静默墙」：本屏从这一刻起安静倒数；中继收到同一指令也各自点火上链
        void startSilenceWall();
        break;
      }
      case "stinger": {
        audio.stinger(msg.kind);
        break;
      }
    }
  };

  if (ch) {
    ch.onmessage = (ev: MessageEvent<DirectorMsg>) => apply(ev.data);
  }

  // 跨设备通道：导演台 POST 到中继，这里轮询取。
  // 一个人参赛时大屏在笔记本、导演台在平板 —— BroadcastChannel 跨不过去。
  let lastSeq = 0;
  const pollDirector = async () => {
    const base = await probeDirectorBase();
    if (base === null) return;
    try {
      const r = await fetch(`${base}/api/director?since=${lastSeq}`, { cache: "no-store" });
      if (!r.ok) {
        directorBase = null; // 地址失效了，下一轮重新探
        return;
      }
      const data = (await r.json()) as { seq?: number; msgs?: DirectorMsg[] };
      if (Array.isArray(data.msgs)) for (const m of data.msgs) apply(m);
      if (typeof data.seq === "number") lastSeq = data.seq;
    } catch {
      directorBase = null;
    }
  };
  void pollDirector();
  setInterval(pollDirector, 1000);
}

/* ── v3「静默墙」：安静 → 齐鸣 ────────────────────────────────── */

let silenceTimer = 0;

/**
 * 收到导演台的 burst 指令后，本屏立刻安静 SILENCE_MS，然后一声齐鸣 + 一屏涟漪。
 *
 * 三件事必须同时做：
 *   1. **先把声音关掉** —— 寂静是这面墙唯一的稀缺资源，先静音才有对比；
 *   2. **叠 90 圈涟漪的欠账** —— 等链的格子真的开始炸时，涟漪才是从中心向外推；
 *   3. **数到点精确恢复原音量** —— 不是"开声"：主讲人可能本来就静音（场地规定）。
 *
 * 中继在收到同一指令的那一刻也各自点火上链。两边不互相等待 ——
 * 这就是"同一个起跳时刻，两条独立时钟"，差几十毫秒不影响任何戏剧效果。
 */
function startSilenceWall() {
  if (silenceTimer) return; // 已在倒数：第二下交给中继的 burst_cooldown 拒绝，不叠加
  const prevMuted = audio.isMuted;
  audio.setMuted(true);
  renderer.queueBurst(90); // 欠账交给 draw() 按令牌排掉（上限 240）

  const t0 = performance.now();
  elSilence.hidden = false;
  const paint = () => {
    const left = Math.max(0, SILENCE_MS - (performance.now() - t0));
    if (left > 0) {
      elSilenceNum.textContent = `静默 ${(left / 1000).toFixed(1)}s`;
      return;
    }
    clearInterval(silenceTimer);
    silenceTimer = 0;
    elSilence.hidden = true;
    audio.setMuted(prevMuted); // 精确回到原状态，不是"翻回开声"
    audio.stinger("burst");
  };
  paint();
  silenceTimer = window.setInterval(paint, 100);
}

/* ── 中继统计（失联要在大屏上说，不能沉默） ─────────── */
const elRelayWarn = $<HTMLDivElement>("relay-warn");
let relayFails = 0;

/** v3：/api/state 快照。cells 的第 4 位（age 秒）只有中继精确缓存过的格子才有 */
type StateResp = {
  claims?: number;
  block?: number | null;
  cells?: Array<readonly [number, number, number] | readonly [number, number, number, number]>;
  tags?: Array<readonly [number, string]>;
};

/** 上一次合并的键：claims×1e6 + block —— 没变就不重放，防每轮把格子闪一遍 */
let mergedKey = -1;

/**
 * 合并中继快照进本地版图（v3）。
 * 与观众页同样的纪律（join.ts syncGrid）：变化才重画。
 *   · 第 4 位 age 有数 → 该格开始算热度衰减（L1「热的土地」）
 *   · tags → 署名墙：只有观众署名，蜂群匿名
 * 大屏原有的两个数据源（历史回放 + 事件订阅）都读不到这两样，只能靠这里补。
 */
async function mergeState() {
  const snap = await relayGet<StateResp>("/api/state");
  if (!snap || !Array.isArray(snap.cells)) return;
  const key = Math.floor(snap.claims ?? 0) * 1_000_000 + (snap.block ?? 0);
  if (key === mergedKey) return;
  mergedKey = key;

  for (const cell of snap.cells) {
    const id = Number(cell[0]);
    const c = Number(cell[1]);
    const h = Number(cell[2]);
    const rawAge = cell[3];
    const ageSec = typeof rawAge === "number" && Number.isFinite(rawAge) ? rawAge : Infinity;
    state.apply(id, c, h, ageSec);
  }

  if (Array.isArray(snap.tags) && snap.tags.length > 0) {
    for (const t of snap.tags) state.setLabel(Number(t[0]), String(t[1]));
    renderer.labelVersion++; // 让渲染器下一帧重扫署名
  }

  // 顶栏还停在 HTML 初始的「连接中…」时，用"中继已成功同步"这一事实诚实点亮。
  // 否则安静期（没有新事件触发 subscribe）或公共 RPC 慢导致 loadHistory 一直挂着时，
  // 大屏明明已画出格子却显示「连接中…」，评委/观众会误判系统坏了。
  // subscribe 真接上链后会把这里覆盖成「实时 · <rpc>」，error 态也不会被覆盖。
  if (elConn.textContent?.includes("连接中")) {
    elConn.classList.remove("dead");
    elConn.textContent = `已同步 · 经中继 · ${fmt(state.total)} 笔`;
  }
}

async function pollRelay() {
  const s = await relayGet<{
    queued?: number;
    sent?: number;
    failed?: number;
    tps?: number;
    keys?: number;
    dryKeys?: number;
    confirmLatencyP50ms?: number | null;
    confirmLatencyP95ms?: number | null;
    confirmLatencyCount?: number;
  }>("/api/stats");
  if (!s) {
    // 连续 2 次（约 6s）连不上才报警：单次抖动是正常的
    relayFails++;
    if (relayFails >= 2) elRelayWarn.hidden = false;
    return;
  }
  if (relayFails >= 2) elRelayWarn.hidden = true;
  relayFails = 0;
  // E-fixes#9：确认延迟样本随 stats 顺带取回（tickHud 里渲染，HUD 与渲染同频）
  lastLat = {
    p50: s.confirmLatencyP50ms ?? null,
    p95: s.confirmLatencyP95ms ?? null,
    n: s.confirmLatencyCount ?? 0,
  };
  const onchain = s.sent ?? 0;
  elTpsSub.textContent = `${elTpsSub.textContent?.split(" · ")[0] ?? ""} · 观众已打 ${onchain}`;
  // v3：顺带合并署名与年龄。失败不影响已有画面，下一轮再试
  void mergeState();
}

/* ── HUD ────────────────────────────────────────────── */
const fmt = (n: number) => n.toLocaleString("en-US");

function tickHud() {
  const now = performance.now();
  stamps = stamps.filter((t) => now - t < 2000);
  const tps = stamps.filter((t) => now - t < 1000).length;

  elTps.textContent = String(tps);
  elTotal.textContent = fmt(state.total);

  // E-fixes#9：tap→链上确认仪表（中继 sync 回执滚动窗口）。≥1 笔才有数，
  // 没到数就是「—」—— 大屏宁可空一行，不许编快。
  elLat.textContent =
    `tap→confirm P50 ${latMs(lastLat.p50)} · P95 ${latMs(lastLat.p95)}` +
    (lastLat.n > 0 ? ` · 近 ${lastLat.n} 笔` : "") +
    ` · tap→链上确认，不含画面同步`;

  const secs = Math.floor((Date.now() - startedAt) / 1000);
  elElapsed.textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

  const ethCost = state.total * GAS_PER_TX * GWEI * 1e-9 * ETH_PRICE;
  elEth.textContent = "$" + fmt(Math.round(ethCost));

  // v3「实时主网账单」：这一秒在烧多少主网等值 USD。左边是累计额，
  // 这行是速率 —— 一个在跳动的数才读得出「燃烧感」，静态的 $X,XXX 只是一行字。
  if (elBurn) {
    elBurn.textContent = "$" + fmt(Math.round(burnRatePerSecond(tps, GAS_PER_TX, GWEI, ETH_PRICE)));
  }

  const mult = tps > 0 ? (tps / 15).toFixed(1) : "—";
  // 这一块是全场唯一的彩色数字，必须一眼看出「是省下的，不是花掉的」。
  // 再给一个可对照的实付单价（实测 60000 gas × 110 gwei = 0.0066 MON），
  // 否则「$42,728」在大屏上读起来像「我们烧了这么多钱」。
  elEthNote.innerHTML =
    `同样 ${fmt(state.total)} 笔放在主网要付这么多<br>` +
    `Monad 实付 <b>0.0066 MON / 笔</b> · 主网 15 tx/s → 当前 ${mult}×`;

  elTpsSub.textContent =
    tps === 0 ? "等待交易…" : tps >= 60 ? "并行满载" : tps >= 25 ? "稳定并行" : "低速运行";

  if (lastClaim) {
    const c = FACTIONS[lastClaim.color]?.name ?? "?";
    elClaim.textContent = `#${lastClaim.id} ${c} · heat ${lastClaim.heat} · ${lastClaim.who.slice(0, 6)}…${lastClaim.who.slice(-4)}`;
  }

  updateShare();
  audio.setDensity(tps);
}

/* ── 交互 ───────────────────────────────────────────── */
btnSound.addEventListener("click", async () => {
  if (!audio.ready) {
    const ok = await audio.enable();
    btnSound.querySelector(".ctl-label")!.textContent = ok ? "声音" : "不可用";
    return;
  }
  const on = audio.toggle();
  btnSound.querySelector(".ctl-label")!.textContent = on ? "声音" : "静音";
});

btnFull.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    btnSound.click();
  }
  if (e.key.toLowerCase() === "f") btnFull.click();
});

window.addEventListener("resize", () => {
  renderer.resize();
});

// 布局变化（字体加载、全屏切换、HUD 折行）也要重算边长
if ("ResizeObserver" in window) {
  new ResizeObserver(() => renderer.resize()).observe(stage);
}

/* ── 二维码：宁可不出，也不能出一个扫不开的 ─────────── */

/** 回环地址只有本机能打开；二维码编码它 = 全场手机都打不开 */
function isLoopback(u: string) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return true;
  }
}

async function mountQr() {
  let relayUp = false;
  if (!AUDIENCE_OVERRIDE) {
    const c = await relayGet<{ joinUrl?: string }>("/api/config");
    if (c) {
      relayUp = true;
      if (c.joinUrl) audienceUrl = c.joinUrl;
    }
  }

  if (isLoopback(audienceUrl)) {
    qrWrap.hidden = true;
    qrWarn.hidden = false;
    qrWarnUrl.textContent = audienceUrl;
    qrWarnFix.textContent = relayUp
      ? "中继没找到可用的局域网地址 —— 检查网络连接，或用 node scripts/stage.mjs 起公网隧道"
      : "先跑 node scripts/stage.mjs（会一并起中继和隧道），再用它打印的「大屏 →」地址重开本页";
    elConn.classList.add("dead");
    elConn.textContent = "二维码不可扫";
    return;
  }

  qrWarn.hidden = true;
  // 把地址明文印在二维码下面：扫不开时还能手输，也让人一眼看出它指向哪
  qrUrl.textContent = audienceUrl.replace(/^https?:\/\//, "");
  try {
    // qrcode 是 CJS 包：默认导入可能挂在 .default 上，两种都兼容
    const mod: any = await import("qrcode");
    const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
    if (typeof toDataURL === "function") {
      qrImg.src = await toDataURL(audienceUrl, {
        margin: 1,
        width: 296,
        color: { dark: "#1a1029", light: "#ffffff" },
      });
      qrWrap.hidden = false;
    }
  } catch {
    /* 二维码失败不影响主画面 */
  }
}

/* ── 启动 ───────────────────────────────────────────── */
async function boot() {
  requestAnimationFrame(frame);

  // 导演台与中继统计先接上 —— 必须在 DEMO 的提前 return 之前
  connectDirector();
  setInterval(pollRelay, 3000);
  pollRelay();

  await mountQr();

  if (DEMO) {
    elConn.classList.remove("dead");
    elConn.textContent = "DEMO · 合成打底 + 真实点击";
    elFooterAddr.textContent = "demo mode · 2500 cells · synthetic + on-chain";
    // K-crowd：240 个带名字/热区/脾气的虚拟观众接管 demo 流(?crowd=N 可调,10-1500)。
    // 四角播种(下面的 plant)仍然执行 —— crowd 从既有版图边界上开打更像「抢地盘」。
    crowd = new Crowd(parseCrowdSize(location.search) ?? CROWD_DEFAULT);
    // ── 版图生长：四角播种，同色向外推 ──────────────────
    // 随机散点永远长不出「版图」，只会是彩色噪声。
    // 这里从四个角各种一块首都，之后新格子 92% 继承源阵营，
    // 于是屏幕上会长出四块大陆，在边界处相撞 —— 这才是「战争」。
    const owned: number[] = [];
    const dirs = [-1, 1, -SIDE, SIDE];

    const plant = (id: number, color: number) => {
      const x = id % SIDE;
      const y = (id / SIDE) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= SIDE || ny < 0 || ny >= SIDE) continue;
          const nid = ny * SIDE + nx;
          if (state.color[nid] !== 0) continue;
          // E-fixes#1：boot 播种是「开场布景」不是「此刻流量」——上色，不计 TPS
          applyClaim({ args: { id: nid, color, heat: 2, who: "0x" + "0".repeat(40) } } as unknown as ClaimLog, false);
          owned.push(nid);
        }
      }
    };

    plant(0, 1);                        // 西北 · 紫
    plant(SIDE - 1, 2);                 // 东北 · 青
    plant((SIDE - 1) * SIDE, 3);        // 西南 · 琥珀
    plant(CELLS - 1, 4);                // 东南 · 绯

    demoEmit = () => {
      let id = -1;
      let color = 1;

      // 92% 从已有领土向外扩，8% 开新点（偶尔的孤岛反而真实）
      if (owned.length > 0 && Math.random() < 0.92) {
        for (let tries = 0; tries < 12; tries++) {
          const base = owned[(Math.random() * owned.length) | 0];
          const nb = base + dirs[(Math.random() * 4) | 0];
          if (nb < 0 || nb >= CELLS) continue;
          // 防跨行环绕
          if (Math.abs((nb % SIDE) - (base % SIDE)) > 1) continue;
          id = nb;
          color = Math.random() < 0.92 ? state.color[base] : 1 + ((Math.random() * 4) | 0);
          break;
        }
      }

      if (id < 0) {
        id = (Math.random() * CELLS) | 0;
        color = 1 + ((Math.random() * 4) | 0);
      }

      if (state.color[id] === 0) owned.push(id);

      applyClaim({
        args: {
          id,
          color,
          heat: 1 + Math.floor(Math.random() * 8),
          who: "0x" + Math.random().toString(16).slice(2, 42).padEnd(40, "0"),
        },
      } as unknown as ClaimLog);
    };

    // demo 只是「打底密度」，不能让观众的点按消失：
    // 现场扫码是真的写到链上的，大屏必须把它们也画出来。
    // 否则观众点了，手机上显示成功，抬头看大屏毫无动静 —— 会以为系统坏了。
    // 用真实历史 + 订阅叠加在合成流之上，两者混在一起正是想要的效果。
    void loadHistory()
      .then(() => subscribe())
      .catch(() => {
        elConn.textContent = "DEMO · 合成打底（链上读不到）";
      });
    return;
  }

  if (!DEPLOYED) {
    elConn.classList.add("dead");
    elConn.textContent = "未部署 · 跑 npm run deploy";
    elFooterAddr.textContent = "contract: 未部署";
    return;
  }

  elFooterAddr.textContent = `contract ${CONTRACT.slice(0, 6)}…${CONTRACT.slice(-4)} · ${CELLS} cells · monad testnet`;

  try {
    const latest = await loadHistory();
    elConn.classList.remove("dead");
    elConn.textContent = `回放至 #${latest} · 已同步 ${fmt(state.total)} 笔`;
    subscribe();
  } catch (e) {
    console.error(e);
    elConn.classList.add("dead");
    elConn.textContent = "历史加载失败 · 检查 RPC";
  }
}

boot();
