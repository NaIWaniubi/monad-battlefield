/**
 * X · P0-3 到场验证页逻辑（web/verify.html 的唯一脚本）
 *
 * 设计（诚实边界，必须照读的规格）：
 *   - 纯前端直连公共 RPC（fetch JSON-RPC），零后端零密钥。
 *   - Claim(id indexed, who indexed, color, heat)：合约源码 contracts/Battlefield.sol:21
 *     里 who 是 indexed；但任务规格要求「按地址过滤不得依赖 topic2」，
 *     所以本文件的过滤主路径 = 窗口内拉全部 Claim → 客户端逐条比对 who。
 *     parseClaimLog 同时兼容「who 非 indexed」的数据段形状，两种 ABI 都不翻车。
 *   - 公共节点 eth_getLogs 有范围硬限（实测 2026-11-21：monad.xyz/drpc/ankr
 *     三家对 >100 块的窗口一律拒绝 "block range too large"），
 *     所以分块 ≤ LOG_CHUNK=50 块/请求（留一倍余量给最保守节点）。
 *   - 历史 2.2M+ 块拉不完 → 默认只扫「最近 DEFAULT_WINDOW=2000 块」，
 *     输入框可调、上限 MAX_WINDOW=5000；页面明写窗口声明，不假装全量。
 *   - 窗口起点永不早于合约 START_BLOCK。
 *
 * 本文件导出两组东西：
 *   1) 纯函数（normalizeAddress / parseWindow / computeWindows / parseClaimLog /
 *      filterClaimsByAddress / formatCellPosition / factionOfColor / 链接与参数解析）
 *      —— tests/verify.test.ts 用假 logs 钉死契约；
 *   2) RPC 驱动（makeRpcCall / scanClaimsRange / verifyAddress）—— 页面与
 *      node 侧验收脚本走同一条代码路径。
 * DOM 引导只在 verify.html 页面里发生（#v-form 存在才启动），node/vitest 导入无副作用。
 */

import { FACTIONS, SIDE } from "./grid";

/* ─────────────────────────── 链上事实常量 ─────────────────────────── */

export const CHAIN_ID = 10143;
export const CONTRACT = "0xd525ef7ee4072e80765fd61633d80322040afd9d";
export const START_BLOCK = 79333331;
/** keccak256("Claim(uint16,address,uint8,uint32)") —— 由 viem toEventHash 独立互证（见单测） */
export const CLAIM_TOPIC0 =
  "0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9";

/** 与 web/src/rpc.ts 同源的多节点列表；主节点按任务书 = 官方 testnet-rpc */
export const RPC_ENDPOINTS = [
  "https://testnet-rpc.monad.xyz",
  "https://monad-testnet.drpc.org",
  "https://rpc.ankr.com/monad_testnet",
];

export const EXPLORER_BASE = "https://testnet.monadscan.com";

export const DEFAULT_WINDOW = 2000;
export const MAX_WINDOW = 5000;
export const LOG_CHUNK = 50;

/** 供测试与 UI 共用的阵营色表（与大屏 grid.ts 同一引用，色值永不漂移） */
export { FACTIONS };

/* ─────────────────────────── 类型 ─────────────────────────── */

export interface RawLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string | number;
  transactionHash?: string;
}

export interface ClaimEvent {
  id: number;
  who: string; // 小写 0x+40hex
  color: number;
  heat: number;
  block: number;
  txHash: string;
}

export interface ScanWindow {
  from: number;
  to: number;
}

/* ─────────────────────────── 纯函数 ─────────────────────────── */

/** 0x + 40 hex（大小写不限，自动去首尾空白）→ 统一小写；否则 null */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** 窗口输入解析：非法/空/≤0 → DEFAULT_WINDOW；> MAX_WINDOW → 钳到 MAX_WINDOW；小数取整 */
export function parseWindow(raw: unknown): number {
  const n =
    typeof raw === "number" ? raw : raw == null || String(raw).trim() === "" ? NaN : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINDOW;
  return Math.min(Math.floor(n), MAX_WINDOW);
}

/** hex(0x…) / 十进制字符串 / number / bigint → 安全整数；坏输入 null */
export function toBlockNumber(v: unknown): number | null {
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const n = /^0x[0-9a-fA-F]+$/.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 扫描计划：覆盖 [max(START_BLOCK, latest-window+1), latest]，
 * 升序、每块恰好一次、每窗 ≤ chunk 块。latest < START_BLOCK → 空数组。
 */
export function computeWindows(latest: number, window: number, chunk: number): ScanWindow[] {
  if (!Number.isSafeInteger(latest) || latest < START_BLOCK) return [];
  const w = Math.max(1, Number.isSafeInteger(window) ? window : DEFAULT_WINDOW);
  const c = Math.max(1, Number.isSafeInteger(chunk) ? chunk : LOG_CHUNK);
  const from0 = Math.max(START_BLOCK, latest - w + 1);
  const out: ScanWindow[] = [];
  for (let f = from0; f <= latest; f += c) out.push({ from: f, to: Math.min(f + c - 1, latest) });
  return out;
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** 32 字节字里的地址：取后 20 字节（兼容个别节点返回裸 20 字节） */
function wordToAddress(word: string | undefined): string | null {
  if (!word) return null;
  if (HEX64.test(word)) return ("0x" + word.slice(-40)).toLowerCase();
  if (HEX40.test(word)) return word.toLowerCase();
  return null;
}

/**
 * 解析一条 Claim 日志。两种 ABI 形状都认：
 *   真实链（Battlefield.sol:21，who indexed）：topics=[sig,id,who], data=[color,heat]
 *   回退（who 非 indexed）：topics=[sig,id], data=[who,color,heat]
 * 其它任何一条校验不过 → null（解析器永不抛异常）。
 */
export function parseClaimLog(log: RawLog): ClaimEvent | null {
  try {
    const topics = log.topics;
    if (!topics || topics.length < 1) return null;
    if (topics[0].toLowerCase() !== CLAIM_TOPIC0.toLowerCase()) return null;

    const idWord = topics[1];
    if (!idWord || !HEX64.test(idWord)) return null;
    const id = Number(BigInt(idWord));
    if (!Number.isSafeInteger(id) || id < 0) return null;

    let who: string | null = null;
    let color = NaN;
    let heat = NaN;

    // data 拆 32 字节词
    const words: (string | undefined)[] = [];
    if (typeof log.data === "string" && /^0x([0-9a-fA-F]{64})+$/.test(log.data)) {
      for (let i = 2; i + 64 <= log.data.length; i += 64) words.push("0x" + log.data.slice(i, i + 64));
    }

    const asNum = (w: string | undefined) => (w && HEX64.test(w) ? Number(BigInt(w)) : NaN);

    if (topics.length >= 3) {
      who = wordToAddress(topics[2]);
      color = asNum(words[0]);
      heat = asNum(words[1]);
    } else {
      who = wordToAddress(words[0]);
      color = asNum(words[1]);
      heat = asNum(words[2]);
    }
    if (!who || !Number.isInteger(color) || color < 0 || color > 255) return null;
    if (!Number.isInteger(heat) || heat < 0) return null;

    const block = toBlockNumber(log.blockNumber);
    if (block == null) return null;
    const txHash = log.transactionHash;
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;

    return { id, who, color, heat, block, txHash };
  } catch {
    return null;
  }
}

/** 过滤 + 排序：只留 who===address 的合法 Claim，按区块降序（最新在前） */
export function filterClaimsByAddress(logs: RawLog[], address: string): ClaimEvent[] {
  const target = normalizeAddress(address);
  if (!target) return [];
  const out: ClaimEvent[] = [];
  for (const log of logs) {
    const c = parseClaimLog(log);
    if (c && c.who === target) out.push(c);
  }
  out.sort((a, b) => b.block - a.block || b.id - a.id);
  return out;
}

/** 格子 id → 「第 r 行 · 第 c 列」（SIDE=50，1-based，与大屏编号同源） */
export function formatCellPosition(id: number): string {
  const r = Math.floor(id / SIDE) + 1;
  const c = (id % SIDE) + 1;
  return `第 ${r} 行 · 第 ${c} 列`;
}

/** color(1..4) → 阵营表项；0/越界 → null */
export function factionOfColor(color: number): { name: string; hex: string } | null {
  return Number.isInteger(color) && color >= 1 && color < FACTIONS.length ? FACTIONS[color] : null;
}

export function monadscanTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}
export function monadscanAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}
export function monadscanBlockUrl(block: number): string {
  return `${EXPLORER_BASE}/block/${block}`;
}

/** 从 location.search 里取预填地址（?addr=0x…）；非法 → null */
export function parseAddrParam(search: string): string | null {
  try {
    const m = /[?&]addr=([^&]+)/.exec(search);
    return m ? normalizeAddress(decodeURIComponent(m[1])) : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────── RPC 驱动（页面与验收脚本共用） ─────────────────────────── */

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * 带故障转移的 JSON-RPC 调用：按 RPC_ENDPOINTS 依次试，成功者置顶。
 * 浏览器与 Node 18+ 都有全局 fetch —— 此函数无 DOM 依赖。
 */
export function makeRpcCall(endpoints: string[] = RPC_ENDPOINTS): RpcCall {
  let preferred = 0;
  return async (method, params) => {
    let lastErr: unknown = null;
    for (let i = 0; i < endpoints.length; i++) {
      const idx = (preferred + i) % endpoints.length;
      try {
        const res = await fetch(endpoints[idx], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (j.error) throw new Error(j.error.message ?? "rpc error");
        preferred = idx;
        return j.result;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("所有 RPC 均不可用");
  };
}

export interface ScanResult {
  claims: ClaimEvent[];
  windows: ScanWindow[];
  failed: ScanWindow[];
}

/** 扫一个已知区块区间：每窗 ≤ chunk 块 getLogs，客户端按 from(who) 过滤 */
export async function scanClaimsRange(
  call: RpcCall,
  address: string,
  windows: ScanWindow[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResult> {
  const target = normalizeAddress(address);
  const claims: ClaimEvent[] = [];
  const failed: ScanWindow[] = [];
  if (!target) return { claims, windows, failed };
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    try {
      const logs = (await call("eth_getLogs", [
        {
          address: CONTRACT,
          topics: [CLAIM_TOPIC0],
          fromBlock: "0x" + w.from.toString(16),
          toBlock: "0x" + w.to.toString(16),
        },
      ])) as RawLog[];
      if (Array.isArray(logs)) {
        for (const log of logs) {
          const c = parseClaimLog(log);
          if (c && c.who === target) claims.push(c);
        }
      }
    } catch {
      failed.push(w); // 单窗失败不中断整体（诚实计入 failed）
    }
    onProgress?.(i + 1, windows.length);
  }
  claims.sort((a, b) => b.block - a.block || b.id - a.id);
  return { claims, windows, failed };
}

export interface VerifyOutcome {
  latest: number;
  plan: ScanWindow[];
  from: number;
  to: number;
  claims: ClaimEvent[];
  failed: ScanWindow[];
}

/** 页面主流程：读最新块 → 计算窗口 → 分块扫描。window 走 parseWindow 钳制。 */
export async function verifyAddress(
  call: RpcCall,
  address: string,
  windowRaw: unknown,
  onProgress?: (done: number, total: number) => void,
): Promise<VerifyOutcome> {
  const window = parseWindow(windowRaw);
  const latest = toBlockNumber(await call("eth_blockNumber", []));
  if (latest == null) throw new Error("无法读取最新区块");
  const plan = computeWindows(latest, window, LOG_CHUNK);
  const from = plan.length ? plan[0].from : latest;
  const r = await scanClaimsRange(call, address, plan, onProgress);
  return { latest, plan, from, to: latest, claims: r.claims, failed: r.failed };
}

/* ─────────────────────────── DOM 引导（仅 verify.html 内触发） ─────────────────────────── */

function boot(): void {
  const $ = <T extends Element>(id: string) => document.getElementById(id) as T | null;
  const form = $<HTMLFormElement>("v-form");
  const addrInput = $<HTMLInputElement>("v-addr");
  const winInput = $<HTMLInputElement>("v-window");
  const goBtn = $<HTMLButtonElement>("v-go");
  const errEl = $<HTMLElement>("v-err");
  const dotEl = $<HTMLElement>("v-dot");
  const blockEl = $<HTMLElement>("v-block");
  const rpcEl = $<HTMLElement>("v-rpc");
  const progEl = $<HTMLElement>("v-progress");
  const summaryEl = $<HTMLElement>("v-summary");
  const listEl = $<HTMLElement>("v-list");
  if (!form || !addrInput || !winInput || !goBtn || !errEl || !dotEl || !blockEl || !rpcEl || !progEl || !summaryEl || !listEl) return;

  const call = makeRpcCall();

  /* 顶部链状态灯 */
  async function pollChain(): Promise<void> {
    const t0 = Date.now();
    try {
      const b = toBlockNumber(await call("eth_blockNumber", []));
      if (b == null) throw new Error("bad block");
      dotEl!.className = "lamp ok";
      blockEl!.textContent = "#" + b.toLocaleString("en-US");
      rpcEl!.textContent = `${Date.now() - t0}ms · Monad Testnet ${CHAIN_ID}`;
    } catch {
      dotEl!.className = "lamp bad";
      blockEl!.textContent = "RPC 不可达";
      rpcEl!.textContent = "稍后自动重试";
    }
  }
  void pollChain();
  setInterval(() => void pollChain(), 5000);

  /* ?addr= 预填（二维码直达：大屏署名格点击 → 本页） */
  const pre = parseAddrParam(location.search);
  if (pre) addrInput.value = pre;

  function el(tag: string, cls: string | null, text?: string): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderClaim(c: ClaimEvent): HTMLElement {
    const row = el("li", "claim");
    const fac = factionOfColor(c.color);
    const sw = el("span", "sw");
    sw.style.background = fac ? fac.hex : "#666";
    row.appendChild(sw);
    row.appendChild(el("span", "cell", `#${c.id}`));
    row.appendChild(el("span", "pos", formatCellPosition(c.id)));
    row.appendChild(el("span", "fac", fac ? fac.name : `色${c.color}`));
    row.appendChild(el("span", "meta", `heat ${c.heat}`));
    const blk = document.createElement("a");
    blk.href = monadscanBlockUrl(c.block);
    blk.target = "_blank";
    blk.rel = "noopener";
    blk.className = "lnk";
    blk.textContent = "块 #" + c.block.toLocaleString("en-US");
    row.appendChild(blk);
    const a = document.createElement("a");
    a.href = monadscanTxUrl(c.txHash);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "lnk tx";
    a.textContent = c.txHash.slice(0, 10) + "…" + c.txHash.slice(-8);
    a.title = c.txHash;
    row.appendChild(a);
    return row;
  }

  let running = false;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (running) return;
    const addr = normalizeAddress(addrInput.value);
    if (!addr) {
      errEl.textContent = "地址格式不对：需要 0x 开头 + 40 位十六进制字符。";
      listEl.replaceChildren();
      summaryEl.replaceChildren();
      return;
    }
    errEl.textContent = "";
    running = true;
    goBtn.disabled = true;
    progEl.textContent = "扫描中…";
    summaryEl.replaceChildren();
    listEl.replaceChildren();

    void verifyAddress(call, addr, winInput.value, (done, total) => {
      progEl.textContent = `扫描中… ${done}/${total} 个区块窗口`;
    })
      .then((out) => {
        const spanned = out.plan.length ? out.to - out.from + 1 : 0;
        const sum = el("div", "summary");
        sum.appendChild(
          el(
            "p",
            "head",
            out.claims.length
              ? `命中 ${out.claims.length} 笔 claim（地址 ${addr.slice(0, 8)}…${addr.slice(-6).toLowerCase()}）`
              : `最近 ${spanned} 块内没有该地址的 claim`,
          ),
        );
        // 诚实边界声明 —— 每次结果都跟着，评委看得懂
        sum.appendChild(
          el(
            "p",
            "bound",
            `本次扫描窗口：块 ${out.from.toLocaleString("en-US")} → ${out.to.toLocaleString("en-US")}` +
              `（${spanned.toLocaleString("en-US")} 块 / ${out.plan.length} 次 getLogs，` +
              `每块区间公共节点硬限 ≤100 块，本页面取 50）。合约自块 ${START_BLOCK.toLocaleString("en-US")} 部署以来的更早历史不在本页扫描范围。` +
              (out.failed.length ? ` 有 ${out.failed.length} 个分块查询失败已跳过（重试可恢复）。` : ""),
          ),
        );
        if (!out.claims.length) {
          sum.appendChild(el("p", "hint", "若这笔 claim 是刚点的：链上索引有延迟，等 10~30 秒再点一次「验证」。"));
        }
        summaryEl.appendChild(sum);
        const ul = el("ul", "claims");
        for (const c of out.claims) ul.appendChild(renderClaim(c));
        listEl.appendChild(ul);
        // 地址在 MonadScan 上的总览链接（覆盖全历史，弥补窗口边界的另一条腿）
        const explorer = el("p", "bound");
        const ea = document.createElement("a");
        ea.href = monadscanAddressUrl(addr);
        ea.target = "_blank";
        ea.rel = "noopener";
        ea.className = "lnk";
        ea.textContent = "在 MonadScan 查看该地址的完整历史 →";
        explorer.appendChild(ea);
        summaryEl.appendChild(explorer);
        progEl.textContent = "";
      })
      .catch((e: unknown) => {
        progEl.textContent = "";
        errEl.textContent = "RPC 查询失败：" + (e instanceof Error ? e.message : String(e)) + "（公共节点限流时稍等重试）";
      })
      .finally(() => {
        running = false;
        goBtn.disabled = false;
      });
  });
}

if (typeof document !== "undefined" && document.getElementById("v-form")) {
  boot();
}
