/**
 * S2-1 · budget.mjs --watch / --patch 外部保险丝测试
 *
 * 为什么起子进程而不是 import：budget.mjs 是 CLI 脚本（顶层读余额、打报告），
 * 它的对外契约就是命令行行为 —— 退出码、stdout。子进程测法同时验证了
 * 「RPC 不通时保险丝照常工作」（watch 只读中继的 /api/stats，不碰链）。
 *
 * 契约：
 *   node scripts/budget.mjs --watch --max-claims N [--relay URL] [--interval ms] [--polls k]
 *     · 每 interval 拉一次 URL/api/stats 的 sent
 *     · sent ≥ N → 打印 STOP + 退出码 2（看门狗/人据此掐蜂群、通知导演台）
 *     · 未触及且 --polls 用完 → 退出码 0（保险丝测试用；不带 polls 则永不自然退出）
 *     · 缺 N（--max-claims 与 MAX_CLAIMS 都没有）→ 退出码 1，拒绝盲跑
 *     · 中继暂时不可达 → 告警后继续等，不算触发（掐错比漏掐更糟）
 *   node scripts/budget.mjs --patch
 *     · 打印「往 relay 接硬截停」的 5 行补丁说明（说明文字，不自动改码）
 *     · 纯本地、不读 .relayers.json 之外的网络 —— RPC 黑洞也必须秒退 0
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = resolve(ROOT, "scripts/budget.mjs");

/**
 * 异步 spawn —— 不能用 spawnSync：假中继活在 vitest 自己的事件循环里，
 * 同步等待子进程会把事件循环冻死，中继永远答不上来（首版红就是这样红的）。
 */
function runBudget(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BUDGET, ...args], {
      cwd: ROOT,
      env: { ...process.env, RPC_URL: "http://127.0.0.1:9", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      done({ status: code, stdout, stderr });
    });
  });
}

/** 同步版：仅给不依赖事件循环的用例（--patch、默认报告模式）用，快且不占中继 */
function runBudgetSync(args, env = {}) {
  return spawnSync(process.execPath, [BUDGET, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, RPC_URL: "http://127.0.0.1:9", ...env },
  });
}

async function fakeRelay(handler) {
  const server = createServer((req, res) => {
    const body = JSON.stringify(handler(req.url));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

describe("budget --watch · 外部保险丝", () => {
  it("sent 达到上限 → STOP + 退出码 2，STOP 行里带上实际值与上限", async () => {
    const relay = await fakeRelay(() => ({ sent: 10, failed: 0 }));
    try {
      const r = await runBudget([
        "--watch",
        "--max-claims", "5",
        "--relay", relay.url,
        "--interval", "80",
        "--polls", "3",
      ]);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain("STOP");
      expect(r.status, out.slice(-1500)).toBe(2);
      expect(out).toMatch(/sent=10/);
      expect(out).toMatch(/max=5|MAX_CLAIMS=5/);
    } finally {
      await relay.close();
    }
  }, 60_000);

  it("未达上限，--polls 用完 → 退出码 0 并明说没触及", async () => {
    const relay = await fakeRelay(() => ({ sent: 3 }));
    try {
      const r = await runBudget(["--watch", "--max-claims", "500", "--relay", relay.url, "--interval", "50", "--polls", "2"]);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out.slice(-1500)).toBe(0);
      expect(out).toContain("未触及");
    } finally {
      await relay.close();
    }
  }, 60_000);

  it("MAX_CLAIMS 环境变量与 --max-claims 同权（relay 侧统一 env 名）", async () => {
    const relay = await fakeRelay(() => ({ sent: 7 }));
    try {
      const r = await runBudget(["--watch", "--relay", relay.url, "--interval", "50", "--polls", "2"], { MAX_CLAIMS: "6" });
      expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-1500)).toBe(2);
    } finally {
      await relay.close();
    }
  }, 60_000);

  it("不给上限就拒绝盲跑：非零退出 + 指名 --max-claims", async () => {
    const r = await runBudget(["--watch", "--relay", "http://127.0.0.1:9", "--interval", "50", "--polls", "1"]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(2); // 是用法错误，不是触发
    expect(out).toMatch(/max-claims|MAX_CLAIMS/);
  }, 60_000);

  it("中继不可达不误触发：告警继续，polls 用尽退 0（掐错比漏掐更糟）", async () => {
    const r = await runBudget(["--watch", "--max-claims", "5", "--relay", "http://127.0.0.1:9", "--interval", "50", "--polls", "2"]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out.slice(-1500)).toBe(0);
    expect(out).not.toContain("██ STOP ██"); // 表头说明文字本就含"STOP+exit 2"字样,真触发标志是 ██ 横幅
    expect(out).toMatch(/不可达|失败|unreachable|fetch/i);
  }, 60_000);
});

describe("budget --patch · 硬截停接入说明（终端即文档）", () => {
  it("纯本地秒退 0，输出含 5 行补丁要点：env 名、插入点、错误码", () => {
    const r = runBudgetSync(["--patch"]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out.slice(-1500)).toBe(0);
    expect(out).toContain("MAX_CLAIMS");
    expect(out).toContain("budget_exhausted");
    expect(out).toContain("handleClaim");
    expect(out).toContain("relayClaim");
    expect(out).toMatch(/docs|说明|不自动/); // 诚实边界：这是说明不是注入
  }, 60_000);
});

describe("budget 默认模式回归（E 的 reserve 模型不许被我改坏）", () => {
  it("无 watch/patch 参数时仍走原报告路径：黑洞 RPC 下照常打 Reserve-balance 模型并退 0", () => {
    const r = runBudgetSync([]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain("Reserve-balance 模型");
    expect(r.status, out.slice(-1200)).toBe(0);
  }, 60_000);
});
