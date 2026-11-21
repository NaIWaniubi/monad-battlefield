const topic0 = "0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9";
const ADDR = "0xd525ef7ee4072e80765fd61633d80322040afd9d";
const WHO = "0xffF48c7929914Fb83CF53984c3b62Ac4e0A1232e";
const whoTopic = "0x000000000000000000000000" + WHO.slice(2).toLowerCase();
const RPC = "https://testnet-rpc.monad.xyz";
const call = async (m, p) => {
  const r = await fetch(RPC, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
};
const latest = parseInt(await call("eth_blockNumber", []), 16);
// 1) range limit probe (no topic filter, address only)
for (const range of [2000, 10000, 50000]) {
  try {
    const logs = await call("eth_getLogs", [{ address: ADDR, topics: [topic0], fromBlock: "0x"+(latest-range).toString(16), toBlock: "0x"+latest.toString(16) }]);
    console.log(`range ${range}: OK, ${logs.length} logs`);
  } catch (e) { console.log(`range ${range}: FAIL ${e.message.slice(0,120)}`); break; }
}
// 2) who-topic filter on 20k window — does it work & how far back to find claims?
let found = [];
for (let i = 0; i < 12; i++) {
  const to = latest - 1 - i*20000, from = to - 19999;
  try {
    const logs = await call("eth_getLogs", [{ address: ADDR, topics: [topic0, null, whoTopic], fromBlock: "0x"+from.toString(16), toBlock: "0x"+to.toString(16) }]);
    console.log(`who-scan ${from}-${to}: ${logs.length}`);
    found.push(...logs);
    if (found.length) break;
  } catch (e) { console.log(`who-scan ${from}-${to}: FAIL ${e.message.slice(0,100)}`); break; }
}
if (found.length) console.log("SAMPLE:", JSON.stringify(found[0]));
