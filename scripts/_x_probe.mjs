import { toEventHash } from "viem";
const topic0 = toEventHash({ type: "event", name: "Claim", inputs: [
  { name: "id", type: "uint16", indexed: true },
  { name: "who", type: "address", indexed: true },
  { name: "color", type: "uint8", indexed: false },
  { name: "heat", type: "uint32", indexed: false },
]});
console.log("topic0", topic0);
const RPC = "https://testnet-rpc.monad.xyz";
const ADDR = "0xd525ef7ee4072e80765fd61633d80322040afd9d";
const call = async (m, p) => {
  const r = await fetch(RPC, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
};
const latest = parseInt(await call("eth_blockNumber", []), 16);
console.log("latest", latest);
for (let i = 0; i < 10; i++) {
  const to = latest - 3 - i*40, from = to - 39;
  const logs = await call("eth_getLogs", [{ address: ADDR, topics: [topic0], fromBlock: "0x"+from.toString(16), toBlock: "0x"+to.toString(16) }]);
  console.log(`chunk ${from}-${to}: ${logs.length} logs`);
  if (logs.length) { console.log(JSON.stringify(logs[0], null, 1)); break; }
}
