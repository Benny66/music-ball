/**
 * 用「已知标准答案」的测试曲验证整条链路：
 *   1. 拍点检测误差（vs 合成时写入的真实拍点）
 *   2. BPM 估计
 *   3. chart 的数值健全性（无 NaN / dt 在界内）
 *   4. 落点精确性（球在拍点时刻是否严格落在板上）
 *   5. 分析耗时
 *
 * 用法：npm run verify
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/analysis/pipeline.ts';
import { buildChart } from '../src/chart/build.ts';
import { evalBall, evalCamera } from '../src/chart/ball.ts';
import { BOARD_TILT_MAX } from '../src/chart/styles.ts';
import type { BallState } from '../src/types.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function readWav(path: string): { pcm: Float32Array; sr: number } {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { pcm, sr };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk: ' + path);
}

/**
 * 期望的拍点时刻：4/4 里每个四分音符都是一拍（kick 在 1、3，snare 在 2、4），
 * 不是只算 kick —— 只对齐 kick 会让「把 8 分音符当成拍」的错误完全看不出来。
 */
function expectedSteady(bpm: number, t0: number, bars: number): number[] {
  const beat = 60 / bpm;
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < 4; q++) out.push(t0 + (b * 4 + q) * beat);
  }
  return out;
}

interface MatchResult {
  matched: number;
  total: number;
  medianErrMs: number;
  p90ErrMs: number;
  maxErrMs: number;
  extra: number;
}

function match(detected: number[], expected: number[], tolMs: number): MatchResult {
  const tol = tolMs / 1000;
  const errs: number[] = [];
  let matched = 0;
  const used = new Uint8Array(detected.length);

  for (const e of expected) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < detected.length; i++) {
      if (used[i]) continue;
      const d = Math.abs(detected[i] - e);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= tol) {
      used[best] = 1;
      matched++;
      errs.push(bestD * 1000);
    }
  }

  errs.sort((a, b) => a - b);
  const q = (p: number): number => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * p))] : 0);

  return {
    matched,
    total: expected.length,
    medianErrMs: q(0.5),
    p90ErrMs: q(0.9),
    maxErrMs: errs.length ? errs[errs.length - 1] : 0,
    extra: detected.length - matched,
  };
}

function pct(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function checkChart(chart: ReturnType<typeof buildChart>): string[] {
  const problems: string[] = [];
  let minDt = Infinity;
  let maxDt = 0;
  let nan = 0;
  let maxGCorr = 0;
  let maxApexErr = 0;
  let maxTilt = 0;
  let maxOverhang = -Infinity;
  const hRatios: number[] = [];
  const tilts: number[] = [];

  for (const s of chart.segs) {
    const dt = s.t1 - s.t0;
    if (!Number.isFinite(dt) || dt <= 0) problems.push(`seg ${s.index} dt=${dt}`);
    minDt = Math.min(minDt, dt);
    maxDt = Math.max(maxDt, dt);
    if (![s.y0, s.dy, s.g, s.h, s.x0, s.x1, s.m0, s.m1].every(Number.isFinite)) nan++;

    // g 必须与 h 自洽：g = 2(√h + √(h+Δy))² / Δt²
    const a = Math.sqrt(Math.max(0, s.h));
    const b = Math.sqrt(Math.max(0, s.h) + s.dy);
    const gExpect = (2 * (a + b) * (a + b)) / (dt * dt);
    maxGCorr = Math.max(maxGCorr, Math.abs(s.g - gExpect) / Math.max(1, s.g));

    // 顶点高度必须真的等于 h（这是"h 与 g 必须绑定同一个 dt"的检验）
    if (s.g > 1e-6) {
      const sStar = s.t1 - s.t0 > 0 ? dt / 2 - s.dy / (s.g * dt) : 0;
      const sc = Math.max(0, Math.min(dt, sStar));
      const yAt = s.y0 + s.dy * (sc / dt) + 0.5 * s.g * sc * (sc - dt);
      maxApexErr = Math.max(maxApexErr, Math.abs(s.y0 - yAt - s.h));
    }

    hRatios.push(s.dy > 0 ? s.h / s.dy : 0);
  }

  for (const b of chart.boards) {
    if (!Number.isFinite(b.angle)) problems.push(`board ${b.index} angle=${b.angle}`);
    maxTilt = Math.max(maxTilt, Math.abs(b.angle));
    tilts.push(Math.abs(b.angle));
    // 旋转后的水平投影不许捅出赛道
    const xHalf = b.halfW * Math.abs(Math.cos(b.angle)) + (b.thick / 2) * Math.abs(Math.sin(b.angle));
    maxOverhang = Math.max(maxOverhang, xHalf - chart.trackW / 2);
  }

  // 落点精确性：在每个拍点求值，球心必须严格在板中心
  const st: BallState = { x: 0, y: 0, seg: 0 };
  let maxYErr = 0;
  let maxXErr = 0;
  for (const s of chart.segs) {
    evalBall(chart, s.t1, st);
    maxYErr = Math.max(maxYErr, Math.abs(st.y - (s.y0 + s.dy)));
    maxXErr = Math.max(maxXErr, Math.abs(st.x - s.x1));
    // 相机在拍点处必须等于球的世界 y
    const cam = evalCamera(chart, s.t1);
    maxYErr = Math.max(maxYErr, Math.abs(cam - (s.y0 + s.dy)));
  }

  // 全时段扫描 NaN
  for (let t = 0; t <= chart.duration; t += 0.017) {
    evalBall(chart, t, st);
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) nan++;
  }

  const kinds = { normal: 0, spring: 0, break: 0 };
  for (const b of chart.boards) kinds[b.kind]++;

  const TILT_MAX = BOARD_TILT_MAX;
  if (nan > 0) problems.push(`NaN 出现 ${nan} 次`);
  if (minDt < 0.124) problems.push(`dt 过小 ${minDt.toFixed(4)}`);
  if (maxYErr > 1e-6) problems.push(`落点 y 误差 ${maxYErr.toExponential(2)}`);
  if (maxXErr > 1e-6) problems.push(`落点 x 误差 ${maxXErr.toExponential(2)}`);
  if (maxGCorr > 1e-6) problems.push(`g 与 h 不自洽 ${maxGCorr.toExponential(2)}`);
  if (maxApexErr > 1e-4) problems.push(`顶点高度与 h 不符 ${maxApexErr.toExponential(2)}`);
  if (maxTilt > TILT_MAX + 1e-9) problems.push(`倾角越界 ${(maxTilt / Math.PI * 180).toFixed(1)}°`);
  if (maxOverhang > -8) problems.push(`板子捅出赛道 ${maxOverhang.toFixed(1)}`);

  const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
  console.log(
    `  chart: segs=${chart.segs.length} dt=[${minDt.toFixed(3)}, ${maxDt.toFixed(3)}] ` +
      `落点误差 y=${maxYErr.toExponential(1)} x=${maxXErr.toExponential(1)} ${problems.length ? '❌' : '✅'}`,
  );
  console.log(
    `  板子: h/Δy p10=${pct(hRatios, 0.1).toFixed(2)} p50=${pct(hRatios, 0.5).toFixed(2)} ` +
      `p90=${pct(hRatios, 0.9).toFixed(2)}  倾角 p50=${deg(pct(tilts, 0.5))}° p90=${deg(pct(tilts, 0.9))}° ` +
      `max=${deg(maxTilt)}°  小节=${chart.stats.barLen}/4 phase=${chart.stats.barPhase}  特殊板 ${JSON.stringify(kinds)}`,
  );
  return problems;
}

function runCase(name: string, file: string, expected: number[] | null): boolean {
  console.log(`\n=== ${name} (${file}) ===`);
  const { pcm, sr } = readWav(join(DIR, file));
  const duration = pcm.length / sr;

  const t0 = performance.now();
  const res = analyze(pcm, sr, duration);
  const elapsed = performance.now() - t0;

  const detected = res.beats.filter((b) => !b.synthetic).map((b) => b.t);
  const bands = { kick: 0, snare: 0, hat: 0 };
  for (const b of res.beats) if (!b.synthetic) bands[b.band]++;

  console.log(
    `  分析: ${elapsed.toFixed(0)}ms  bpm=${res.bpm.toFixed(2)} conf=${res.bpmConfidence.toFixed(2)} ` +
      `拍数=${detected.length} (${(detected.length / duration).toFixed(2)}/s) ` +
      `band=${JSON.stringify(bands)}`,
  );

  const chart = buildChart(res);
  const problems = checkChart(chart);
  if (problems.length) console.log('  问题: ' + problems.join(' | '));

  // drama=0 必须退回旧观感：h 恒为 Δy/3（或被动上界压低）、无倾角、无特殊板
  {
    const plain = buildChart(res, { drama: 0 });
    const p2: string[] = [];
    let over = 0;
    let clamped = 0;
    for (const s of plain.segs) {
      const target = s.dy / 3;
      if (s.h > target + 1e-9) over = Math.max(over, s.h - target);
      if (s.h < target - 1e-9) clamped++;
    }
    if (over > 1e-9) p2.push(`h 超过 Δy/3（${over.toExponential(2)}）`);
    if (plain.boards.some((b) => Math.abs(b.angle) > 1e-12)) p2.push('仍有倾角');
    if (plain.boards.some((b) => b.kind !== 'normal')) p2.push('仍有特殊板');
    problems.push(...p2);
    console.log(
      `  drama=0: h 恒等于 Δy/3${clamped > 0 ? `（${clamped} 段被几何上界压低）` : ''} ` +
        `${p2.length ? '❌ ' + p2.join('; ') : '✅'}`,
    );
  }

  let ok = problems.length === 0;
  if (expected && expected.length > 0) {
    // 合成轨道可能比音频本身长，只比较落在音频内的期望拍
    const inRange = expected.filter((t) => t < duration - 0.05);
    const m = match(detected, inRange, 35);
    const rate = m.matched / Math.max(1, m.total);
    console.log(
      `  对拍: ${m.matched}/${m.total} (${(rate * 100).toFixed(1)}%) ` +
        `中位误差=${m.medianErrMs.toFixed(1)}ms p90=${m.p90ErrMs.toFixed(1)}ms max=${m.maxErrMs.toFixed(1)}ms ` +
        `多检=${m.extra} ${rate >= 0.9 ? '✅' : '❌'}`,
    );
    if (rate < 0.9) ok = false;
  }

  return ok;
}

const results: boolean[] = [];

results.push(runCase('稳态 120BPM', 'steady-120.wav', expectedSteady(120, 0.6, 30)));
results.push(runCase('8 秒空当前奏 128BPM', 'intro-silence-128.wav', expectedSteady(128, 8.0, 24)));

{
  const a = expectedSteady(100, 0.5, 10);
  const tEnd = 0.5 + 10 * 4 * (60 / 100);
  const b = expectedSteady(140, tEnd, 20);
  results.push(runCase('中途变速 100→140', 'tempo-change-100-140.wav', [...a, ...b]));
}

{
  // 钢琴曲：无鼓、长延音、旋律 + 分解和弦（真值由 make-piano.mts 生成）
  const pt = JSON.parse(readFileSync(join(DIR, 'piano-90.truth.json'), 'utf8')) as {
    beats: number[];
  };
  results.push(runCase('钢琴曲 90BPM（小星星 + 分解和弦）', 'piano-90.wav', pt.beats));
}
{
  const beat = 60 / 150;
  const waltz: number[] = [];
  for (let bar = 0; bar < 40; bar++) {
    for (let q = 0; q < 3; q++) waltz.push(0.4 + (bar * 3 + q) * beat);
  }
  results.push(runCase('3/4 拍 150BPM', 'waltz-150-3-4.wav', waltz));
}

console.log(
  `\n${results.every(Boolean) ? '✅ 全部通过' : '❌ 有失败项'}  (${results.filter(Boolean).length}/${results.length})`,
);
process.exit(results.every(Boolean) ? 0 : 1);
