/**
 * 生成带「已知标准答案」的测试曲，用来验证拍点检测与运动学的准确性。
 *
 * 用法：npm run testtrack
 * 产物：fixtures/*.wav（16-bit PCM 44.1kHz 单声道）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Hit {
  t: number;
  kind: 'kick' | 'snare' | 'hat';
  amp: number;
}

/** 反推出的简化鼓机：kick 用带扫频的正弦，snare 用噪声爆发 + 200Hz 体 */
function render(hits: Hit[], duration: number, pad: boolean): Float32Array {
  const n = Math.ceil(duration * SR);
  const buf = new Float32Array(n);

  let rngState = 0x1234567;
  const rnd = (): number => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return ((rngState >>> 0) / 4294967296) * 2 - 1;
  };

  for (const h of hits) {
    const start = Math.round(h.t * SR);
    if (h.kind === 'kick') {
      const len = Math.round(0.36 * SR);
      let phase = 0;
      for (let i = 0; i < len && start + i < n; i++) {
        const tt = i / SR;
        const f = 118 * Math.exp(-tt / 0.035) + 42;
        phase += (2 * Math.PI * f) / SR;
        const env = Math.exp(-tt / 0.085) * (1 - Math.exp(-tt / 0.002));
        buf[start + i] += Math.sin(phase) * env * h.amp;
      }
    } else if (h.kind === 'snare') {
      const len = Math.round(0.19 * SR);
      for (let i = 0; i < len && start + i < n; i++) {
        const tt = i / SR;
        const env = Math.exp(-tt / 0.048);
        const noise = rnd() * 0.85 + Math.sin(2 * Math.PI * 197 * tt) * 0.35;
        buf[start + i] += noise * env * h.amp;
      }
    } else {
      const len = Math.round(0.055 * SR);
      for (let i = 0; i < len && start + i < n; i++) {
        const tt = i / SR;
        const env = Math.exp(-tt / 0.014);
        buf[start + i] += rnd() * env * h.amp;
      }
    }
  }

  if (pad) {
    // 温和的和弦垫底，模拟真实的频谱占用（不含瞬态，不该影响拍点）
    const freqs = [220, 277.18, 329.63];
    for (let i = 0; i < n; i++) {
      const tt = i / SR;
      const bar = Math.floor(tt / 2);
      let s = 0;
      for (let k = 0; k < freqs.length; k++) s += Math.sin(2 * Math.PI * freqs[k] * tt + bar);
      buf[i] += (s / freqs.length) * 0.055;
    }
  }

  // 归一化到 -3dBFS
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const gain = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < n; i++) buf[i] *= gain;
  return buf;
}

function writeWav(path: string, pcm: Float32Array): void {
  const n = pcm.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** 按 BPM 生成 4/4 鼓组：kick 在 1、3 拍，snare 在 2、4 拍，hat 在八分音符 */
function drumPattern(bpm: number, t0: number, bars: number, swing = 0): Hit[] {
  const beat = 60 / bpm;
  const hits: Hit[] = [];
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < 4; q++) {
      const t = t0 + (b * 4 + q) * beat;
      if (q === 0 || q === 2) hits.push({ t, kind: 'kick', amp: 0.95 });
      if (q === 1 || q === 3) hits.push({ t, kind: 'snare', amp: 0.55 });
      hits.push({ t, kind: 'hat', amp: 0.24 });
      const off = t + beat * (0.5 + (q % 2 === 1 ? swing : 0));
      hits.push({ t: off, kind: 'hat', amp: 0.17 });
    }
  }
  return hits.sort((a, b) => a.t - b.t);
}

mkdirSync(OUT_DIR, { recursive: true });

// 1) 标准 120BPM 电子乐 —— 最简单、必须通过的基线
{
  const hits = drumPattern(120, 0.6, 30);
  const pcm = render(hits, 62, true);
  writeWav(join(OUT_DIR, 'steady-120.wav'), pcm);
  writeFileSync(join(OUT_DIR, 'steady-120.beats.json'), JSON.stringify(hits.filter((h) => h.kind === 'kick'), null, 0));
  console.log('steady-120.wav  hits=%d', hits.length);
}

// 2) 8 秒空当前奏（检验外推能不能把开头填满）
{
  const hits = drumPattern(128, 8.0, 24);
  const pcm = render(hits, 58, true);
  writeWav(join(OUT_DIR, 'intro-silence-128.wav'), pcm);
  console.log('intro-silence-128.wav  hits=%d', hits.length);
}

// 3) 中途变速 100 → 140（检验 DP 跟踪能不能跟上，全局网格必然崩）
{
  const a = drumPattern(100, 0.5, 10);
  const tEnd = 0.5 + 10 * 4 * (60 / 100);
  const b = drumPattern(140, tEnd, 20);
  const pcm = render([...a, ...b].sort((x, y) => x.t - y.t), 52, true);
  writeWav(join(OUT_DIR, 'tempo-change-100-140.wav'), pcm);
  console.log('tempo-change-100-140.wav');
}

// 4) 3/4 拍圆舞曲（检验不是 4/4 时会不会漏拍）
{
  const beat = 60 / 150;
  const hits: Hit[] = [];
  for (let bar = 0; bar < 40; bar++) {
    for (let q = 0; q < 3; q++) {
      const t = 0.4 + (bar * 3 + q) * beat;
      if (q === 0) hits.push({ t, kind: 'kick', amp: 0.9 });
      else hits.push({ t, kind: 'hat', amp: 0.35 });
    }
  }
  const pcm = render(hits, 50, true);
  writeWav(join(OUT_DIR, 'waltz-150-3-4.wav'), pcm);
  console.log('waltz-150-3-4.wav');
}

console.log('\n输出目录:', OUT_DIR);
