// 后台勘查：从最新块往回，100块窗口 + who topic 过滤，定位 0xffF48…#3 的 claim 所在区块
const topic0 = "0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9";
const ADDR = "0xd525ef7ee4072e80765fd61633d80322040afd9d";
const whoTopic = "0x000000000000000000000000fff48c7929914fb83cf53984c3b62ac4e0a1232e";
const RPCS = ["https://testnet-rpc.monad.xyz","https://monad-testnet.drpc.org"];
async function getLogs(rpc, q) {
  const j = await (await fetch(rpc, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getLogs",params:[q]})})).json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const latest = parseInt((await (await fetch(RPCS[0], {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})})).json()).result, 16);
console.log("start scan from", latest);
const hits = [];
let rpcIdx = 0, consecFail = 0;
for (let w = 0; w < 1200 && hits.length < 3; w++) {
  const to = latest - 2 - w*100, from = to - 99;
  if (to < 79333331) break;
  let logs = null;
  for (let a = 0; a < RPCS.length; a++) {
    const rpc = RPCS[(rpcIdx + a) % RPCS.length];
    try { logs = await getLogs(rpc, { address: ADDR, topics:[topic0,null,whoTopic], fromBlock:"0x"+from.toString(16), toBlock:"0x"+to.toString(16) }); rpcIdx = (rpcIdx+a)%RPCS.length; consecFail=0; break; }
    catch (e) { consecFail++; if (consecFail % 20 === 0) console.log(`window ${from}-${to}: fail x${consecFail}`); }
  }
  if (logs && logs.length) { hits.push(...logs); console.log(`HIT ${from}-${to}: ${logs.length}`, JSON.stringify(logs[0]).slice(0,400)); }
  if (w % 50 === 0) console.log(`progress w=${w} at ${from}`);
}
console.log("TOTAL HITS", hits.length);
for (const h of hits) console.log("tx", h.transactionHash, "block", parseInt(h.blockNumber,16), "data", h.data, "topics", JSON.stringify(h.topics));
