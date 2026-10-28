/**
 * 生成一首「已知标准答案」的钢琴测试曲。
 *
 * 钢琴和流行歌的信号特征完全不同，是现有流水线的盲区：
 *   - 无鼓：kick/snare/hat 的分类没有意义
 *   - 长延音：一个音鸣响 1–3 秒，onset 包络是「尖峰 + 长尾」
 *   - 旋律 + 分解和弦：8 分音符的伴奏会测试 dtMin 合并逻辑
 *   - 力度起伏大
 *
 * 输出 fixtures/piano-90.wav + piano-90.truth.json（精确的拍点网格与旋律音高）。
 *
 *   node --experimental-strip-types scripts/make-piano.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'fixtures');
const SR = 44100;

const BPM = 90;
const BEAT = 60 / BPM; // 0.6667s
const T0 = 2.0; // 前奏静音 2 秒（测试前奏外推）
const BARS = 24;

/** 钢琴音色：谐波列 + 琴弦张力导致的微不谐和 + 长指数衰减（低音更长） */
function pianoNote(buf: Float32Array, sr: number, t0: number, freq: number, dur: number, vel: number): void {
  const start = Math.round(t0 * sr);
  const len = Math.min(buf.length - start, Math.round(dur * sr));
  if (len <= 0) return;
  const B = 0.00025; // 琴弦刚度 → 高谐波越来越偏离整数倍
  const decayT = (freq < 200 ? 3.2 : freq < 500 ? 2.2 : 1.4) * sr; // 低音更长
  const attack = Math.max(1, Math.round(0.004 * sr));
  for (let k = 1; k <= 6; k++) {
    const f = freq * k * Math.sqrt(1 + B * k * k);
    if (f > sr * 0.45) break;
    const amp = vel * (1 / Math.pow(k, 1.25)) * (k === 1 ? 0.55 : 1);
    const w = (2 * Math.PI * f) / sr;
    const phase = k * 0.7;
    for (let i = 0; i < len; i++) {
      const env =
        i < attack ? i / attack : Math.exp(-(i - attack) / (decayT / Math.sqrt(k)));
      buf[start + i] += Math.sin(phase + w * i) * amp * env;
    }
  }
}

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** 小星星（C 大调）。返回 [拍位（以拍计）, MIDI, 时值（拍）] */
function melody(): Array<[number, number, number]> {
  const q = 1; // 一拍
  const h = 2;
  const seq: Array<[number, number, number]> = [];
  const phrase: Array<[number, number]> = [
    [0, 72], [1, 72], [2, 79], [3, 79], [4, 81], [5, 81], [6, 79],
  ]; // do do sol sol la la sol~
  let bar = 0;
  for (let rep = 0; rep < 6; rep++) {
    for (const [beat, midi] of phrase) {
      const dur = beat === 6 ? h : q;
      seq.push([bar * 4 + beat, midi, dur]);
      if (beat === 6) bar += 2;
    }
    bar += 2; // 每句 2 小节（7 拍 + 1 拍休止）
  }
  return seq;
}

/** 左手分解和弦：每拍根-五-三-五（8 分音符），测试 dtMin 与密集 onset */
function accompaniment(): Array<[number, number, number]> {
  const roots = [48, 48, 53, 53, 57, 57, 53, 53]; // C C F F A A F F（每小节换）
  const out: Array<[number, number, number]> = [];
  for (let bar = 0; bar < BARS; bar++) {
    const root = roots[bar % roots.length];
    for (let e = 0; e < 8; e++) {
      const chord = [root, root + 7, root + 4, root + 7];
      out.push([bar * 4 + e * 0.5, chord[e % 4], 0.45]);
    }
  }
  return out;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const duration = T0 + BARS * 4 * BEAT + 3;
  const n = Math.round(duration * SR);
  const buf = new Float32Array(n);

  const melodyNotes = melody();
  const accompNotes = accompaniment();

  for (const [beat, midi, durBeats] of melodyNotes) {
    pianoNote(buf, SR, T0 + beat * BEAT, midiToFreq(midi), durBeats * BEAT * 1.15, 0.5);
  }
  for (const [beat, midi, durBeats] of accompNotes) {
    pianoNote(buf, SR, T0 + beat * BEAT, midiToFreq(midi), durBeats * BEAT * 0.9, 0.22);
  }

  // 轻微整体动态起伏（测试响度变化下的阈值稳定性）
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    buf[i] *= 0.85 + 0.15 * Math.sin((2 * Math.PI * t) / 13);
  }
  // 峰值归一到 -1dBFS
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const norm = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
  for (let i = 0; i < n; i++) buf[i] *= norm;

  // 16-bit WAV
  const dataLen = n * 2;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SR, 24);
  wav.writeUInt32LE(SR * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  }
  const wavPath = join(OUT_DIR, 'piano-90.wav');
  writeFileSync(wavPath, wav);

  // 真值
  const beats: number[] = [];
  for (let k = 0; k < BARS * 4; k++) beats.push(+(T0 + k * BEAT).toFixed(4));
  const melodyTruth = melodyNotes.map(([beat, midi, durBeats]) => ({
    t: +(T0 + beat * BEAT).toFixed(4),
    midi,
    end: +(T0 + (beat + durBeats) * BEAT).toFixed(4),
  }));
  writeFileSync(
    join(OUT_DIR, 'piano-90.truth.json'),
    JSON.stringify({ bpm: BPM, t0: T0, beatLen: BEAT, beats, melody: melodyTruth }, null, 1),
  );

  console.log(`已生成 ${wavPath}`);
  console.log(`时长 ${duration.toFixed(1)}s  BPM ${BPM}  拍数 ${beats.length}  旋律音 ${melodyTruth.length}  伴奏音 ${accompNotes.length}`);
}

main();
