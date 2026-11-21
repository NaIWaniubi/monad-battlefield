/**
 * 并发性质测试：server/nonce-queue.mjs
 *
 * 目的：把 index.mjs 里「同步占号 + 失败回链对账」的语义钉成可执行契约。
 * 不碰链、不引新依赖：链上 nonce 由模拟器注入，事件交错由 seeded PRNG（mulberry32）生成，
 * 失败时打印种子即可原样复现。
 *
 * 四条性质（每条都跑满 SEQUENCES=200 组随机交错序列，> 任务要求的 50 个种子）：
 *
 *   P1 同一 key 内 nonce 严格递增、并发无重复：
 *      - 一个「纪元」（两次 resync 之间）内，acquisition 严格 +1，不可能重复；
 *      - 任意时刻在途（已 acquire、未结算）集合内不得出现同一个 nonce。
 *      注意 1：跨纪元**允许**复用「未上链」的号 —— 这正是 allowRollback 回退补洞的定义，
 *      所以「全局永不重复」在回退语义下本身不成立，不能写成断言。
 *      注意 2：回退到空洞后，池中高位号可能瞬间连通、链上 nonce 跳变，
 *      本地 nextNonce 会短暂落后于链上（staleAssignment）。这不是并发重复：
 *      节点对 nonce too low 必然拒绝，失败路径 markResyncNeeded，排空后 resync 自愈。
 *      因此 P1 不对「永不分配低于链上的号」下断言，只在 P2/P4 断言对账后的收敛。
 *
 *   P2 resync(key, chainNonce, true) 在 pending===0 时，nextNonce 必须精确等于 chainNonce；
 *      allowRollback=false 时只许前进、绝不下退。
 *
 *   P3 pending 计数永不为负；pendingCount(key) === 该 key 在途笔数；
 *      全局 pendingCount()===0 当且仅当全局无在途。
 *
 *   P4 任意失败序列（含乱序成功/失败、空洞、空转 resync）排空后做一次回退对账，
 *      nextNonce 必等于链上最小未上链号；下一次 acquire 恰好拿到这个号（无永久空洞），
 *      且 resyncNeeded 被清除。
 */
import { describe, expect, it } from "vitest";
import { createNonceQueue } from "../server/nonce-queue.mjs";

/* ────────────────────────── seeded PRNG ────────────────────────── */

/** mulberry32：32-bit 种子，确定性、无依赖。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

/* ────────────────────────── 模拟模型 ────────────────────────── */

const KEYS = ["key-0", "key-1", "key-2"] as const;
const SEQUENCES = 200; // 每条性质 200 组随机序列（任务下限 50）
const STEPS = 120; // 每组序列的事件数

type Prop = "P1" | "P2" | "P3" | "P4";

interface Violation {
  seed: number;
  prop: Prop;
  msg: string;
}

interface KeyModel {
  id: string;
  /** 链上最小未上链 nonce（= eth_getTransactionCount(pending) 的模型） */
  chainNonce: bigint;
  /** 已接收但尚未连成前缀的高位 nonce（> chainNonce 的空洞上方） */
  accepted: Set<string>;
  /** 已 acquire、尚未结算：nonce(string) → bigint */
  inflight: Map<string, bigint>;
  /** 本纪元最后一次 acquire 的 nonce；resync 后进入新纪元 */
  epochLast: bigint | null;
}

interface SimStats {
  acquires: number;
  rollbackResyncs: number;
  forwardResyncs: number;
  skippedResyncs: number;
  pooledReuse: number;
  /** 回退后链上跳变导致的「本地落后」占号：节点必然以 nonce too low 拒绝 */
  staleAssignments: number;
  /** 真实发送里被节点拒绝（nonce too low）的笔数 */
  rejectedStale: number;
}

interface SimResult {
  violations: Violation[];
  stats: SimStats;
}

function acceptMined(key: KeyModel, nonce: bigint): void {
  key.accepted.add(nonce.toString());
  while (key.accepted.has(key.chainNonce.toString())) {
    key.accepted.delete(key.chainNonce.toString());
    key.chainNonce += 1n;
  }
}

async function simulate(seed: number): Promise<SimResult> {
  const rand = mulberry32(seed);
  const violations: Violation[] = [];
  const stats: SimStats = {
    acquires: 0,
    rollbackResyncs: 0,
    forwardResyncs: 0,
    skippedResyncs: 0,
    pooledReuse: 0,
    staleAssignments: 0,
    rejectedStale: 0,
  };

  const fail = (prop: Prop, msg: string) => {
    violations.push({ seed, prop, msg });
  };

  const keys: KeyModel[] = KEYS.map((id, i) => ({
    id,
    // 起始链上 nonce 在 0..2 之间，覆盖「开局就有历史交易」的情况
    chainNonce: BigInt(i === 0 ? 0 : Math.floor(rand() * 3)),
    accepted: new Set<string>(),
    inflight: new Map<string, bigint>(),
    epochLast: null,
  }));
  const byId = new Map<string, KeyModel>(keys.map((k) => [k.id, k]));

  const q = createNonceQueue({
    // 每次 ensure/resync 都由模型当前链高提供；真实实现里这是一次
    // eth_getTransactionCount(address, "pending")，链高会随交易上链推进。
    getChainNonce: (keyId: string) => byId.get(keyId)!.chainNonce,
  });

  // 初始化：并发 ensure 两次，验证只初始化一次且拿到链上值
  await Promise.all([q.ensure("key-0"), q.ensure("key-0")]);
  for (const k of keys) {
    await q.ensure(k.id);
    if (q.nextNonceOf(k.id) !== k.chainNonce) {
      fail("P2", `ensure 未采用链上值：${k.id} next=${q.nextNonceOf(k.id)} chain=${k.chainNonce}`);
    }
  }

  const totalInflight = () => keys.reduce((n, k) => n + k.inflight.size, 0);

  const checkPending = (where: string) => {
    // P3：全局计数 == 在途总数；单 key 计数 == 该 key 在途数（且不为负）
    if (q.pendingCount() !== totalInflight()) {
      fail("P3", `${where} 全局 pending=${q.pendingCount()} 但在途=${totalInflight()}`);
    }
    for (const k of keys) {
      const p = q.pendingCount(k.id);
      if (p < 0) fail("P3", `${where} ${k.id} pending 为负：${p}`);
      if (p !== k.inflight.size) {
        fail("P3", `${where} ${k.id} pending=${p} 但在途=${k.inflight.size}`);
      }
    }
    if (q.pendingCount() === 0 && totalInflight() !== 0) {
      fail("P3", `${where} 全局 pending 归零但仍有在途`);
    }
    if (q.pendingCount() !== 0 && totalInflight() === 0) {
      fail("P3", `${where} 无在途但全局 pending=${q.pendingCount()}`);
    }
  };

  const doAcquire = (k: KeyModel, where: string) => {
    q.retain(k.id);
    const nonce = q.acquire(k.id);
    stats.acquires++;

    // 回退后链上跳变会让本地暂落后：记一笔「注定 nonce too low」的占号。
    // 这不是重复分配（在途重复下面单独查），节点必然拒绝，随后 resync 自愈。
    if (nonce < k.chainNonce) stats.staleAssignments++;
    // 并发在途重复（P1）
    if (k.inflight.has(nonce.toString())) {
      fail("P1", `${where} ${k.id} 重复分配在途 nonce ${nonce}`);
    }
    // 纪元内严格 +1（P1）
    if (k.epochLast !== null && nonce !== k.epochLast + 1n) {
      fail("P1", `${where} ${k.id} 纪元内不连续：上次 ${k.epochLast} 本次 ${nonce}`);
    }
    // 记录「复用了池中高位号」——回退语义下的已知代价，不是并发 bug
    if (k.accepted.has(nonce.toString())) stats.pooledReuse++;

    k.epochLast = nonce;
    k.inflight.set(nonce.toString(), nonce);
  };

  for (let step = 0; step < STEPS; step++) {
    const r = rand();
    const key = pick(rand, keys);
    const where = `seed=${seed} step=${step}`;

    if (r < 0.5) {
      // 占号：retain → ensure（已初始化）→ acquire
      await q.ensure(key.id);
      doAcquire(key, where);
    } else if (r < 0.8) {
      // 结算一笔在途：80% 节点接收（成功），20% 发送失败（留下空洞）
      const owners = keys.filter((k) => k.inflight.size > 0);
      if (owners.length === 0) {
        await q.ensure(key.id);
        doAcquire(key, where);
      } else {
        const owner = pick(rand, owners);
        const nonces = [...owner.inflight.values()];
        const nonce = pick(rand, nonces);
        owner.inflight.delete(nonce.toString());
        q.release(owner.id);
        // 节点语义：nonce < chainNonce 必然 nonce too low，不能算成功接收。
        if (rand() < 0.8 && nonce >= owner.chainNonce) {
          acceptMined(owner, nonce);
        } else {
          // 发送失败（含 nonce too low）→ 该 key 需要回链对账；队列清空时立刻回退补洞
          if (nonce < owner.chainNonce) stats.rejectedStale++;
          q.markResyncNeeded(owner.id);
          if (q.pendingCount(owner.id) === 0) {
            const res = q.resync(owner.id, owner.chainNonce, true);
            if (q.nextNonceOf(owner.id) !== owner.chainNonce) {
              fail(
                "P2",
                `${where} 失败后回退对账未贴合链上：next=${q.nextNonceOf(owner.id)} chain=${owner.chainNonce} applied=${res.applied}`,
              );
            }
            if (q.resyncNeededOf(owner.id)) {
              fail("P4", `${where} 回退对账后 resyncNeeded 未清除`);
            }
            owner.epochLast = null; // 回退 → 新纪元
            stats.rollbackResyncs++;
          }
        }
      }
    } else if (r < 0.92) {
      // 例行对账：pending>0 必须跳过；pending===0 时随机「只前进」或「允许回退」
      const before = q.nextNonceOf(key.id);
      const allowRollback = rand() < 0.5;
      const res = q.resync(key.id, key.chainNonce, allowRollback);
      if (q.pendingCount(key.id) > 0) {
        stats.skippedResyncs++;
        if (res.applied || res.reason !== "pending" || res.after !== before) {
          fail("P2", `${where} 有在途时 resync 未跳过：${JSON.stringify(res)}`);
        }
      } else if (allowRollback) {
        stats.rollbackResyncs++;
        if (q.nextNonceOf(key.id) !== key.chainNonce) {
          fail("P2", `${where} 回退对账 next=${q.nextNonceOf(key.id)} chain=${key.chainNonce}`);
        }
        if (q.resyncNeededOf(key.id)) fail("P4", `${where} 回退对账未清 resyncNeeded`);
        key.epochLast = null;
      } else {
        stats.forwardResyncs++;
        if (before !== null && q.nextNonceOf(key.id)! < before) {
          fail("P2", `${where} 只前进对账发生下退：${before} → ${q.nextNonceOf(key.id)}`);
        }
        const expectNext = before === null || key.chainNonce > before ? key.chainNonce : before;
        if (q.nextNonceOf(key.id) !== expectNext) {
          fail("P2", `${where} 只前进对账结果错：next=${q.nextNonceOf(key.id)} 期望=${expectNext}`);
        }
        if (res.applied) key.epochLast = null;
      }
    } else {
      // 重复 ensure：幂等，不得覆盖已推进的本地计数
      const before = q.nextNonceOf(key.id);
      await q.ensure(key.id);
      if (q.nextNonceOf(key.id) !== before) {
        fail("P1", `${where} 重复 ensure 覆盖了本地 next：${before} → ${q.nextNonceOf(key.id)}`);
      }
    }

    checkPending(where);
  }

  /* ── P4：任意失败序列排空 + 一次回退对账 → 无永久空洞 ── */
  for (const k of keys) {
    // 把剩余在途全部按「发送失败」结算（不回链接受）
    for (const nonce of [...k.inflight.values()]) {
      k.inflight.delete(nonce.toString());
      q.release(k.id);
      q.markResyncNeeded(k.id);
    }
    checkPending(`seed=${seed} drain ${k.id}`);
    q.resync(k.id, k.chainNonce, true);
    if (q.nextNonceOf(k.id) !== k.chainNonce) {
      fail("P4", `seed=${seed} drain 后 ${k.id} 未回到链上 nonce：next=${q.nextNonceOf(k.id)} chain=${k.chainNonce}`);
    }
    if (q.resyncNeededOf(k.id)) fail("P4", `seed=${seed} drain 后 ${k.id} resyncNeeded 未清除`);

    // 无永久空洞：下一次 acquire 必须恰好是最小未上链号
    q.retain(k.id);
    const next = q.acquire(k.id);
    q.release(k.id);
    if (next !== k.chainNonce) {
      fail("P4", `seed=${seed} ${k.id} 恢复后 acquire=${next}，链上最小未上链=${k.chainNonce}`);
    }
    // 这笔未广播：回退复位，避免影响后续断言
    q.markResyncNeeded(k.id);
    q.resync(k.id, k.chainNonce, true);
  }
  checkPending(`seed=${seed} end`);

  return { violations, stats };
}

/** 跑满 SEQUENCES 组序列，按性质收集违规并统计覆盖量。 */
async function runProperty(prop: Prop): Promise<{ violations: Violation[]; stats: SimStats; seeds: number }> {
  const violations: Violation[] = [];
  const stats: SimStats = {
    acquires: 0,
    rollbackResyncs: 0,
    forwardResyncs: 0,
    skippedResyncs: 0,
    pooledReuse: 0,
    staleAssignments: 0,
    rejectedStale: 0,
  };
  for (let seed = 1; seed <= SEQUENCES; seed++) {
    const result = await simulate(seed);
    violations.push(...result.violations.filter((v) => v.prop === prop));
    stats.acquires += result.stats.acquires;
    stats.rollbackResyncs += result.stats.rollbackResyncs;
    stats.forwardResyncs += result.stats.forwardResyncs;
    stats.skippedResyncs += result.stats.skippedResyncs;
    stats.pooledReuse += result.stats.pooledReuse;
    stats.staleAssignments += result.stats.staleAssignments;
    stats.rejectedStale += result.stats.rejectedStale;
  }
  console.log(
    `[${prop}] seeds=${SEQUENCES} steps/seed=${STEPS} acquires=${stats.acquires} ` +
      `rollbackResync=${stats.rollbackResyncs} forwardResync=${stats.forwardResyncs} ` +
      `skippedResync=${stats.skippedResyncs} pooledReuse=${stats.pooledReuse} ` +
      `staleAssign=${stats.staleAssignments} rejectedStale=${stats.rejectedStale}`,
  );
  return { violations, stats, seeds: SEQUENCES };
}

function report(violations: Violation[]): void {
  if (violations.length === 0) return;
  const head = violations.slice(0, 8).map((v) => `seed=${v.seed} [${v.prop}] ${v.msg}`).join("\n");
  expect.fail(`${violations.length} 条违规（前 8 条，种子可复现）：\n${head}`);
}

/* ────────────────────────── 四条性质 ────────────────────────── */

describe("nonce-queue 并发性质（seeded PRNG，mulberry32）", () => {
  it("P1 同 key 纪元内严格递增、在途无重复", async () => {
    const { violations, stats, seeds } = await runProperty("P1");
    expect(seeds).toBeGreaterThanOrEqual(50);
    expect(stats.acquires).toBeGreaterThan(0);
    report(violations);
  }, 30_000);

  it("P2 allowRollback=true 精确贴合链上；false 只许前进", async () => {
    const { violations, stats, seeds } = await runProperty("P2");
    expect(seeds).toBeGreaterThanOrEqual(50);
    expect(stats.rollbackResyncs).toBeGreaterThan(0);
    expect(stats.forwardResyncs).toBeGreaterThan(0);
    expect(stats.skippedResyncs).toBeGreaterThan(0);
    report(violations);
  }, 30_000);

  it("P3 pending 永不为负、计数与在途等价", async () => {
    const { violations, seeds } = await runProperty("P3");
    expect(seeds).toBeGreaterThanOrEqual(50);
    report(violations);
  }, 30_000);

  it("P4 任意失败序列排空并回退对账后无永久空洞", async () => {
    const { violations, seeds } = await runProperty("P4");
    expect(seeds).toBeGreaterThanOrEqual(50);
    report(violations);
  }, 30_000);
});

/* ────────────────────────── 契约边角（非随机） ────────────────────────── */

describe("nonce-queue 契约边角", () => {
  it("未初始化时 acquire 抛 nonce_queue_uninitialized", () => {
    const q = createNonceQueue({ getChainNonce: () => 0n });
    expect(() => q.acquire("k")).toThrowError(/nonce_queue_uninitialized/);
    expect(q.nextNonceOf("k")).toBeNull();
  });

  it("并发 ensure 只问链一次，且拿到同一个值", async () => {
    let calls = 0;
    let resolveChain!: (v: bigint) => void;
    const gate = new Promise<bigint>((r) => {
      resolveChain = r;
    });
    const q = createNonceQueue({
      getChainNonce: () => {
        calls++;
        return gate;
      },
    });
    const a = q.ensure("k");
    const b = q.ensure("k");
    expect(calls).toBe(1);
    resolveChain(7n);
    expect(await a).toBe(7n);
    expect(await b).toBe(7n);
    expect(q.nextNonceOf("k")).toBe(7n);
  });

  it("ensure 失败后可重试（init 复位）", async () => {
    let calls = 0;
    const q = createNonceQueue({
      getChainNonce: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("rpc down"));
        return 4n;
      },
    });
    await expect(q.ensure("k")).rejects.toThrowError(/rpc down/);
    expect(await q.ensure("k")).toBe(4n);
    expect(calls).toBe(2);
  });

  it("release 下溢抛错（pending 不可能为负）", () => {
    const q = createNonceQueue({ getChainNonce: () => 0n });
    expect(() => q.release("k")).toThrowError(/pending_underflow/);
  });

  it("pending>0 时 resync 跳过；排空后 allowRollback 才回退", async () => {
    const q = createNonceQueue({ getChainNonce: () => 10n });
    await q.ensure("k");
    q.retain("k");
    const first = q.acquire("k");
    expect(first).toBe(10n);
    const skipped = q.resync("k", 3n, true);
    expect(skipped).toMatchObject({ applied: false, reason: "pending", after: 11n });
    q.release("k");
    const rolled = q.resync("k", 3n, true);
    expect(rolled.applied).toBe(true);
    expect(q.nextNonceOf("k")).toBe(3n);
  });

  it("allowRollback=false 永不下退，只跟随链上前进", async () => {
    const q = createNonceQueue({ getChainNonce: () => 10n });
    await q.ensure("k");
    expect(q.nextNonceOf("k")).toBe(10n);
    q.resync("k", 9n, false);
    expect(q.nextNonceOf("k")).toBe(10n);
    q.resync("k", 15n, false);
    expect(q.nextNonceOf("k")).toBe(15n);
  });

  it("resyncNeeded 只在 allowRollback=true 时清除", async () => {
    const q = createNonceQueue({ getChainNonce: () => 0n });
    await q.ensure("k");
    q.markResyncNeeded("k");
    q.resync("k", 0n, false);
    expect(q.resyncNeededOf("k")).toBe(true);
    q.resync("k", 0n, true);
    expect(q.resyncNeededOf("k")).toBe(false);
  });
});
