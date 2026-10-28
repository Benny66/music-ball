/**
 * 玻璃珠编排纯函数回归。
 *
 *   npm run verify:bead
 *
 * 真实片段缓存（out/bead/notes.json）存在时额外跑一组真实输入检查；
 * 缓存不存在时只跑合成输入，保证 CI/干净工作区也能验证接缝。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MelodyNote, MelodyResult } from '../src/analysis/melody.ts';
import { boardsFromNotes } from '../src/chart/notes.ts';
import { BALL_R } from '../src/chart/styles.ts';
import {
  buildBeadChoreography,
  evalBead,
  evalBeadCamera,
  evalBeadRoll,
  evalBoardEntry,
  impactsFromNotes,
  type BeadImpact,
  type BeadPath,
} from '../src/chart/bead.ts';

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function regularImpacts(
  count: number,
  opts: { dt?: number; start?: number; power?: (i: number) => number; midi?: (i: number) => number; dur?: (i: number) => number } = {},
): BeadImpact[] {
  const dt = opts.dt ?? 0.5;
  const start = opts.start ?? 0.4;
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * dt,
    power: opts.power?.(i) ?? 0.5,
    midi: opts.midi?.(i) ?? 67,
    dur: opts.dur?.(i) ?? 0.5,
    side: (i % 2 === 0 ? -1 : 1) as -1 | 1,
    band: 'snare' as const,
  }));
}

function first(p: BeadPath) {
  return p.impacts[0];
}

test('impactsFromNotes：沿用 boardsFromNotes 的时间/力度/音高，并补时值与左右交替', () => {
  const notes: MelodyNote[] = [
    { start: 0.4, end: 0.9, midi: 64, amplitude: 0.9 },
    { start: 0.4, end: 0.7, midi: 71, amplitude: 0.8 },
    { start: 0.9, end: 1.2, midi: 60, amplitude: 0.4 },
    { start: 1.4, end: 1.8, midi: 76, amplitude: 0.7 },
  ];
  const beats = boardsFromNotes(notes, { minGap: 0.7 });
  const impacts = impactsFromNotes(notes, { minGap: 0.7 });
  assert.equal(impacts.length, beats.length);
  for (let i = 0; i < beats.length; i++) {
    assert.ok(close(impacts[i].t, beats[i].t));
    assert.ok(close(impacts[i].power, beats[i].power));
    assert.equal(impacts[i].midi, beats[i].midi);
    assert.equal(impacts[i].side, i % 2 === 0 ? -1 : 1);
  }
  assert.ok(impacts[0].dur >= 0.49, `和弦最大时值 ${impacts[0].dur}`);
});

test('impact 时间严格等于输入，100 个撞击无累积漂移', () => {
  const impacts = regularImpacts(100, { dt: 0.47, start: 0.37 });
  const path = buildBeadChoreography(impacts, { duration: 60 });
  assert.equal(path.impacts.length, 100);
  for (let i = 0; i < impacts.length; i++) {
    assert.ok(close(path.impacts[i].t, impacts[i].t));
    assert.equal(path.impacts[i].side, i % 2 === 0 ? -1 : 1);
  }
});

test('滚动段：外侧高点 → 内侧低点，方向朝中心', () => {
  const path = buildBeadChoreography(regularImpacts(6));
  for (let i = 0; i < path.impacts.length; i++) {
    const b = path.boards[i];
    const s = path.slides[i];
    assert.ok(close(s.t0, b.t));
    assert.ok(close(s.x0, b.outerX));
    assert.ok(close(s.y0, b.impactY));
    assert.ok(close(s.x1, b.innerX));
    assert.ok(close(s.y1, b.innerY));
    assert.ok(b.innerY > b.impactY);
    if (b.side === -1) assert.ok(b.innerX > b.outerX);
    else assert.ok(b.innerX < b.outerX);
  }
});

test('滚动段时长 0.45–0.75s，随力度/时值单调，掉落段至少 0.45s', () => {
  const powers = [0.1, 0.35, 0.6, 0.85, 1.0];
  const byPower = buildBeadChoreography(
    regularImpacts(6, { dt: 1.3, power: (i) => powers[i] ?? 0.5 }),
  );
  for (let i = 0; i < 5; i++) {
    const st = byPower.slides[i].t1 - byPower.slides[i].t0;
    const fallT = byPower.falls[i].t1 - byPower.falls[i].t0;
    assert.ok(st >= 0.45 - 1e-9, `st=${st}`);
    assert.ok(st <= 0.75 + 1e-9, `st=${st}`);
    assert.ok(fallT >= 0.45 - 1e-9, `fall=${fallT}`);
    const prev = i === 0 ? 0 : byPower.slides[i - 1].t1 - byPower.slides[i - 1].t0;
    assert.ok(st >= prev - 1e-9, `power 单调: ${prev} -> ${st}`);
  }

  const durs = [0.08, 0.3, 0.6, 1.0, 1.5];
  const byDur = buildBeadChoreography(
    regularImpacts(6, { dt: 1.3, dur: (i) => durs[i] ?? 0.5 }),
  );
  for (let i = 1; i < 5; i++) {
    const prev = byDur.slides[i - 1].t1 - byDur.slides[i - 1].t0;
    const cur = byDur.slides[i].t1 - byDur.slides[i].t0;
    assert.ok(cur >= prev - 1e-9, `dur 单调: ${prev} -> ${cur}`);
  }
});

test('滚动：接触段转角 = 板面弧长/球半径，空中保持角速度且边界连续', () => {
  const path = buildBeadChoreography(regularImpacts(5, { dt: 1.2 }));
  for (let i = 0; i < path.boards.length; i++) {
    const b = path.boards[i];
    const s = path.slides[i];
    const f = path.falls[i];
    const arc = Math.hypot(b.innerX - b.outerX, b.innerY - b.impactY);
    const expected = (-b.side * arc) / BALL_R;
    const r0 = evalBeadRoll(path, s.t0);
    const r1 = evalBeadRoll(path, s.t1);
    assert.ok(close(r1 - r0, expected, 1e-6), `roll ${i}: ${r1 - r0} vs ${expected}`);
    if (f) {
      const atFall = evalBeadRoll(path, f.t0 + 0.001);
      const expectFall = f.roll0 + f.rollOmega * 0.001;
      assert.ok(close(atFall, expectFall, 1e-9), `fall roll ${i}`);
    }
  }
});

test('掉落段：滚动终点 → 下一块板外侧高点，终点严格对齐下一个 impact', () => {
  const path = buildBeadChoreography(regularImpacts(8));
  for (let i = 0; i < path.falls.length; i++) {
    const f = path.falls[i];
    const next = path.boards[i + 1];
    assert.ok(close(f.t0, path.slides[i].t1));
    assert.ok(close(f.t1, path.impacts[i + 1].t));
    assert.ok(close(f.x0, path.slides[i].x1));
    assert.ok(close(f.y0, path.slides[i].y1));
    assert.ok(close(f.x1, next.outerX));
    assert.ok(close(f.y1, next.impactY));
    assert.ok(f.t1 > f.t0);
  }
});

test('滚动/掉落段内坐标有限且 y 单调不减，无穿板', () => {
  const path = buildBeadChoreography(regularImpacts(12, { dt: 0.55 }));
  for (let i = 0; i < path.impacts.length; i++) {
    const s = path.slides[i];
    let prevY = -Infinity;
    for (let k = 0; k <= 40; k++) {
      const t = s.t0 + ((s.t1 - s.t0) * k) / 40;
      const st = evalBead(path, t);
      assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `slide ${i} k=${k}`);
      assert.ok(st.y >= prevY - 1e-9, `slide y 回退 ${i} k=${k}`);
      prevY = st.y;
    }
    const f = path.falls[i];
    if (!f) continue;
    prevY = -Infinity;
    for (let k = 0; k <= 60; k++) {
      const t = f.t0 + ((f.t1 - f.t0) * k) / 60;
      const st = evalBead(path, t);
      assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `fall ${i} k=${k}`);
      assert.ok(st.y >= prevY - 1e-9, `fall y 回退 ${i} k=${k}`);
      prevY = st.y;
    }
  }
});

test('相机：撞击帧等于球 y（58%），滚动段保持，单调且无位置突跳', () => {
  const path = buildBeadChoreography(regularImpacts(10));
  for (const b of path.boards) {
    assert.ok(close(evalBeadCamera(path, b.t), b.impactY), `impact ${b.t}`);
  }
  for (let i = 0; i < path.slides.length; i++) {
    const s = path.slides[i];
    const mid = (s.t0 + s.t1) / 2;
    assert.ok(close(evalBeadCamera(path, mid), path.boards[i].impactY), `slide hold ${i}`);
  }
  let prev = evalBeadCamera(path, 0);
  let maxStep = 0;
  for (let t = 0; t <= path.duration; t += 0.001) {
    const cur = evalBeadCamera(path, t);
    assert.ok(cur >= prev - 1e-6, `camera 回退 t=${t}`);
    maxStep = Math.max(maxStep, Math.abs(cur - prev));
    prev = cur;
  }
  assert.ok(maxStep < 20, `1ms 相机最大跳变 ${maxStep}`);
});

test('板入场：撞击前到位，从对应侧滑入，且不早于上一撞击', () => {
  const path = buildBeadChoreography(regularImpacts(10));
  for (let i = 0; i < path.boards.length; i++) {
    const b = path.boards[i];
    assert.ok(b.entryEnd < b.t - 1e-9, `board ${i} entryEnd`);
    assert.ok(b.entryStart < b.entryEnd, `board ${i} entryStart`);
    assert.ok(close(evalBoardEntry(b, b.entryEnd), 0));
    assert.ok(Math.sign(evalBoardEntry(b, b.entryStart)) === b.side, `board ${i} 侧别`);
    assert.ok(evalBoardEntry(b, b.t) === 0);
    if (i > 0) {
      assert.ok(b.entryStart >= path.impacts[i - 1].t - 1e-9, `board ${i} 入场过早`);
      assert.ok(b.entryStart >= path.slides[i - 1].t1 - 1e-9, `board ${i} 入场早于上一段滚动结束`);
    }
  }
});

test('音高：改变宽/厚/颜色与落距，不改变侧别和撞击时刻', () => {
  const low = buildBeadChoreography(regularImpacts(3, { midi: () => 60 }));
  const high = buildBeadChoreography(regularImpacts(3, { midi: () => 84 }));
  const lb = low.boards[1];
  const hb = high.boards[1];
  assert.equal(lb.side, hb.side);
  assert.ok(close(lb.t, hb.t));
  assert.ok(hb.halfW > lb.halfW, `halfW ${lb.halfW} -> ${hb.halfW}`);
  assert.ok(hb.thick > lb.thick, `thick ${lb.thick} -> ${hb.thick}`);
  assert.notEqual(hb.band, lb.band);
  const lf = low.falls[0];
  const hf = high.falls[0];
  assert.ok(hf.y1 - hf.y0 < lf.y1 - lf.y0, `落距 ${lf.y1 - lf.y0} -> ${hf.y1 - hf.y0}`);
});

test('开场：t=0 在首个撞击上方，首个撞击帧回到球心', () => {
  const path = buildBeadChoreography(regularImpacts(5, { start: 0.4 }));
  const start = evalBead(path, 0);
  const hit = evalBead(path, first(path).t);
  assert.ok(Number.isFinite(start.x) && Number.isFinite(start.y));
  assert.ok(start.y < hit.y);
  assert.ok(close(hit.y, path.boards[0].impactY));
  assert.ok(close(hit.x, path.boards[0].outerX));
});

test('掉落中段球在 58% 上方，撞击帧回到 58%', () => {
  const path = buildBeadChoreography(regularImpacts(8, { dt: 1.3 }));
  for (const f of path.falls) {
    for (const u of [0.5, 0.7, 0.85]) {
      const t = f.t0 + (f.t1 - f.t0) * u;
      const ball = evalBead(path, t).y;
      const cam = evalBeadCamera(path, t);
      assert.ok(ball < cam - 0.5, `fall ${f.t0} u=${u} 球未在 58% 上方`);
    }
    assert.ok(close(evalBead(path, f.t1).y, evalBeadCamera(path, f.t1)));
  }
});

test('整段采样无 NaN/Infinity', () => {
  const path = buildBeadChoreography(regularImpacts(20, { dt: 0.8 }), { duration: 20 });
  for (let t = 0; t <= path.duration; t += 1 / 60) {
    const st = evalBead(path, t);
    assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `t=${t}`);
    assert.ok(Number.isFinite(evalBeadCamera(path, t)), `cam t=${t}`);
    assert.ok(Number.isFinite(evalBeadRoll(path, t)), `roll t=${t}`);
  }
});

test('撞击时间重复/倒序直接报错，不静默丢板', () => {
  const base = regularImpacts(2);
  assert.throws(() => buildBeadChoreography([...base, { ...base[1] }]));
});

test('撞击间隔小于最短掉落时直接报错', () => {
  assert.throws(() =>
    buildBeadChoreography([
      { ...regularImpacts(1)[0], t: 0.4 },
      { ...regularImpacts(1)[0], t: 0.45 },
    ]),
  );
});

test('同输入/同参数构建结果完全一致', () => {
  const a = buildBeadChoreography(regularImpacts(12), { duration: 12 });
  const b = buildBeadChoreography(regularImpacts(12), { duration: 12 });
  assert.deepEqual(a, b);
});

test('真实缓存：撞击密度、左右交替与 18s 时长', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'bead', 'notes.json');
  if (!existsSync(path)) {
    console.log('  (skip) 没有 out/bead/notes.json，先运行 bead:fixture');
    return;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MelodyResult;
  assert.equal(parsed.source, 'basic-pitch');
  const impacts = impactsFromNotes(parsed.notes, { minGap: 0.7 });
  assert.ok(impacts.length >= 14 && impacts.length <= 40, `撞击数 ${impacts.length}`);
  const gaps = impacts.slice(1).map((x, i) => x.t - impacts[i].t);
  const med = median(gaps);
  assert.ok(med >= 0.5 && med <= 1.4, `中位 ${med}`);
  assert.ok(Math.max(...gaps) <= 2.0, `最大 ${Math.max(...gaps)}`);
  for (let i = 0; i < impacts.length; i++) {
    assert.equal(impacts[i].side, i % 2 === 0 ? -1 : 1);
  }
  const choreo = buildBeadChoreography(impacts, { duration: 18 });
  assert.equal(choreo.boards.length, impacts.length);
  assert.equal(choreo.falls.length, impacts.length - 1);
  assert.ok(choreo.duration >= 17.9);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(failed === 0 ? `\n✓ 全部通过 (${tests.length}/${tests.length})` : `\n✗ ${failed}/${tests.length} 失败`);
process.exit(failed === 0 ? 0 : 1);
