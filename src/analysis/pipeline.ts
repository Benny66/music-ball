import { bandFlux, frameToSec, pickPeaks, FFT_HOP, FFT_N, type BandFlux } from './onset.ts';
import { estimateTempo } from './tempo.ts';
import { sanitizeFrames, trackBeats } from './beats.ts';
import { lowBandOnsets } from './lowband.ts';
import { regularizeBeats } from './grid.ts';
import { clamp } from '../util/math.ts';
import type { AnalysisResult, Band, Beat } from '../types.ts';

export interface AnalyzeOptions {
  /** BPM 先验，默认 120。用户手动改 BPM 时可以传入以重新吸附 */
  hintBpm?: number;
  /** 全局时间偏移（秒），用于补偿某些转码链引入的 priming delay */
  timeOffset?: number;
  onProgress?: (phase: 'flux' | 'tempo' | 'beats' | 'classify', ratio: number) => void;
}

/** 低于这个阈值就认为整段静音、没有可用节拍 */
const SILENCE_ENV = 1e-4;

/**
 * 完整分析流水线。纯同步、零 DOM 依赖 —— 既能在 Web Worker 里跑，也能在 Node 里跑。
 */
export function analyze(
  pcm: Float32Array,
  sr: number,
  duration: number,
  opts: AnalyzeOptions = {},
): AnalysisResult {
  const offset = opts.timeOffset ?? 0;

  opts.onProgress?.('flux', 0);
  const flux = bandFlux(pcm, sr);
  opts.onProgress?.('flux', 1);

  if (flux.env.length === 0) {
    return emptyResult(sr, duration, flux);
  }

  opts.onProgress?.('tempo', 0);
  const tempo = estimateTempo(flux.env, flux.hopSec, { hintBpm: opts.hintBpm });
  opts.onProgress?.('tempo', 1);

  opts.onProgress?.('beats', 0);
  const track = trackBeats(flux.env, tempo.periodFrames);
  const minGap = Math.max(2, Math.round(0.12 / flux.hopSec));
  const frames = sanitizeFrames(track.frames, minGap);
  opts.onProgress?.('beats', 0.6);

  let peak = 0;
  for (let i = 0; i < flux.env.length; i++) if (flux.env[i] > peak) peak = flux.env[i];

  const detected: Beat[] = [];
  if (peak > SILENCE_ENV && frames.length >= 2) {
    opts.onProgress?.('classify', 0);
    const scale = bandScale(flux);
    for (const f of frames) {
      const idx = Math.min(flux.env.length - 1, Math.max(0, Math.round(f)));
      const t = frameToSec(flux, f) + offset;
      if (t < -0.5 || t > duration + 0.5) continue;
      detected.push({
        t: clamp(t, 0, duration),
        power: clamp(flux.env[idx] / peak, 0.05, 1),
        band: classifyBand(flux, idx, scale),
        synthetic: false,
      });
    }
    opts.onProgress?.('classify', 1);
  }

  // 完全没有可用节拍（纯人声/静音/环境音）→ 退化成 120BPM 均匀网格，保证画面不空
  if (detected.length < 2) {
    const bpm = 120;
    const step = 60 / bpm;
    const beats: Beat[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) {
      beats.push({ t: Math.min(t, duration), power: 0.6, band: 'kick', synthetic: true });
    }
    return {
      sr,
      duration,
      bpm,
      bpmConfidence: 0,
      beats,
      envelope: flux.env,
      hopSec: flux.hopSec,
      highRatio: bandRatio(flux),
      onsets: [],
    };
  }

  opts.onProgress?.('beats', 1);

  // ---- 网格正则 + 吸附 ----
  // DP 的毛病不是「找错拍」，而是在正确拍附近 ±25% 乱跳（真实流行歌实测 12%–23% 的间隔
  // 落在 0.75×/1.25×）。先拟合出一条规则网格把这些抖动抹平，再用 ±40ms 的小窗
  // 把网格点拉回真实鼓点 —— 光吸附不拟合网格只会把抖动搬到最近的 onset 上。
  const low = lowBandOnsets(pcm, sr);
  const broadPeaks = pickPeaks(flux.env, flux, { k: 1.0 }).map((p) => ({
    t: p.t,
    strength: p.strength,
  }));
  const grid = regularizeBeats(detected, low, broadPeaks, {}, (t) => {
    const idx = Math.round(t / flux.hopSec);
    let m = 0;
    for (let i = Math.max(0, idx - 3); i < Math.min(flux.env.length, idx + 4); i++) {
      if (flux.env[i] > m) m = flux.env[i];
    }
    return peak > 0 ? m / peak : 0;
  });
  opts.onProgress?.('beats', 1);

  const regularized = grid.beats.length >= 2 ? grid.beats : detected;
  const beats = extrapolate(
    regularized,
    duration,
    grid.period > 0 ? grid.period : medianGap(regularized),
  );

  const bpm = grid.period > 0 ? 60 / grid.period : crossCheckBpm(beats, tempo.bpm);

  // 规律度：拍间隔落在中位 ±15% 内的比例。这是「画面节奏稳不稳」的直接量度，
  // 合成曲 100%，真实曲修复前 52–93%、修复后 97–100%。
  const gaps: number[] = [];
  for (let i = 1; i < regularized.length; i++) gaps.push(regularized[i].t - regularized[i - 1].t);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const medGap = sorted[sorted.length >> 1] ?? 0;
  const regularity =
    medGap > 0 ? gaps.filter((g) => Math.abs(g / medGap - 1) < 0.15).length / Math.max(1, gaps.length) : 0;

  return {
    sr,
    duration,
    bpm,
    bpmConfidence: tempo.confidence,
    beats,
    envelope: flux.env,
    hopSec: flux.hopSec,
    quality: {
      regularity,
      drift: grid.drift,
      snapped: grid.snappedRatio,
      period: grid.period,
    },
    highRatio: bandRatio(flux),
    onsets: broadPeaks.map((p) => ({ t: p.t, strength: p.strength })),
  };
}

/** 高频通量占总通量的比例。鼓组曲目通常 0.11–0.26，钢琴独奏约 0.04–0.06。 */
function bandRatio(flux: BandFlux): number {
  let lo = 0;
  let mid = 0;
  let hi = 0;
  const n = Math.min(flux.low.length, flux.mid.length, flux.high.length);
  for (let i = 0; i < n; i++) {
    lo += flux.low[i];
    mid += flux.mid[i];
    hi += flux.high[i];
  }
  const total = lo + mid + hi;
  return total > 0 ? hi / total : 0;
}

function emptyResult(sr: number, duration: number, flux: BandFlux): AnalysisResult {
  return {
    sr,
    duration,
    bpm: 120,
    bpmConfidence: 0,
    beats: [],
    envelope: flux?.env ?? new Float32Array(0),
    hopSec: FFT_HOP / sr,
    highRatio: flux ? bandRatio(flux) : 0,
    onsets: [],
  };
}

/** 按三个频段的相对强度判定这一拍是什么打击乐 */
function classifyBand(flux: BandFlux, frame: number, scale: BandScale): Band {
  // 必须先按各频段自身的量级归一化。未归一化时低频常占 70%+ 能量，
  // 结果就是「每一拍都被判成 kick」，配色彻底失去层次。
  const lo = (flux.low[frame] ?? 0) / scale.low;
  const mid = (flux.mid[frame] ?? 0) / scale.mid;
  const hi = (flux.high[frame] ?? 0) / scale.high;
  if (lo >= mid && lo >= hi) return 'kick';
  if (mid >= hi) return 'snare';
  return 'hat';
}

interface BandScale {
  low: number;
  mid: number;
  high: number;
}

function bandScale(flux: BandFlux): BandScale {
  const p = (src: Float32Array): number => {
    // 用 98 分位而非最大值，避免单个爆音把整首的尺度拉飞
    const sample: number[] = [];
    const step = Math.max(1, Math.floor(src.length / 2000));
    for (let i = 0; i < src.length; i += step) sample.push(src[i]);
    sample.sort((a, b) => a - b);
    return sample[Math.floor(sample.length * 0.98)] || 1;
  };
  return { low: p(flux.low), mid: p(flux.mid), high: p(flux.high) };
}

function medianGap(beats: Beat[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i].t - beats[i - 1].t);
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  return med > 0.05 ? med : 0.5;
}

/**
 * 用检测到的实际拍点中位间隔反过来校准 BPM。
 * 自相关的八度误差在这里会被自动纠正 —— 如果拍点间距对应 88BPM 而 ACF 说 176，
 * 相信拍点，因为拍点才是真正驱动画面的东西。
 */
function crossCheckBpm(beats: Beat[], acfBpm: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i].t - beats[i - 1].t;
    if (d > 0.1) gaps.push(d);
  }
  if (gaps.length < 4) return acfBpm;
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  const fromGaps = 60 / med;
  // 只有当两者接近整数倍关系时才采信拍点间距
  const ratio = fromGaps / acfBpm;
  const nearInt = Math.abs(ratio - Math.round(ratio)) < 0.12 && Math.round(ratio) >= 1;
  return nearInt ? fromGaps : acfBpm;
}

/**
 * 向前/向后外推，保证 chart 覆盖 [0, duration]。
 * 前奏 8 秒没鼓的时候，球也不会停在画面顶上不动。
 */
function extrapolate(detected: Beat[], duration: number, localT: number): Beat[] {
  const out = detected.slice();

  let guard = 0;
  while (out.length > 0 && out[0].t > localT * 0.5 && guard++ < 512) {
    const t = out[0].t - localT;
    out.unshift({ t: Math.max(0, t), power: 0.35, band: out[0].band, synthetic: true });
    if (t <= 0) break;
  }
  if (out.length > 0 && out[0].t > 0.02) {
    out.unshift({ t: 0, power: 0.35, band: out[0].band, synthetic: true });
  }

  guard = 0;
  while (out.length > 0 && out[out.length - 1].t + localT < duration && guard++ < 4096) {
    out.push({
      t: out[out.length - 1].t + localT,
      power: 0.35,
      band: out[out.length - 1].band,
      synthetic: true,
    });
  }
  if (out.length > 0 && duration - out[out.length - 1].t > 0.02) {
    out.push({ t: duration, power: 0.35, band: out[out.length - 1].band, synthetic: true });
  }

  return out;
}

export { FFT_N, FFT_HOP };
