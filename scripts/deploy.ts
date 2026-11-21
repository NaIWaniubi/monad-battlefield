import type { Hex } from "viem";
import { loadArtifact, mustEnv, pub, saveJson, wallet } from "./lib.js";

const pk = mustEnv("PRIVATE_KEY") as Hex;
const { abi, bytecode } = loadArtifact();
const w = wallet(pk);
const account = w.account!;

console.log(`chain : ${w.chain.name} (id=${w.chain.id})  rpc=${w.chain.rpcUrls.default.http[0]}`);
const bal = await pub.getBalance({ address: account.address });
console.log(`signer: ${account.address}  balance=${bal} wei`);

const hash = await w.deployContract({ abi, bytecode, args: [] });
console.log(`deploy tx: ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
if (!receipt.contractAddress) throw new Error("部署失败：receipt 里没有合约地址");

const info = {
  address: receipt.contractAddress,
  startBlock: Number(receipt.blockNumber),
  deployer: account.address,
  chainId: w.chain.id,
};

saveJson("deployments.json", info);
saveJson("web/src/deploy.json", {
  address: info.address,
  startBlock: info.startBlock,
});

console.log(`✔ block  ${receipt.blockNumber}`);
console.log(`✔ address ${receipt.contractAddress}`);
console.log(`✔ 写入 deployments.json 与 web/src/deploy.json`);
