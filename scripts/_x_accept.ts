/**
 * X · P0-3 真链验收：node 侧 import 页面同一模块（web/src/verify.ts），
 * 走与浏览器完全相同的代码路径打公共 RPC。
 */
import {
  makeRpcCall, verifyAddress, scanClaimsRange, computeWindows,
  formatCellPosition, factionOfColor, monadscanTxUrl,
} from "../web/src/verify";

const WHO = "0xffF48c7929914Fb83CF53984c3b62Ac4e0A1232e"; // relay.log 里的 relayer#3（观众那笔）
const call = makeRpcCall();

// ── A. 页面现行主路径（最近 2000 块，与浏览器逐字节同码）──
const live = await verifyAddress(call, WHO, "2000", (d, t) => { if (d === t) console.log(`[A] ${d}/${t} 窗口完成`); });
console.log(`[A] latest=${live.latest} 窗口 ${live.from}→${live.to} 请求数=${live.plan.length} 失败窗=${live.failed.length} 命中=${live.claims.length}`);

// ── B. 同一 scanClaimsRange/computeWindows，锚定到已知 3 笔历史 claim 的窗口 ──
// （已知 claim 在块 81495639/676/702，距最新已 >5000 块，页面 UI 按规格够不到；
//   这里把「窗口右端」锚到当时区块，证明同款查询能原样列出它们）
const plan = computeWindows(81495750, 200, 50);
console.log("[B] 窗口计划", JSON.stringify(plan));
const t0 = Date.now();
const back = await scanClaimsRange(call, WHO, plan);
console.log(`[B] 用时 ${Date.now() - t0}ms 失败窗=${back.failed.length} 命中=${back.claims.length}`);
for (const c of back.claims) {
  const fac = factionOfColor(c.color);
  console.log(`    #${c.id} ${formatCellPosition(c.id)} ${fac?.name}/${fac?.hex} color=${c.color} heat=${c.heat} block=${c.block} ${monadscanTxUrl(c.txHash)}`);
}
const ids = back.claims.map(c => c.id).sort((a,b)=>a-b);
const ok = back.claims.length === 3 && ids.join() === "531,1326,1436" &&
  back.claims.every(c => c.who === WHO.toLowerCase());
console.log(ok ? "[B] PASS: 三笔已知观众 claim 全部列出，字段与链上一致" : "[B] FAIL: " + JSON.stringify(back.claims));
process.exit(ok ? 0 : 1);
