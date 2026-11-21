/**
 * 导演台：控场面板。
 *
 * 两条投递通道，缺一不可：
 *   1. BroadcastChannel("battlefield") —— 同一浏览器同源页面，零延迟
 *   2. POST /api/director → 大屏轮询 GET —— 跨设备（平板开导演台、笔记本放大屏）
 *
 * 只用通道 1 是个陷阱：BroadcastChannel 不跨设备，而「在第二个屏幕/平板上开」
 * 恰恰是这个页面存在的理由。而且 postMessage 不报错、状态栏照样显示「已发送」，
 * 大屏那边什么都没有 —— 静默失效 + 假装成功。
 */
const ch = new BroadcastChannel("battlefield");
const statusEl = document.getElementById("status")!;
const muteBtn = document.getElementById("muteBtn") as HTMLButtonElement;
const banner = document.getElementById("banner") as HTMLInputElement;

/**
 * 中继候选：同源优先。
 * 空串表示同源，是合法答案 —— 不能用 truthy 判断"有没有找到"，
 * 否则同源成功的场景每次都会重新探测。用 null 表示还没找到。
 */
const RELAY_CANDIDATES = [
  (new URLSearchParams(location.search).get("relay") ?? "").replace(/\/$/, ""),
  "",
  `http://${location.hostname || "127.0.0.1"}:8791`,
].filter((v, i, a) => a.indexOf(v) === i);

let relayBase: string | null = null;
let muted = false;
/** 手动「爆发」的唯一 5.2s 倒数计时器；null = 没有待发的 burst */
let burstTimer: number | null = null;
async function findRelay(): Promise<string | null> {
  if (relayBase !== null) return relayBase;
  for (const base of RELAY_CANDIDATES) {
    try {
      const r = await fetch(`${base}/api/stats`, { cache: "no-store" });
      if (r.ok) {
        relayBase = base;
        return base;
      }
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

async function send(msg: unknown) {
  let local = false;
  let remote = false;

  try {
    ch.postMessage(msg);
    local = true;
  } catch {
    /* 隐私模式下 BroadcastChannel 可能不可用 */
  }

  const base = await findRelay();
  if (base !== null) {
    try {
      const r = await fetch(`${base}/api/director`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
      });
      remote = r.ok;
      if (!remote) relayBase = null;
    } catch {
      relayBase = null;
    }
  }

  if (local || remote) {
    // 诚实标注：BroadcastChannel 的 postMessage 只要通道存在就不报错，
    // 它只能证明「本机广播出去了」，证明不了同浏览器的另一块大屏真的收到。
    // 只有中继回了 2xx 才敢说「跨设备 · 大屏已收」。
    const via =
      local && remote ? "本机广播+跨设备" : local ? "仅本机广播 · 大屏未确认" : "跨设备";
    setFlash(`已发送 · ${via} ${new Date().toLocaleTimeString()}`, remote ? "#6ee7b7" : "#fbbf24");
  } else {
    setFlash("发送失败 · 中继未连接", "#f43f5e", 4000);
  }
}

document.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const act = btn.dataset.act;

    switch (act) {
      case "fullscreen":
        send({ type: "fullscreen" });
        break;
      case "mute":
        muted = !muted;
        send({ type: "mute", muted });
        muteBtn.textContent = muted ? "已静音 · 点此开声" : "静音 / 开声";
        muteBtn.classList.toggle("on", muted);
        break;
      case "mode": {
        const mode = btn.dataset.mode === "hype" ? "hype" : "normal";
        send({ type: "mode", mode });
        document.querySelectorAll<HTMLButtonElement>('button[data-act="mode"]').forEach((b) => {
          b.classList.toggle("on", b.dataset.mode === mode);
        });
        break;
      }
      case "start":
        send({ type: "stinger", kind: "start" });
        break;
      case "end":
        send({ type: "stinger", kind: "end" });
        break;
      case "reset":
        if (confirm("只清屏，不动链上。确定？")) send({ type: "reset" });
        break;
      case "burst":
        // v3「静默墙」：先让大屏安静，再点火。走 armBurst —— 连点只重挂一次倒数，
        // 不会叠出好几个 5.2s 计时器各自点火（中继虽有冷却兜底，但导演台自己先把重复点火掐掉）。
        armBurst();
        break;
      case "banner":
        send({ type: "banner", text: banner.value.trim() });
        break;
      case "banner-clear":
        banner.value = "";
        send({ type: "banner", text: "" });
        break;
    }
  });
});

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const text = chip.dataset.preset ?? "";
    banner.value = text;
    send({ type: "banner", text });
  });
});

/* ── 中继统计（服务没起就保持 —） ───────────────────── */
/**
 * 不能写死 localhost：一个人参赛时导演台往往开在手机上（笔记本接投影），
 * 那时 localhost 指向手机自己，面板会一直显示「中继未连接」——
 * 演讲者会以为蜂群挂了，其实只是地址找错了。
 * 顺序与观众页一致：?relay= → 同源 → 当前主机 8791。
 */
const STATS_CANDIDATES = [
  (new URLSearchParams(location.search).get("relay") ?? "").replace(/\/$/, ""),
  "",
  `http://${location.hostname || "127.0.0.1"}:8791`,
].filter((v, i, a) => a.indexOf(v) === i);

async function poll() {
  for (const base of STATS_CANDIDATES) {
    try {
      const r = await fetch(`${base}/api/stats`, { cache: "no-store" });
      if (!r.ok) continue;
      const s = await r.json();
      const set = (id: string, v: unknown) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(v);
      };
      set("s-queued", s.queued);
      set("s-sent", s.sent);
      set("s-failed", s.failed);
      set("s-tps", s.tps);
      set("s-keys", s.keys);
      // 只报连接状态；「已发送 · 跨设备」在 sendFlash 里单独显示，
      // 否则每 2 秒被这里冲掉，演讲者永远看不到自己那一下到底走没走通。
      setStatus("中继在线", "#6ee7b7");
      return;
    } catch {
      /* 换下一个候选地址 */
    }
  }
  setStatus("中继未连接", "#f43f5e");
}

/**
 * 状态栏由连接状态和发送回执两件事组成。
 * 分开存，避免互相覆盖：连接状态每 2s 刷新，发送回执保留 2.5s。
 */
let connState = { text: "未连接", color: "#94a3b8" };
let flash: { text: string; color: string; until: number } | null = null;

function setStatus(text: string, color: string) {
  connState = { text, color };
  renderStatus();
}

function setFlash(text: string, color: string, ms = 2500) {
  flash = { text, color, until: Date.now() + ms };
  renderStatus();
}

function renderStatus() {
  if (flash && Date.now() < flash.until) {
    statusEl.textContent = flash.text;
    statusEl.style.color = flash.color;
    return;
  }
  flash = null;
  statusEl.textContent = connState.text;
  statusEl.style.color = connState.color;
}
setInterval(renderStatus, 500);

poll();
setInterval(poll, 2000);

/* ────────────────────────────────────────────────────────────
 * 演出脚本：90 秒时间轴
 * 上台前按一次，剩下的交给它 —— 你只需要说话。
 * ──────────────────────────────────────────────────────────── */

type Cue = {
  at: number;                       // 秒
  label: string;                    // 导演台自己显示什么
  msg: Record<string, unknown>;     // 发给大屏
};

const SHOW: Cue[] = [
  { at: 0,  label: "起：让画面跑 3 秒",       msg: { type: "banner", text: "" } },
  { at: 3,  label: "「每一次变色、每一声，都是一笔链上交易」", msg: { type: "banner", text: "每一次变色、每一声，都是一笔链上交易" } },
  { at: 12, label: "「每条车道一个独立钱包」——速率不上字幕,顶栏 HUD 是多少念多少(F 口径)", msg: { type: "banner", text: "每条车道 = 一个独立钱包 · 实时速率见右上 HUD" } },
  { at: 22, label: "切高能模式",                              msg: { type: "mode", mode: "hype" } },
  { at: 25, label: "「扫码就能抢，不用钱包不用 gas」",         msg: { type: "banner", text: "扫码就能抢 · 不用钱包 · 不用 gas" } },
  { at: 45, label: "「刚才那几格是评委改的」",                 msg: { type: "banner", text: "刚才那几格，是评委改的" } },
  { at: 55, label: "「这不是动画，是浏览器」",                 msg: { type: "banner", text: "这不是动画 · 这是区块链浏览器" } },
  // v3「静默墙」：58s 起全场安静，62s 起爆 —— 大屏从收到 burst 那一刻各自倒数
  // 5.2 秒，真正炸开约在 67.2s，正好压在「主网贵且排队」那句台词上(0.42s 是提交窗口,落链随后几块,口径见 SUBMISSION)
  { at: 58, label: "「安静……五秒后一起涌入」",               msg: { type: "banner", text: "安静……五秒后，一起涌入" } },
  { at: 62, label: "⚡ 静默墙爆发 240 笔齐发",                msg: { type: "burst", count: 240 } },
  { at: 65, label: "「同样的体验，主网=天价+长队」(价格×延迟口径,别说物理打不进)", msg: { type: "banner", text: "同样的体验,以太坊主网 = 天价 + 长队" } },
  { at: 75, label: "杀手句",                                   msg: { type: "banner", text: "没写一行并行代码 · 只是把状态切成 2500 个互不相干的格子" } },
  { at: 88, label: "收尾音效",                                 msg: { type: "stinger", kind: "end" } },
  { at: 90, label: "结束",                                     msg: { type: "banner", text: "" } },
];

const SHOW_LEN = 90;
let showTimer: number | null = null;
let showStart = 0;

const btnRun = document.getElementById("runShow") as HTMLButtonElement | null;
const btnStop = document.getElementById("stopShow") as HTMLButtonElement | null;
const elBar = document.getElementById("showBar");
const elNow = document.getElementById("showNow");

function stopShow() {
  if (showTimer !== null) {
    clearInterval(showTimer);
    showTimer = null;
  }
  cancelBurst(); // 停止 = 把所有待发的手动爆发也撤掉，别留着 5.2s 后偷偷点火
  stopSelfCheck();
  if (elBar) elBar.style.width = "0%";
  if (elNow) elNow.textContent = "已停止";
}

function runShow() {
  stopShow();
  send({ type: "stinger", kind: "start" });
  showStart = performance.now();

  // 先把 0 秒的 cue 打出去。同时标 done：interval 第一拍 t≈0.2s 时
  // 0<=t 成立，若不标 done 会把 SHOW[0] 这条字幕再发一遍（双发）。
  send(SHOW[0].msg);
  (SHOW[0] as Cue & { done?: boolean }).done = true;

  showTimer = window.setInterval(() => {
    const t = (performance.now() - showStart) / 1000;

    for (const cue of SHOW) {
      if (cue.at <= t && !(cue as Cue & { done?: boolean }).done) {
        (cue as Cue & { done?: boolean }).done = true;
        send(cue.msg);
        if (elNow) elNow.textContent = `${cue.at}s · ${cue.label}`;
      }
    }

    if (elBar) elBar.style.width = Math.min(100, (t / SHOW_LEN) * 100).toFixed(1) + "%";

    if (t >= SHOW_LEN) {
      stopShow();
      if (elNow) elNow.textContent = "演出结束";
      (SHOW as Array<Cue & { done?: boolean }>).forEach((c) => (c.done = false));
    }
  }, 200) as unknown as number;
}

btnRun?.addEventListener("click", () => {
  (SHOW as Array<Cue & { done?: boolean }>).forEach((c) => (c.done = false));
  runShow();
});

btnStop?.addEventListener("click", stopShow);

/* ── 手动「爆发」的唯一计时器 ─────────────────────────── */
function armBurst() {
  if (burstTimer !== null) clearTimeout(burstTimer); // 连点 → 重挂，不叠加
  send({ type: "banner", text: "安静……五秒后，一起涌入" });
  setFlash("静默 5.2 秒…（再点可重挂倒数）", "#fbbf24", 5200);
  burstTimer = window.setTimeout(() => {
    burstTimer = null;
    send({ type: "burst", count: 240 });
  }, 5200) as unknown as number;
}

function cancelBurst() {
  if (burstTimer !== null) {
    clearTimeout(burstTimer);
    burstTimer = null;
  }
}

/* ── SHOW 自检：上台前排练，逐条过一遍 cue 的投递 ────────────
 * 只验证「指令能不能发出去 / 走哪条通道」，绝不真的连链：
 *   · 字幕 / 高能 / 静音这类纯显示 cue：实发，回执就是通道证据；
 *   · 爆发（会真发 240 笔上链）、清屏（会抹掉现场版图）、全屏（会抢走
 *     演讲者窗口）：只登记、回报「已跳过」，不触发。
 */
type SelfStep = { label: string; safe: boolean; run?: () => void };

const SELFCHECK: SelfStep[] = [
  { label: "静音·开", safe: true, run: () => send({ type: "mute", muted: true }) },
  { label: "静音·关", safe: true, run: () => send({ type: "mute", muted: false }) },
  { label: "字幕", safe: true, run: () => send({ type: "banner", text: "SHOW 自检 · 字幕通道 OK" }) },
  { label: "高能", safe: true, run: () => send({ type: "mode", mode: "hype" }) },
  { label: "普通", safe: true, run: () => send({ type: "mode", mode: "normal" }) },
  { label: "全屏", safe: false },
  { label: "清屏", safe: false },
  { label: "爆发240", safe: false },
  { label: "清字幕", safe: true, run: () => send({ type: "banner", text: "" }) },
];

let selfCheckTimer: number | null = null;

function stopSelfCheck() {
  if (selfCheckTimer !== null) {
    clearTimeout(selfCheckTimer);
    selfCheckTimer = null;
  }
}

function runSelfCheck() {
  stopShow(); // 与正式演出互斥（stopShow 里已顺带 stopSelfCheck + cancelBurst）
  const skipped = SELFCHECK.filter((c) => !c.safe).map((c) => c.label);
  let i = 0;
  const step = () => {
    if (i >= SELFCHECK.length) {
      setFlash(
        `自检完成：实发 ${SELFCHECK.length - skipped.length} · 跳过 ${skipped.length}（${skipped.join("/")} 会动链上/界面）`,
        "#6ee7b7",
        6000,
      );
      if (elNow) elNow.textContent = "自检完成";
      selfCheckTimer = null;
      return;
    }
    const c = SELFCHECK[i];
    if (elNow) elNow.textContent = `自检 ${i + 1}/${SELFCHECK.length} · ${c.label}`;
    if (c.safe && c.run) c.run();
    else setFlash(`自检 · ${c.label}：已跳过（排练不触发）`, "#fbbf24", 800);
    i++;
    selfCheckTimer = window.setTimeout(step, 560) as unknown as number;
  };
  step();
}

// 自检按钮：HTML 里没有现成的，就在「播放演示」旁边动态插一个，不污染静态结构。
const btnSelf = document.createElement("button");
btnSelf.id = "selfCheck";
btnSelf.textContent = "✓ SHOW 自检";
btnSelf.title = "上台前排练：逐条发一遍 cue 看通道是否打通。不会真的爆发上链 / 清屏 / 全屏。";
btnRun?.parentElement?.insertBefore(btnSelf, btnRun.nextSibling);
btnSelf.addEventListener("click", runSelfCheck);
