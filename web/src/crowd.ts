/**
 * K-crowd · 观众模拟器 —— 让大屏在演示时「真有人在打」
 *
 * 不是随机噪声点格子:每个虚拟玩家是一个有名字、有地盘、有脾气的人 ——
 *   · 中文昵称池(112 个,中英混排),阵营 mod 4 均匀分
 *   · 热区:每人一个圆心 + 半径,60% 的点击落在自己热区(领地感),40% 全图乱点(游客)
 *   · 节律:间隔均值 1.5-4s 指数分布(泊松流),有人快手有人佛系
 *   · 状态机:idle → burst(按住连点 3-7 下,间隔 150ms)→ cooldown(8-20s)→ idle
 *   · 反捣:自家格子被抢,热区覆盖到的同阵营观众会记住这个仇,
 *     下一次点击 60% 概率去抢回该格或它的邻格 —— 边界由此形成拉锯
 *   · mood 三档(calm/busy/rush):倍率作用在等待与冷却上,全场密度整体起伏;
 *     step 内部每 30-60s 自动换档,演示不需要人肉干预就有呼吸感
 *
 * 容量策略(主控 2026-11-21 调整):
 *   · 默认 3000 人(4 阵营 × 60);?crowd=N 可调(演示推荐 3000-8000),夹在 [10, 20000]
 *   · 人数越多单人热区半径按 sqrt 收缩,2 万人也不挤成一坨
 *
 * 热路径纪律(对齐 grid.ts):
 *   · mulberry32 决定论 PRNG:同 seed + 同 dt 序列 → 逐条一致的 claim 流(截图可复现)
 *   · step 不 new 大对象:玩家属性全 SoA 类型化数组;反捣邻域热度用 Int16Array 网格累加;
 *     claims 从 1024 容量的环形对象池取槽位
 *   · 返回数组是**复用缓冲**:调用方必须在下一次 step 前消费完(main.ts 的 for-of 即消费),
 *     跨帧留档需自行拷贝
 */

import { CELLS, SIDE } from "./grid";

/* ── 常量与纯工具(冻结在模块顶层,node 环境可 import)────────────── */

export type Mood = "calm" | "busy" | "rush";

export type CrowdClaim = { cell: number; faction: 1 | 2 | 3 | 4; nick: string };

export type CrowdStats = {
  total: number;
  active: number;
  byFaction: [number, number, number, number];
  /** 本会话最大活跃玩家数(截图标题用) */
  peakActive: number;
  /** 累计「瞄准复仇目标出手」的次数(反捣机制在工作的事实证据) */
  revengeActions: number;
};

export const CROWD_MIN = 10;
export const CROWD_MAX = 20000;
export const CROWD_DEFAULT = 3000;

/** mood → 间隔倍率:作用在 idle 等待与 burst 后冷却上(cooldown 也是「隔两次 burst 的间隔」) */
const MOOD_MUL: Record<Mood, number> = { calm: 2.2, busy: 1.0, rush: 0.45 };

/** burst 连点间隔(秒)—— 模拟「按住不放」 */
const BURST_GAP = 0.15;
/** 冷却区间(秒) */
const COOLDOWN_MIN = 3;
const COOLDOWN_SPAN = 4;
/** 最后一次点击在多少秒内算「活跃」 */
const ACTIVE_WINDOW = 10;
/** 环形 claim 池容量(单步不会超过玩家数;2 万人 × dt≤0.05 也小于它(超出部分视觉上丢弃)) */
const POOL_SIZE = 8192;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** mulberry32:32-bit 状态,一步一个乘加一个 imul —— grid.ts / effects.ts 同款 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * main.ts 用它读 `?crowd=N`。纯函数:接收 location.search 字符串,不碰 window,
 * 所以能在 node 环境(单测)里验证。无参数 / 非数字 → null(调用方用 CROWD_DEFAULT 兜底)。
 */
export function parseCrowdSize(search: string): number | null {
  if (!search) return null;
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("crowd");
  } catch {
    return null;
  }
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clamp(Math.round(n), CROWD_MIN, CROWD_MAX);
}

/* ── 昵称池:中英混排 112 个,以中文为主(真实观众群像)────────────── */

const NICKS: string[] = [
  "奶蛙", "阿润", "小满", "队长", "老K", "橘子海", "夜航星", "半夏",
  "青柠", "北望", "阿楚", "小七", "大熊", "云舒", "拾柒", "阿澈",
  "阿泰", "小刀", "阿苗", "阿松", "阿岚", "阿橙", "阿蕾", "阿吉",
  "星坠", "未名", "老周", "三斤", "墨鱼", "阿茶", "九命", "山竹",
  "冬瓜", "泡芙", "阿汤", "小舟", "看客", "阿豪", "大飞", "阿May",
  "路人乙", "隔壁老王", "阿宝", "雪碧", "小虎", "阿猛", "慢半拍", "阿贵",
  "Neo", "Max", "Lisa", "Alex", "YR", "Momo", "Ken", "Nina",
  "Eason", "Jay", "Kk", "Zed", "Luna", "Ray", "Iris", "Oz",
  "Kevin", "Amy", "Leo", "Ivy", "Sam", "Zoe", "Ryan", "Vera",
  "阿飞正传", "打酱油的", "吃瓜真人", "前排马扎", "夜猫子", "摸鱼大师",
  "充电中", "不想起名", "随便看看", "就点一下", "再来一格", "别抢我的",
  "守塔人", "拆迁办", "攻城狮", "画地图的", "圈地中", "钉子户",
  "Alpha", "Echo", "Delta", "Sierra", "Nova", "Pixel", "Turbo", "Quant",
  "阿伦", "表妹", "二叔", "隔壁阿珍", "大表哥", "小辣椒", "铁头娃", "卷心菜",
  "海王", "阿飘", "土拨鼠", "卡皮巴拉",
];

/* ── 状态机相位 ─────────────────────────────────────── */
const PH_IDLE = 0; // timer = 距下一次 burst 起跳
const PH_BURST = 1; // timer = 距下一次连点;clicks = 还剩几下
const PH_COOLDOWN = 2; // timer = 距回到 idle

/* ── Crowd ──────────────────────────────────────────── */

export class Crowd {
  /** 关掉后 setMood 就是绝对指令(单测用);默认 step 每 30-60s 自动换档 */
  autoMood = true;

  readonly size: number;
  private rnd: () => number;

  /* SoA 玩家属性 —— 构造期一次分配,step 只读只改,零扩容 */
  private nick: string[];
  private faction: Uint8Array; // 1..4
  private cx: Float32Array;
  private cy: Float32Array;
  private r2: Float32Array; // 热区半径平方
  private mu: Float32Array; // 泊松间隔均值(1.5-4s)
  private phase: Uint8Array;
  private timer: Float32Array;
  private clicks: Uint8Array;
  private revenge: Int16Array; // 复仇目标格,-1 = 无
  private lastSeen: Float64Array;

  /* 战场镜像 + 反捣热度扩散网格(Int16Array 累加,不 new) */
  private colors: Uint8Array;
  private aggro: Int16Array;

  /* 时钟与 mood */
  private time = 0;
  private mood: Mood = "busy";
  private nextMoodAt: number;
  private nextDecay = 0.6;
  private nextActiveAt = 0.5;
  private active = 0;
  private peakActive = 0;
  private revengeActions = 0;

  /* claim 环形对象池 + 本步输出缓冲(复用,不逐帧 new) */
  private pool: CrowdClaim[];
  private poolHead = 0;
  private out: CrowdClaim[] = [];
  private outLen = 0;

  constructor(size: number, seed?: number) {
    this.size = clamp(Math.round(Number.isFinite(size) ? size : CROWD_DEFAULT), CROWD_MIN, CROWD_MAX);
    // 不传 seed → 每次开屏都不同(现场不重样);传 seed → 完全决定论(复现截图)
    this.rnd = mulberry32(seed !== undefined ? seed >>> 0 : (Math.random() * 0xffffffff) >>> 0);
    const rnd = this.rnd;
    const n = this.size;

    this.nick = new Array<string>(n);
    this.faction = new Uint8Array(n);
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.r2 = new Float32Array(n);
    this.mu = new Float32Array(n);
    this.phase = new Uint8Array(n);
    this.timer = new Float32Array(n);
    this.clicks = new Uint8Array(n);
    this.revenge = new Int16Array(n).fill(-1);
    this.lastSeen = new Float64Array(n).fill(-1e6);

    this.colors = new Uint8Array(CELLS);
    this.aggro = new Int16Array(CELLS);

    this.pool = new Array<CrowdClaim>(POOL_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) this.pool[i] = { cell: 0, faction: 1, nick: "" };

    // 人越多热区越小:sqrt 收缩,240 → 4..9 格,1500 → 约 1.6..3.6 格(下限 1.5)
    const rScale = n > CROWD_DEFAULT ? Math.max(0.35, Math.sqrt(CROWD_DEFAULT / n)) : 1;

    const nickBase = (rnd() * NICKS.length) | 0;
    for (let i = 0; i < n; i++) {
      this.nick[i] = NICKS[(nickBase + i) % NICKS.length];
      this.faction[i] = 1 + (i & 3); // mod 4 均匀分阵营
      this.cx[i] = rnd() * SIDE;
      this.cy[i] = rnd() * SIDE;
      const rr = Math.max(1.5, (4 + rnd() * 5) * rScale); // 规格半径 4-9,随 N 收缩
      this.r2[i] = rr * rr;
      this.mu[i] = 1.5 + rnd() * 2.5; // 有人快有人慢
      // 开局:人人都在首轮连点里,起跳时刻打散(0.05-1.6s)——
      // 既避免 t=0 齐步走,又让开场几秒就有「观众入场即开抢」的密度
      this.phase[i] = PH_BURST;
      this.clicks[i] = 3 + ((rnd() * 5) | 0);
      this.timer[i] = 0.05 + rnd() * 1.55;
    }

    this.nextMoodAt = this.time + 30 + rnd() * 30;
  }

  get currentMood(): Mood {
    return this.mood;
  }

  /** 绝对指令:mood 影响所有「间隔」采样(含 burst 后冷却),画面密度整体升降 */
  setMood(mood: Mood): void {
    this.mood = MOOD_MUL[mood] === undefined ? "busy" : mood;
    this.nextMoodAt = this.time + 30 + this.rnd() * 30;
  }

  stats(): CrowdStats {
    const byF: [number, number, number, number] = [0, 0, 0, 0];
    let active = 0;
    for (let p = 0; p < this.size; p++) {
      if (this.time - this.lastSeen[p] <= ACTIVE_WINDOW) {
        active++;
        byF[this.faction[p] - 1]++;
      }
    }
    this.active = active;
    if (active > this.peakActive) this.peakActive = active;
    return {
      total: this.size,
      active,
      byFaction: byF,
      peakActive: this.peakActive,
      revengeActions: this.revengeActions,
    };
  }

  /**
   * 推进 dt 秒。返回本步所有要 paint 的 claim(写入外部 GridState 由调用方负责)。
   * 返回的数组与其中的对象都是复用缓冲 —— 下一次 step 前消费完。
   */
  step(dt: number): CrowdClaim[] {
    if (!(dt > 0)) {
      this.out.length = 0;
      this.outLen = 0;
      return this.out;
    }
    this.time += dt;
    const moodMul = MOOD_MUL[this.mood];

    if (this.autoMood && this.time >= this.nextMoodAt) {
      const r = this.rnd();
      this.mood = r < 0.3 ? "calm" : r < 0.75 ? "busy" : "rush";
      this.nextMoodAt = this.time + 30 + this.rnd() * 30;
    }
    if (this.time >= this.nextDecay) {
      // 争执热度衰减:每 0.6s 收一半,复仇热点不会永久发光
      const ag = this.aggro;
      for (let i = 0; i < CELLS; i++) {
        const v = ag[i];
        if (v > 0) ag[i] = (v * 0.5) | 0;
      }
      this.nextDecay = this.time + 0.6;
    }
    if (this.time >= this.nextActiveAt) {
      let a = 0;
      for (let p = 0; p < this.size; p++) {
        if (this.time - this.lastSeen[p] <= ACTIVE_WINDOW) a++;
      }
      this.active = a;
      if (a > this.peakActive) this.peakActive = a;
      this.nextActiveAt = this.time + 0.5;
    }

    this.outLen = 0;
    const n = this.size;
    for (let p = 0; p < n; p++) {
      let t = this.timer[p] - dt;
      if (t > 0) {
        this.timer[p] = t;
        continue;
      }
      const ph = this.phase[p];
      if (ph === PH_IDLE) {
        // 等待到点 → 起手一轮连点
        this.phase[p] = PH_BURST;
        this.clicks[p] = 3 + ((this.rnd() * 5) | 0);
        this.emit(p);
        t = BURST_GAP;
        if (--this.clicks[p] <= 0) {
          // 单下也算一轮(3 起)不会走到这;防御
          this.phase[p] = PH_COOLDOWN;
          t = (COOLDOWN_MIN + this.rnd() * COOLDOWN_SPAN) * moodMul;
        }
        this.timer[p] = t;
        continue;
      }
      if (ph === PH_BURST) {
        this.emit(p);
        t = BURST_GAP;
        if (--this.clicks[p] <= 0) {
          this.phase[p] = PH_COOLDOWN;
          t = (COOLDOWN_MIN + this.rnd() * COOLDOWN_SPAN) * moodMul;
        }
        this.timer[p] = t;
        continue;
      }
      // PH_COOLDOWN 到点 → 回到「看戏等待」
      this.phase[p] = PH_IDLE;
      this.timer[p] = this.expo(this.mu[p] * moodMul);
    }
    this.out.length = this.outLen;
    return this.out;
  }

  /* ── 内部 ─────────────────────────────────────────── */

  /** 指数分布采样(泊松过程的到达间隔),下限 0.05s 防退化 */
  private expo(mean: number): number {
    const u = this.rnd();
    const v = -Math.log(1 - u * 0.999999) * mean;
    return v < 0.05 ? 0.05 : v;
  }

  /** 玩家 p 出手:选格 → 记账 → 写进环形池 */
  private emit(p: number): void {
    const cell = this.pickCell(p);
    const f = this.faction[p] as 1 | 2 | 3 | 4;
    this.lastSeen[p] = this.time;
    this.onClaim(cell, f);

    const slot = this.pool[this.poolHead];
    this.poolHead = (this.poolHead + 1) & (POOL_SIZE - 1);
    slot.cell = cell;
    slot.faction = f;
    slot.nick = this.nick[p];
    const w = this.outLen++;
    if (w < this.out.length) this.out[w] = slot;
    else this.out.push(slot);
  }

  /** 选落子格:复仇瞄准 60% → 热区(争执热点优先)→ 全图随机 */
  private pickCell(p: number): number {
    const rnd = this.rnd;
    const rv = this.revenge[p];
    if (rv >= 0) {
      this.revenge[p] = -1;
      if (rnd() < 0.6) {
        this.revengeActions++;
        if (rnd() < 0.5) return rv; // 抢回本尊
        // 抢邻格(围而不破,像真人)
        const tx = rv % SIDE;
        const ty = (rv / SIDE) | 0;
        const d = (rnd() * 4) | 0;
        let nx = tx + (d === 0 ? -1 : d === 1 ? 1 : 0);
        let ny = ty + (d === 2 ? -1 : d === 3 ? 1 : 0);
        if (nx < 0) nx = 0;
        else if (nx >= SIDE) nx = SIDE - 1;
        if (ny < 0) ny = 0;
        else if (ny >= SIDE) ny = SIDE - 1;
        return ny * SIDE + nx;
      }
    }
    if (rnd() < 0.6) {
      // 热区 60%:圆内采 3 个点,落「争执热度」最高的那个 ——
      // 于是人群自动涌向被反复易主的边界,这就是「拉锯」的画法
      const cx = this.cx[p];
      const cy = this.cy[p];
      const rad = Math.sqrt(this.r2[p]);
      let best = -1;
      let bestScore = 0;
      for (let k = 0; k < 3; k++) {
        const a = rnd() * 6.283185307;
        const rr = rad * Math.sqrt(rnd());
        const x = Math.round(cx + rr * Math.cos(a));
        const y = Math.round(cy + rr * Math.sin(a));
        if (x < 0 || x >= SIDE || y < 0 || y >= SIDE) continue;
        const c = y * SIDE + x;
        const score = this.aggro[c];
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best >= 0) return best;
      // 3 个点都出界(热区圆心贴边时偶发):圆内重试一次,再不行落到圆心格
      const a2 = rnd() * 6.283185307;
      const x2 = Math.round(cx + rad * 0.5 * Math.cos(a2));
      const y2 = Math.round(cy + rad * 0.5 * Math.sin(a2));
      if (x2 >= 0 && x2 < SIDE && y2 >= 0 && y2 < SIDE) return y2 * SIDE + x2;
      const cxx = clamp(Math.round(cx), 0, SIDE - 1);
      const cyy = clamp(Math.round(cy), 0, SIDE - 1);
      return cyy * SIDE + cxx;
    }
    // 40% 游客行为:全图均匀随机
    return (rnd() * CELLS) | 0;
  }

  /**
   * 落子后记账(grid.ts apply 之前,由 Crowd 自己维护镜像):
   *   · 本方视角:该格 + 4 邻域争执热度累加(Int16Array,封顶防爆)
   *   · 敌方视角:若这格原来属于别的阵营,热区覆盖它的该阵营玩家按概率记仇
   */
  private onClaim(cell: number, f: number): void {
    this.addAggro(cell, 6);
    const x = cell % SIDE;
    const y = (cell / SIDE) | 0;
    if (x > 0) this.addAggro(cell - 1, 3);
    if (x < SIDE - 1) this.addAggro(cell + 1, 3);
    if (y > 0) this.addAggro(cell - SIDE, 3);
    if (y < SIDE - 1) this.addAggro(cell + SIDE, 3);

    const prev = this.colors[cell];
    this.colors[cell] = f;
    if (prev === 0 || prev === f) return;

    // 被抢的阵营里,热区盖住这格的人开始磨牙
    const rnd = this.rnd;
    const start = prev - 1; // faction = 1 + (i & 3) → i ≡ prev-1 (mod 4)
    for (let p = start; p < this.size; p += 4) {
      if (this.revenge[p] >= 0) continue; // 已经有仇了,别叠
      const dx = x - this.cx[p];
      const dy = y - this.cy[p];
      if (dx * dx + dy * dy > this.r2[p]) continue;
      if (rnd() < 0.4) this.revenge[p] = cell;
    }
  }

  private addAggro(cell: number, add: number): void {
    const v = this.aggro[cell] + add;
    this.aggro[cell] = v > 800 ? 800 : v;
  }
}
