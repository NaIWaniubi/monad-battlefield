/**
 * B-sync · 观众点击同步回执（eth_sendRawTransactionSync）纯逻辑单测
 *
 * 本会话没有测试币私钥，无法真发交易，所以把「从节点五花八门的返回结构里
 * 提取 txHash / blockNumber / status」抽成纯函数 parseSyncReceipt（server/index.mjs
 * 里导出），在这里钉死它的行为契约。
 *
 * 契约（设计原则：解析器永不抛异常，坏输入 → 中性结果，由调用方降级）：
 *   parseSyncReceipt(raw) → {
 *     txHash:     string | null,   // 64位十六进制交易哈希（原样保留）
 *     blockNumber: number | null,  // 十进制数字；接受 hex 字符串 / 十进制字符串 / number / bigint
 *     status:     boolean | null,  // 回执 status：true=成功 false=revert null=回执里没有
 *     confirmed:  boolean,         // 探测到 receipt（有 blockNumber 或有 status）才算 true
 *     isError:    boolean,         // raw 明确是节点错误（error 对象/字符串、非哈希的裸字符串）
 *     errorText:  string | null,   // 错误的可读文本，供日志/降级判断
 *   }
 *
 * 另注：导入 server/index.mjs 之所以安全，是因为它的启动段（listen/轮询/横幅）
 * 被 isMainModule 守卫包住了 —— 作为模块被 import 时不会占用 8791、不会打网络。
 */
import { describe, expect, it } from "vitest";
import { parseSyncReceipt } from "../server/index.mjs";

const H = "0x5a1f3c8e9d2b4a6f0123456789abcdef0123456789abcdef0123456789abcdef";
const H2 = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("parseSyncReceipt — 标准回执", () => {
  it("viem/JSON-RPC 风格：transactionHash + hex blockNumber + status 0x1", () => {
    const r = parseSyncReceipt({ transactionHash: H, blockNumber: "0x1f4", status: "0x1" });
    expect(r.txHash).toBe(H);
    expect(r.blockNumber).toBe(500);
    expect(r.status).toBe(true);
    expect(r.confirmed).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.errorText).toBeNull();
  });

  it("哈希字段别名 hash / txHash 都认", () => {
    expect(parseSyncReceipt({ hash: H, blockNumber: 12, status: "0x1" }).txHash).toBe(H);
    expect(parseSyncReceipt({ txHash: H2, blockNumber: 12, status: "0x1" }).txHash).toBe(H2);
  });

  it("status=0x0：上链确认但 revert —— confirmed 仍为 true，status 为 false", () => {
    const r = parseSyncReceipt({ transactionHash: H, blockNumber: "0x2", status: "0x0" });
    expect(r.confirmed).toBe(true);
    expect(r.status).toBe(false);
  });

  it("缺 blockNumber 但有 status —— 仍是回执，confirmed=true，block 为 null", () => {
    const r = parseSyncReceipt({ transactionHash: H, status: "0x1" });
    expect(r.confirmed).toBe(true);
    expect(r.blockNumber).toBeNull();
  });

  it("blockNumber=0x0 是合法的 0，不能当成缺失", () => {
    const r = parseSyncReceipt({ transactionHash: H, blockNumber: "0x0", status: "0x1" });
    expect(r.blockNumber).toBe(0);
    expect(r.confirmed).toBe(true);
  });

  it("blockNumber 各种数字形状：十进制字符串 / number / bigint", () => {
    expect(parseSyncReceipt({ hash: H, blockNumber: "26", status: "0x1" }).blockNumber).toBe(26);
    expect(parseSyncReceipt({ hash: H, blockNumber: 30, status: "0x1" }).blockNumber).toBe(30);
    expect(parseSyncReceipt({ hash: H, blockNumber: 30n, status: "0x1" }).blockNumber).toBe(30);
  });

  it("status 布尔 true / false 也认", () => {
    expect(parseSyncReceipt({ hash: H, status: true }).status).toBe(true);
    expect(parseSyncReceipt({ hash: H, status: false }).status).toBe(false);
  });

  it("被 JSON-RPC 信封包了一层 { jsonrpc, result } 时先拆信封", () => {
    const r = parseSyncReceipt({ jsonrpc: "2.0", id: 1, result: { hash: H, blockNumber: "0xa", status: "0x1" } });
    expect(r.txHash).toBe(H);
    expect(r.blockNumber).toBe(10);
    expect(r.confirmed).toBe(true);
  });
});

describe("parseSyncReceipt — 裸哈希与降级路径", () => {
  it("裸 txHash 字符串：拿到哈希但没有回执信息 → confirmed=false（不能谎称已上链）", () => {
    const r = parseSyncReceipt(H);
    expect(r.txHash).toBe(H);
    expect(r.confirmed).toBe(false);
    expect(r.blockNumber).toBeNull();
    expect(r.status).toBeNull();
    expect(r.isError).toBe(false);
  });

  it("非哈希的裸字符串（节点回了一句人话）→ isError", () => {
    const r = parseSyncReceipt("transaction not ready to be processed");
    expect(r.isError).toBe(true);
    expect(r.txHash).toBeNull();
    expect(r.errorText).toContain("not ready");
  });

  it("只有哈希的对象（无 block 无 status）→ confirmed=false", () => {
    const r = parseSyncReceipt({ transactionHash: H });
    expect(r.txHash).toBe(H);
    expect(r.confirmed).toBe(false);
  });
});

describe("parseSyncReceipt — 错误对象", () => {
  it("JSON-RPC error 对象 { error: { code, message } }", () => {
    const r = parseSyncReceipt({ error: { code: -32602, message: "screening unavailable" } });
    expect(r.isError).toBe(true);
    expect(r.errorText).toContain("screening unavailable");
    expect(r.txHash).toBeNull();
    expect(r.confirmed).toBe(false);
  });

  it("error 是裸字符串", () => {
    const r = parseSyncReceipt({ error: "method not allowed" });
    expect(r.isError).toBe(true);
    expect(r.errorText).toContain("method not allowed");
  });
});

describe("parseSyncReceipt — 坏输入一律中性，绝不抛", () => {
  it("null / undefined / 空串 / 数字 / 数组 / 空对象 → 中性结果", () => {
    for (const bad of [null, undefined, "", 42, [], {}, "0x12", true]) {
      const r = parseSyncReceipt(bad);
      expect(r.txHash).toBeNull();
      expect(r.blockNumber).toBeNull();
      expect(r.status).toBeNull();
      expect(r.confirmed).toBe(false);
    }
  });

  it("对象里没有任何可用字段 → 非错误、非确认（调用方按未确认降级）", () => {
    const r = parseSyncReceipt({ foo: "bar" });
    expect(r.isError).toBe(false);
    expect(r.confirmed).toBe(false);
    expect(r.txHash).toBeNull();
  });

  it("坏 blockNumber（乱码字符串）→ block 为 null，但哈希与 status 照常提取", () => {
    const r = parseSyncReceipt({ hash: H, blockNumber: "not-a-number", status: "0x1" });
    expect(r.txHash).toBe(H);
    expect(r.blockNumber).toBeNull();
    expect(r.confirmed).toBe(true);
  });
});
