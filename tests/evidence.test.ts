/**
 * E1-2 · scripts/evidence.mjs 纯函数单测
 *
 * 只测不触网的部分：topic0 正确性、区块号解析、窗口切分/抽样、
 * 外推估计、日志计数、Markdown 渲染。网络层（rpcCall/main）不在
 * 单测里跑 —— CI 的 evidence job 用 continue-on-error，真链可达性
 * 由本地干跑 + 现场 CI 验证。
 */
import { describe, expect, it } from "vitest";
import { getEventSelector, parseAbiItem } from "viem";
import {
  CLAIM_TOPIC0,
  countClaims,
  extrapolate,
  parseBlockNumber,
  parseHeatSlot,
  renderEvidenceMarkdown,
  sampleWindows,
  splitWindows,
} from "../scripts/evidence.mjs";

describe("CLAIM_TOPIC0", () => {
  it("等于合约事件 Claim(uint16 indexed,address indexed,uint8,uint32) 的选择器", () => {
    // 与 contracts/Battlefield.sol:21 逐字段对齐；topic 写错 = 扫到 0 条还自称"链上无 claim"，
    // 这是整份证据文件唯一会静默说谎的地方，必须钉死。
    const computed = getEventSelector(
      parseAbiItem("event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)"),
    );
    expect(CLAIM_TOPIC0.toLowerCase()).toBe(computed.toLowerCase());
  });
});

describe("parseBlockNumber", () => {
  it("解析十六进制区块号；非法输入抛错", () => {
    expect(parseBlockNumber("0x4db8035")).toBe(81494069n); // 逐位手算：4·16⁶+13·16⁵+11·16⁴+8·16³+3·16+5
    expect(parseBlockNumber("0x0")).toBe(0n);
    expect(() => parseBlockNumber("81461301")).toThrow(TypeError);
    expect(() => parseBlockNumber("0xzz")).toThrow(TypeError);
    expect(() => parseBlockNumber(null)).toThrow(TypeError);
  });
});

describe("窗口切分", () => {
  it("splitWindows：200 块按 100 切成两个升序无空洞窗口", () => {
    const ws = splitWindows(1000n, 200n, 100n);
    expect(ws).toEqual([
      { from: 801n, to: 900n },
      { from: 901n, to: 1000n },
    ]);
    // 跨度不整除时也要严丝合缝（窗口 ≤ windowSize、相邻无缺口）
    const ws2 = splitWindows(1000n, 250n, 100n);
    expect(ws2[0].from).toBe(751n);
    for (let i = 1; i < ws2.length; i++) expect(ws2[i].from).toBe(ws2[i - 1].to + 1n);
    for (const w of ws2) expect(w.to - w.from).toBeLessThanOrEqual(99n);
  });

  it("sampleWindows：等距、在界内、互不重叠、首窗含 start 末窗含 latest", () => {
    const ws = sampleWindows(1000n, 2099n, 11, 100n); // 跨度 1100
    expect(ws.length).toBe(11);
    expect(ws[0].from).toBe(1000n);
    expect(ws[ws.length - 1].to).toBe(2099n);
    for (let i = 1; i < ws.length; i++) expect(ws[i].from).toBeGreaterThan(ws[i - 1].to);
    // 确定性：同样输入两次调用结果一致
    expect(sampleWindows(1000n, 2099n, 11, 100n)).toEqual(ws);
    // 历史不足一个窗口时退化为全量切分，不越界
    const tiny = sampleWindows(950n, 1050n, 30, 100n);
    expect(tiny[0].from).toBeGreaterThanOrEqual(950n);
    expect(tiny[tiny.length - 1].to).toBe(1050n);
  });
});

describe("统计与外推", () => {
  it("countClaims：只数 topic0（和地址）匹配的日志", () => {
    const ok = { address: "0xAAA", topics: [CLAIM_TOPIC0] };
    const other = { address: "0xAAA", topics: ["0x" + "11".repeat(32)] };
    expect(countClaims([ok, other, ok], "0xaaa")).toBe(2);
    expect(countClaims([], "0xaaa")).toBe(0);
    // 地址过滤：同 topic 但别家合约发的不算
    expect(countClaims([{ address: "0xBBB", topics: [CLAIM_TOPIC0] }], "0xaaa")).toBe(0);
  });

  it("extrapolate：按采样密度线性外推，样本为 0 返回 0", () => {
    expect(extrapolate(30n, 3000n, 300000n)).toBe(3000);
    expect(extrapolate(0n, 3000n, 300000n)).toBe(0);
    expect(extrapolate(5n, 0n, 100n)).toBe(0);
  });

  it("parseHeatSlot：packed slot 的 heat = (v>>160)&0xffffffff", () => {
    // 2026-11-21 实链实测值（cells[7]，color=1、heat=2、owner=0x3470b1ae…）
    expect(
      parseHeatSlot("0x0000000000000001000000023470b1aeb06d28145b37dfe7d77190196a79ecb8"),
    ).toBe(2n);
    expect(parseHeatSlot("0x0")).toBe(0n); // 空槽短形式
    expect(() => parseHeatSlot("not-hex")).toThrow(TypeError);
    expect(() => parseHeatSlot(undefined)).toThrow(TypeError);
  });
});

describe("renderEvidenceMarkdown", () => {
  it("包含时间戳、精确近段计数、抽样估计与诚实免责声明", () => {
    const md = renderEvidenceMarkdown(
      {
        rpc: "https://testnet-rpc.monad.xyz",
        chainId: "10143",
        address: "0xd525ef7ee4072e80765fd61633d80322040afd9d",
        startBlock: "79333331",
        latest: 81518495n,
        recentBlocks: 200n,
        recentClaims: 7n,
        totalClaims: 45678n,
        sampledClaims: 120n,
        sampledBlocks: 2400n,
        sampleCount: 24,
        sampleFails: 0,
        estimate: 1104167n,
      },
      new Date("2026-11-21T07:00:00.000Z"),
    );
    expect(md).toContain("2026-11-21"); // 时间戳（UTC + 北京时间两行都含此日期）
    expect(md).toContain("自动生成");
    expect(md).toContain("7"); // 近 200 块精确计数原样出现
    expect(md).toContain("1,104,167");
    expect(md).toContain("45,678"); // Σheat 精确总表原样入表
    expect(md).toContain("估计");
    expect(md).toContain("均匀"); // 免责声明：抽样外推的假设必须写在脸面上
  });
});
