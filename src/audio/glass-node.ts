import { clamp } from '../util/math.ts';
import { hashFloat, mulberry32 } from '../util/prng.ts';
import { GLASS_SR } from './glass.ts';

/**
 * Node 端的玻璃音轨合成器。
 *
 * 与 `glass.ts`（浏览器 OfflineAudioContext）用的是同一套模态合成配方与同一个 seed，
 * 目的是让命令行出片（`scripts/render-video.mts`）的音轨和浏览器导出一致 ——
 * 否则用户会看到「浏览器导出是玻璃声、命令行出的是原曲」这种不一致。
 *
 * OfflineAudioContext 在 Node 里不存在，所以这里直接往 Float32Array 里叠加样本：
 * 每个音符 = 5 个不谐和正弦分音（指数衰减）+ 一阶高通的白噪 burst。
 */

export interface GlassNoteNode {
  t: number;
  midi: number | null;
  band: 'kick' | 'snare' | 'hat';
  accent: number;
  dt: number;
  panX: number;
}

const RATIOS = [1, 1.6, 2.2, 2.9, 3.6];
const AMPS = [1, 0.5, 0.34, 0.22, 0.14];
const BAND_MIDI = { kick: 45, snare: 52, hat: 74 } as const;

/** 一阶高通滤波（用于噪声 burst，去掉低频轰隆声） */
function highpass(src: Float32Array, fc: number, sr: number): Float32Array {
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + 1 / sr);
  const out = new Float32Array(src.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    prevOut = a * (prevOut + x - prevIn);
    prevIn = x;
    out[i] = prevOut;
  }
  return out;
}

/**
 * 离线渲染整条玻璃音轨（48kHz 单声道）。
 * 与浏览器版同一个 seed、同一套配方 —— 同输入同输出。
 */
export function renderGlassTrackNode(
  notes: GlassNoteNode[],
  durationSec: number,
  seed = 0x51a55,
): Float32Array {
  const sr = GLASS_SR;
  const total = Math.ceil((durationSec + 1) * sr);
  const out = new Float32Array(total);
  const rng = mulberry32(seed);

  // 预生成一份白噪 + 高通，全曲复用
  const rawNoise = new Float32Array(Math.ceil(0.5 * sr));
  for (let i = 0; i < rawNoise.length; i++) rawNoise[i] = rng() * 2 - 1;

  for (const n of notes) {
    if (!(n.t >= 0) || n.t > durationSec + 0.5) continue;
    const midi = n.midi ?? BAND_MIDI[n.band];
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const dur = clamp(0.3 * n.dt, 0.12, 0.6);
    const gain = n.band === 'hat' ? 0.25 : n.accent > 0.7 ? 1 : 0.5;
    // 单声道输出不做声像，但保留 pan 的能量差（±3dB）以免左右失衡
    const panGain = 1 - Math.min(0.6, Math.abs(n.panX) * 0.3);
    const start = Math.max(0, Math.round(n.t * sr));

    // —— 模态合成：5 个不谐和分音 ——
    for (let k = 0; k < RATIOS.length; k++) {
      const detune = (hashFloat(Math.round(n.t * 1000) + k * 7, k) - 0.5) * 0.004;
      const f = freq * RATIOS[k] * (1 + detune);
      const w = (2 * Math.PI * f) / sr;
      const decay = sr * dur * (n.band === 'kick' ? 1.4 : 1);
      const peak = gain * AMPS[k] * (n.band === 'kick' ? 1.25 : 1) * panGain;
      const attack = Math.max(1, Math.round(0.002 * sr));
      const len = Math.min(total - start, Math.round(decay) + attack);
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const env = i < attack ? i / attack : Math.exp(-(i - attack) / (decay * 0.32));
        const idx = start + i;
        if (idx >= total) break;
        out[idx] += Math.sin(phase) * peak * env;
        phase += w;
      }
    }

    // —— 高通噪声 burst ——
    const nDur = n.band === 'hat' ? 0.045 : 0.016;
    const nLen = Math.min(rawNoise.length, Math.round(nDur * sr));
    const ng = highpass(rawNoise.subarray(0, nLen), n.band === 'hat' ? 6000 : 3000, sr);
    const nPeak = gain * (n.band === 'hat' ? 0.9 : 0.3) * panGain;
    for (let i = 0; i < nLen; i++) {
      const idx = start + i;
      if (idx >= total) break;
      const env = Math.exp(-i / (nLen * 0.25));
      out[idx] += ng[i] * nPeak * env;
    }
  }

  // 软限幅，防止叠加爆音
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v > 1) out[i] = 1 - 1 / (v + 1);
    else if (v < -1) out[i] = -1 + 1 / (1 - v);
  }
  return out;
}

/** 线性插值重采样（Node 端没有 OfflineAudioContext 可用） */
export function resampleLinear(pcm: Float32Array, srFrom: number, srTo: number): Float32Array {
  if (srFrom === srTo) return pcm;
  const ratio = srFrom / srTo;
  const len = Math.floor(pcm.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 混音：out += glass * gain（等长或取较长者） */
export function mixInto(target: Float32Array, glass: Float32Array, gain: number): void {
  const n = Math.min(target.length, glass.length);
  for (let i = 0; i < n; i++) target[i] += glass[i] * gain;
}

/** 写一段 IEEE float32 的 WAVE 文件（ffmpeg 直接吃） */
export function writeWavF32le(pcm: Float32Array, sr: number, channels: number): Buffer {
  const bytesPerSample = 4;
  const dataLen = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeFloatLE(clamp(pcm[i], -1, 1), 44 + i * 4);
  return buf;
}
