/**
 * 音乐驱动下落速度的纯函数回归。
 *
 *   npm run verify:speed
 */
import assert from 'node:assert/strict';
import { activityAt, combineActivity, envelopeP90, longFactorFor, speedFor } from '../src/chart/speed.ts';
import { buildChart } from '../src/chart/build.ts';
import { buildWeights, DOWNBEAT_BOOST } from '../src/chart/styles.ts';
import { clamp } from '../src/util/math.ts';
import type { AnalysisResult, Band } from '../src/types.ts';

function fakeAnalysis(envelope: number[], hopSec = 0.1, bpm = 120): AnalysisResult {
  return {
    sr: 44100,
    duration: envelope.length * hopSec,
    bpm,
    bpmConfidence: 1,
    beats: [],
    envelope: Float32Array.from(envelope),
    hopSec,
  };
}

function gridAnalysis(envelope: number[], bpm: number, beats = 120): AnalysisResult {
  const beatLen = 0.5;
  const beatList = Array.from({ length: beats }, (_, i) => ({
    t: i * beatLen,
    power: 0.4 + 0.5 * (i % 4 === 0 ? 1 : 0.2),
    band: (i % 4 === 0 ? 'kick' : 'snare') as Band,
    synthetic: false,
  }));
  return {
    sr: 44100,
    duration: beats * beatLen,
    bpm,
    bpmConfidence: 1,
    beats: beatList,
    envelope: Float32Array.from(envelope),
    hopSec: 0.05,
  };
}

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

function ranks(xs: number[]): number[] {
  const order = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && xs[order[j + 1]] === xs[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  const mb = rb.reduce((s, v) => s + v, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i] - ma;
    const y = rb[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function chartSpeeds(chart: ReturnType<typeof buildChart>): number[] {
  return chart.segs.map((s) => s.dy / (s.t1 - s.t0));
}

function chartActivities(
  a: AnalysisResult,
  chart: ReturnType<typeof buildChart>,
): number[] {
  const p90 = envelopeP90(a);
  const weights = buildWeights(chart.boards);
  return chart.segs.map((s, i) => {
    const b = chart.boards[i];
    const wBase = clamp(weights[i] + (b && b.barPos === 0 ? DOWNBEAT_BOOST : 0), 0, 1);
    return combineActivity(activityAt(a, s.t0, s.t1, p90), wBase);
  });
}

const env = Array.from({ length: 1200 }, (_, i) => 0.05 + (i % 80 < 40 ? 0.1 : 1.0));

test('envelopeP90：空包络回退 1，正常包络取 p90', () => {
  assert.equal(envelopeP90(fakeAnalysis([])), 1);
  const a = fakeAnalysis([0, 0, 1, 1, 0, 0]);
  assert.equal(envelopeP90(a), 1);
  const b = fakeAnalysis(Array.from({ length: 10 }, (_, i) => i));
  assert.equal(envelopeP90(b), 9);
});

test('activityAt：取段落后 75% 的均值并按 p90 归一化', () => {
  const a = fakeAnalysis([0, 0, 1, 1, 0, 0]);
  assert.ok(close(activityAt(a, 0, 0.6, 1), 0.4));
  assert.ok(close(activityAt(a, 0, 0.6, 0.5), 0.8));
  assert.equal(activityAt(fakeAnalysis([]), 0, 1), 0.5);
  assert.equal(activityAt(a, 1, 1, 1), 0.5);
});

test('speedFor：drama=0 恒定为基础速度', () => {
  for (const bpm of [60, 120, 180]) {
    for (const act of [0, 0.5, 1]) {
      assert.ok(close(speedFor(520, bpm, act, 0), 520), `bpm=${bpm} act=${act}`);
    }
  }
});

test('speedFor：BPM 与活跃度单调，且有上下限', () => {
  const slow = speedFor(520, 60, 0.2, 0.7);
  const fast = speedFor(520, 180, 0.9, 0.7);
  assert.ok(fast > slow, `${fast} <= ${slow}`);

  const quiet = speedFor(520, 120, 0, 0.7);
  const loud = speedFor(520, 120, 1, 0.7);
  assert.ok(loud > quiet, `${loud} <= ${quiet}`);

  assert.ok(speedFor(520, 180, 1, 1) <= 520 * 1.9 + 1e-9);
  assert.ok(speedFor(520, 60, 0, 1) >= 520 * 0.45 - 1e-9);
});

test('combineActivity：包络与力度按 0.6/0.4 融合', () => {
  assert.ok(close(combineActivity(0, 0), 0));
  assert.ok(close(combineActivity(1, 1), 1));
  assert.ok(close(combineActivity(0.5, 0.5), 0.5));
  assert.ok(close(combineActivity(1, 0), 0.6));
});

test('Chart：网格逐段 V 与活跃度正相关', () => {
  const a = gridAnalysis(env, 120);
  const chart = buildChart(a, { drama: 0.7, preRoll: 0 });
  const speeds = chartSpeeds(chart);
  const acts = chartActivities(a, chart);
  const rho = spearman(acts, speeds);
  assert.ok(rho >= 0.5, `rho=${rho.toFixed(2)}`);
});

test('Chart：音符驱动逐段 V 与活跃度正相关', () => {
  const a = gridAnalysis(env, 120);
  const notes = Array.from({ length: 70 }, (_, i) => ({
    start: 0.2 + i * 0.7,
    end: 0.2 + i * 0.7 + 0.5,
    midi: 60 + (i % 12),
    amplitude: i % 4 === 0 ? 0.9 : 0.25,
  }));
  const chart = buildChart(a, { noteSource: notes, drama: 0.7, preRoll: 0 });
  const speeds = chartSpeeds(chart);
  const acts = chartActivities(a, chart);
  const rho = spearman(acts, speeds);
  assert.ok(rho >= 0.5, `rho=${rho.toFixed(2)}`);
});

test('Chart：drama=0 时所有段 V 等于基础速度', () => {
  const a = gridAnalysis(env, 120);
  const chart = buildChart(a, { drama: 0, preRoll: 0 });
  for (const v of chartSpeeds(chart)) assert.ok(close(v, 520), `v=${v}`);
});

test('Chart：BPM 因子生效（60 vs 180）', () => {
  const a60 = gridAnalysis(env, 60);
  const a180 = gridAnalysis(env, 180);
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const v60 = mean(chartSpeeds(buildChart(a60, { drama: 0.7, preRoll: 0 })));
  const v180 = mean(chartSpeeds(buildChart(a180, { drama: 0.7, preRoll: 0 })));
  assert.ok(v180 / v60 >= 1.3, `ratio=${(v180 / v60).toFixed(2)}`);
});

test('Chart：V 在 drama 上下限内且经过 EMA 平滑', () => {
  const a = gridAnalysis(env, 120);
  const chart = buildChart(a, { drama: 0.7, preRoll: 0 });
  const speeds = chartSpeeds(chart);
  const lo = 520 * (1 - 0.55 * 0.7);
  const hi = 520 * (1 + 0.9 * 0.7);
  for (const v of speeds) assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `v=${v}`);
  for (let i = 1; i < speeds.length; i++) {
    const ratio = Math.max(speeds[i], speeds[i - 1]) / Math.max(1e-9, Math.min(speeds[i], speeds[i - 1]));
    assert.ok(ratio <= 1.4, `相邻段跳变 ${ratio.toFixed(2)} @${i}`);
  }
});
test('longFactorFor：长间隔额外减速，drama=0 无效果', () => {
  assert.equal(longFactorFor(0.5, 0.7), 1);
  assert.ok(longFactorFor(5, 0.7) < 0.85);
  assert.equal(longFactorFor(5, 0), 1);
});

test('Chart：长间隔段的 V 明显低于密集段（网格）', () => {
  const beats = [];
  for (let i = 0; i < 8; i++) {
    beats.push({ t: i * 0.5, power: 0.8, band: 'kick' as Band, synthetic: false });
  }
  for (let i = 0; i < 8; i++) {
    beats.push({ t: 7.5 + i * 0.5, power: 0.8, band: 'kick' as Band, synthetic: false });
  }
  const a: AnalysisResult = {
    sr: 44100,
    duration: 12,
    bpm: 120,
    bpmConfidence: 1,
    beats,
    envelope: Float32Array.from({ length: 240 }, () => 0.5),
    hopSec: 0.05,
  };
  const chart = buildChart(a, { drama: 0.7, preRoll: 0 });
  const segs = chart.segs.map((s) => ({ t0: s.t0, v: s.dy / (s.t1 - s.t0) }));
  const gap = segs.filter((s) => s.t0 >= 3.5 && s.t0 < 7.5);
  const dense = segs.filter((s) => s.t0 < 3.5 || s.t0 >= 7.5);
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  assert.ok(gap.length >= 2);
  assert.ok(mean(gap.map((s) => s.v)) < mean(dense.map((s) => s.v)) * 0.95, '长间隔没有减速');
});

test('Chart：音频活跃度参与弹跳强弱', () => {
  const notes = Array.from({ length: 70 }, (_, i) => ({
    start: 0.2 + i * 0.7,
    end: 0.2 + i * 0.7 + 0.5,
    midi: 60 + (i % 12),
    amplitude: 0.6,
  }));
  const a = gridAnalysis(env, 120);
  const chart = buildChart(a, { noteSource: notes, drama: 0.7, preRoll: 0 });
  const p90 = envelopeP90(a);
  const high: number[] = [];
  const low: number[] = [];
  chart.segs.forEach((s) => {
    const act = activityAt(a, s.t0, s.t1, p90);
    if (act > 0.6) high.push(s.h);
    else if (act < 0.4) low.push(s.h);
  });
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  assert.ok(high.length > 0 && low.length > 0);
  assert.ok(mean(high) > mean(low) * 1.05, `高活跃 h=${mean(high).toFixed(1)} 低活跃 h=${mean(low).toFixed(1)}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(String(err instanceof Error ? err.stack ?? err.message : err));
  }
}
console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败项'} (${tests.length - failed}/${tests.length})`);
if (failed > 0) process.exitCode = 1;
