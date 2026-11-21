/**
 * E2-2 · 合约语义 TS 侧不变式（ABI 回归钉）
 *
 * 定位（诚实边界）：这里**不跑链**、不 revert 真合约。
 * 真实 BadId 回滚、heat 真实回绕属于「待现场 / CI 链上跑」的验收面
 * （见 RUNBOOK 的链上冒烟条目），本文件钉的是它的**前置条件**：
 *   部署产物 contracts/artifacts/Battlefield.json 的 ABI 形状、选择器、
 *   编解码往返，以及 Battlefield.sol 里那几条「观众页和蜂群都依赖的源语义」。
 * 任何一条红 = 合约被改动而链下代码没跟上 —— 先在这里响，而不是在台上响。
 *
 * 断言分三层：
 *   A. ABI 形状钉：函数/事件/错误清单、claim(uint16,uint8) 选择器字面量。
 *   B. 编解码往返钉：encode→decode 恒等；越界值在编码层就被 viem 拒
 *      （uint16/uint8 的类型边界是 ABI 的一部分）。
 *   C. 源语义钉（正则读 .sol）：CELLS=2500、id>=CELLS→BadId、
 *      无 color 链上校验（0..4 是链下约定！）、heat 为 unchecked uint32 回绕。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeEventTopics,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  toFunctionSelector,
  type Abi,
} from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(ROOT, "contracts/artifacts/Battlefield.json");
const solPath = resolve(ROOT, "contracts/Battlefield.sol");

function loadAbi(): Abi {
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf8");
  } catch {
    throw new Error(`缺少 ${artifactPath} —— 先跑 npm run build:contract（本钉依赖部署产物）`);
  }
  const j = JSON.parse(raw) as { abi: Abi; bytecode?: string };
  expect(j.bytecode, "artifacts 里必须有 bytecode —— 否则等于没部署产物").toBeTruthy();
  return j.abi;
}

const abi = loadAbi();
const sol = readFileSync(solPath, "utf8");

const byName = (n: string) => abi.find((x) => "name" in x && x.name === n);
const claimItem = byName("claim");
if (!claimItem) throw new Error("ABI 里没有 claim —— 合约改名了？链下三端全部会瞎");

describe("A · ABI 形状钉（部署产物回归面）", () => {
  it("对外面冻结：函数恰为 CELLS/SIDE/cells/claim，错误 BadId，事件 Claim", () => {
    const fns = abi.filter((x) => x.type === "function").map((x) => x.name).sort();
    expect(fns).toEqual(["CELLS", "SIDE", "cells", "claim"]);
    expect(abi.some((x) => x.type === "error" && x.name === "BadId")).toBe(true);
    expect(abi.some((x) => x.type === "event" && x.name === "Claim")).toBe(true);
  });

  it("claim(uint16 id, uint8 color) 的选择器字面量钉死 —— 改参数=换选择器=历史 tx 解码全断", () => {
    expect(toFunctionSelector(claimItem as never)).toBe("0xbf31eb0b");
    // 独立口径再钉一遍：从规范签名串解析出的选择器必须一致
    expect(toFunctionSelector(parseAbiItem("function claim(uint16 id, uint8 color)"))).toBe("0xbf31eb0b");
  });

  it("常量与 view getter 形状：SIDE/CELLS→uint16；cells(uint256)→(address,uint32,uint8)", () => {
    for (const n of ["SIDE", "CELLS"]) {
      const item = byName(n);
      expect(item?.type).toBe("function");
      const out = (item as { outputs: readonly { type: string }[] }).outputs;
      expect(out.map((o) => o.type)).toEqual(["uint16"]);
    }
    const cells = byName("cells") as { inputs: readonly { type: string }[]; outputs: readonly { type: string }[] };
    expect(cells.inputs.map((i) => i.type)).toEqual(["uint256"]);
    // 打包槽三元组：owner/heat/color —— 顺序变了 HUD 的 [id,color,heat] 传输格式就错位
    expect(cells.outputs.map((o) => o.type)).toEqual(["address", "uint32", "uint8"]);
  });

  it("Claim 事件签名 + indexed 布局钉死（服务端 getLogs 解码的唯一依据）", () => {
    const topics = encodeEventTopics({ abi: [parseAbiItem("event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)")], args: { id: 7n, who: `0x${"1".repeat(40)}` } });
    expect(topics[0]).toBe("0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9");
    // indexed 参数进 topics，非 indexed（color/heat）进 data —— 布局变了这里先红
    const evItem = byName("Claim") as { inputs: readonly { indexed?: boolean; name?: string }[] };
    expect(evItem.inputs.map((i) => [i.name, !!i.indexed])).toEqual([
      ["id", true],
      ["who", true],
      ["color", false],
      ["heat", false],
    ]);
  });
});

describe("B · 编解码往返钉（链下发送方的字节层契约）", () => {
  it("claim(7,1) encode→decode 恒等，且 calldata 前 4 字节 = 钉住的选择器", () => {
    const data = encodeFunctionData({ abi, functionName: "claim", args: [7, 1] });
    expect(data.slice(0, 10)).toBe("0xbf31eb0b");
    const back = decodeFunctionData({ abi, data });
    expect(back.functionName).toBe("claim");
    expect(back.args).toEqual([7, 1]);
  });

  it("id 边界 0 与 2499（合法域两端）可编码可解码", () => {
    for (const id of [0, 2499]) {
      const d = encodeFunctionData({ abi, functionName: "claim", args: [id, 1] });
      expect(decodeFunctionData({ abi, data: d }).args).toEqual([id, 1]);
    }
  });

  it("类型层边界：uint16/uint8 越界值在编码期即被拒（-1/256 color、65536 id）", () => {
    expect(() => encodeFunctionData({ abi, functionName: "claim", args: [5, -1] as never })).toThrowError();
    expect(() => encodeFunctionData({ abi, functionName: "claim", args: [5, 256] as never })).toThrowError();
    expect(() => encodeFunctionData({ abi, functionName: "claim", args: [65536, 1] as never })).toThrowError();
  });

  it("链上边界 2500≤id≤65535 编码合法 —— BadId 只能由链上 revert 执行（诚实标注：本测试不模拟 revert，待现场/CI 链上跑）", () => {
    const d = encodeFunctionData({ abi, functionName: "claim", args: [2500, 1] });
    expect(decodeFunctionData({ abi, data: d }).args).toEqual([2500, 1]);
    // 所以链下调用方必须自己守住 <2500，这正是 C 层钉源语义的意义。
  });

  it("Claim 事件日志可用 ABI 解码（服务端事件索引路径的字节层前提）", () => {
    const evAbi = [parseAbiItem("event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat)")];
    const who = getAddress(`0x${"ab".repeat(20)}`); // viem 解码输出是 EIP-55 校验和形态，期望值同口径
    const topics = encodeEventTopics({ abi: evAbi, args: { id: 41n, who } });
    const data = "0x" + "00".repeat(31) + "03" + "00".repeat(31) + "2a"; // color=3, heat=42
    const log = decodeEventLog({ abi: evAbi, data, topics: topics as never });
    expect(log.eventName).toBe("Claim");
    // uint16/uint8/uint32 在安全整数域内 viem 解码为 number（不是 bigint）—— 实测钉住，
    // 服务端事件索引拿到的就是这个形状；哪天它变 bigint 说明编码层升级，全链下消费方要跟一遍。
    expect(log.args).toMatchObject({ id: 41, who, color: 3, heat: 42 });
  });
});

describe("C · 源语义钉（Battlefield.sol —— 观众页/蜂群赖以成立的三条线）", () => {
  it("格子数 = 2500（50×50）：前端网格、蜂群 id 取模、预算模型共用这个数", () => {
    expect(sol).toMatch(/uint16\s+public\s+constant\s+CELLS\s*=\s*2500/);
    expect(sol).toMatch(/uint16\s+public\s+constant\s+SIDE\s*=\s*50/);
  });

  it("claim 的边界守卫在：id >= CELLS → revert BadId()（无此句链上会直接越界写）", () => {
    expect(sol).toMatch(/if\s*\(id\s*>=\s*CELLS\)\s*revert\s+BadId\(\)/);
  });

  it("color 无链上校验（诚实事实）：0..4 是链下约定，0=未占领、1..4=阵营 —— 校验在 relay/前端，别指望合约", () => {
    const claimBody = sol.slice(sol.indexOf("function claim"), sol.indexOf("emit Claim"));
    expect(claimBody).not.toMatch(/color\s*(<=|>=|>|<)\s*\d/); // 合约不比较 color
    expect(claimBody).not.toMatch(/BadColor|revert[^;]*color/i);
    // 链下口径钉在 relay：color 合法域 1..4（gridState 注释 0=未占领）
    const relay = readFileSync(resolve(ROOT, "server/index.mjs"), "utf8");
    expect(relay).toMatch(/color\s*<\s*1\s*\|\|\s*color\s*>\s*4/);
  });

  it("heat 是 unchecked uint32 自增：2^32-1 后回绕到 0 是既定语义，TS 镜像钉住同值", () => {
    expect(sol).toMatch(/unchecked\s*\{\s*h\s*=\s*c\.heat\s*\+\s*1;\s*\}/);
    const wrap = (h: bigint) => (h + 1n) % 2n ** 32n; // Solidity unchecked uint32 的算术模型
    expect(wrap(0n)).toBe(1n);
    expect(wrap(41n)).toBe(42n);
    expect(wrap(2n ** 32n - 1n)).toBe(0n);
    // 真实回绕要 42.9 亿笔同格点击，链上验证归现场/CI；这里钉的是语义模型不是执行。
  });

  it("并行度根基：claim 只写 cells[id] 单个 slot，无全局计数器（加 totalClaims++ 者先红这里）", () => {
    // 注释里写着「不要加 totalClaims++」——那是给读代码的人的，不是代码。
    // 先剥掉整行注释再钉，防的真是可执行体。
    const code = sol
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/totalClaims\s*(\+\+|\+=|=)/);
    expect(sol).toMatch(/Cell\s+storage\s+c\s*=\s*cells\[id\]/);
  });
});
