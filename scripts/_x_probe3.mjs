const topic0 = "0x34096f49d042317834b90c387b35a6771a44c30e06dc5f2b6354116c4c6154a9";
const ADDR = "0xd525ef7ee4072e80765fd61633d80322040afd9d";
const post = async (rpc, body) => (await fetch(rpc, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)})).json();
const call = async (rpc, range) => {
  const latest = parseInt((await post(rpc, {jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})).result, 16);
  try {
    const j = await post(rpc, {jsonrpc:"2.0",id:2,method:"eth_getLogs",params:[{ address: ADDR, topics:[topic0], fromBlock:"0x"+(latest-range).toString(16), toBlock:"0x"+latest.toString(16) }]});
    if (j.error) return `FAIL(${j.error.code} ${String(j.error.message).slice(0,40)})`;
    return `OK(${j.result.length})`;
  } catch (e) { return "ERR " + e.message.slice(0,40); }
};
for (const rpc of ["https://testnet-rpc.monad.xyz","https://monad-testnet.drpc.org","https://rpc.ankr.com/monad_testnet"]) {
  const out = [];
  for (const range of [50, 100, 500, 1000, 2000, 5000, 10000]) out.push(`${range}:${await call(rpc, range)}`);
  console.log(rpc, "=>", out.join(" | "));
}
