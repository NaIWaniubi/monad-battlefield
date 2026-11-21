import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const RPC_URL = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
/** 多节点轮转：公共 RPC 限流很严，40 条车道全打一个节点必然 429 */
export const RPC_URLS: string[] = (
  process.env.RPC_URLS ??
  "https://monad-testnet.drpc.org,https://rpc.ankr.com/monad_testnet,https://testnet-rpc.monad.xyz"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

/** Monad Testnet：EVM 等价，0.5s 出块，并行执行。 */
export const monad = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "MonadScan", url: "https://testnet.monadscan.com" },
  },
});

export const pub = createPublicClient({
  chain: monad,
  transport: http(RPC_URL, { retryCount: 3, timeout: 20_000 }),
});

export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: monad,
    transport: http(RPC_URL, { retryCount: 2, timeout: 20_000 }),
  });
}

export type Artifact = { abi: Abi; bytecode: Hex };
export type DeployInfo = { address: Address; startBlock: number; deployer: Address };

export function loadArtifact(): Artifact {
  const p = "contracts/artifacts/Battlefield.json";
  if (!existsSync(p)) {
    throw new Error(`缺少 ${p} —— 先跑 npm run build:contract`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function loadDeploy(): DeployInfo {
  const p = "deployments.json";
  if (!existsSync(p)) {
    throw new Error(`缺少 ${p} —— 先跑 npm run deploy`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveJson(path: string, obj: unknown) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`缺少环境变量 ${key}（把 .env.example 复制成 .env 再填）`);
  return v;
}

/**
 * E-fixes#8（C2 fund→swarm 防抖）：注资后等余额「可见」再收工。
 *
 * 问题： Monad 是异步执行，交易被接收 ≠ 状态可读（D=3 传播约 1.2s）。
 * fund.ts 一跑完就启动蜂群，新号第一笔 tx 会因节点还没反映余额被拒 ——
 * 演示日志里那串难看的 fail= 有一小半就是这么来的。
 * 做法：每轮 pollMs 查一遍全部地址，直到 ≥ needWei 或 timeoutMs 到；
 * 全部就位/超时后再固定加等 settleMs（覆盖 D=3 可见性余量，默认 1.5s）。
 * 依赖注入（假 pub + 假 sleep）供 tests/e-fixes-lib.test.ts 无网络单测。
 */
export async function waitBalancesVisible(
  client: { getBalance: (a: { address: Address }) => Promise<bigint> },
  addresses: readonly Address[],
  needWei: bigint,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    settleMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ ready: number; pending: Address[] }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 1_000;
  const settleMs = opts.settleMs ?? 1_500;
  const nap = opts.sleep ?? sleep;
  if (!addresses.length) return { ready: 0, pending: [] };

  const deadline = Date.now() + timeoutMs;
  let pending: Address[] = [...addresses];
  for (;;) {
    const stillPending: Address[] = [];
    for (const addr of pending) {
      let bal = 0n;
      try {
        bal = await client.getBalance({ address: addr });
      } catch {
        /* 查询失败本轮按不就位处理，下轮再试 */
      }
      if (bal < needWei) stillPending.push(addr);
    }
    pending = stillPending;
    if (!pending.length || Date.now() >= deadline) break;
    await nap(pollMs);
  }

  // 全就位（或超时尽力了）之后再等一个可见性余量：链的「查得到」略滞后于「已生效」
  await nap(settleMs);
  return { ready: addresses.length - pending.length, pending };
}

export type Bot = { address: Address; pk: Hex };

export function loadBots(): Bot[] {
  const p = ".bots.json";
  if (!existsSync(p)) throw new Error(`缺少 ${p} —— 先跑 npm run keys`);
  return JSON.parse(readFileSync(p, "utf8"));
}
