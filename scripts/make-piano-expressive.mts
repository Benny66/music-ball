/**
 * 生成一首「表达性」钢琴测试曲：切分、装饰音/快速跑动、rubato、长音、休止、
 * 强弱段、上行/下行音阶、和弦都覆盖。真值 JSON 给出每个音符的精确起点。
 *
 * 输出 fixtures/piano-expressive.wav（被 .gitignore 忽略）
 *      fixtures/piano-expressive.truth.json（入库）
 *
 *   node --experimental-strip-types scripts/make-piano-expressive.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'fixtures');
const SR = 44100;

const BPM = 100;
const BEAT = 60 / BPM; // 0.6s
const T0 = 2.0; // 前奏静音，测试「静音段不产生假撞击」
const TAIL = 2.0;

interface Note {
  t: number;
  midi: number;
  dur: number;
  vel: number;
  isMelody: boolean;
}

interface Section {
  name: string;
  start: number;
  end: number;
}

const notes: Note[] = [];
const sections: Section[] = [];
let cursor = T0;

function add(t: number, midi: number, dur: number, vel: number, isMelody = true): void {
  notes.push({ t, midi, dur, vel, isMelody });
}

function begin(name: string): void {
  sections.push({ name, start: cursor, end: cursor });
}

function end(): void {
  const s = sections[sections.length - 1];
  if (s) s.end = cursor;
}

/** 钢琴音色：谐波列 + 微不谐和 + 长指数衰减（低音更长） */
function pianoNote(buf: Float32Array, sr: number, t0: number, freq: number, dur: number, vel: number): void {
  const start = Math.round(t0 * sr);
  if (start >= buf.length) return;
  const len = Math.min(buf.length - start, Math.round(dur * sr));
  if (len <= 0) return;
  const B = 0.00025;
  const decayT = (freq < 200 ? 3.2 : freq < 500 ? 2.2 : 1.4) * sr;
  const attack = Math.max(1, Math.round(0.004 * sr));
  for (let k = 1; k <= 6; k++) {
    const f = freq * k * Math.sqrt(1 + B * k * k);
    if (f > sr * 0.45) break;
    const amp = vel * (1 / Math.pow(k, 1.25)) * (k === 1 ? 0.55 : 1);
    const w = (2 * Math.PI * f) / sr;
    const phase = k * 0.7;
    for (let i = 0; i < len; i++) {
      const env = i < attack ? i / attack : Math.exp(-(i - attack) / (decayT / Math.sqrt(k)));
      buf[start + i] += Math.sin(phase + w * i) * amp * env;
    }
  }
}

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// 1) 上行音阶，弱奏
begin('scale-up-soft');
for (let i = 0; i < 8; i++) add(cursor + i * BEAT, 60 + i, BEAT * 0.9, 0.3);
cursor += 8 * BEAT + 0.6;
end();

// 2) 下行音阶，强奏
begin('scale-down-loud');
for (let i = 0; i < 8; i++) add(cursor + i * BEAT, 67 - i, BEAT * 0.9, 0.85);
cursor += 8 * BEAT + 0.6;
end();

// 3) 切分：大量音符落在非整拍
begin('syncopation');
{
  const offsets = [0, 0.5, 1.5, 2, 2.5, 3.5, 4, 5, 5.5, 6.5];
  const midis = [64, 67, 72, 71, 67, 64, 69, 72, 67, 64];
  for (let i = 0; i < offsets.length; i++) add(cursor + offsets[i] * BEAT, midis[i], BEAT * 0.8, 0.55);
  cursor += 7 * BEAT + 0.6;
}
end();

// 4) 快速跑动：16 个 32 分音符，间隔 0.12s，低于 125ms 合并阈值
begin('fast-run');
{
  const step = BEAT * 0.2;
  for (let i = 0; i < 16; i++) {
    const midi = 60 + (i < 8 ? i : 15 - i);
    add(cursor + i * step, midi, step * 0.8, i % 2 === 0 ? 0.9 : 0.35);
  }
  cursor += 16 * step + 0.6;
}
end();

// 5) 长音 + 休止：4 秒长音，2 秒静音，再来一个短音
begin('long-rest');
add(cursor, 48, 4.0, 0.7);
cursor += 6.0;
add(cursor, 72, 1.2, 0.6);
cursor += 1.2 + 0.6;
end();

// 6) 和弦：同时起音，力度递增
begin('chords');
{
  const chords: Array<[number, number[]]> = [
    [0.55, [60, 64, 67]],
    [0.7, [65, 69, 72]],
    [0.9, [67, 71, 74]],
  ];
  for (const [vel, midis] of chords) {
    for (const midi of midis) add(cursor, midi, 1.2, vel);
    cursor += 1.8;
  }
  cursor += 0.6;
}
end();

// 7) Rubato：拍长从 0.60 拉到 0.84 再收回
begin('rubato');
{
  const lens = [0.6, 0.66, 0.72, 0.78, 0.84, 0.78, 0.72, 0.66];
  const midis = [60, 62, 64, 65, 67, 69, 71, 72];
  for (let i = 0; i < lens.length; i++) {
    add(cursor, midis[i], lens[i] * 0.9, 0.5);
    cursor += lens[i];
  }
  cursor += 0.6;
}
end();

// 8) 强弱交替：同音高、同间隔，只变力度
begin('dynamics');
for (let i = 0; i < 8; i++) add(cursor + i * BEAT, 72, BEAT * 0.8, i % 2 === 0 ? 0.9 : 0.25);
cursor += 8 * BEAT + 1.0;
end();

const duration = cursor + TAIL;
const n = Math.round(duration * SR);
const buf = new Float32Array(n);

for (const note of notes) {
  pianoNote(buf, SR, note.t, midiToFreq(note.midi), note.dur, note.vel);
}

// 轻微整体动态起伏（测试响度变化下的阈值稳定性）
for (let i = 0; i < n; i++) {
  const t = i / SR;
  buf[i] *= 0.9 + 0.1 * Math.sin((2 * Math.PI * t) / 11);
}
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
for (let i = 0; i < n; i++) buf[i] *= norm;

function writeWav(path: string): void {
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
  writeFileSync(path, wav);
}

mkdirSync(OUT_DIR, { recursive: true });
const wavPath = join(OUT_DIR, 'piano-expressive.wav');
writeWav(wavPath);

const allNotes = notes
  .slice()
  .sort((a, b) => a.t - b.t || b.midi - a.midi)
  .map((note) => ({
    t: +note.t.toFixed(4),
    midi: note.midi,
    dur: +note.dur.toFixed(4),
    amp: note.vel,
    isMelody: note.isMelody,
  }));

writeFileSync(
  join(OUT_DIR, 'piano-expressive.truth.json'),
  JSON.stringify({ bpm: BPM, t0: T0, beatLen: BEAT, duration: +duration.toFixed(3), sections, allNotes }, null, 1),
);

console.log(`已生成 ${wavPath}`);
console.log(`时长 ${duration.toFixed(1)}s  BPM ${BPM}  音符 ${allNotes.length}  段落 ${sections.length}`);
