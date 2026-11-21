/**
 * 多 RPC 故障转移层。
 *
 * 公共 Monad 测试网节点各有怪癖：
 *   - 官方节点限流严（429）
 *   - drpc 免费档 getLogs 范围 ≤ 10000 块
 *   - ankr 范围更小，超了报 "Block range is too large"
 * 所以：小 chunk + 多节点轮询 + 失败自动换家。
 */
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

export const RPC_LIST: string[] = (
  (import.meta.env.VITE_RPC_URLS as string | undefined) ??
  "https://monad-testnet.drpc.org,https://rpc.ankr.com/monad_testnet,https://testnet-rpc.monad.xyz"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const monad = defineChain({
  id: Number(import.meta.env.VITE_CHAIN_ID ?? 10143),
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_LIST[0]] } },
});

const clients: PublicClient[] = RPC_LIST.map((url) =>
  createPublicClient({
    chain: monad,
    transport: http(url, { retryCount: 1, timeout: 15_000 }),
  }),
);

let preferred = 0;

/** 依次尝试各节点，成功就把该节点设为优先 */
export async function withFailover<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < clients.length; i++) {
    const idx = (preferred + i) % clients.length;
    try {
      const out = await fn(clients[idx]);
      preferred = idx;
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("所有 RPC 均不可用");
}

export function currentRpc(): string {
  return RPC_LIST[preferred];
}

/** getLogs 的安全 chunk：ankr 对大范围直接拒绝，40 块最稳 */
export const LOG_CHUNK = 40n;
