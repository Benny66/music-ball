/**
 * 音符驱动链路的回归测试。
 *
 * 与 verify.mts 的分工：
 *   verify.mts      拍点检测 / 网格图表 / 现有鼓组回归
 *   verify-note.mts 音符事件对齐 / 位置与力度映射 / 静音段 / 自动判定
 *
 * 真值来自 scripts/make-piano-expressive.mts，音符起点是合成时写入的精确值。
 *
 *   npm run pianotrack
 *   npm run verify:note
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { analyze } from '../src/analysis/pipeline.ts';
import { selectRhythmMode, kickRatio } from '../src/analysis/rhythm-mode.ts';
import { buildChart } from '../src/chart/build.ts';
import { boardsFromNotes } from '../src/chart/notes.ts';
import { trackLimit } from '../src/chart/styles.ts';
import { notesFromChart } from '../src/audio/glass.ts';
import type { AnalysisResult, Band, Board } from '../src/types.ts';
import type { MelodyNote, MelodyResult } from '../src/analysis/melody.ts';
import { snapNotesToOnsets } from '../src/analysis/melody.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

if (!existsSync(join(DIR, 'piano-expressive.wav'))) {
  console.error('缺少 fixtures/piano-expressive.wav，请先运行 npm run pianotrack');
  process.exit(1);
}

interface TruthNote {
  t: number;
  midi: number;
  dur: number;
  amp: number;
  isMelody: boolean;
}

interface Truth {
  bpm: number;
  t0: number;
  beatLen: number;
  duration: number;
  sections: Array<{ name: string; start: number; end: number }>;
  allNotes: TruthNote[];
}

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

function toMelodyNotes(truth: Truth): MelodyNote[] {
  return truth.allNotes.map((n) => ({
    start: n.t,
    end: n.t + n.dur,
    midi: n.midi,
    amplitude: n.amp,
  }));
}

function loadFixture(): { truth: Truth; res: AnalysisResult; notes: MelodyNote[] } {
  const truth = JSON.parse(readFileSync(join(DIR, 'piano-expressive.truth.json'), 'utf8')) as Truth;
  const { pcm, sr } = readWav(join(DIR, 'piano-expressive.wav'));
  const res = analyze(pcm, sr, pcm.length / sr);
  return { truth, res, notes: toMelodyNotes(truth) };
}

let cachedFixture: { truth: Truth; res: AnalysisResult; notes: MelodyNote[] } | null = null;
function fixture(): { truth: Truth; res: AnalysisResult; notes: MelodyNote[] } {
  if (!cachedFixture) cachedFixture = loadFixture();
  return cachedFixture;
}

function decodeAudio(path: string): { pcm: Float32Array; sr: number } {
  if (path.endsWith('.wav')) return readWav(path);
  const sr = 44100;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], {
    maxBuffer: 1024 * 1024 * 512,
  });
  if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${path}\n${r.stderr.toString()}`);
  const b = r.stdout;
  const pcm = new Float32Array(b.length / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = b.readFloatLE(i * 4);
  return { pcm, sr };
}

const tests: Array<[string, () => void]> = [];

function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

// ---------- 001 数据契约 ----------

test('音符板携带 midi/dyn，网格板不携带', () => {
  const { res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const real = chart.boards.filter((b) => !b.ghost && !b.synthetic);
  assert.ok(real.length > 10, `音符板太少: ${real.length}`);
  for (const b of real as Array<Board & { midi?: number; dyn?: number }>) {
    assert.ok(Number.isFinite(b.midi), `board ${b.index} 缺 midi`);
    assert.ok(Number.isFinite(b.dyn), `board ${b.index} 缺 dyn`);
    assert.ok((b.midi as number) >= 21 && (b.midi as number) <= 108, `board ${b.index} midi 越界`);
    assert.ok((b.dyn as number) >= 0 && (b.dyn as number) <= 1, `board ${b.index} dyn 越界`);
  }

  const grid = buildChart(res);
  for (const b of grid.boards as Array<Board & { midi?: number; dyn?: number }>) {
    assert.equal(b.midi, undefined, `网格板 ${b.index} 不应有 midi`);
    assert.equal(b.dyn, undefined, `网格板 ${b.index} 不应有 dyn`);
  }
});

test('midi/dyn 穿过 stride / 长间隔细分 / 预卷后仍保留在真实板上', () => {
  const { res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes, stride: 2 });
  const real = chart.boards.filter((b) => !b.ghost && !b.synthetic) as Array<Board & { midi?: number; dyn?: number }>;
  assert.ok(real.length > 5);
  for (const b of real) {
    assert.ok(Number.isFinite(b.midi), `stride 后 board ${b.index} 缺 midi`);
    assert.ok(Number.isFinite(b.dyn), `stride 后 board ${b.index} 缺 dyn`);
  }
  const ghosts = chart.boards.filter((b) => b.ghost || b.synthetic) as Array<Board & { midi?: number; dyn?: number }>;
  for (const b of ghosts) {
    assert.equal(b.midi, undefined, `ghost/预卷 board ${b.index} 不应有 midi`);
    assert.equal(b.dyn, undefined, `ghost/预卷 board ${b.index} 不应有 dyn`);
  }
});

test('真值 fixture 覆盖 8 个段落且音符数足够', () => {
  const { truth } = fixture();
  assert.equal(truth.sections.length, 8);
  assert.ok(truth.allNotes.length >= 60);
  assert.ok(truth.sections.some((s) => s.name === 'fast-run'));
  assert.ok(truth.sections.some((s) => s.name === 'long-rest'));
  assert.ok(truth.sections.some((s) => s.name === 'rubato'));
});

// ---------- 002 纯模式判定 ----------

function fakeAnalysis(bands: Band[], syntheticKick = false): AnalysisResult {
  const beats = bands.map((band, i) => ({
    t: i * 0.5,
    power: 0.5,
    band,
    synthetic: false,
  }));
  if (syntheticKick) beats.push({ t: 99, power: 0.5, band: 'kick', synthetic: true });
  return {
    sr: 44100,
    duration: bands.length * 0.5 + 1,
    bpm: 120,
    bpmConfidence: 1,
    beats,
    envelope: new Float32Array(0),
    hopSec: 256 / 44100,
  };
}

function fakeMelody(n: number, source: MelodyResult['source'] = 'basic-pitch'): MelodyResult {
  return {
    notes: Array.from({ length: n }, (_, i) => ({
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      midi: 60 + (i % 12),
      amplitude: 0.5,
    })),
    source,
  };
}

test('手动选择优先于自动判定，但模型来源不可用时回退网格', () => {
  const res = fakeAnalysis(Array(50).fill('kick') as Band[]);
  assert.equal(selectRhythmMode(res, fakeMelody(50), 'notes').mode, 'notes');
  assert.equal(selectRhythmMode(res, fakeMelody(50), 'grid').mode, 'grid');
  assert.equal(selectRhythmMode(res, null, 'notes').mode, 'grid');

  const fallback = selectRhythmMode(res, fakeMelody(50, 'fft-fallback'), 'notes');
  assert.equal(fallback.mode, 'grid');
  assert.match(fallback.reason, /回退/);

  const autoFallback = selectRhythmMode(res, fakeMelody(50, 'fft-fallback'), 'auto');
  assert.equal(autoFallback.mode, 'grid');
  assert.match(autoFallback.reason, /回退/);
});

test('自动判定：钢琴 → 音符，鼓组 → 网格', () => {
  const { res, notes } = fixture();
  const piano = selectRhythmMode(res, { notes, source: 'basic-pitch' }, 'auto');
  assert.equal(piano.mode, 'notes', piano.reason);

  for (const f of ['steady-120.wav', 'intro-silence-128.wav', 'tempo-change-100-140.wav', 'waltz-150-3-4.wav']) {
    const { pcm, sr } = readWav(join(DIR, f));
    const r = analyze(pcm, sr, pcm.length / sr);
    const d = selectRhythmMode(r, fakeMelody(120), 'auto');
    assert.equal(d.mode, 'grid', `${f}: ${d.mode} · ${d.reason}`);
    console.log(`      ${f}  grid  high=${(r.highRatio ?? 0).toFixed(3)} reg=${(r.quality?.regularity ?? 0).toFixed(2)}`);
  }

  const { pcm, sr } = readWav(join(DIR, 'piano-90.wav'));
  const r = analyze(pcm, sr, pcm.length / sr);
  const d = selectRhythmMode(r, fakeMelody(42), 'auto');
  assert.equal(d.mode, 'notes', `piano-90: ${d.mode} · ${d.reason}`);
  console.log(`      piano-90.wav  notes  high=${(r.highRatio ?? 0).toFixed(3)} reg=${(r.quality?.regularity ?? 0).toFixed(2)}`);
});

test('模型不可用或音符不足时回退网格', () => {
  const { res } = fixture();
  const fallback = selectRhythmMode(res, fakeMelody(69, 'fft-fallback'), 'auto');
  assert.equal(fallback.mode, 'grid');
  assert.match(fallback.reason, /回退/);

  const manualFallback = selectRhythmMode(res, fakeMelody(69, 'fft-fallback'), 'notes');
  assert.equal(manualFallback.mode, 'grid');
  assert.match(manualFallback.reason, /回退/);

  const fewAuto = selectRhythmMode(res, fakeMelody(10), 'auto');
  assert.equal(fewAuto.mode, 'grid');
  assert.match(fewAuto.reason, /不足/);

  assert.equal(selectRhythmMode(res, fakeMelody(10), 'notes').mode, 'notes');
  assert.equal(selectRhythmMode(res, fakeMelody(3), 'notes').mode, 'grid');
});

test('真实曲自动判定（加 --real 运行）', () => {
  if (!process.argv.includes('--real')) {
    console.log('      (跳过：npm run verify:note:real 跑真实曲矩阵)');
    return;
  }
  const dir = join(DIR, 'real');
  if (!existsSync(dir)) {
    console.log('      (跳过：fixtures/real 不存在)');
    return;
  }
  const files = readdirSync(dir).filter((f) => /\.(flac|mp3)$/i.test(f));
  assert.ok(files.length > 0, 'fixtures/real 下没有音频');
  for (const f of files) {
    const { pcm, sr } = decodeAudio(join(dir, f));
    const r = analyze(pcm, sr, pcm.length / sr);
    const d = selectRhythmMode(r, fakeMelody(240), 'auto');
    const want = /夜的钢琴曲/.test(f) ? 'notes' : /^0[1-6]\./.test(f) ? 'grid' : null;
    console.log(
      `      ${f}  ${d.mode}  high=${(r.highRatio ?? 0).toFixed(3)} reg=${(r.quality?.regularity ?? 0).toFixed(2)}`,
    );
    if (!want) {
      console.log('      (未知素材，跳过断言)');
      continue;
    }
    assert.equal(d.mode, want, `${f}: ${d.mode} · ${d.reason} · high=${(r.highRatio ?? 0).toFixed(3)}`);
  }
});

test('kickRatio 忽略 synthetic 拍，且空拍返回 1', () => {
  const res = fakeAnalysis(Array(10).fill('snare') as Band[], true);
  assert.equal(kickRatio(res), 0);
  assert.equal(kickRatio(fakeAnalysis([])), 1);
});

test('reason 始终可展示', () => {
  const res = fakeAnalysis(Array(50).fill('snare') as Band[]);
  for (const choice of ['auto', 'notes', 'grid'] as const) {
    const d = selectRhythmMode(res, fakeMelody(50), choice);
    assert.ok(d.reason.length > 0);
  }
});

// ---------- 003 手动音符驱动端到端 ----------

function pct(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

interface OnsetEvent {
  t: number;
  dur: number;
}

/** 把同一时刻的音符合并成一个起音事件（和弦只算一个事件） */
function onsetEvents(notes: TruthNote[]): OnsetEvent[] {
  const sorted = notes.slice().sort((a, b) => a.t - b.t);
  const events: OnsetEvent[] = [];
  for (const n of sorted) {
    const last = events[events.length - 1];
    if (last && Math.abs(n.t - last.t) < 1e-3) {
      last.dur = Math.max(last.dur, n.dur);
    } else {
      events.push({ t: n.t, dur: n.dur });
    }
  }
  return events;
}

function nearest(times: number[], t: number): number {
  let best = Infinity;
  for (const x of times) best = Math.min(best, Math.abs(x - t));
  return best;
}

test('简单段的板时间对齐音符起音：median ≤10ms / p90 ≤30ms / 召回 ≥95%', () => {
  const { truth, res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const boardTimes = chart.boards.filter((b) => !b.ghost && !b.synthetic).map((b) => b.t);
  const events = onsetEvents(truth.allNotes);
  const fast = truth.sections.find((s) => s.name === 'fast-run');
  assert.ok(fast, '缺 fast-run 段落');

  const simple = events.filter((e, i) => {
    if (e.t >= fast.start && e.t < fast.end) return false;
    if (e.dur < 0.08) return false;
    if (i > 0 && e.t - events[i - 1].t < 0.125) return false;
    return true;
  });

  const precisionDists = boardTimes.map((t) => nearest(events.map((e) => e.t), t));
  assert.ok(precisionDists.length > 10);
  assert.ok(
    Math.max(...precisionDists) <= 0.05,
    `板偏离最近起音超过 50ms: max=${(Math.max(...precisionDists) * 1000).toFixed(1)}ms`,
  );
  const med = pct(precisionDists, 0.5);
  const p90 = pct(precisionDists, 0.9);
  assert.ok(med <= 0.01, `median 超差: ${(med * 1000).toFixed(1)}ms`);
  assert.ok(p90 <= 0.03, `p90 超差: ${(p90 * 1000).toFixed(1)}ms`);

  const missed = simple.filter((e) => !boardTimes.some((t) => Math.abs(t - e.t) <= 0.05));
  const recall = 1 - missed.length / Math.max(1, simple.length);
  assert.ok(
    recall >= 0.95,
    `简单段召回不足: ${(recall * 100).toFixed(1)}%（漏 ${missed.length}/${simple.length}）`,
  );
  console.log(
    `      板 ${boardTimes.length}  简单起音 ${simple.length}  误差 median=${(med * 1000).toFixed(1)}ms p90=${(p90 * 1000).toFixed(1)}ms  召回 ${(recall * 100).toFixed(1)}%`,
  );
});

// ---------- 004 密集起音与静音段 ----------

test('密集起音合并后间隔 ≥125ms，且保留强起音', () => {
  const { truth, res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const times = chart.boards.filter((b) => !b.ghost && !b.synthetic).map((b) => b.t);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 0.125 - 1e-6, `板间隔过小: ${(times[i] - times[i - 1]).toFixed(4)}s`);
  }

  const fast = truth.sections.find((s) => s.name === 'fast-run');
  assert.ok(fast);
  const fastBoards = times.filter((t) => t >= fast.start && t < fast.end);
  assert.ok(fastBoards.length > 0);
  assert.ok(fastBoards.length <= 10, `快速跑动板太多: ${fastBoards.length}`);
  for (const t of fastBoards) {
    const near = truth.allNotes
      .filter((n) => Math.abs(n.t - t) <= 0.05)
      .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    assert.ok(near, `快速跑动板 ${t.toFixed(3)} 没有对应起音`);
    assert.ok(near.amp >= 0.8, `快速跑动保留了弱起音 amp=${near.amp} @${t.toFixed(3)}`);
  }
});

test('音符模式下前奏/休止没有非 ghost 板，也没有假玻璃事件', () => {
  const { truth, res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  assert.equal(chart.noteDriven, true);

  const first = truth.allNotes[0].t;
  const before = chart.boards.filter((b) => !b.ghost && b.t < first);
  assert.equal(before.length, 0, `前奏出现了 ${before.length} 块非 ghost 板`);

  const events = notesFromChart(chart, notes);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.t >= first - 1e-9), '玻璃事件落在首个音符之前');

  const long = truth.sections.find((s) => s.name === 'long-rest');
  assert.ok(long);
  const restStart = long.start + 0.05;
  const restEnd = long.start + 5.9; // 长音 4s + 2s 休止，留出边界
  const inRest = chart.boards.filter((b) => !b.ghost && b.t > restStart && b.t < restEnd);
  assert.equal(inRest.length, 0, `休止段出现了 ${inRest.length} 块非 ghost 板`);
});

test('网格模式的预卷行为不变', () => {
  const { res } = fixture();
  const grid = buildChart(res);
  assert.equal(grid.noteDriven, false);
  const preRoll = grid.boards.filter((b) => b.synthetic && b.t < grid.boards.find((x) => !x.synthetic)!.t);
  assert.ok(preRoll.length > 0 && preRoll.every((b) => !b.ghost), '网格预卷应保持可见板');
});

// ---------- 005 力度映射 ----------

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

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

test('力度映射：amplitude 越高，h 与板宽越大', () => {
  const { truth, res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const dyn = truth.sections.find((s) => s.name === 'dynamics');
  assert.ok(dyn);
  const boards = chart.boards.filter(
    (b) => b.t >= dyn.start && b.t < dyn.end && !b.ghost && !b.synthetic,
  );
  assert.ok(boards.length >= 6, `强弱段板太少: ${boards.length}`);

  const amps = boards.map((b) => {
    const near = truth.allNotes
      .filter((n) => Math.abs(n.t - b.t) <= 0.05)
      .sort((a, b2) => Math.abs(a.t - b.t) - Math.abs(b2.t - b.t))[0];
    assert.ok(near, `board ${b.index} 没有对应真值`);
    return near.amp;
  });
  const hs = boards.map((b) => chart.segs[b.index]?.h ?? 0);
  const widths = boards.map((b) => b.halfW);

  assert.ok(spearman(amps, hs) >= 0.7, `amplitude 与 h 的 Spearman=${spearman(amps, hs).toFixed(2)}`);
  assert.ok(
    spearman(amps, widths) >= 0.7,
    `amplitude 与板宽 Spearman=${spearman(amps, widths).toFixed(2)}`,
  );

  const loud = hs.filter((_, i) => amps[i] >= 0.8);
  const soft = hs.filter((_, i) => amps[i] <= 0.3);
  assert.ok(loud.length > 0 && soft.length > 0);
  assert.ok(
    mean(loud) > mean(soft) * 1.2,
    `强弱段高度差不足: loud=${mean(loud).toFixed(1)} soft=${mean(soft).toFixed(1)}`,
  );
  console.log(
    `      强弱段 h loud=${mean(loud).toFixed(1)} soft=${mean(soft).toFixed(1)}  ρ(amp,h)=${spearman(amps, hs).toFixed(2)} ρ(amp,width)=${spearman(amps, widths).toFixed(2)}`,
  );
});

test('和弦规模越大，power 越高（同力度、同时值）', () => {
  const mk = (midis: number[]) =>
    boardsFromNotes(
      midis.map((midi) => ({ start: 1, end: 1.5, midi, amplitude: 0.6 })),
      { minGap: 0.125 },
    );
  const single = mk([60]);
  const chord = mk([60, 64, 67]);
  assert.equal(single.length, 1);
  assert.equal(chord.length, 1);
  assert.ok(chord[0].power > single[0].power, `和弦 power=${chord[0].power} 单音 power=${single[0].power}`);
});

// ---------- 006 音高轮廓横向 ----------

test('音高轮廓：上行向右、下行向左，步长随音程，且不出界', () => {
  const { res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const limit = trackLimit(chart.trackW);
  const real = chart.boards.filter((b) => !b.ghost && !b.synthetic);
  assert.ok(real.length > 20);

  const pairs: Array<{ dp: number; dx: number }> = [];
  for (let i = 1; i < real.length; i++) {
    const a = real[i - 1];
    const b = real[i];
    if (a.midi === undefined || b.midi === undefined) continue;
    if (Math.abs(a.x) > limit * 0.75 || Math.abs(b.x) > limit * 0.75) continue;
    const dp = b.midi - a.midi;
    if (dp === 0 || Math.abs(dp) > 24) continue;
    pairs.push({ dp, dx: b.x - a.x });
  }
  assert.ok(pairs.length >= 10, `可比板对太少: ${pairs.length}`);

  const signOk = pairs.filter((p) => Math.sign(p.dp) === Math.sign(p.dx)).length / pairs.length;
  assert.ok(signOk >= 0.9, `方向一致率 ${(signOk * 100).toFixed(1)}%`);
  const rho = spearman(
    pairs.map((p) => Math.abs(p.dp)),
    pairs.map((p) => Math.abs(p.dx)),
  );
  assert.ok(rho >= 0.7, `|Δpitch| 与 |Δx| 的 Spearman=${rho.toFixed(2)}`);

  for (const b of chart.boards) assert.ok(Math.abs(b.x) <= limit + 1e-6, `board ${b.index} 出界 x=${b.x}`);
  assert.ok(Math.abs(real[0].x) < 1e-6, `首个音符板应从中心开始，x=${real[0].x}`);
  console.log(`      方向一致 ${(signOk * 100).toFixed(1)}%  ρ(|Δpitch|,|Δx|)=${rho.toFixed(2)}  可比对 ${pairs.length}`);
});

test('音高不变时横向基本静止（中心区域）', () => {
  const { res } = fixture();
  const flat = Array.from({ length: 8 }, (_, i) => ({
    start: 1 + i * 1.0,
    end: 1.4 + i * 1.0,
    midi: 60,
    amplitude: 0.6,
  }));
  const chart = buildChart(res, { noteSource: flat });
  const real = chart.boards.filter((b) => !b.ghost && !b.synthetic);
  assert.ok(real.length >= 6);
  for (const b of real) assert.ok(Math.abs(b.x) < 1e-6, `重复音高横向移动了: ${b.x}`);
});

test('音符轮廓同 seed 可复现', () => {
  const { res, notes } = fixture();
  const a = buildChart(res, { noteSource: notes, seed: 7 });
  const b = buildChart(res, { noteSource: notes, seed: 7 });
  const ax = a.boards.filter((x) => !x.ghost && !x.synthetic).map((x) => [x.t, x.x]);
  const bx = b.boards.filter((x) => !x.ghost && !x.synthetic).map((x) => [x.t, x.x]);
  assert.deepEqual(ax, bx);
});

// ---------- 008 模型音符起音精修 ----------

test('模型音符吸附到音频 onset，无对应起音的谐波被丢弃', () => {
  const notes: MelodyNote[] = [
    { start: 1.07, end: 1.5, midi: 60, amplitude: 0.6 },
    { start: 2.2, end: 2.5, midi: 72, amplitude: 0.3 },
    { start: 3.01, end: 3.4, midi: 64, amplitude: 0.5 },
  ];
  const out = snapNotesToOnsets(notes, [{ t: 1.0 }, { t: 3.0 }], 0.16);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, 1.0);
  assert.ok(Math.abs(out[0].end - 1.43) < 1e-9);
  assert.equal(out[1].start, 3.0);
  assert.ok(Math.abs(out[1].end - 3.39) < 1e-9);

  assert.equal(snapNotesToOnsets(notes, [], 0.16), notes);
});

test('主导音高取和弦最高音并折回 C4–C6', () => {
  const high = boardsFromNotes(
    [
      { start: 1, end: 1.5, midi: 67, amplitude: 0.7 },
      { start: 1, end: 1.5, midi: 95, amplitude: 0.3 },
    ],
    { minGap: 0.125 },
  );
  assert.equal(high.length, 1);
  assert.equal(high[0].midi, 83); // 95 折回 83

  const bass = boardsFromNotes([{ start: 1, end: 1.5, midi: 36, amplitude: 0.8 }], { minGap: 0.125 });
  assert.equal(bass[0].midi, 60); // 36 折回 60

  const tie = boardsFromNotes(
    [
      { start: 1, end: 1.5, midi: 60, amplitude: 0.6 },
      { start: 1, end: 1.5, midi: 67, amplitude: 0.6 },
    ],
    { minGap: 0.125 },
  );
  assert.equal(tie[0].midi, 67);
});

test('音符驱动的玻璃音高使用板的主导音高', () => {
  const { res, notes } = fixture();
  const chart = buildChart(res, { noteSource: notes });
  const real = chart.boards.filter((b) => !b.ghost && !b.synthetic);
  const events = notesFromChart(chart, notes);
  assert.equal(events.length, real.length);
  for (let i = 0; i < real.length; i++) {
    assert.equal(events[i].t, real[i].t, `玻璃事件 ${i} 时刻不匹配`);
    assert.equal(events[i].midi, real[i].midi ?? null, `玻璃事件 ${i} 音高不匹配`);
  }
});

test('折回后的旋律音高对大跳变做压缩', () => {
  const { res } = fixture();
  const pitches = [60, 62, 64, 95, 66, 68, 70, 72];
  const notes = pitches.map((midi, i) => ({
    start: 1 + i * 0.5,
    end: 1.4 + i * 0.5,
    midi,
    amplitude: 0.6,
  }));
  const chart = buildChart(res, { noteSource: notes });
  const boards = chart.boards.filter((b) => !b.ghost && !b.synthetic);
  assert.ok(boards.length >= 6);
  const spike = boards.find((b) => b.midi === 83);
  assert.ok(spike, '尖峰板应折回 83');
  const idx = boards.indexOf(spike);
  assert.ok(idx > 0 && idx + 1 < boards.length);
  // 83 相对 64 是 19 半音；tanh 压缩后不应把球一步甩到墙上
  assert.ok(
    Math.abs(spike.x - boards[idx - 1].x) < 260,
    `尖峰横向步长过大: ${(spike.x - boards[idx - 1].x).toFixed(1)}`,
  );
});

test('音符源不足 4 块时回退网格，不启用音符渲染', () => {
  const { res } = fixture();
  const chart = buildChart(res, {
    noteSource: [{ start: 1, end: 1.5, midi: 60, amplitude: 0.6 }],
    stride: 2,
  });
  assert.equal(chart.noteDriven, false);
  assert.ok(chart.boards.some((b) => b.synthetic && !b.ghost), '网格预卷应保持可见');
});

test('同输入同 seed 的 Chart 完全相等', () => {
  const { res, notes } = fixture();
  const a = buildChart(res, { noteSource: notes, seed: 7 });
  const b = buildChart(res, { noteSource: notes, seed: 7 });
  assert.deepEqual(a, b);
});

// ---------- runner ----------

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
