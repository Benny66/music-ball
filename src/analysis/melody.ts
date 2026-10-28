import { clamp } from '../util/math.ts';

/**
 * 主旋律提取。
 *
 * 主路径：`@spotify/basic-pitch`（Spotify 的轻量 AMT 模型，Apache-2.0，TFJS 约 1MB）。
 *   它输出**带时间的音符事件**，玻璃声按音高演奏 —— 听起来像玻璃风琴在弹这首歌的旋律。
 * 降级路径：每拍在 80–1000Hz 找 FFT 主峰。对混音后的流行歌准确率有限（能量峰 ≠ 主旋律），
 *   但能保证「有音高、有变化」，不会因为模型加载失败就让玻璃声变成纯打击乐。
 *
 * 两条路径产出**同构**的结果，下游无感。
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

let modelPromise: Promise<unknown> | null = null;

/** 惰性加载模型（只加载一次；失败会抛给调用方走降级） */
async function getModel(): Promise<unknown> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const mod = await import('@spotify/basic-pitch');
      return new mod.BasicPitch('/models/basic-pitch/model.json');
    })();
  }
  return modelPromise;
}

/** 任意采样率的 PCM 重采样到 22050Hz 单声道（basic-pitch 固定用这个采样率） */
async function resampleTo22050(pcm: Float32Array, sr: number): Promise<AudioBuffer> {
  const target = 22050;
  const len = Math.max(1, Math.ceil((pcm.length * target) / sr));
  const ctx = new OfflineAudioContext(1, len, target);
  const buf = ctx.createBuffer(1, pcm.length, sr);
  buf.getChannelData(0).set(pcm);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

export async function extractMelody(
  pcm: Float32Array,
  sr: number,
  onProgress?: (p: number) => void,
): Promise<MelodyResult> {
  try {
    const resampled = await resampleTo22050(pcm, sr);
    const mod = await import('@spotify/basic-pitch');
    const model = (await getModel()) as InstanceType<typeof mod.BasicPitch>;

    const frames: number[][] = [];
    const onsets: number[][] = [];
    const contours: number[][] = [];
    await model.evaluateModel(
      resampled,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (p) => onProgress?.(p),
    );

    // ⚠️ outputToNotesPoly 会原地 mutate 入参 —— 必须传副本，否则重跑拿到空结果
    const poly = mod.outputToNotesPoly(frames.slice(), onsets.slice(), 0.25, 0.25, 5);
    const bent = mod.addPitchBendsToNoteEvents(contours.slice(), poly);
    const timed = mod.noteFramesToTime(bent);

    // NoteEventTime 只有 start/end/pitchMidi；amplitude 挂在原始 NoteEvent 上
    const notes: MelodyNote[] = timed
      .filter((n) => Number.isFinite(n.startTimeSeconds) && Number.isFinite(n.pitchMidi))
      .map((n) => ({
        start: n.startTimeSeconds,
        end: n.startTimeSeconds + n.durationSeconds,
        midi: n.pitchMidi,
        amplitude: n.amplitude,
      }));

    if (notes.length === 0) throw new Error('basic-pitch 没有输出音符');
    return { notes, source: 'basic-pitch' };
  } catch {
    // 模型加载失败 / 推理失败（含 Node 里没有 OfflineAudioContext）→ FFT 主峰兜底
    return { notes: fftMelody(pcm, sr), source: 'fft-fallback' };
  }
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
