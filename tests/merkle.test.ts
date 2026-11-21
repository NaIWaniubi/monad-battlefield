import { readFileSync } from "node:fs";
import { concat, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildDistribution,
  getProof,
  getRoot,
  hashPair,
  leafHash,
  verifyProof,
} from "../scripts/merkle-core.mjs";

const addr = (n: number) => `0x${(n + 1).toString(16).padStart(40, "0")}`;
const amount = (n: number) => BigInt(1_000_000 + n * 7);
const zeros = "0x" + "0".repeat(64);

/** 造 n 片叶子：地址互不相同、金额互不相同 */
function makeLeaves(n: number) {
  return Array.from({ length: n }, (_, i) => leafHash(i, addr(i), amount(i)));
}

describe("Merkle 性质：任意叶子数都能自证", () => {
  for (const n of [1, 2, 3, 5, 8, 32]) {
    it(`${n} 片叶子：每个 index 的 proof 都能验证到同一 root`, () => {
      const leaves = makeLeaves(n);
      const root = getRoot(leaves);
      expect(root).toMatch(/^0x[0-9a-f]{64}$/);
      for (let i = 0; i < n; i++) {
        expect(verifyProof(root, i, addr(i), amount(i), getProof(leaves, i))).toBe(true);
      }
    });
  }

  it("1 片叶子：root === leaf，proof 为空串", () => {
    const leaves = makeLeaves(1);
    expect(getRoot(leaves)).toBe(leaves[0]);
    expect(getProof(leaves, 0)).toEqual([]);
  });

  it("奇数个节点原样晋升：3 叶时 index2 的 proof 只有 1 项，index0 有 2 项", () => {
    const leaves = makeLeaves(3);
    expect(getProof(leaves, 2)).toHaveLength(1);
    expect(getProof(leaves, 0)).toHaveLength(2);
  });

  it("8 叶树 proof 长度恒为 3（log2 8），且深度边界不越界", () => {
    const leaves = makeLeaves(8);
    for (let i = 0; i < 8; i++) expect(getProof(leaves, i)).toHaveLength(3);
    expect(() => getProof(leaves, 8)).toThrow(/越界/);
    expect(() => getProof(leaves, -1)).toThrow(/越界/);
  });
});

describe("Merkle 性质：任何篡改都必须失败", () => {
  it("篡改 amount → 验证失败", () => {
    const leaves = makeLeaves(5);
    const root = getRoot(leaves);
    const proof = getProof(leaves, 2);
    expect(verifyProof(root, 2, addr(2), amount(2) + 1n, proof)).toBe(false);
  });

  it("篡改 account → 验证失败", () => {
    const leaves = makeLeaves(5);
    const root = getRoot(leaves);
    const proof = getProof(leaves, 2);
    expect(verifyProof(root, 2, addr(99), amount(2), proof)).toBe(false);
  });

  it("篡改 index → 验证失败（index 参与叶子哈希，不只是数组下标）", () => {
    const leaves = makeLeaves(5);
    const root = getRoot(leaves);
    const proof = getProof(leaves, 2);
    expect(verifyProof(root, 3, addr(2), amount(2), proof)).toBe(false);
  });

  it("错误 root → 验证失败", () => {
    const leaves = makeLeaves(8);
    const proof = getProof(leaves, 5);
    expect(verifyProof(hashPair(getRoot(leaves), zeros), 5, addr(5), amount(5), proof)).toBe(false);
  });

  it("截断 proof → 验证失败", () => {
    const leaves = makeLeaves(8);
    const root = getRoot(leaves);
    const proof = getProof(leaves, 5);
    expect(verifyProof(root, 5, addr(5), amount(5), proof.slice(0, -1))).toBe(false);
  });

  it("加长 proof → 验证失败（多出来的兄弟节点改变上卷结果）", () => {
    const leaves = makeLeaves(8);
    const root = getRoot(leaves);
    const proof = getProof(leaves, 5);
    expect(verifyProof(root, 5, addr(5), amount(5), [...proof, proof[0]])).toBe(false);
  });

  it("拿别人的 proof 冒领 → 验证失败", () => {
    const leaves = makeLeaves(5);
    const root = getRoot(leaves);
    const proofOf1 = getProof(leaves, 1);
    expect(verifyProof(root, 4, addr(4), amount(4), proofOf1)).toBe(false);
  });
});

describe("分配方案：按贡献比例、和恒等于奖池、可复算", () => {
  const contributions = [
    { account: addr(3), contributions: 9 },
    { account: addr(0), contributions: 1 },
    { account: addr(7), contributions: 5 },
    { account: addr(2), contributions: 5 },
  ];
  const pool = 10_000_000_000_000_000n; // 0.01 MON

  it("叶子金额之和 === 奖池，一分不多一分不少（余数给 index 0）", () => {
    const d = buildDistribution(contributions, pool);
    const sum = d.leaves.reduce((s, l) => s + l.amountWei, 0n);
    expect(sum).toBe(pool);
    expect(d.totalContributions).toBe(20);
  });

  it("金额严格按贡献比例（向下取整）", () => {
    const d = buildDistribution(contributions, pool);
    const byAccount = new Map(d.leaves.map((l) => [l.account.toLowerCase(), l.amountWei]));
    expect(byAccount.get(addr(3).toLowerCase())).toBe((pool * 9n) / 20n);
    expect(byAccount.get(addr(0).toLowerCase())).toBe((pool * 1n) / 20n);
    expect(byAccount.get(addr(7).toLowerCase())).toBe((pool * 5n) / 20n);
  });

  it("输入顺序不影响 root 与 index（按地址升序确定性生成）", () => {
    const a = buildDistribution(contributions, pool);
    const b = buildDistribution([...contributions].reverse(), pool);
    expect(a.root).toBe(b.root);
    expect(a.leaves.map((l) => [l.index, l.account, l.amountWei.toString()])).toEqual(
      b.leaves.map((l) => [l.index, l.account, l.amountWei.toString()]),
    );
  });

  it("分配产出的每条 proof 都能验证到分配的 root", () => {
    const d = buildDistribution(contributions, pool);
    for (const l of d.leaves) {
      expect(verifyProof(d.root, l.index, l.account, l.amountWei, l.proof)).toBe(true);
    }
  });

  it("空贡献表 → 零根、空叶子（合约 setRoot 前状态）", () => {
    const d = buildDistribution([], pool);
    expect(d.root).toBe(zeros);
    expect(d.leaves).toEqual([]);
  });
});

describe("出货产物 docs/merkle.json：root 可复算、proof 全可验、金额守恒", () => {
  it("从 leaves 重算的 root === 文件里的 root（任何人可独立复算）", () => {
    const doc = JSON.parse(readFileSync("docs/merkle.json", "utf8"));
    const recomputed = getRoot(
      doc.leaves.map((l: any) => leafHash(l.index, l.account, BigInt(l.amountWei))),
    );
    expect(recomputed).toBe(doc.root);
  });

  it("文件里每一条 proof 都能验证到该 root", () => {
    const doc = JSON.parse(readFileSync("docs/merkle.json", "utf8"));
    expect(doc.leaves.length).toBeGreaterThan(0);
    for (const l of doc.leaves) {
      expect(verifyProof(doc.root, l.index, l.account, BigInt(l.amountWei), l.proof)).toBe(true);
    }
  });

  it("所有叶子金额之和 === 奖池（不多发、不留在树外）", () => {
    const doc = JSON.parse(readFileSync("docs/merkle.json", "utf8"));
    const sum = doc.leaves.reduce((s: bigint, l: any) => s + BigInt(l.amountWei), 0n);
    expect(sum).toBe(BigInt(doc.poolWei));
  });
});

describe("与 Solidity abi.encode 逐字节一致（防编码器漂移）", () => {
  const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

  it("leafHash === keccak256(手动 pad(index) + pad(address) + pad(amount))", () => {
    const index = 7n;
    const account = addr(7);
    const amountWei = 1234567890123456789n;
    const manual = `0x${pad32(index.toString(16))}${pad32(account.slice(2).toLowerCase())}${pad32(
      amountWei.toString(16),
    )}`;
    expect(leafHash(index, account, amountWei)).toBe(keccak256(manual));
  });

  it("hashPair === keccak256(concat(较小值, 较大值))，且交换参数结果不变", () => {
    const a = leafHash(0, addr(0), 1n);
    const b = leafHash(1, addr(1), 2n);
    const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
    expect(hashPair(a, b)).toBe(keccak256(concat([lo, hi])));
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });
});
