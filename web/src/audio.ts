/**
 * 把吞吐变成声音 —— 不是「随机音符」，而是**现场氛围音乐**：
 * 观众在嘈杂展馆里应该能凭声音判断「链现在多忙」，甚至凭声像找到格子。
 *
 * 母带链：
 *   voices/pads/bed/sweep → master(≤0.8) → wall(静默墙衰减) → DynamicsCompressor → destination
 *   另有一路 convolver（程序化 IR）做全局小混响，voice 按格子 y 坐标微送。
 *
 * 音乐层：
 *   · 环境床 bed：60–90 Hz 噪声带通 + 0.06Hz LFO 游走，TPS 越低越明显 ——
 *     安静时「链还在跳」的体感来自它，高负载时它主动让位；
 *   · 和声 pad：双 pad 轮转，每次转调做 4 秒 crossfade（I–vi–IV–V 循环不变，
 *     但周期随机 22–38s，听众抓不到节点）；
 *   · 声部 = 阵营：紫/青走 Dorian（根音 F4 / C5），琥珀/绯走 Aeolian（根音 A3 / D3），
 *     阵营对位时调式天然擦出火药味，同阵营内永远和谐；
 *   · note 包络 FM 化：carrier + 2 modulator（频率比 1 : 0.5 : 0.2），
 *     attack 8ms release ~280ms，短促带铃感，不抢主循环；
 *   · 能量档位（由 TPS）：0 安静实验室 → 1 五声流动 → 2 FM 加密混响加深 → 3
 *     和声墙 + 300→3000Hz 噪声 sweep「满载」。切档一律 2s 级 ramp，不硬切。
 *
 * 性能与健壮性：
 *   · 稳态持久节点 ≈ 34；note 走「令牌桶(4/11/14/14 每秒) + 硬并发闸 MAX_VOICES=5」
 *     双保险，note voice 最多 7~8 节点 → 稳态 < 80；
 *   · stinger 是秒级瞬态，豁免并发闸（满载齐鸣一次 ≈ +22 节点，1.6s 内全部释放）；
 *   · 混响送出不建 per-voice 节点：全体 voice 共享一条 revSend → convolver 总线，
 *     行 y 用阈值决定是否入送（零成本拿到「上排格子回声更明显」）；
 *   · 所有 voice 用完 stop+disconnect（onended 在 stop 之前挂好，防合成事件时序陷阱），
 *     长局不泄漏；
 *   · 所有公开方法吞掉一切异常 —— audio 挂了，画面必须继续。
 */

const SIDE = 50;

/** master 增益上限（规格要求 ≤ 0.8） */
const MASTER_MAX = 0.8;

/* ────────────────────────── 乐理表（导出给单测钉契约） ────────────────────────── */

/** Dorian 调式（比 Aeolian 亮 1 音：6 级还原）—— 紫 / 青 */
export const DORIAN: readonly number[] = [0, 2, 3, 5, 7, 9, 10];
/** Aeolian（自然小调）—— 琥珀 / 绯 */
export const AEOLIAN: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

/** 阵营根音（Hz）：紫 F4 · 青 C5 · 琥珀 A3 · 绯 D3 */
export function rootHzForColor(color: number): number {
  switch (Number.isFinite(color) ? Math.floor(color) : 1) {
    case 2:
      return 523.25; // C5
    case 3:
      return 220.0; // A3
    case 4:
      return 146.83; // D3
    default:
      return 349.23; // F4
  }
}

/** 阵营 → 调式：1/2 Dorian，3/4 Aeolian（未知阵营兜底 Dorian） */
export function scaleForColor(color: number): readonly number[] {
  const c = Number.isFinite(color) ? Math.floor(color) : 1;
  return c === 3 || c === 4 ? AEOLIAN : DORIAN;
}

/** 格子 x 列 → 立体声声像：0 → -0.8，24.5 → 0，49 → +0.8（视觉听觉空间一致） */
export function panForCol(col: number): number {
  if (!Number.isFinite(col)) return 0;
  const c = clamp(col, 0, SIDE - 1);
  return (c / (SIDE - 1) - 0.5) * 1.6;
}

/** 格子 y 行 → 混响送出量：越靠上的行回声越明显（0.06 → 0.18，「微微」级） */
export function noteSendForRow(row: number): number {
  if (!Number.isFinite(row)) return 0.06;
  return 0.06 + (clamp(row, 0, SIDE - 1) / (SIDE - 1)) * 0.12;
}

/** TPS → 能量档位：0 实验室 / 1 流动 / 2 加密 / 3 满载 */
export function tierForTps(tps: number): 0 | 1 | 2 | 3 {
  if (Number.isNaN(tps)) return 0;
  if (tps < 5) return 0;
  if (tps < 30) return 1;
  if (tps < 60) return 2;
  return 3;
}

/* ────────────────────────────── 声部 / 和声表 ────────────────────────────── */

/** 限流：按档位给不同平均速率，允许 4 个瞬时突发（FM voice 节点贵，压并发） */
const NOTE_RATE_BY_TIER = [4, 11, 14, 14];
const NOTE_BURST = 4;
/** 硬并发闸：同时在飞的 note voice 上限（stinger 豁免），稳态节点预算的依据 */
export const MAX_VOICES = 5;
/** 行号 → 混响送出的阈值：y 越大越先进入 reverb 总线 */
const SEND_ROW_MIN = 0.12;

/** FM 铃感的出现概率随档位上升（「30-60 FM bell 加密」） */
const FM_BELL_P = [0.3, 0.5, 0.8, 1];

/** 和声 pad 的驻留时长：随机 22–38s，打破 30s 的规律感 */
const CHORD_DUR_MIN = 22;
const CHORD_DUR_MAX = 38;
/** crossfade 时间常数：τ×3.5 ≈ 4s 后旧 pad 只剩 ~2%，听不出切点 */
const CHORD_XFADE_TAU = 1.15;

/**
 * I–vi–IV–V（C 大调骨架）：根音 / 五度 / 三度，Hz。
 * 和声墙在低八度提供空间感，旋律音阶走各阵营调式，互不踩脚。
 */
const CHORDS = [
  { root: 65.41, fifth: 98.0, third: 164.81 }, // I   C2 · G2 · E3
  { root: 110.0, fifth: 164.81, third: 261.63 }, // vi  A2 · E3 · C4
  { root: 87.31, fifth: 130.81, third: 220.0 }, // IV  F2 · C3 · A3
  /* V 的三音用 D4 而不是 B3：B3 会和 C 形成长期拍音，听感像「音准坏了」。 */
  { root: 98.0, fifth: 146.83, third: 293.66 }, // V   G2 · D3 · D4
];

/**
 * 阵营 → 声部。根音见 rootHzForColor；波形与滤波沿用 v1 的辨识度：
 *   1 紫  triangle  F4  Dorian
 *   2 青  sine      C5  Dorian
 *   3 琥珀 square   A3  Aeolian（低通 1.8k 压方波毛刺）
 *   4 绯  sawtooth  D3  Aeolian（低通 520Hz，厚而不炸）
 */
type VoiceSpec = {
  type: OscillatorType;
  offset: number;
  peak: number;
  decay: number;
  cutoff?: number;
  q?: number;
};

const VOICES: Record<number, VoiceSpec> = {
  1: { type: "triangle", offset: 0, peak: 0.052, decay: 0.3 },
  2: { type: "sine", offset: 2, peak: 0.046, decay: 0.26 },
  3: { type: "square", offset: 1, peak: 0.026, decay: 0.24, cutoff: 1800, q: 0.5 },
  4: { type: "sawtooth", offset: 4, peak: 0.055, decay: 0.32, cutoff: 520, q: 0.9 },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function randChordDur(): number {
  return CHORD_DUR_MIN + Math.random() * (CHORD_DUR_MAX - CHORD_DUR_MIN);
}

type ToneOpts = {
  type: OscillatorType;
  freq: number;
  at: number;
  attack: number;
  hold?: number;
  decay: number;
  peak: number;
  cutoff?: number;
  cutoffEnd?: number;
  q?: number;
  pan?: number;
  detune?: number;
  glideTo?: number;
  glideTime?: number;
  /** FM 铃感：carrier + 2 modulator（1 : 0.5 : 0.2），音头 8ms 内亮一下就收 */
  fm?: boolean;
  /** → convolver 的混响送出（0..0.3） */
  send?: number;
};

/** 一个和声层：3 支振荡器 → 各自增益 → out（crossfade 用）→ padBus */
type Pad = {
  out: GainNode;
  root: OscillatorNode;
  fifth: OscillatorNode;
  third: OscillatorNode;
  fifthGain: GainNode;
  thirdGain: GainNode;
};

export class BattleAudio {
  ready = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wall: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;

  /* 混响：程序化 IR（2s 指数衰减噪声 + 30Hz 高切）+ 共享送出总线 */
  private convolver: ConvolverNode | null = null;
  private revSend: GainNode | null = null;
  private revWet: GainNode | null = null;

  /* 环境床 */
  private bedSrc: AudioBufferSourceNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedGain: GainNode | null = null;
  private bedLfo: OscillatorNode | null = null;
  private bedLfoGain: GainNode | null = null;

  /* 满载噪声 sweep */
  private sweepSrc: AudioBufferSourceNode | null = null;
  private sweepFilter: BiquadFilterNode | null = null;
  private sweepGain: GainNode | null = null;
  private sweepLfo: OscillatorNode | null = null;
  private sweepLfoGain: GainNode | null = null;

  /* 和声 pad（双缓冲 crossfade） */
  private padBus: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private padA: Pad | null = null;
  private padB: Pad | null = null;
  private padActive: 0 | 1 = 0;
  private shimmer: OscillatorNode | null = null;
  private shimmerGain: GainNode | null = null;

  /** 白噪声缓冲：bed / sweep / burst 冲击共用，省内存 */
  private noiseBuffer: AudioBuffer | null = null;

  private muted = false;
  private enabling: Promise<boolean> | null = null;

  /* 限流状态 */
  private tokens = NOTE_BURST;
  private tokenAt = 0;
  private voiceCursor = 0;
  private noteRate = NOTE_RATE_BY_TIER[1];
  /** 在飞 note voice 数（onended 归还）；并发闸，stinger 不计 */
  private activeVoices = 0;

  /* 能量状态 */
  private density = 0; // 0..1，由 TPS 平滑而来
  private energy = 0; // 0..1，由 claim 热度推高，自行衰减
  private tps = 0; // 原始 TPS，决定 bed / sweep / 档位
  private tier: 0 | 1 | 2 | 3 = 1;
  private lastDroneAt = 0;
  private lastDroneGainAt = 0;
  private chordIndex = 0;
  private chordAt = 0;
  private chordDur = randChordDur();

  /* stinger 冷却 */
  private lastCaptureAt = -Infinity;
  private lastStingerAt = -Infinity;

  /* end 之后的 drone 退场（到时自动回弹，不会把下一局永久静音） */
  private duckUntil = 0;

  /* 浏览器挂起后的恢复节流 */
  private lastResumeAt = -Infinity;

  constructor() {
    try {
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", this.onVisibility);
      }
    } catch {
      /* 连监听失败都不许影响调用方 */
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 必须在用户手势里调用；永远不抛错，失败返回 false */
  async enable(): Promise<boolean> {
    if (this.enabling) return this.enabling;
    const p = this.build();
    this.enabling = p;
    try {
      return await p;
    } catch {
      this.ready = false;
      return false;
    } finally {
      this.enabling = null;
    }
  }

  /** 返回「现在是否出声」 */
  toggle(): boolean {
    try {
      const ctx = this.ctx;
      const master = this.master;
      if (!ctx || !master || ctx.state === "closed") {
        this.ready = false;
        this.muted = true;
        return false;
      }

      this.muted = !this.muted;
      if (!this.muted && ctx.state === "suspended") {
        try {
          void ctx.resume().catch(() => {});
        } catch {
          /* ignore */
        }
      }

      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(this.muted ? 0 : MASTER_MAX, now, 0.08);
      return !this.muted;
    } catch {
      return false;
    }
  }

  /**
   * 绝对静音/解除（v3「静默墙」用）。
   * 与 toggle 的区别：它不多不少地设到目标值，不翻转当前状态 ——
   * 静默墙结束时必须精确回到之前的音量，而不是再翻一次。
   */
  setMuted(m: boolean): boolean {
    try {
      const ctx = this.ctx;
      const master = this.master;
      if (!ctx || !master || ctx.state === "closed") return false;
      this.muted = m;
      if (!m && ctx.state === "suspended") {
        try {
          void ctx.resume().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(m ? 0 : MASTER_MAX, now, 0.08);
      return !m;
    } catch {
      return false;
    }
  }

  /**
   * 静默墙进度 0..1：倒数开始时以 0 接入，随倒数递增到 1，
   * 整段声音被压到无声；倒数结束（burst 或取消）时复位到 0。
   * 与 setMuted 独立：这是「渐弱曲线」，那是「开关」。
   */
  setSilenceWallProgress(p: number): void {
    try {
      const ctx = this.ctx;
      const wall = this.wall;
      if (!ctx || !wall) return;
      const now = ctx.currentTime;
      const t = Number.isFinite(p) ? clamp(p, 0, 1) : 0;
      wall.gain.cancelScheduledValues(now);
      /* τ≈0.4s：倒数每 100ms 喂一次进度，听感就是连续渐弱而非台阶 */
      wall.gain.setTargetAtTime(Math.max(0.0001, 1 - t), now, 0.4);
    } catch {
      /* ignore */
    }
  }

  /**
   * 一笔交易 → 一个音符。
   * color 为 1..4；旧的两参调用会传 undefined，按紫方（1）兜底。
   * 声像 = 列 x（左屏左响），FM 铃感随档位加密，混响送出随行 y 微增。
   */
  note(id: number, heat: number, color = 1): void {
    try {
      const ctx = this.ctx;
      const master = this.master;
      if (!ctx || !master || !this.ready || this.muted) return;
      if (!this.ensureAlive(ctx)) return;
      if (ctx.state !== "running") {
        this.tryResume(ctx);
        return;
      }

      const now = ctx.currentTime;
      this.maybeAdvanceChord(now, ctx);

      const h = clamp(Number.isFinite(heat) ? heat : 0, 0, 64);
      const c = Number.isFinite(color) && color >= 1 && color <= 4 ? Math.floor(color) : 1;

      /* 限流双闸：并发满了或令牌不足 → 只推 drone 不发声 */
      if (this.activeVoices >= MAX_VOICES || !this.takeToken(now)) {
        this.bumpEnergy(0.01 + Math.min(h, 32) * 0.0008);
        this.applyAmbience(now, ctx);
        return;
      }

      const n = Number.isFinite(id) ? Math.floor(id) : 0;
      const col = ((n % SIDE) + SIDE) % SIDE;
      const row = ((Math.floor(n / SIDE) % SIDE) + SIDE) % SIDE;

      const voice = VOICES[c] ?? VOICES[1];
      const scale = scaleForColor(c);
      /* 列 × 2 mod 7：相邻列取到不同音级；隔行抬高纯五度 */
      const step = (col * 2 + voice.offset) % scale.length;
      const semis = scale[step] + (((row >> 1) & 1) === 1 ? 7 : 0);
      const freq = rootHzForColor(c) * Math.pow(2, semis / 12);
      const hNorm = Math.min(h, 32) / 32;

      /* 突发时按 ~25/s 摊开，避免同一帧的几十笔叠成一个和弦 */
      if (this.voiceCursor < now) this.voiceCursor = now;
      if (this.voiceCursor > now + 0.5) this.voiceCursor = now + 0.5;
      const at = this.voiceCursor + Math.random() * 0.012;
      this.voiceCursor = at + 0.038;

      const fm = Math.random() < FM_BELL_P[this.tier];
      this.spawnTone(ctx, master, {
        type: voice.type,
        freq,
        at,
        attack: 0.008,
        hold: 0.012,
        decay: voice.decay,
        peak: voice.peak * (0.72 + hNorm * 0.55),
        cutoff: voice.cutoff ? voice.cutoff * (0.65 + hNorm * 0.95) : undefined,
        q: voice.q,
        pan: clamp(panForCol(col) + (Math.random() - 0.5) * 0.08, -0.92, 0.92),
        detune: (Math.random() - 0.5) * 10,
        fm,
        /* 上排行微微入送（走共享 revSend 总线，不建 per-voice 送节点） */
        send: noteSendForRow(row) >= SEND_ROW_MIN ? noteSendForRow(row) : 0,
      });

      this.bumpEnergy(0.018 + hNorm * 0.016);
      this.applyAmbience(now, ctx);
    } catch {
      /* audio 绝不把异常抛回主循环 */
    }
  }

  /** 用 TPS 驱动档位：bed / pad / 混响 / sweep / 限流速率，2s 级 ramp */
  setDensity(tps: number): void {
    try {
      const ctx = this.ctx;
      if (!ctx) return;
      if (!this.ensureAlive(ctx)) return;
      const t = Number.isFinite(tps) ? clamp(tps, 0, 240) : 0;
      this.tps = t;
      this.density = t / 80;
      this.tier = tierForTps(t);
      this.noteRate = NOTE_RATE_BY_TIER[this.tier];
      const now = ctx.currentTime;
      this.maybeAdvanceChord(now, ctx);
      this.applyAmbience(now, ctx);
    } catch {
      /* ignore */
    }
  }

  /** capture：上行三连音 / start：低沉扫频 + 8 音 arpeggio / end：下行收尾 / burst：齐鸣+冲击 */
  stinger(kind: "capture" | "start" | "end" | "burst"): void {
    try {
      const ctx = this.ctx;
      const master = this.master;
      if (!ctx || !master || !this.ready || this.muted) return;
      if (!this.ensureAlive(ctx)) return;
      if (ctx.state !== "running") {
        this.tryResume(ctx);
        return;
      }

      const now = ctx.currentTime;
      if (now - this.lastStingerAt < 0.1) return;
      this.lastStingerAt = now;

      if (kind === "capture") {
        /* 占领：C5 → Eb5 → G5 短促上行三连音（小三和弦，Dorian/Aeolian 双轨通吃） */
        if (now - this.lastCaptureAt < 1.0) return; // 防止每次 claim 都炸一遍
        this.lastCaptureAt = now;
        const triplet = [523.25, 622.25, 783.99];
        for (let i = 0; i < triplet.length; i++) {
          this.spawnTone(ctx, master, {
            type: "triangle",
            freq: triplet[i],
            at: now + i * 0.07,
            attack: 0.004,
            hold: 0.01,
            decay: 0.2,
            peak: 0.085,
            pan: -0.18 + i * 0.18,
            detune: (Math.random() - 0.5) * 6,
            send: 0.1,
          });
        }
        this.bumpEnergy(0.12);
        this.applyAmbience(now, ctx);
        return;
      }

      if (kind === "start") {
        /* 开场：36 → 130.8Hz 低沉扫频打底 */
        this.spawnTone(ctx, master, {
          type: "triangle",
          freq: 36,
          glideTo: 130.81,
          glideTime: 1.5,
          at: now,
          attack: 0.12,
          hold: 0.35,
          decay: 1.1,
          peak: 0.12,
          cutoff: 300,
          cutoffEnd: 1200,
          q: 0.8,
          pan: -0.05,
        });
        this.spawnTone(ctx, master, {
          type: "sine",
          freq: 65.41,
          glideTo: 130.81,
          glideTime: 1.6,
          at: now,
          attack: 0.18,
          hold: 0.3,
          decay: 1.0,
          peak: 0.06,
          pan: 0.05,
        });
        /* F Dorian 上行 8 音 arpeggio F4→C6，从左到右扫过全场 */
        const arp = [349.23, 392.0, 466.16, 523.25, 587.33, 698.46, 830.61, 1046.5];
        for (let i = 0; i < arp.length; i++) {
          this.spawnTone(ctx, master, {
            type: "triangle",
            freq: arp[i],
            at: now + 0.12 + i * 0.065,
            attack: 0.006,
            hold: 0.01,
            decay: 0.26,
            peak: 0.075,
            pan: clamp(-0.7 + (i / (arp.length - 1)) * 1.4, -0.92, 0.92),
            fm: true,
            send: 0.12,
          });
        }
        /* 回到 I 级，准备开场 */
        this.resetChord(now, ctx, 0);
        this.duckUntil = 0;
        this.bumpEnergy(0.3);
        this.applyAmbience(now, ctx);
        return;
      }

      if (kind === "burst") {
        /* v3「静默墙」落点：C2 三层齐鸣 + 高八度闪音 + 600ms 白噪冲击 + 身体感 sub drop。
         * 全场唯一一次炸开，同时把静默墙衰减复位（防止倒数残值把齐鸣吞了）。 */
        if (this.wall) {
          try {
            this.wall.gain.cancelScheduledValues(now);
            this.wall.gain.setTargetAtTime(1, now, 0.05);
          } catch {
            /* ignore */
          }
        }
        const chord = [65.41, 98.0, 130.81];
        for (let i = 0; i < chord.length; i++) {
          this.spawnTone(ctx, master, {
            type: "triangle",
            freq: chord[i],
            at: now + i * 0.02,
            attack: 0.02,
            hold: 0.06,
            decay: 1.6,
            peak: 0.13,
            cutoff: 2600,
            pan: -0.25 + i * 0.25,
            detune: (Math.random() - 0.5) * 8,
            send: 0.12,
          });
        }
        this.spawnTone(ctx, master, {
          type: "sine",
          freq: 261.63,
          glideTo: 1046.5,
          glideTime: 0.05,
          at: now,
          attack: 0.004,
          hold: 0.02,
          decay: 0.7,
          peak: 0.08,
          pan: 0,
          send: 0.15,
        });
        /* 600ms 白噪声冲击：开满高频再塌下来，「砰」的那一下 */
        this.spawnNoiseHit(ctx, master, now, 0.6, 0.13, 6500, 0.18);
        /* sub drop 80 → 40Hz：音量压在限流阈值下，让胸腔而不是耳朵听见 */
        this.spawnTone(ctx, master, {
          type: "sine",
          freq: 80,
          glideTo: 40,
          glideTime: 0.85,
          at: now,
          attack: 0.006,
          hold: 0.05,
          decay: 1.0,
          peak: 0.155,
          cutoff: 220,
          pan: 0,
          send: 0.06,
        });
        this.bumpEnergy(0.45);
        this.applyAmbience(now, ctx);
        return;
      }

      /* end：C5 → C3 下行收尾，低音同步落到 C2 */
      this.spawnTone(ctx, master, {
        type: "triangle",
        freq: 523.25,
        glideTo: 130.81,
        glideTime: 1.7,
        at: now,
        attack: 0.01,
        hold: 0.08,
        decay: 1.5,
        peak: 0.09,
        cutoff: 2400,
        cutoffEnd: 320,
        q: 0.7,
        pan: 0.06,
        send: 0.15,
      });
      this.spawnTone(ctx, master, {
        type: "sine",
        freq: 261.63,
        glideTo: 55,
        glideTime: 1.8,
        at: now + 0.05,
        attack: 0.02,
        hold: 0.1,
        decay: 1.4,
        peak: 0.07,
        pan: -0.06,
        send: 0.12,
      });
      /* end：drone 跟着退场 3 秒，尾音落定后自动回弹（下一局不用手动恢复） */
      this.duckUntil = now + 3;
      this.bumpEnergy(0.15);
      this.applyAmbience(now, ctx);
    } catch {
      /* ignore */
    }
  }

  /* ── 内部实现 ─────────────────────────────────────── */

  private onVisibility = (): void => {
    try {
      if (typeof document !== "undefined" && document.visibilityState === "visible" && this.ctx) {
        this.tryResume(this.ctx);
      }
    } catch {
      /* ignore */
    }
  };

  private async build(): Promise<boolean> {
    try {
      if (typeof window === "undefined") return false;
      const w = window as unknown as {
        AudioContext?: new () => AudioContext;
        webkitAudioContext?: new () => AudioContext;
      };
      const Ctx = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) return false;

      let ctx = this.ctx;
      if (ctx && ctx.state === "closed") {
        this.disposeGraph();
        this.ctx = null;
        ctx = null;
      }

      if (!ctx) {
        ctx = new Ctx();
        this.ctx = ctx;
        try {
          this.wire(ctx);
        } catch {
          this.disposeGraph();
          try {
            void ctx.close();
          } catch {
            /* ignore */
          }
          this.ctx = null;
          this.ready = false;
          return false;
        }
        this.tokens = NOTE_BURST;
        this.tokenAt = ctx.currentTime;
        this.voiceCursor = ctx.currentTime;
        this.lastDroneAt = ctx.currentTime;
        this.lastDroneGainAt = 0;
        this.chordIndex = 0;
        this.chordAt = ctx.currentTime;
        this.chordDur = randChordDur();
        this.padActive = 0;
        this.duckUntil = 0;
        this.energy = 0;
        this.activeVoices = 0;
      }

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      this.ready = true;
      this.muted = false;
      const now = ctx.currentTime;
      if (this.master) {
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(MASTER_MAX, now, 0.12);
      }
      if (this.wall) {
        try {
          this.wall.gain.cancelScheduledValues(now);
          this.wall.gain.setTargetAtTime(1, now, 0.05);
        } catch {
          /* ignore */
        }
      }
      this.applyAmbience(now, ctx);
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  /** 建立母带链、混响、bed、sweep 与双 pad。任何一步失败都由 build 负责回收 */
  private wire(ctx: AudioContext): void {
    /* master ≤ 0.8 → wall（静默墙渐弱）→ DynamicsCompressor（防削波）→ destination */
    const master = ctx.createGain();
    master.gain.value = 0;

    const wall = ctx.createGain();
    wall.gain.value = 1;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; // 只压峰，不压正常动态
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;

    master.connect(wall);
    wall.connect(limiter);
    limiter.connect(ctx.destination);

    /* 共用白噪声源缓冲（2 秒，够 bed/sweep 循环不出重复感） */
    const noiseBuffer = this.makeNoiseBuffer(ctx, 2);
    this.noiseBuffer = noiseBuffer;

    /* 小混响：程序化 IR（2s 指数衰减 + 30Hz 高切）。
     * voice 全部只连 revSend 这一条总线（零 per-voice 送节点），
     * wet 深度由档位调 0.12–0.22。 */
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx, 2);
    const revSend = ctx.createGain();
    revSend.gain.value = 1;
    const revWet = ctx.createGain();
    revWet.gain.value = 0.12;
    revSend.connect(convolver);
    convolver.connect(revWet);
    revWet.connect(master);

    /* 和声墙总线：低通 → master */
    const padBus = ctx.createGain();
    padBus.gain.value = 0;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 260;
    padFilter.Q.value = 0.6;
    padBus.connect(padFilter);
    padFilter.connect(master);

    const makePad = (chord: (typeof CHORDS)[number], active: boolean): Pad => {
      const out = ctx.createGain();
      out.gain.value = active ? 1 : 0;
      out.connect(padBus);

      const mk = (type: OscillatorType, hz: number, gainValue: number, detune: number) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = hz;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = gainValue;
        osc.connect(g);
        g.connect(out);
        osc.start();
        return { osc, gain: g };
      };
      const root = mk("triangle", chord.root, 0.7, -4);
      const fifth = mk("sine", chord.fifth, 0.42, 3);
      const third = mk("sine", chord.third, 0.1, -2);
      return { out, root: root.osc, fifth: fifth.osc, third: third.osc, fifthGain: fifth.gain, thirdGain: third.gain };
    };

    const padA = makePad(CHORDS[0], true);
    const padB = makePad(CHORDS[0], false);

    /* 高八度泛音层：跟单 pad 走，不占 crossfade（音量小，滑音听不出切点） */
    const shimmer = ctx.createOscillator();
    shimmer.type = "triangle";
    shimmer.frequency.value = CHORDS[0].root * 2;
    shimmer.detune.value = 9;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0;
    shimmer.connect(shimmerGain);
    shimmerGain.connect(padBus);
    shimmer.start();

    /* 环境床：循环白噪 → 75Hz 带通 →（0.06Hz LFO 让通带在 ~66–84Hz 游走）→ 音量 */
    const bedSrc = ctx.createBufferSource();
    bedSrc.buffer = noiseBuffer;
    bedSrc.loop = true;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = "bandpass";
    bedFilter.frequency.value = 75;
    bedFilter.Q.value = 1.15;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    const bedLfo = ctx.createOscillator();
    bedLfo.type = "sine";
    bedLfo.frequency.value = 0.06;
    const bedLfoGain = ctx.createGain();
    bedLfoGain.gain.value = 9;
    bedLfo.connect(bedLfoGain);
    bedLfoGain.connect(bedFilter.frequency);
    bedSrc.connect(bedFilter);
    bedFilter.connect(bedGain);
    bedGain.connect(master);
    bedSrc.start();
    bedLfo.start();

    /* 满载 sweep：循环白噪 → 带通（1650 ± 1350，0.045Hz 慢扫 300↔3000Hz）→ 0.05 音量 */
    const sweepSrc = ctx.createBufferSource();
    sweepSrc.buffer = noiseBuffer;
    sweepSrc.loop = true;
    const sweepFilter = ctx.createBiquadFilter();
    sweepFilter.type = "bandpass";
    sweepFilter.frequency.value = 1650;
    sweepFilter.Q.value = 0.7;
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = 0;
    const sweepLfo = ctx.createOscillator();
    sweepLfo.type = "sine";
    sweepLfo.frequency.value = 0.045;
    const sweepLfoGain = ctx.createGain();
    sweepLfoGain.gain.value = 1350;
    sweepLfo.connect(sweepLfoGain);
    sweepLfoGain.connect(sweepFilter.frequency);
    sweepSrc.connect(sweepFilter);
    sweepFilter.connect(sweepGain);
    sweepGain.connect(master);
    sweepSrc.start();
    sweepLfo.start();

    this.master = master;
    this.wall = wall;
    this.limiter = limiter;
    this.convolver = convolver;
    this.revSend = revSend;
    this.revWet = revWet;
    this.padBus = padBus;
    this.padFilter = padFilter;
    this.padA = padA;
    this.padB = padB;
    this.shimmer = shimmer;
    this.shimmerGain = shimmerGain;
    this.bedSrc = bedSrc;
    this.bedFilter = bedFilter;
    this.bedGain = bedGain;
    this.bedLfo = bedLfo;
    this.bedLfoGain = bedLfoGain;
    this.sweepSrc = sweepSrc;
    this.sweepFilter = sweepFilter;
    this.sweepGain = sweepGain;
    this.sweepLfo = sweepLfo;
    this.sweepLfoGain = sweepLfoGain;

    /* 浏览器强行关闭/恢复上下文时同步 ready，主控按钮才知道能不能重建 */
    try {
      ctx.onstatechange = () => {
        try {
          if (ctx.state === "closed") {
            this.ready = false;
            this.muted = true;
          } else if (ctx.state === "running" && !this.muted) {
            this.ready = true;
          }
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* 老浏览器没有 onstatechange，忽略 */
    }
  }

  /** 2 秒白噪缓冲（bed / sweep / burst 冲击共用） */
  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * 程序化混响 IR：双声道 2 秒指数衰减噪声。
   * 30Hz 一阶高切扫掉低频泥浆（否则小房间听感变雷雨声），
   * 左右声道独立随机 → 天然的立体声扩散。
   */
  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const dt = 1 / ctx.sampleRate;
    const rc = 1 / (2 * Math.PI * 30);
    const a = rc / (rc + dt); // 一阶高切系数
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let prevX = 0;
      let prevY = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.exp(-5.2 * t) * (1 - t * t * t); // 指数头 + 轻收尾，避免末端咔哒
        const x = (Math.random() * 2 - 1) * env;
        const y = a * (prevY + x - prevX);
        data[i] = y;
        prevX = x;
        prevY = y;
      }
    }
    return buf;
  }

  private disposeGraph(): void {
    const stopOsc = (osc: OscillatorNode | null) => {
      if (!osc) return;
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
      try {
        osc.disconnect();
      } catch {
        /* ignore */
      }
    };
    const stopBuf = (src: AudioBufferSourceNode | null) => {
      if (!src) return;
      try {
        src.stop();
      } catch {
        /* ignore */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    };
    const pads: (Pad | null)[] = [this.padA, this.padB];
    for (const p of pads) {
      if (!p) continue;
      stopOsc(p.root);
      stopOsc(p.fifth);
      stopOsc(p.third);
    }
    stopOsc(this.shimmer);
    stopOsc(this.bedLfo);
    stopOsc(this.sweepLfo);
    stopBuf(this.bedSrc);
    stopBuf(this.sweepSrc);
    for (const node of [
      this.padA?.out ?? null,
      this.padA?.fifthGain ?? null,
      this.padA?.thirdGain ?? null,
      this.padB?.out ?? null,
      this.padB?.fifthGain ?? null,
      this.padB?.thirdGain ?? null,
      this.shimmerGain,
      this.padBus,
      this.padFilter,
      this.bedFilter,
      this.bedGain,
      this.bedLfoGain,
      this.sweepFilter,
      this.sweepGain,
      this.sweepLfoGain,
      this.convolver,
      this.revSend,
      this.revWet,
      this.master,
      this.wall,
      this.limiter,
    ]) {
      try {
        node?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.master = null;
    this.wall = null;
    this.limiter = null;
    this.convolver = null;
    this.revSend = null;
    this.revWet = null;
    this.padBus = null;
    this.padFilter = null;
    this.padA = null;
    this.padB = null;
    this.padActive = 0;
    this.shimmer = null;
    this.shimmerGain = null;
    this.bedSrc = null;
    this.bedFilter = null;
    this.bedGain = null;
    this.bedLfo = null;
    this.bedLfoGain = null;
    this.sweepSrc = null;
    this.sweepFilter = null;
    this.sweepGain = null;
    this.sweepLfo = null;
    this.sweepLfoGain = null;
    this.noiseBuffer = null;
  }

  /** 令牌桶：速率随档位（4/11/14/14 每秒），允许 4 个瞬时突发 */
  private takeToken(now: number): boolean {
    const dt = Math.min(1, Math.max(0, now - this.tokenAt));
    this.tokenAt = now;
    const rate = NOTE_RATE_BY_TIER[this.tier] ?? 14;
    this.tokens = Math.min(NOTE_BURST, this.tokens + dt * rate);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private bumpEnergy(x: number): void {
    this.energy = Math.min(1, this.energy + x);
  }

  /**
   * 把档位 / density / energy 写进所有持续层：
   * pad 音量与低通、三度与泛音、bed（反比于 TPS）、sweep（满载才开）、混响深度。
   * 全部走 setTargetAtTime(τ≈0.6s)，档位切换 ≈2s 滑过去，听不出台阶。
   */
  private applyAmbience(now: number, ctx: AudioContext): void {
    const bus = this.padBus;
    const filter = this.padFilter;
    const bed = this.bedGain;
    if (!bus || !filter || !bed) return;
    if (now - this.lastDroneGainAt < 0.05) return;

    const dt = Math.max(0, now - this.lastDroneAt);
    this.lastDroneAt = now;
    this.lastDroneGainAt = now;
    this.energy *= Math.exp(-dt * 0.9); // 活动热度自行衰减

    const d = clamp(this.density, 0, 1);
    const e = clamp(this.energy, 0, 1);
    const tier = this.tier;
    const tau = 0.6;

    /* 越忙越厚：pad 音量 + 低通开口 + 三度/泛音层渐入；end 后短暂 duck 让收尾干净。
       duck 只压和声墙与泛音 —— bed 是「链还在跳」的底，不许被收尾带走。 */
    const duck = now < this.duckUntil ? 0.18 : 1;
    const padTargets = [
      0.02 + e * 0.02, // 0 实验室：几乎只剩 bed
      0.055 + d * 0.06 + e * 0.04, // 1 drone 起来
      0.095 + d * 0.055 + e * 0.05, // 2 墙渐厚
      0.14 + e * 0.06, // 3 整张和声墙
    ];
    const filtTargets = [210, 250 + d * 520 + e * 140, 430 + d * 700 + e * 160, 900 + d * 1400];
    const thirdTargets = [0.08, 0.12 + d * 0.28 + e * 0.07, 0.2 + d * 0.3 + e * 0.08, 0.3 + d * 0.3 + e * 0.12];
    const shimmerTargets = [0.02 + d * 0.08, 0.06 + d * 0.24 + e * 0.08, 0.16 + d * 0.3 + e * 0.1, 0.3 + d * 0.22 + e * 0.12];

    bus.gain.setTargetAtTime(Math.min(0.2, padTargets[tier] * duck), now, tau);
    filter.frequency.setTargetAtTime(Math.min(2400, filtTargets[tier]) * (duck < 1 ? 0.4 : 1), now, tau);
    for (const p of [this.padA, this.padB]) {
      p?.thirdGain.gain.setTargetAtTime(Math.min(0.6, thirdTargets[tier] * duck), now, tau + 0.1);
    }
    this.shimmerGain?.gain.setTargetAtTime(Math.min(0.5, shimmerTargets[tier] * duck), now, tau + 0.2);

    /* bed 反比 TPS：tps=0 → 0.055 明显；tps≥60 → 0.005 几乎消失 */
    const bedTargets = [0.055, 0.03, 0.014, 0.005];
    bed.gain.setTargetAtTime(bedTargets[tier], now, 0.8);

    /* 满载才开噪声 sweep（0.05，「链在烧」的白噪质感） */
    this.sweepGain?.gain.setTargetAtTime(tier === 3 ? 0.05 : 0.00001, now, tau + 0.4);

    /* 混响深度 0.12 → 0.22 */
    const wetTargets = [0.12, 0.12, 0.17, 0.22];
    this.revWet?.gain.setTargetAtTime(wetTargets[tier], now, 1.0);
  }

  /**
   * 随机 22–38s 转一次和弦；转的过程是双 pad 4 秒 crossfade ——
   * 静音 pad 先对好新和弦，再淡入把旧 pad 淡出，听众抓不到切点。
   */
  private maybeAdvanceChord(now: number, ctx: AudioContext): void {
    const silent = this.padActive === 0 ? this.padB : this.padA;
    const audible = this.padActive === 0 ? this.padA : this.padB;
    if (!silent || !audible) return;

    const elapsed = now - this.chordAt;
    if (elapsed < this.chordDur) return;

    const nextIdx = (this.chordIndex + 1) % CHORDS.length;
    const c = CHORDS[nextIdx];
    /* 后台标签页攒了好几个周期：直接落位，不补做 4 秒 crossfade */
    const snap = elapsed > this.chordDur + CHORD_XFADE_TAU * 6;
    const xf = snap ? 0.02 : CHORD_XFADE_TAU;

    this.setPadFreqs(silent, c, now, snap ? 0.02 : 0.5);
    try {
      silent.out.gain.cancelScheduledValues(now);
      silent.out.gain.setTargetAtTime(1, now, xf);
      audible.out.gain.cancelScheduledValues(now);
      audible.out.gain.setTargetAtTime(0.00001, now, xf);
    } catch {
      /* ignore */
    }
    try {
      this.shimmer?.frequency.cancelScheduledValues(now);
      this.shimmer?.frequency.setTargetAtTime(Math.max(8, c.root * 2), now, snap ? 0.02 : 1.4);
    } catch {
      /* ignore */
    }

    this.padActive = this.padActive === 0 ? 1 : 0;
    this.chordIndex = nextIdx;
    this.chordAt = now;
    this.chordDur = randChordDur();
    this.bumpEnergy(snap ? 0.08 : 0.12); // 转调时 drone 轻轻涌一下
    void ctx;
  }

  /** 开场 stinger 用：两支 pad 一起对齐到指定和弦（0.5s 滑入，听得出是「回到 I」） */
  private resetChord(now: number, ctx: AudioContext, index: number): void {
    const c = CHORDS[index] ?? CHORDS[0];
    const audible = this.padActive === 0 ? this.padA : this.padB;
    const silent = this.padActive === 0 ? this.padB : this.padA;
    if (audible) this.setPadFreqs(audible, c, now, 0.5);
    if (silent) this.setPadFreqs(silent, c, now, 0.5);
    try {
      // crossfade 中途被 start 打断时，active pad 可能正淡出 —— 必须拉回满位，
      // 否则回到 I 级却发现音量在往无声走。
      audible?.out.gain.cancelScheduledValues(now);
      audible?.out.gain.setTargetAtTime(1, now, 0.3);
      silent?.out.gain.cancelScheduledValues(now);
      silent?.out.gain.setTargetAtTime(0.00001, now, 0.3);
      this.shimmer?.frequency.cancelScheduledValues(now);
      this.shimmer?.frequency.setTargetAtTime(Math.max(8, c.root * 2), now, 0.5);
    } catch {
      /* ignore */
    }
    this.chordIndex = index;
    this.chordAt = now;
    this.chordDur = randChordDur();
    void ctx;
  }

  /** 一支 pad 的三个振荡器一起滑向新和弦 */
  private setPadFreqs(pad: Pad, c: (typeof CHORDS)[number], now: number, tau: number): void {
    const glide = (osc: OscillatorNode | null, hz: number) => {
      if (!osc) return;
      try {
        osc.frequency.cancelScheduledValues(now);
        osc.frequency.setTargetAtTime(Math.max(8, hz), now, tau);
      } catch {
        /* ignore */
      }
    };
    glide(pad.root, c.root);
    glide(pad.fifth, c.fifth);
    glide(pad.third, c.third);
  }

  private tryResume(ctx: AudioContext): void {
    try {
      if (ctx.state !== "suspended") return;
      const wall = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (wall - this.lastResumeAt < 1200) return;
      this.lastResumeAt = wall;
      void ctx.resume().catch(() => {});
    } catch {
      /* 恢复失败就保持静音，不影响画面 */
    }
  }

  /**
   * 浏览器可能因为内存压力/标签页回收把 AudioContext 直接关掉。
   * 这时 ready 必须变回 false，主控点「声音」按钮才会走 enable() 重建整张图；
   * 否则界面显示「声音开」，实际永远静音。
   */
  private ensureAlive(ctx: AudioContext): boolean {
    if (ctx.state !== "closed") return true;
    this.disposeGraph();
    this.ctx = null;
    this.ready = false;
    this.muted = true;
    return false;
  }

  /** 白噪声冲击（burst 落点用）：开满 → 塌下来的「砰」，用完即弃 */
  private spawnNoiseHit(
    ctx: AudioContext,
    dest: AudioNode,
    at: number,
    dur: number,
    peak: number,
    cutoff: number,
    send: number,
  ): void {
    try {
      const buf = this.noiseBuffer;
      if (!buf) return;
      const t0 = Math.max(ctx.currentTime, at);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = false;

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.max(200, cutoff), t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * 0.18), t0 + dur);
      filter.Q.value = 0.7;

      const gain = ctx.createGain();
      const p = clamp(peak, 0.0002, 0.2);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(p, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      if (send > 0.001 && this.revSend) gain.connect(this.revSend);

      /* onended 必须在 stop() 之前挂好：stop 触发 ended 是同步语义的坑，
         先 stop 后挂会漏掉清理回调（fake AudioContext 单测实测踩过）。 */
      src.onended = () => {
        try {
          src.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
      };
      /* 随机起点：每次冲击的噪声纹理不同，不重样 */
      const off = Math.random() * Math.max(0, buf.duration - dur - 0.05);
      src.start(t0, off);
      src.stop(t0 + dur + 0.02);
    } catch {
      /* 冲击失败不影响其它声部 */
    }
  }

  /**
   * 单个音符/扫频的通用发声器。
   * osc → [lowpass] → gain envelope → [panner] → dest
   *                                └→ [send] → convolver
   * fm: 两支正弦 modulator（频率 0.5× / 0.2× carrier）接 carrier.frequency，
   *     深度在音头 0.16s 内塌到零 —— 铃感只在起音，不污染延音乐队。
   */
  private spawnTone(ctx: AudioContext, dest: AudioNode, o: ToneOpts): void {
    try {
      const t0 = Math.max(ctx.currentTime, Number.isFinite(o.at) ? o.at : ctx.currentTime);
      const freq = Math.max(8, Number.isFinite(o.freq) ? o.freq : 220);
      const attack = Math.max(0.002, o.attack);
      const hold = Math.max(0, o.hold ?? 0.01);
      const decay = Math.max(0.03, o.decay);
      const end = t0 + attack + hold + decay;
      const peak = clamp(Number.isFinite(o.peak) ? o.peak : 0.04, 0.0002, 0.16);

      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.setValueAtTime(freq, t0);
      if (o.glideTo !== undefined && Number.isFinite(o.glideTo)) {
        const target = Math.max(8, o.glideTo);
        osc.frequency.exponentialRampToValueAtTime(target, t0 + Math.max(0.02, o.glideTime ?? 0.5));
      }
      if (o.detune !== undefined && Number.isFinite(o.detune)) {
        osc.detune.value = clamp(o.detune, -100, 100);
      }

      /* FM：carrier.frequency 的附加调制 = Σ mod_i × depth_i（包络塌缩） */
      const mods: OscillatorNode[] = [];
      const modGains: GainNode[] = [];
      if (o.fm) {
        const defs = [
          { ratio: 0.5, depth: 0.6, tau: 0.16 },
          { ratio: 0.2, depth: 0.22, tau: 0.09 },
        ];
        for (const def of defs) {
          const m = ctx.createOscillator();
          m.type = "sine";
          m.frequency.value = Math.max(1, freq * def.ratio);
          const mg = ctx.createGain();
          const d0 = Math.max(1, freq * def.depth);
          mg.gain.setValueAtTime(d0, t0);
          mg.gain.exponentialRampToValueAtTime(Math.max(0.5, d0 * 0.02), t0 + Math.max(0.03, def.tau));
          m.connect(mg);
          mg.connect(osc.frequency);
          m.start(t0);
          m.stop(end + 0.03);
          mods.push(m);
          modGains.push(mg);
        }
      }

      let node: AudioNode = osc;
      let filter: BiquadFilterNode | null = null;
      if (o.cutoff !== undefined && Number.isFinite(o.cutoff) && o.cutoff > 0) {
        filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(Math.max(60, o.cutoff), t0);
        if (o.cutoffEnd !== undefined && Number.isFinite(o.cutoffEnd)) {
          filter.frequency.exponentialRampToValueAtTime(
            Math.max(60, o.cutoffEnd),
            t0 + Math.max(0.05, o.glideTime ?? 0.8),
          );
        }
        filter.Q.value = clamp(o.q ?? 0.7, 0.0001, 20);
        node.connect(filter);
        node = filter;
      }

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      node.connect(gain);

      let out: AudioNode = gain;
      let pan: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === "function") {
        pan = ctx.createStereoPanner();
        pan.pan.value = clamp(Number.isFinite(o.pan ?? 0) ? (o.pan as number) : 0, -0.95, 0.95);
        gain.connect(pan);
        out = pan;
      }
      out.connect(dest);
      if (o.send !== undefined && o.send > 0.001 && this.revSend) {
        out.connect(this.revSend);
      }

      /* 并发闸占用：start 成功后才计数，onended/异常必归还（released 标志防双扣） */
      let counted = false;
      const release = (): void => {
        if (counted) {
          counted = false;
          this.activeVoices = Math.max(0, this.activeVoices - 1);
        }
      };
      const cleanup = (): void => {
        try {
          osc.disconnect();
          for (const m of mods) m.disconnect();
          for (const mg of modGains) mg.disconnect();
          filter?.disconnect();
          gain.disconnect();
          pan?.disconnect();
        } catch {
          /* ignore */
        }
      };

      /* onended 必须在 start/stop 之前挂好：stop 触发 ended 在部分环境是同步的，
         先 stop 后挂会漏掉清理 —— fake AudioContext 单测实测踩过（v1 就是这个顺序）。 */
      osc.onended = () => {
        release();
        cleanup();
      };
      try {
        osc.start(t0);
        counted = true;
        this.activeVoices += 1;
        osc.stop(end + 0.03);
      } catch {
        release();
        cleanup();
      }
    } catch {
      /* 单个音符失败不影响整场 */
    }
  }
}
