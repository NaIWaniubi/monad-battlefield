/**
 * merkle-core — 手写 Merkle 树（无 OZ、无 merkletreejs）
 *
 * 叶子：keccak256(abi.encode(uint256 index, address account, uint256 amount))
 * 内部：keccak256(abi.encodePacked(min(a,b), max(a,b)))  —— 与合约逐字节一致
 *
 * 奇数节点不复制，而是「原样晋升」到上一层（OpenZeppelin 同款），
 * 证明里对应位置少一项，验证方逐项上卷即可。
 */
import { concat, encodeAbiParameters, getAddress, keccak256 } from "viem";

export const LEAF_TYPES = [
  { type: "uint256" },
  { type: "address" },
  { type: "uint256" },
];

/** 叶子哈希：keccak256(abi.encode(index, account, amount)) */
export function leafHash(index, account, amountWei) {
  const encoded = encodeAbiParameters(LEAF_TYPES, [
    BigInt(index),
    getAddress(account),
    BigInt(amountWei),
  ]);
  return keccak256(encoded);
}

/** 内部节点哈希：排序后拼接再 keccak（顺序无关，防第二原像拼接歧义） */
export function hashPair(a, b) {
  return BigInt(a) <= BigInt(b)
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

/** 逐层建树；奇数末尾节点原样晋升 */
export function buildLayers(leaves) {
  if (!leaves.length) return [];
  const layers = [[...leaves]];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    }
    layers.push(next);
  }
  return layers;
}

export function getRoot(leaves) {
  if (!leaves.length) return "0x" + "0".repeat(64);
  const layers = buildLayers(leaves);
  return layers[layers.length - 1][0];
}

/** 取第 index 个叶子的证明（按层上卷的兄弟节点列表） */
export function getProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error(`index ${index} 越界`);
  const layers = buildLayers(leaves);
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling >= 0 && sibling < layer.length) proof.push(layer[sibling]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** 纯验证：给定 root + 叶子三元组 + proof，重算是否一致 */
export function verifyProof(root, index, account, amountWei, proof) {
  let h = leafHash(index, account, amountWei);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === String(root).toLowerCase();
}

/**
 * 从贡献表生成完整分配方案。
 * entries: [{ account, contributions }]，按地址升序（确定性），index=排序后位置。
 * 金额 = poolWei * contributions / totalContributions，向下取整；
 * 余数给 index 0，保证 sum(amountWei) === poolWei。
 */
export function buildDistribution(entries, poolWei) {
  const pool = BigInt(poolWei);
  const clean = entries
    .map((e) => ({ account: getAddress(e.account), contributions: Number(e.contributions) }))
    .filter((e) => e.contributions > 0)
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));

  const totalContributions = clean.reduce((s, e) => s + e.contributions, 0);
  if (!clean.length || totalContributions === 0) {
    return { root: "0x" + "0".repeat(64), leaves: [], totalContributions: 0, poolWei: pool };
  }

  let assigned = 0n;
  const rows = clean.map((e, index) => {
    const amountWei = (pool * BigInt(e.contributions)) / BigInt(totalContributions);
    assigned += amountWei;
    return { index, account: e.account, amountWei, contributions: e.contributions };
  });
  const dust = pool - assigned;
  if (dust > 0n) {
    rows[0].amountWei += dust;
    rows[0].dustWei = dust;
  }

  const leafNodes = rows.map((r) => leafHash(r.index, r.account, r.amountWei));
  const root = getRoot(leafNodes);
  const leaves = rows.map((r) => ({ ...r, proof: getProof(leafNodes, r.index) }));
  return { root, leaves, totalContributions, poolWei: pool };
}
