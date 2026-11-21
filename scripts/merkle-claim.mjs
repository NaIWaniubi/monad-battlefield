/**
 * merkle-claim — 用 proof 从合约领取自己那份
 *
 *   node scripts/merkle-claim.mjs --proof-index 0
 *   node scripts/merkle-claim.mjs --proof-index 1 --key 0x... 
 *   node scripts/merkle-claim.mjs --proof-index 0 --dry   # 只验 proof + 编码 calldata，不发交易
 *
 * 任何人都能代发：钱只进 leaf.account，claim 的 index 在链上防重领。
 */
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arg, fmt, loadEnv } from "./merkle-env.mjs";
import { verifyProof } from "./merkle-core.mjs";

loadEnv();

const RPC = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const DEP = "deployments-merkle.json";
const DOC = "docs/merkle.json";

const ABI = [
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "total", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32[]" }], outputs: [] },
  { type: "event", name: "Claimed", inputs: [{ indexed: true, name: "index", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: false, name: "amount", type: "uint256" }] },
];

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, timeout: 30_000 }) });

async function main() {
  if (!existsSync(DEP)) throw new Error(`缺少 ${DEP}：合约尚未部署（先 node scripts/merkle-deploy.mjs）`);
  const dep = JSON.parse(readFileSync(DEP, "utf8"));
  const deployed = Boolean(dep.address);
  if (!deployed && !arg("dry")) {
    throw new Error(`合约未部署（${DEP}.status=${dep.status ?? "unknown"}）：${dep.reason ?? "先给 deployer 充值后 node scripts/merkle-deploy.mjs"}`);
  }
  const doc = JSON.parse(readFileSync(DOC, "utf8"));
  const index = Number(arg("proof-index", process.env.PROOF_INDEX ?? "0"));
  const leaf = doc.leaves.find((l) => l.index === index);
  if (!leaf) throw new Error(`docs/merkle.json 里没有 index=${index}（共 ${doc.leaves.length} 条）`);

  // 本地先验：proof 必过，否则不发交易
  if (!verifyProof(doc.root, leaf.index, leaf.account, BigInt(leaf.amountWei), leaf.proof)) {
    throw new Error("本地 proof 验证失败，拒绝发送");
  }
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "claim",
    args: [BigInt(leaf.index), leaf.account, BigInt(leaf.amountWei), leaf.proof],
  });

  const pkArg = arg("key");
  const pk = String(pkArg ?? process.env.PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("缺少可用私钥（.env PRIVATE_KEY 或 --key）");
  const account = privateKeyToAccount(pk);

  console.log(`contract : ${dep.address ?? "（未部署 · dry-run）"}`);
  console.log(`claim    : #${leaf.index} ${leaf.account} ${fmt(BigInt(leaf.amountWei))} (${leaf.contributions} claims)`);
  console.log(`proof    : ${leaf.proof.length} 项, 本地验证 ✔`);
  console.log(`calldata : ${data.length / 2 - 1} bytes`);
  console.log(`sender   : ${account.address}`);

  if (arg("dry")) {
    const onchainRoot = deployed
      ? await pub.readContract({ address: dep.address, abi: ABI, functionName: "root" }).catch(() => null)
      : null;
    console.log(`onchain root: ${onchainRoot ?? "（合约未部署/不可读，dry-run 到此为止）"}`);
    if (onchainRoot) console.log(onchainRoot.toLowerCase() === doc.root.toLowerCase() ? "root 与 docs/merkle.json 一致 ✔" : "⚠ root 不一致");
    return;
  }

  const bal = await pub.getBalance({ address: account.address });
  console.log(`balance  : ${fmt(bal)}`);
  const onchainRoot = await pub.readContract({ address: dep.address, abi: ABI, functionName: "root" });
  if (onchainRoot.toLowerCase() !== doc.root.toLowerCase()) {
    throw new Error(`链上 root ${onchainRoot} ≠ docs/merkle.json ${doc.root}，拒绝 claim`);
  }
  const already = await pub.readContract({
    address: dep.address, abi: ABI, functionName: "isClaimed", args: [doc.root, BigInt(leaf.index)],
  });
  if (already) throw new Error(`index=${leaf.index} 已领取过（防重领生效）`);

  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const { request } = await pub.simulateContract({
    account,
    address: dep.address,
    abi: ABI,
    functionName: "claim",
    args: [BigInt(leaf.index), leaf.account, BigInt(leaf.amountWei), leaf.proof],
  });
  const hash = await wallet.writeContract(request);
  console.log(`claim tx : ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  const cost = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
  if (rc.status !== "success") throw new Error(`交易失败 status=${rc.status}`);

  dep.claims = dep.claims ?? [];
  dep.claims.push({
    index: leaf.index,
    account: leaf.account,
    amountWei: leaf.amountWei,
    tx: hash,
    block: Number(rc.blockNumber),
    gasUsed: rc.gasUsed.toString(),
    costWei: cost.toString(),
  });
  writeFileSync(DEP, JSON.stringify(dep, null, 2) + "\n");
  console.log(`✔ status=${rc.status} block=${rc.blockNumber} gas=${rc.gasUsed} cost=${fmt(cost)}（领取额另计 ${fmt(BigInt(leaf.amountWei))}）`);
  console.log(`✔ 已把 tx 记入 ${DEP}.claims`);
}

main().catch((e) => {
  console.error("✘", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
