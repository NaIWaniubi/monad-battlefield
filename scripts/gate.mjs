/**
 * 一键验收门禁 —— 一条命令判定「这套东西现在能不能上台」。
 *
 * 依次跑四道，任何一道失败整体退出码非 0：
 *   1. tsc --noEmit        类型
 *   2. vite build          三端都打得出来
 *   3. vitest run          纯逻辑单测
 *   4. scripts/qr-check.py 二维码真的能被解码、且解码出的地址真的能打开
 *      （第 4 道会自己拉起中继、等 /health、跑完再关掉）
 *
 * 用法：node scripts/gate.mjs [--skip-qr]
 * 路径按脚本自身位置解析，cwd 无关 —— 工作流从工作区根调用也能跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_QR = process.argv.includes("--skip-qr");
const PORT = Number(process.env.PORT ?? 8791);

function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  const tail = (s, n = 1400) => (s ?? "").trim().split("\n").slice(-14).join("\n").slice(-n);
  console.log(`\n── ${label} ── ${ok ? "PASS" : "FAIL"} (${(ms / 1000).toFixed(1)}s, exit=${r.status})`);
  if (!ok) {
    console.log(tail(r.stdout));
    console.log(tail(r.stderr));
  } else if (process.env.GATE_VERBOSE) {
    console.log(tail(r.stdout, 2400));
  }
  return { label, ok, ms, exit: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function waitHealth(url, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 直接用 node 调 CLI 入口，不走 npx / npm 外壳：
// 实测 `npx tsc` 会偶发 exit=134（原生 abort），而 `node …/bin/tsc` 稳定通过。
// 少一层 shell 也少一处「命令找不到」的失败面。
const results = [];
// 密钥扫描排第一：它最快，而且失败后果最严重（公开仓库里的私钥撤不回来）。
// 不是 git 仓库时它返回 2 —— 那是「跳过」，不是失败。
const secrets = run("密钥泄露扫描 check-secrets", process.execPath, ["scripts/check-secrets.mjs"], { shell: false });
if (secrets.exit === 2) {
  secrets.ok = true;
  console.log("（不是 git 仓库，已跳过 —— 提交前记得 git init 后再跑一次）");
}
results.push(secrets);
results.push(run("类型检查 tsc --noEmit", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], { shell: false }));
results.push(
  run("三端构建 vite build", process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "web/vite.config.ts"], { shell: false }),
);
results.push(run("单元测试 vitest run", process.execPath, ["node_modules/vitest/vitest.mjs", "run"], { shell: false }));

if (!SKIP_QR) {
  // 中继自己拉起来：门禁不依赖「你记得先开了服务」
  const relay = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (d) => (relayLog += d));
  relay.stderr.on("data", (d) => (relayLog += d));

  let up = false;
  try {
    up = await waitHealth(`http://127.0.0.1:${PORT}/health`);
    if (!up) {
      console.log(`\n── 二维码可达性 ── FAIL（中继 40s 内没起来）`);
      console.log(relayLog.slice(-1600));
      results.push({ label: "二维码可达性 qr-check", ok: false, ms: 0, exit: -1 });
    } else {
      const banner = relayLog.split("\n").filter((l) => /大屏 →|join |备用网卡/.test(l)).join("\n");
      if (banner) console.log("\n中继自报地址：\n" + banner);
      results.push(
        run("二维码可达性 qr-check", "python", ["-I", "scripts/qr-check.py"], {
          timeout: 180000,
        }),
      );
      results.push(
        run("跨设备控场 director-check", "python", ["-I", "scripts/director-check.py", "--base", `http://localhost:${PORT}`], {
          timeout: 180000,
        }),
      );
    }
  } finally {
    relay.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    if (!relay.killed) relay.kill("SIGKILL");
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n════════════════════════════════════════");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
console.log("════════════════════════════════════════");
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.map((r) => ({ label: r.label, ok: r.ok, exit: r.exit })) }));
process.exit(failed.length === 0 ? 0 : 1);