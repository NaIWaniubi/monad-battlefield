/**
 * 生成（或复用）蜂群钱包。
 * 关键：并行度上限 = 独立发送方数量。一个 EOA 的 tx 按 nonce 严格串行，
 * 所以想打满 40 条车道，就必须有 40 个真有钱的账户。
 *
 * 钱包私钥存在 .bots.json（只用于测试网，勿提交到公开仓库）。
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync } from "node:fs";
import { saveJson, type Bot } from "./lib.js";

const K = Number(process.env.BOTS ?? 40);
const PATH = ".bots.json";

let bots: Bot[] = existsSync(PATH)
  ? (JSON.parse(readFileSync(PATH, "utf8")) as Bot[])
  : [];

const before = bots.length;
while (bots.length < K) {
  const pk = generatePrivateKey();
  bots.push({ address: privateKeyToAccount(pk).address, pk });
}

saveJson(PATH, bots);

console.log(`车道数=${K}  新建=${bots.length - before}  复用=${before}`);
console.log(`已写入 ${PATH}（含私钥，别提交到公开仓库）`);
for (const b of bots.slice(0, 3)) console.log(`  ${b.address}`);
if (bots.length > 3) console.log(`  … 共 ${bots.length} 个`);
