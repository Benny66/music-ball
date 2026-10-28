import { clamp } from '../util/math.ts';
import { hashFloat, mulberry32 } from '../util/prng.ts';
import type { Chart } from '../types.ts';
import type { BeadPath } from '../chart/bead.ts';
import { midiAt, type MelodyNote } from '../analysis/melody.ts';
import {
  GLASS_AMPS,
  GLASS_ATTACK_SEC,
  GLASS_FADE_SEC,
  GLASS_MASTER,
  GLASS_NOISE,
  GLASS_RATIOS,
  glassGain,
  glassPartialDecay,
  glassRing,
  softClip,
} from './glass-recipe.ts';

/**
 * 玻璃音轨：每次撞击一个「敲玻璃」声，音高跟主旋律（或鼓组）。
 *
 * 音色用 modal synthesis 手写 —— 玻璃的敲击声本质上是若干个**不谐和**振动模态的
 * 叠加加一段高频噪声。不引 Tone.js（~150KB 且它的 Transport 模型和我们的闭式求值冲突）。
 *
 * 整条音轨用 OfflineAudioContext 一次性离线渲染成一个 AudioBuffer，
 * 预览和导出播同一份 —— 所听即所得，也避免实时调度与时钟漂移。
 */

export const GLASS_SR = 48000;

export interface GlassNote {
  t: number;
  /** MIDI 音高；null = 该拍没有旋律，用鼓组默认音高 */
  midi: number | null;
  band: 'kick' | 'snare' | 'hat';
  /** 0..1 重音程度 */
  accent: number;
  /** 距下一拍的时间（余音随间距变长，最短 0.6s） */
  dt: number;
  /** -1..1，球在赛道上的相对位置 → 声像 */
  panX: number;
}

/** 没有旋律信息时的兜底音高 */
const BAND_MIDI = { kick: 45, snare: 52, hat: 74 } as const;

/** 从 chart 的板生成玻璃声事件（旋律为空时的兜底，或旋律提取完成前） */
export function notesFromChart(chart: Chart, melody: MelodyNote[] | null): GlassNote[] {
  const boards = chart.boards;
  const out: GlassNote[] = [];
  const half = chart.trackW / 2 || 1;
  for (let i = 0; i < boards.length; i++) {
    const b = boards[i];
    if (b.ghost) continue;
    const dt = i + 1 < boards.length ? boards[i + 1].t - b.t : 0.5;
    out.push({
      t: b.t,
      // 音符驱动的板已经带旋律音高；网格驱动才回退到 midiAt
      midi: b.midi ?? (melody ? midiAt(melody, b.t) : null),
      band: b.band,
      accent: b.accent,
      dt: clamp(dt, 0.1, 1.5),
      panX: clamp(b.x / half, -1, 1),
    });
  }
  return out;
}

/** 玻璃珠场景：每个撞击一块板，音高/力度/声像都来自该板。 */
export function notesFromBead(path: BeadPath): GlassNote[] {
  const half = path.trackW / 2 || 1;
  return path.boards.map((b, i) => {
    const next = path.boards[i + 1];
    return {
      t: b.t,
      midi: b.midi,
      band: b.band,
      accent: b.power,
      dt: clamp(next ? next.t - b.t : 0.5, 0.1, 1.5),
      panX: clamp(b.centerX / half, -1, 1),
    };
  });
}

function makeNoise(ctx: OfflineAudioContext, rng: () => number, seconds: number): AudioBuffer {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
  return buf;
}

/**
 * 离线渲染整条玻璃音轨。
 * 全部随机数来自 seed —— 同输入同输出（导出可复现的硬约束延伸到音频层）。
 */
export async function renderGlassTrack(
  chart: Chart,
  notes: GlassNote[],
  opts: { seed?: number; masterGain?: number } = {},
): Promise<AudioBuffer> {
  const sr = GLASS_SR;
  const duration = Math.max(1, chart.duration + 1);
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sr), sr);

  const master = ctx.createGain();
  master.gain.value = opts.masterGain ?? GLASS_MASTER;
  master.connect(ctx.destination);

  const rng = mulberry32(opts.seed ?? 0x51a55);
  const noise = makeNoise(ctx, rng, 0.5);

  for (const n of notes) {
    if (!(n.t >= 0) || n.t > chart.duration + 0.5) continue;
    const midi = n.midi ?? BAND_MIDI[n.band];
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const ring = glassRing(n.dt);
    const gain = glassGain(n.accent);

    // 声像跟随球的位置
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(n.panX, -1, 1) * 0.6;
    pan.connect(master);

    const start = Math.max(0, n.t);

    // —— 模态合成：7 个强不谐和分音，高次模态衰减更快 ——
    for (let k = 0; k < GLASS_RATIOS.length; k++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // ±0.2% 微失谐：真实玻璃的模态频率不完全严格，完全谐和会像电子琴
      const detune = (hashFloat(Math.round(n.t * 1000) + k * 7, k) - 0.5) * 0.004;
      osc.frequency.value = freq * GLASS_RATIOS[k] * (1 + detune);

      const g = ctx.createGain();
      const decay = glassPartialDecay(ring, k);
      const peak = gain * GLASS_AMPS[k];
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak, start + GLASS_ATTACK_SEC);
      g.gain.exponentialRampToValueAtTime(peak * 0.05, start + decay);
      g.gain.exponentialRampToValueAtTime(0.0001, start + decay + GLASS_FADE_SEC);

      osc.connect(g);
      g.connect(pan);
      osc.start(start);
      osc.stop(start + decay + GLASS_FADE_SEC + 0.02);
    }

    // —— 高通噪声：短促起音 + 一点高频 shimmer ——
    for (const spec of GLASS_NOISE) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = spec.fc;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(gain * spec.gain, start);
      ng.gain.exponentialRampToValueAtTime(0.0001, start + spec.dur);

      src.connect(hp);
      hp.connect(ng);
      ng.connect(pan);
      src.start(start, 0, spec.dur + 0.02);
    }
  }

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = softClip(data[i]);
  return rendered;
}

/** 均方根（响度） */
export function rmsOf(buffer: AudioBuffer): number {
  let sum = 0;
  let cnt = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) {
      sum += d[i] * d[i];
      cnt++;
    }
  }
  return cnt > 0 ? Math.sqrt(sum / cnt) : 0;
}

/**
 * 两个 buffer 混音（用于「玻璃声 + 原曲」模式）。
 * ⚠️ 两个采样率不同的裸 AudioBuffer 不能直接相加 —— 必须经 OfflineAudioContext
 * 播放重采样（44.1k 的原曲进 48k 的上下文会自动重采样）。
 */
export async function mixBuffers(
  glass: AudioBuffer,
  original: AudioBuffer,
  glassGain: number,
): Promise<AudioBuffer> {
  const sr = GLASS_SR;
  const len = Math.ceil(Math.max(glass.duration, original.duration) * sr);
  const ctx = new OfflineAudioContext(2, len, sr);

  const g = ctx.createBufferSource();
  g.buffer = glass;
  const o = ctx.createBufferSource();
  o.buffer = original;

  const gg = ctx.createGain();
  gg.gain.value = glassGain;
  const og = ctx.createGain();
  og.gain.value = 1;

  g.connect(gg).connect(ctx.destination);
  o.connect(og).connect(ctx.destination);
  g.start(0);
  o.start(0);
  return ctx.startRendering();
}

/** 把原曲重采样到 48k（「只有原曲」模式也要走这一步，让三种模式的 AAC 配置一致） */
export async function resampleTo48k(original: AudioBuffer): Promise<AudioBuffer> {
  if (original.sampleRate === GLASS_SR) return original;
  const sr = GLASS_SR;
  const len = Math.ceil(original.duration * sr);
  const ctx = new OfflineAudioContext(original.numberOfChannels, len, sr);
  const src = ctx.createBufferSource();
  src.buffer = original;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}
