/**
 * X · P0-3 到场验证页（web/verify.html）纯逻辑单测
 *
 * 钉死四组契约：
 *   1. 地址输入校验（0x+40hex，大小写归一）
 *   2. 扫描窗口计算（默认 2000 / 上限 5000 / 分块 ≤50 / 不早于 startBlock）
 *   3. Claim 日志解析（真实链上 indexed-who 形状为主契约，
 *      兼容「who 非 indexed」假设的数据段回退 —— 两种形状都必须解析正确，
 *      这是评委现场无论链上事件 ABI 长什么样页面都不翻车的保险）
 *   4. 按地址过滤 + 格式化（格子坐标 / 阵营色 / MonadScan 链接）
 *
 * 全部纯函数，无 DOM、无网络。假 logs 输入。
 */
import { describe, expect, it } from "vitest";
import { toEventHash } from "viem";
import {
  CLAIM_TOPIC0,
  CONTRACT,
  DEFAULT_WINDOW,
  EXPLORER_BASE,
  FACTIONS,
  MAX_WINDOW,
  START_BLOCK,
  computeWindows,
  filterClaimsByAddress,
  factionOfColor,
  formatCellPosition,
  monadscanAddressUrl,
  monadscanTxUrl,
  normalizeAddress,
  parseAddrParam,
  parseClaimLog,
  parseWindow,
  type RawLog,
} from "../web/src/verify";

// viem 独立计算的事件 topic0 —— 与 verify.ts 里硬编码常量互证
const TOPIC0 = toEventHash({
  type: "event",
  name: "Claim",
  inputs: [
    { name: "id", type: "uint16", indexed: true },
    { name: "who", type: "address", indexed: true },
    { name: "color", type: "uint8", indexed: false },
    { name: "heat", type: "uint32", indexed: false },
  ],
});

const pad32 = (hex: string) =>
  "0x" + hex.replace(/^0x/, "").padStart(64, "0");

const WHO_A = "0xfff48c7929914fb83cf53984c3b62ac4e0a1232e";
const WHO_A_MIXED = "0xffF48c7929914Fb83CF53984c3b62Ac4e0A1232e";
const WHO_B = "0x17ff85c1d82aed d1da887406a307d087c5cda61e".replace(/\s/g, "");

const TX = "0x" + "ab".repeat(32);
const TX2 = "0x" + "cd".repeat(32);

/** 真实链形状：id/who 在 topics[1]/[2]，color/heat 在 data */
function claimLog(opts: {
  id: number;
  who: string;
  color: number;
  heat: number;
  block: number;
  tx: string;
}): RawLog {
  return {
    address: CONTRACT,
    topics: [
      TOPIC0,
      pad32(opts.id.toString(16)),
      "0x000000000000000000000000" + opts.who.slice(2).toLowerCase(),
    ],
    data: pad32(opts.color.toString(16)) + pad32(opts.heat.toString(16)).slice(2),
    blockNumber: "0x" + opts.block.toString(16),
    transactionHash: opts.tx,
  };
}

describe("地址校验 normalizeAddress", () => {
  it("接受 0x+40hex，大小写混合 → 统一小写", () => {
    expect(normalizeAddress(WHO_A_MIXED)).toBe(WHO_A);
    expect(normalizeAddress("  " + WHO_A.toUpperCase().replace("0X", "0x") + " ")).toBe(WHO_A);
  });
  it("拒绝：缺 0x / 39 位 / 41 位 / 非 hex / 空串 / null", () => {
    expect(normalizeAddress(WHO_A.slice(2))).toBeNull();
    expect(normalizeAddress(WHO_A.slice(0, -1))).toBeNull();
    expect(normalizeAddress(WHO_A + "0")).toBeNull();
    expect(normalizeAddress("0x" + "g".repeat(40))).toBeNull();
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("0x123")).toBeNull();
  });
});

describe("窗口参数 parseWindow", () => {
  it("空/非法输入回默认 2000", () => {
    expect(parseWindow("")).toBe(DEFAULT_WINDOW);
    expect(parseWindow("abc")).toBe(DEFAULT_WINDOW);
    expect(parseWindow("0")).toBe(DEFAULT_WINDOW);
    expect(parseWindow("-10")).toBe(DEFAULT_WINDOW);
    expect(parseWindow(null)).toBe(DEFAULT_WINDOW);
    expect(parseWindow(undefined)).toBe(DEFAULT_WINDOW);
  });
  it("合法值取整；超过上限 5000 钳到 5000", () => {
    expect(parseWindow("100")).toBe(100);
    expect(parseWindow("1500.7")).toBe(1500);
    expect(parseWindow("99999")).toBe(MAX_WINDOW);
    expect(parseWindow(DEFAULT_WINDOW)).toBe(DEFAULT_WINDOW);
    expect(DEFAULT_WINDOW).toBe(2000);
    expect(MAX_WINDOW).toBe(5000);
  });
});

describe("扫描窗口计算 computeWindows", () => {
  it("覆盖 [latest-window+1, latest] 且升序、每块恰好一次（含首尾）", () => {
    const ws = computeWindows(81_000_000, 100, 50);
    expect(ws).toEqual([
      { from: 80_999_901, to: 80_999_950 },
      { from: 80_999_951, to: 81_000_000 },
    ]);
  });
  it("非整除时最后一窗缩短，仍无缝覆盖", () => {
    const ws = computeWindows(81_000_000, 110, 50);
    expect(ws.length).toBe(3);
    let next = 81_000_000 - 110 + 1;
    for (const w of ws) {
      expect(w.from).toBe(next);
      expect(w.to - w.from + 1).toBeLessThanOrEqual(50);
      next = w.to + 1;
    }
    expect(next).toBe(81_000_001);
  });
  it("单窗边界：块数 ≤ chunk 时只有一窗", () => {
    expect(computeWindows(81_000_000, 40, 50)).toEqual([{ from: 80_999_961, to: 81_000_000 }]);
  });
  it("不早于合约 startBlock：窗口被 startBlock 截断；latest < startBlock 时为空", () => {
    const ws = computeWindows(START_BLOCK + 10, 5000, 50);
    expect(ws[0].from).toBe(START_BLOCK);
    expect(ws[ws.length - 1].to).toBe(START_BLOCK + 10);
    expect(computeWindows(START_BLOCK - 5, 2000, 50)).toEqual([]);
  });
  it("默认规模 2000 块 / 50 一块 = 40 个请求；每窗 ≤50 块（RPC 硬限）", () => {
    const ws = computeWindows(81_500_000, DEFAULT_WINDOW, 50);
    expect(ws.length).toBe(40);
    for (const w of ws) expect(w.to - w.from + 1).toBeLessThanOrEqual(50);
  });
});

describe("Claim 日志解析 parseClaimLog", () => {
  it("topic0 常量与 viem 独立计算互证", () => {
    expect(CLAIM_TOPIC0.toLowerCase()).toBe(TOPIC0.toLowerCase());
  });

  it("真实链形状（who indexed）：解出 id/who/color/heat/block/tx", () => {
    const log = claimLog({ id: 1237, who: WHO_A, color: 3, heat: 42000, block: 81_488_802, tx: TX });
    const c = parseClaimLog(log);
    expect(c).not.toBeNull();
    expect(c!.id).toBe(1237);
    expect(c!.who).toBe(WHO_A);
    expect(c!.color).toBe(3);
    expect(c!.heat).toBe(42000);
    expect(c!.block).toBe(81_488_802);
    expect(c!.txHash).toBe(TX);
  });

  it("回退形状（who 非 indexed，在 data word0）：同样解出全部字段", () => {
    const log: RawLog = {
      address: CONTRACT,
      topics: [TOPIC0, pad32("0x2f5")], // 只有 id indexed
      data:
        "0x000000000000000000000000" + WHO_B.slice(2) +
        pad32("2").slice(2) + pad32("ff").slice(2),
      blockNumber: "0x64",
      transactionHash: TX2,
    };
    const c = parseClaimLog(log);
    expect(c).not.toBeNull();
    expect(c!.id).toBe(0x2f5);
    expect(c!.who).toBe(WHO_B);
    expect(c!.color).toBe(2);
    expect(c!.heat).toBe(255);
    expect(c!.block).toBe(100);
  });

  it("噪声拒绝：topic0 不匹配 / topics 缺 id / data 词数不足 / txHash 非法", () => {
    const base = claimLog({ id: 1, who: WHO_A, color: 1, heat: 1, block: 1, tx: TX });
    expect(parseClaimLog({ ...base, topics: [pad32("999"), ...base.topics.slice(1)] })).toBeNull();
    expect(parseClaimLog({ ...base, topics: [base.topics[0]] })).toBeNull();
    expect(parseClaimLog({ ...base, data: pad32("1") })).toBeNull();
    expect(parseClaimLog({ ...base, transactionHash: "0xdeadbeef" })).toBeNull();
    expect(parseClaimLog({})).toBeNull();
  });
});

describe("按地址过滤 + 排序 filterClaimsByAddress", () => {
  it("大小写不敏感命中；非目标地址剔除；按区块降序（最新在前）", () => {
    const logs: RawLog[] = [
      claimLog({ id: 10, who: WHO_B, color: 1, heat: 5, block: 500, tx: TX }),
      claimLog({ id: 20, who: WHO_A, color: 2, heat: 9, block: 400, tx: TX2 }),
      claimLog({ id: 30, who: WHO_A, color: 4, heat: 1, block: 600, tx: TX }),
      { ...claimLog({ id: 40, who: WHO_A, color: 4, heat: 1, block: 601, tx: TX }), topics: undefined },
    ];
    const out = filterClaimsByAddress(logs, WHO_A_MIXED);
    expect(out.map((c) => c.id)).toEqual([30, 20]);
    expect(out[0].block).toBeGreaterThanOrEqual(out[1].block);
  });
});

describe("格式化与链接", () => {
  it("格子 id → 行列（SIDE=50，1-based）", () => {
    expect(formatCellPosition(0)).toBe("第 1 行 · 第 1 列");
    expect(formatCellPosition(49)).toBe("第 1 行 · 第 50 列");
    expect(formatCellPosition(50)).toBe("第 2 行 · 第 1 列");
    expect(formatCellPosition(2499)).toBe("第 50 行 · 第 50 列");
  });
  it("阵营色与 grid.ts FACTIONS 同源：1紫 2青 3琥珀 4绯；越界返回 null", () => {
    expect(FACTIONS[1].hex).toBe("#8B7BD8");
    expect(FACTIONS[4].hex).toBe("#B5525F");
    expect(factionOfColor(3)!.name).toBe("琥珀");
    expect(factionOfColor(0)).toBeNull();
    expect(factionOfColor(9)).toBeNull();
  });
  it("MonadScan 直达链接：testnet 域 + /tx/ 与 /address/ 路径", () => {
    expect(EXPLORER_BASE).toBe("https://testnet.monadscan.com");
    expect(monadscanTxUrl(TX)).toBe(`https://testnet.monadscan.com/tx/${TX}`);
    expect(monadscanAddressUrl(WHO_A)).toBe(`https://testnet.monadscan.com/address/${WHO_A}`);
  });
  it("URL 预填参数 ?addr= 解析：合法→小写地址，非法/缺省→null", () => {
    expect(parseAddrParam("?addr=" + WHO_A_MIXED)).toBe(WHO_A);
    expect(parseAddrParam("?x=1&addr=" + WHO_A)).toBe(WHO_A);
    expect(parseAddrParam("?addr=nothex")).toBeNull();
    expect(parseAddrParam("")).toBeNull();
  });
});
