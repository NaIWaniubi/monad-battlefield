#!/usr/bin/env node
/**
 * venue.mjs — 一条命令起本地全场:npm run venue
 * 干的事:构建检查 → 起中继 → 探 RPC 定档位 → 起蜂群(自适应节奏)→ 打印三端地址。
 * 隧道/公网扫码仍归 stage.mjs(它负责 cloudflared + JOIN_URL)。venue 管"一台机器全开"。
 * Ctrl-C 收摊带走所有子进程。--dry 只打印将做什么(CI/排练安全)。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const PORT = process.env.PORT || "8791";
const RPC = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const kids = [];

const say = (m) => console.log(m);
const sh = (cmd, args) => {
  if (DRY) return say(`[dry] 将执行: ${cmd} ${args.join(" ")}`);
  const k = spawn(cmd, args, { cwd: ROOT, shell: true, stdio: "inherit", env: process.env });
  kids.push(k);
  return k;
};
const cleanup = () => {
  for (const k of kids) { try { process.kill(-k.pid, "SIGINT"); } catch { try { k.kill(); } catch {} } }
  process.exit(0);
};
process.on("SIGINT", cleanup);

// 前置:合约产物与部署信息
if (!existsSync(join(ROOT, "contracts/artifacts/Battlefield.json"))) {
  say("缺合约产物 → 先 build:contract");
  if (!DRY) spawnSync("npm", ["run", "build:contract"], { cwd: ROOT, shell: true, stdio: "inherit" });
}
if (!existsSync(join(ROOT, "deployments.json"))) {
  say("⚠ 无 deployments.json:中继将进「未部署」模式(大屏/观众页会显示部署模式横幅,链路仍可排练)。");
}

// 1) 前端构建(保证 dist 是三端齐全的最新版)
if (!DRY) {
  say("① 构建三端…");
  const b = spawnSync("npm", ["run", "build:web"], { cwd: ROOT, shell: true, stdio: "inherit" });
  if (b.status !== 0) { say("✗ 构建失败,venue 中止"); process.exit(1); }
} else say("[dry] 将执行: npm run build:web");

// 2) RPC 档位探测(决定顶栏会显示 实时/合成,人先于评委知道)
let chainOk = false;
try {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(8000),
  }).then((x) => x.json());
  chainOk = !!r?.result;
  if (chainOk) say(`② RPC 在线 · head=${parseInt(r.result, 16)}`);
} catch { /* fallthrough */ }
if (!chainOk) say("② ⚠ RPC 不可达:照常起栈——大屏将走「合成打底」诚实档,链上档恢复后自动切回。");

// 3) 中继 + 蜂群(余额自适应在 swarm 内部已实现:<10MON 道自动钳 1.2s)
sh("node", ["--env-file-if-exists=.env", "server/index.mjs"]);
sh("node", ["--env-file-if-exists=.env", "--import", "tsx", "scripts/swarm.ts"]);

// 4) 静态伺服 dist(vite preview,端口 5180)
sh("npx", ["vite", "preview", "--config", "web/vite.config.ts", "--port", "5180", "--host", "127.0.0.1"]);

await new Promise((r) => setTimeout(r, DRY ? 0 : 4000));
const mode = chainOk ? "链上实时(自动档)" : "合成打底(诚实标注)";
say(`
═══ venue 就绪(${mode}) ═══
  大屏    http://127.0.0.1:5180/           全屏按 F
  排练    http://127.0.0.1:5180/?demo=1    合成密度(顶栏标 DEMO)
  验证页  http://127.0.0.1:5180/verify.html 输地址→到场证明
  导演台  http://127.0.0.1:5180/director.html SHOW 一键演出
  观众    http://localhost:${PORT}/join.html  手机扫码请走 stage.mjs 公网隧道
  健康    http://localhost:${PORT}/health
Ctrl-C 全部收摊。`);
if (!DRY) await new Promise(() => {}); // 驻留
