/**
 * merkle-deploy — 编译并部署 MerkleDistributor
 *
 *   node scripts/merkle-deploy.mjs              # 编译 + 部署，写 deployments-merkle.json
 *   node scripts/merkle-deploy.mjs --set-root   # 读 docs/merkle.json，校验后 setRoot + 注入奖池
 *
 * 手动 .env 兜底；不依赖 Battlefield 的 lib/artifact。ABI 内联，避免额外产物文件。
 */
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arg, fmt, loadEnv } from "./merkle-env.mjs";
import { getRoot, leafHash, verifyProof } from "./merkle-core.mjs";

loadEnv();
const require = createRequire(import.meta.url);
const solc = require("solc");

const RPC = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const FILE = "MerkleDistributor.sol";
const SOURCE = "contracts/MerkleDistributor.sol";
const OUT = "deployments-merkle.json";

const chain = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, timeout: 30_000 }) });

export const ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "total", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setRoot", stateMutability: "payable", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32[]" }], outputs: [] },
  { type: "event", name: "RootSet", inputs: [{ indexed: true, name: "root", type: "bytes32" }, { indexed: false, name: "total", type: "uint256" }] },
  { type: "event", name: "Claimed", inputs: [{ indexed: true, name: "index", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: false, name: "amount", type: "uint256" }] },
];

function compile() {
  const source = readFileSync(SOURCE, "utf8");
  const input = {
    language: "Solidity",
    sources: { [FILE]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 1 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) {
    console.error(errors.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
  const c = out.contracts[FILE].MerkleDistributor;
  return {
    abi: c.abi,
    bytecode: "0x" + c.evm.bytecode.object,
    runtimeBytes: c.evm.deployedBytecode.object.length / 2,
  };
}

function save(obj) {
  writeFileSync(OUT, JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("缺少可用 PRIVATE_KEY（.env 或 --key 未提供）");
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const bal = await pub.getBalance({ address: account.address });
  console.log(`chain    : ${chain.name} id=${chain.id} rpc=${RPC}`);
  console.log(`signer   : ${account.address}  balance=${fmt(bal)}`);

  if (arg("set-root")) {
    if (!existsSync(OUT)) throw new Error("先跑一次无参数部署，生成 " + OUT);
    const dep = JSON.parse(readFileSync(OUT, "utf8"));
    const doc = JSON.parse(readFileSync("docs/merkle.json", "utf8"));
    // 花钱前的强校验：从 leaves 重算 root，并逐条验证 proof
    const recomputed = getRoot(doc.leaves.map((l) => recomputeLeaf(l)));
    if (recomputed.toLowerCase() !== doc.root.toLowerCase()) {
      throw new Error(`merkle.json root 不可复算: json=${doc.root} recomputed=${recomputed}`);
    }
    for (const l of doc.leaves) {
      if (!verifyProof(doc.root, l.index, l.account, l.amountWei, l.proof)) {
        throw new Error(`leaf ${l.index} 的 proof 验证失败，拒绝上链`);
      }
    }
    const poolWei = BigInt(doc.poolWei);
    const totalWei = BigInt(doc.totalWei ?? doc.poolWei);
    const gas = await pub.estimateGas({
      account: account.address,
      to: dep.address,
      data: encodeSetRoot(doc.root, totalWei),
      value: poolWei,
    });
    const gp = await pub.getGasPrice();
    const est = gas * gp + poolWei;
    if (bal < est) throw new Error(`余额不足：需要 ${fmt(est)}，只有 ${fmt(bal)}`);
    console.log(`setRoot  : root=${doc.root} total=${doc.totalWei} pool=${fmt(poolWei)}  estCost=${fmt(est)}`);
    const hash = await wallet.writeContract({
      address: dep.address,
      abi: ABI,
      functionName: "setRoot",
      args: [doc.root, totalWei],
      value: poolWei,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const cost = rc.gasUsed * (rc.effectiveGasPrice ?? gp);
    dep.root = doc.root;
    dep.totalWei = totalWei.toString();
    dep.poolWei = poolWei.toString();
    dep.setRootTx = hash;
    dep.setRootBlock = Number(rc.blockNumber);
    dep.setRootGasUsed = rc.gasUsed.toString();
    dep.setRootCostWei = cost.toString();
    dep.claims = dep.claims ?? [];
    save(dep);
    console.log(`✔ setRoot tx ${hash}  block=${rc.blockNumber}  gas=${rc.gasUsed}  cost=${fmt(cost)}（含奖池）`);
    return;
  }

  const { bytecode, runtimeBytes } = compile();
  const gas = await pub.estimateGas({ account: account.address, data: bytecode });
  const gp = await pub.getGasPrice();
  const est = gas * gp;
  console.log(`solc     : ${solc.version()}`);
  console.log(`bytecode : runtime=${runtimeBytes}B  deployGas≈${gas}  gasPrice=${gp} wei  estCost=${fmt(est)}`);
  const reserve = arg("max-cost-mon") ? BigInt(Math.floor(Number(arg("max-cost-mon")) * 1e6)) * 10n ** 12n : 0n;
  if (reserve && est > reserve) throw new Error(`预估 ${fmt(est)} 超过 --max-cost-mon ${fmt(reserve)}，不发送`);
  if (bal < est + 10n ** 15n) throw new Error(`余额不足：需要 ${fmt(est)} + 0.001 缓冲，只有 ${fmt(bal)}`);

  const hash = await wallet.deployContract({ abi: ABI, bytecode });
  console.log(`deploy tx: ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error("部署失败：receipt 无合约地址");
  const cost = rc.gasUsed * (rc.effectiveGasPrice ?? gp);
  const info = {
    address: rc.contractAddress,
    deployer: account.address,
    chainId: chain.id,
    deployTx: hash,
    block: Number(rc.blockNumber),
    runtimeBytes,
    gasUsed: rc.gasUsed.toString(),
    costWei: cost.toString(),
    root: null,
    totalWei: "0",
    poolWei: "0",
    setRootTx: null,
    claims: [],
  };
  save(info);
  console.log(`✔ address ${rc.contractAddress}`);
  console.log(`✔ block=${rc.blockNumber} gas=${rc.gasUsed} cost=${fmt(cost)}`);
  console.log(`✔ 写入 ${OUT}`);
}

function encodeSetRoot(root, total) {
  return encodeFunctionData({ abi: ABI, functionName: "setRoot", args: [root, total] });
}

main().catch((e) => {
  console.error("✘", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
