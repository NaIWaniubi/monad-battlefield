/**
 * 一键上台 —— 一条命令把「78 台手机能扫开」这件事变成既成事实。
 *
 * 为什么需要它：
 *   RUNBOOK 原来的步骤是「笔记本连 4G 路由、手机用自己的流量」。
 *   那种情况下手机和笔记本**不在同一个网络**，二维码里写局域网 IP（10.x / 192.168.x）
 *   手机根本路由不到 —— 和写 localhost 一样是死码，只是死得更隐蔽。
 *   唯一对「任意手机、任意网络」都成立的做法是公网 HTTPS 隧道。
 *
 * 它做的事：
 *   1. vite build（确保 dist/ 是三端齐全的最新版）
 *   2. cloudflared 起临时隧道 → 拿到 https://xxx.trycloudflare.com
 *   3. 用 JOIN_URL=<隧道>/join.html 起中继（中继本来就支持这个覆盖）
 *   4. 等隧道真的能访问到 /health
 *   5. 打印大屏 / 观众页 / 导演台三个地址 —— 全部同一个 origin
 *
 * 用法：
 *   node scripts/stage.mjs            公网隧道模式（默认，会场用这个）
 *   node scripts/stage.mjs --lan      局域网模式（所有人连同一个 wifi 时才用）
 *   node scripts/stage.mjs --check    起完后再跑一遍二维码可达性验收
 *
 * Ctrl-C 退出，会带走中继和隧道两个子进程。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8791);
const LAN = process.argv.includes("--lan");
const CHECK = process.argv.includes("--check");
/** dist/ 已经是刚构建好的（比如门禁刚跑过）时跳过构建，避免多个进程同时写 dist/ */
const NO_BUILD = process.argv.includes("--no-build");
const kids = [];

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

function cleanup(code = 0) {
  for (const k of kids) killTree(k.pid);
  process.exit(code);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("exit", () => {
  for (const k of kids) killTree(k.pid);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lanIp() {
  const VIRTUAL = /tailscale|zerotier|vmware|vmnet|vethernet|hyper-v|wsl|docker|virtualbox|vbox|loopback|utun|^tun\d|^tap\d/i;
  const PHYS = /^(wlan|wi-?fi|以太网|ethernet|eth\d|en\d|本地连接|local area)/i;
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family !== "IPv4" || ni.internal || ni.address.startsWith("169.254.")) continue;
      out.push({ name, address: ni.address, rank: VIRTUAL.test(name) ? 2 : PHYS.test(name) ? 0 : 1 });
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  return out[0]?.address ?? "127.0.0.1";
}

async function waitUrl(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

/* ── 1. 构建 ─────────────────────────────────────────── */
if (NO_BUILD) {
  console.log("▶ 跳过构建（--no-build），直接用现有 dist/");
  if (!existsSync(resolve(ROOT, "dist/index.html"))) {
    console.error("dist/index.html 不存在 —— --no-build 用不了，去掉这个参数重跑。");
    cleanup(1);
  }
} else {
  console.log("▶ 构建三端 …");
  const build = spawnSync("npm", ["run", "build:web"], { cwd: ROOT, shell: true, encoding: "utf8" });
  if (build.status !== 0) {
    console.error(build.stdout?.slice(-1500));
    console.error(build.stderr?.slice(-1500));
    console.error("构建失败 —— 先修构建，别上台。");
    cleanup(1);
  }
  console.log("  构建完成");
}

/* ── 2. 隧道 ─────────────────────────────────────────── */
let publicBase = "";
if (!LAN) {
  console.log("▶ 起 cloudflared 临时隧道 …");
  const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(cf);
  let buf = "";
  const grab = (d) => {
    buf += d.toString();
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !publicBase) publicBase = m[0];
  };
  cf.stdout.on("data", grab);
  cf.stderr.on("data", grab);
  cf.on("exit", (c) => {
    if (!publicBase) {
      console.error("cloudflared 退出了，没拿到隧道地址。输出：\n" + buf.slice(-1500));
      cleanup(1);
    }
  });

  const t0 = Date.now();
  while (!publicBase && Date.now() - t0 < 60000) await sleep(400);
  if (!publicBase) {
    console.error("60s 内没拿到隧道地址。cloudflared 输出：\n" + buf.slice(-1500));
    console.error("改用局域网模式：node scripts/stage.mjs --lan（要求所有手机连同一个 wifi）");
    cleanup(1);
  }
  console.log(`  隧道 ${publicBase}`);
}

const base = LAN ? `http://${lanIp()}:${PORT}` : publicBase;

/* ── 3. 中继 ─────────────────────────────────────────── */
console.log("▶ 起中继 …");
const relay = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", "server/index.mjs"],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), JOIN_URL: `${base}/join.html` },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
kids.push(relay);
let relayBuf = "";
relay.stdout.on("data", (d) => {
  relayBuf += d;
  process.stdout.write(d);
});
relay.stderr.on("data", (d) => {
  relayBuf += d;
  process.stderr.write(d);
});
relay.on("exit", (c) => {
  console.error(`\n中继退出（code=${c}）`);
  cleanup(c ?? 1);
});

if (!(await waitUrl(`http://127.0.0.1:${PORT}/health`, 40000))) {
  console.error("中继 40s 内没起来。日志：\n" + relayBuf.slice(-1800));
  cleanup(1);
}

/* ── 4. 隧道端到端可达 ───────────────────────────────── */
if (!LAN) {
  console.log("▶ 等隧道打通 …");
  if (!(await waitUrl(`${base}/health`, 90000))) {
    console.error("隧道地址访问不到 /health —— 换局域网模式：node scripts/stage.mjs --lan");
    cleanup(1);
  }
}

/* ── 5. 打印 ─────────────────────────────────────────── */
console.log("");
console.log("  ══════════════════════════════════════════════════");
console.log(`  大屏（投影）  ${base}/`);
console.log(`  观众页（扫码）${base}/join.html`);
console.log(`  导演台        ${base}/director.html`);
console.log("  ══════════════════════════════════════════════════");
console.log("  三个地址同一个 origin —— 导演台的字幕才推得到大屏。");
if (!LAN) console.log("  公网 HTTPS：手机用流量也能扫开，不需要连同一个 wifi。");
else console.log("  局域网模式：所有手机必须连同一个 wifi，否则扫不开。");
console.log("  Ctrl-C 退出（会带走中继和隧道）");
console.log("");

/* ── 6. 可选验收 ─────────────────────────────────────── */
if (CHECK) {
  console.log("▶ 跑二维码可达性验收 …");
  const r = spawnSync("python", ["-I", "scripts/qr-check.py", "--base", base], {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    timeout: 240000,
  });
  console.log(r.stdout ?? "");
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-1200) ?? "");
    console.error("验收没过 —— 别上台，先看上面的 FAIL 项。");
  }
}

// 挂着，直到 Ctrl-C
await new Promise(() => {});