import { clamp } from '../util/math.ts';

/**
 * 主旋律提取的纯逻辑与重采样接缝。
 *
 * 模型推理在 `melody-model.ts`（由 Worker 导入）；这里保留 FFT 降级、onset 精修、
 * 音高查询和 22.05kHz 重采样 —— 全部可在主线程/Node 里跑。
 *
 * 降级路径：每 0.1s 取一帧 2048 点 Hann，在 80–1000Hz 找能量主峰。对混音后的流行歌
 * 准确率有限（能量峰 ≠ 主旋律），但能保证「有音高、有变化」。
 */

export interface MelodyNote {
  start: number;
  end: number;
  midi: number;
  amplitude: number;
}

export interface MelodyResult {
  notes: MelodyNote[];
  /** 用的是哪条路径 */
  source: 'basic-pitch' | 'fft-fallback';
}

/** 任意采样率的 PCM 重采样到 22050Hz 单声道（basic-pitch 固定用这个采样率） */
export async function resampleTo22050(pcm: Float32Array, sr: number): Promise<Float32Array> {
  const target = 22050;
  const len = Math.max(1, Math.ceil((pcm.length * target) / sr));
  const ctx = new OfflineAudioContext(1, len, target);
  const buf = ctx.createBuffer(1, pcm.length, sr);
  buf.getChannelData(0).set(pcm);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

/**
 * 降级：每 0.1s 取一帧 2048 点 Hann，在 80–1000Hz 找能量主峰。
 * 混音流行歌上准确率有限，但足以让玻璃声「有音高、有起伏」。
 */
export function fftMelody(pcm: Float32Array, sr: number): MelodyNote[] {
  const N = 2048;
  const hop = Math.round(sr * 0.1);
  if (pcm.length < N) return [];
  const notes: MelodyNote[] = [];
  const fMin = 80;
  const fMax = 1000;

  // 能量阈值：低于全曲 p30 的帧判「无旋律」
  const energies: number[] = [];
  for (let off = 0; off + N < pcm.length; off += hop) energies.push(frameEnergy(pcm, off, N));
  energies.sort((a, b) => a - b);
  const floor = energies[Math.floor(energies.length * 0.3)] || 0;

  let start = -1;
  let midi = 0;
  for (let off = 0; off + N < pcm.length; off += hop) {
    if (frameEnergy(pcm, off, N) < floor) {
      if (start >= 0) {
        notes.push({ start, end: off / sr, midi, amplitude: 0.5 });
        start = -1;
      }
      continue;
    }
    const peak = dominantFreq(pcm, off, N, sr, fMin, fMax);
    const m = 69 + 12 * Math.log2(Math.max(1, peak) / 440);
    if (start < 0) {
      start = off / sr;
      midi = m;
    } else if (Math.abs(m - midi) > 1.5) {
      // 音高变了，收上一段
      notes.push({ start, end: off / sr, midi, amplitude: 0.5 });
      start = off / sr;
      midi = m;
    }
  }
  if (start >= 0) notes.push({ start, end: pcm.length / sr, midi, amplitude: 0.5 });
  return notes;
}

function frameEnergy(pcm: Float32Array, off: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += pcm[off + i] * pcm[off + i];
  return Math.sqrt(s / n);
}

/** 2048 点 Hann + 直接 DFT（只在 80–1000Hz 的 ~46 个 bin 上算，够快） */
function dominantFreq(
  pcm: Float32Array,
  off: number,
  n: number,
  sr: number,
  fMin: number,
  fMax: number,
): number {
  const binHz = sr / n;
  const lo = Math.max(1, Math.floor(fMin / binHz));
  const hi = Math.min(n >> 1, Math.ceil(fMax / binHz));
  let best = 0;
  let bestMag = -1;
  for (let k = lo; k <= hi; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      const s = pcm[off + i] * w;
      const ang = (-2 * Math.PI * k * i) / n;
      re += s * Math.cos(ang);
      im += s * Math.sin(ang);
    }
    const mag = Math.sqrt(re * re + im * im);
    if (mag > bestMag) {
      bestMag = mag;
      best = k;
    }
  }
  return best * binHz;
}

/**
 * 用音频 onset 精修模型音符的起点：
 *   - 模型负责音高/和弦，音频负责精确时刻（basic-pitch 在重叠音上会提前 60–80ms）
 *   - 窗口内没有起音的模型音符视为长音谐波/多检，直接丢弃
 *   - 没有 onset 可用时原样返回，避免把整首曲子清空
 */
export function snapNotesToOnsets(
  notes: MelodyNote[],
  onsets: Array<{ t: number }>,
  windowSec = 0.16,
): MelodyNote[] {
  if (onsets.length === 0) return notes;
  const times = onsets.map((o) => o.t).sort((a, b) => a - b);
  const out: MelodyNote[] = [];

  for (const n of notes) {
    let lo = 0;
    let hi = times.length - 1;
    let best = -1;
    let bestD = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = Math.abs(times[mid] - n.start);
      if (d < bestD) {
        bestD = d;
        best = mid;
      }
      if (times[mid] < n.start) lo = mid + 1;
      else hi = mid - 1;
    }
    if (best < 0 || bestD > windowSec) continue;

    const start = times[best];
    const shift = start - n.start;
    out.push({ ...n, start, end: Math.max(start + 0.05, n.end + shift) });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 拍点 → 音高。优先「start 距 t ≤ 0.12s 且覆盖 t 的音符」按 amplitude 加权，
 * 否则取覆盖 t 的长音；否则 null（下游用鼓组默认音高）。
 */
export function midiAt(notes: MelodyNote[], t: number): number | null {
  let best: MelodyNote | null = null;
  let bestScore = -1;
  for (const n of notes) {
    if (t < n.start - 0.12 || t > n.end + 0.05) continue;
    const covers = t >= n.start && t <= n.end;
    const near = Math.abs(n.start - t) <= 0.12;
    if (!covers && !near) continue;
    const score = n.amplitude * (covers ? 2 : 1) - Math.abs(n.start - t);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best ? clamp(Math.round(best.midi), 21, 108) : null;
}
