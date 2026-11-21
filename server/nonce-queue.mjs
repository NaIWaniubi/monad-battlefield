/**
 * server/nonce-queue.mjs — 每个 relayer key 一条 nonce 队列的纯实现。
 *
 * 从 server/index.mjs 的 createRelayer / ensureNonce / relayClaim / resyncNonce
 * 提炼出来的**语义等价**模块。这里不碰网络、不碰 viem：链上 nonce 由调用方通过
 * `getChainNonce(keyId)` 提供，因此可以直接在单测里驱动。
 *
 * 与现实现一一对应的四条语义：
 *
 *   1. 懒加载 + 只初始化一次（ensure）
 *      - 并发调用共享同一个 promise，只有第一次真正问链；
 *      - 初始化期间如果已经有本地占号（nextNonce !== null），绝不覆盖。
 *
 *   2. 同步占号（acquire）
 *      - 读 nextNonce → 写回 nextNonce+1 之间没有 await；
 *        JS 单线程下两个并发请求不可能拿到同一个 nonce。
 *      - nextNonce 未初始化时抛 nonce_queue_uninitialized（调用方必须先 await ensure）。
 *
 *   3. pending 是「已占位、尚未发送完成」的笔数（retain/release）
 *      - index.mjs 在 await ensureNonce **之前**就 key.pending++，
 *        否则并发请求会在 await 期间看到 pending=0 全挤到同一个 key；
 *        所以这里 retain 与 acquire 分开，调用顺序必须是 retain → ensure → acquire。
 *      - release 下溢直接抛错：宁可炸，也不让计数悄悄变负。
 *
 *   4. 对账（resync）
 *      - pending > 0 时绝不动号（返回 applied:false, reason:"pending"）；
 *      - allowRollback=true：完全信任链上 pending nonce，允许回退（补空洞）；
 *      - allowRollback=false：只允许前进，防止把已经在飞的交易覆盖掉；
 *      - allowRollback=true 时顺带清掉 resyncNeeded 标记。
 *
 * 状态机：Idle → (retain/ensure) Acquiring → (acquire) Inflight → (release) Settled
 *         → (resync at pending===0) Idle。详见 docs/RELAY-SPEC.md。
 *
 * 注：index.mjs 里的 failStreak / cooldown / funded 属于「健康度」而非 nonce 状态，
 * 刻意留在调用方，本模块不接管。
 */

/** @typedef {{ nextNonce: bigint | null, pending: number, resyncNeeded: boolean, init: Promise<bigint> | null }} KeyState */

/**
 * @param {{
 *   getChainNonce: (keyId: string) => Promise<bigint | number | string> | bigint | number | string,
 *   log?: (msg: string) => void,
 * }} options
 */
export function createNonceQueue({ getChainNonce, log = () => {} } = {}) {
  if (typeof getChainNonce !== "function") {
    throw new TypeError("createNonceQueue: getChainNonce must be a function");
  }

  /** @type {Map<string, KeyState>} */
  const states = new Map();

  /** @param {string} keyId @returns {KeyState} */
  function stateOf(keyId) {
    let s = states.get(keyId);
    if (!s) {
      s = { nextNonce: null, pending: 0, resyncNeeded: false, init: null };
      states.set(keyId, s);
    }
    return s;
  }

  /**
   * 懒加载链上 nonce；并发调用共享同一个 promise（对应 ensureNonce）。
   * 失败后 init 复位，下一次调用会重新问链（对应 .finally(() => nonceInit = null)）。
   * @param {string} keyId
   * @returns {Promise<bigint>}
   */
  function ensure(keyId) {
    const s = stateOf(keyId);
    if (s.nextNonce !== null) return Promise.resolve(s.nextNonce);
    if (!s.init) {
      /** @type {Promise<bigint | number | string>} */
      let asked;
      try {
        asked = Promise.resolve(getChainNonce(keyId));
      } catch (e) {
        asked = Promise.reject(e);
      }
      s.init = asked
        .then((n) => {
          // 只在我们还没有本地计数时采用链上值；期间已有占号则保留本地值。
          if (s.nextNonce === null) s.nextNonce = BigInt(n);
          return /** @type {bigint} */ (s.nextNonce);
        })
        .finally(() => {
          s.init = null;
        });
    }
    return s.init;
  }

  /**
   * 占位：对应 relayClaim 里的 key.pending++（发生在 await ensureNonce 之前）。
   * @param {string} keyId
   * @returns {number} 占位后的 pending
   */
  function retain(keyId) {
    const s = stateOf(keyId);
    s.pending += 1;
    return s.pending;
  }

  /**
   * 释放占位：对应 finally 里的 key.pending--。
   * 下溢抛错，保证 P3（pending 永不为负）不是靠调用方自觉。
   * @param {string} keyId
   * @returns {number} 释放后的 pending
   */
  function release(keyId) {
    const s = stateOf(keyId);
    if (s.pending <= 0) {
      const err = new Error(`nonce_queue_pending_underflow:${keyId}`);
      err.code = "nonce_queue_pending_underflow";
      throw err;
    }
    s.pending -= 1;
    return s.pending;
  }

  /**
   * 同步占号：读 nextNonce → 写回 nextNonce + 1，中间没有 await。
   * @param {string} keyId
   * @returns {bigint} 本次分配到的 nonce
   */
  function acquire(keyId) {
    const s = stateOf(keyId);
    if (s.nextNonce === null) {
      const err = new Error(`nonce_queue_uninitialized:${keyId}`);
      err.code = "nonce_queue_uninitialized";
      throw err;
    }
    const nonce = s.nextNonce;
    s.nextNonce = nonce + 1n;
    return nonce;
  }

  /** 标记该 key 需要回链对账（发送报 nonce/underpriced 错时调用）。 */
  function markResyncNeeded(keyId) {
    stateOf(keyId).resyncNeeded = true;
  }

  /** @param {string} keyId */
  function resyncNeededOf(keyId) {
    return stateOf(keyId).resyncNeeded;
  }

  /** 把任意 bigint/number/string 规整成 bigint；非法值抛 TypeError。 */
  function toBigInt(value) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`nonce_queue_bad_chain_nonce:${value}`);
      }
      return BigInt(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    throw new TypeError(`nonce_queue_bad_chain_nonce:${String(value)}`);
  }

  /**
   * 回链对账（对应 resyncNonce，链上值由调用方查好后传入）。
   *
   * @param {string} keyId
   * @param {bigint | number | string} chainNonce 链上 pending nonce
   * @param {boolean} [allowRollback] true=允许回退（失败后补空洞）；false=只许前进
   * @returns {{ applied: boolean, reason?: "pending", before: bigint | null, after: bigint | null, chainNonce: bigint }}
   */
  function resync(keyId, chainNonce, allowRollback = false) {
    const s = stateOf(keyId);
    const chain = toBigInt(chainNonce);
    if (s.pending > 0) {
      return { applied: false, reason: "pending", before: s.nextNonce, after: s.nextNonce, chainNonce: chain };
    }
    const before = s.nextNonce;
    const after =
      before === null ? chain : allowRollback ? chain : chain > before ? chain : before;
    if (after !== before) {
      s.nextNonce = after;
      log(`${keyId} nonce 对账：本地 ${before} → ${after}（链上 ${chain}）`);
    }
    if (allowRollback) s.resyncNeeded = false;
    return { applied: after !== before, before, after, chainNonce: chain };
  }

  /**
   * pending 计数：不传 keyId 返回全局总数，传了返回该 key 的数。
   * @param {string} [keyId]
   */
  function pendingCount(keyId) {
    if (keyId !== undefined) return stateOf(keyId).pending;
    let n = 0;
    for (const s of states.values()) n += s.pending;
    return n;
  }

  /**
   * 该 key 当前的下一个 nonce（未初始化返回 null）。
   * @param {string} keyId
   * @returns {bigint | null}
   */
  function nextNonceOf(keyId) {
    return stateOf(keyId).nextNonce;
  }

  return {
    ensure,
    retain,
    release,
    acquire,
    markResyncNeeded,
    resyncNeededOf,
    resync,
    pendingCount,
    nextNonceOf,
  };
}
