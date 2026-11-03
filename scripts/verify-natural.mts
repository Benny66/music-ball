/**
 * 自然滚动玻璃珠路径回归（纯逻辑，不依赖 DOM）。
 *
 *   npm run verify:natural
 */
import assert from 'node:assert/strict';

import { buildNaturalPath } from '../src/chart/natural.ts';
import type { Beat } from '../src/types.ts';

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

function impacts(count: number, gap = 0.75, start = 0.5): Beat[] {
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * gap,
    power: 0.4 + 0.5 * ((i * 3) % 7) / 6,
    band: (i % 3 === 0 ? 'kick' : i % 3 === 1 ? 'snare' : 'hat') as Beat['band'],
    synthetic: false,
    midi: 60 + ((i * 5) % 17),
  }));
}

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('轨迹覆盖整曲：首尾帧都有有限球位，撞击时刻回到对应板高边', () => {
  const list = impacts(24);
  const duration = list[list.length - 1].t + 0.8;
  const path = buildNaturalPath(list, { duration, trackW: 900, viewH: 1600 });
  assert.equal(path.boards.length, list.length);
  assert.equal(path.duration, duration);

  for (const t of [0, 0.1, duration - 0.01, duration]) {
    const s = path.ballAt(t);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.roll));
  }
  for (let i = 0; i < list.length; i++) {
    const s = path.ballAt(list[i].t);
    const b = path.boards[i];
    assert.ok(close(s.x, b.x, 1e-6), `撞击 ${i} x=${s.x} vs ${b.x}`);
    assert.ok(close(s.y, b.y, 1e-6), `撞击 ${i} y=${s.y} vs ${b.y}`);
  }
});

test('球位随时间连续：60fps 相邻帧无突跳', () => {
  const list = impacts(18);
  const duration = list[list.length - 1].t + 0.7;
  const path = buildNaturalPath(list, { duration });
  let prev = path.ballAt(0);
  let maxDx = 0;
  let maxDy = 0;
  for (let f = 1; f <= Math.round(duration * 60); f++) {
    const s = path.ballAt(f / 60);
    maxDx = Math.max(maxDx, Math.abs(s.x - prev.x));
    maxDy = Math.max(maxDy, Math.abs(s.y - prev.y));
    prev = s;
  }
  assert.ok(maxDx < 400, `单帧横向突跳 ${maxDx.toFixed(1)}`);
  assert.ok(maxDy < 400, `单帧纵向突跳 ${maxDy.toFixed(1)}`);
});

test('镜头低通跟随：撞击帧球在画面 40–65% 舒适区附近', () => {
  const list = impacts(20);
  const duration = list[list.length - 1].t + 0.6;
  const path = buildNaturalPath(list, { duration, viewH: 1600 });
  const cy = 1600 * 0.54;
  const samples: number[] = [];
  for (let t = list[0].t; t <= duration; t += 0.1) {
    const s = path.ballAt(t);
    const screenY = cy + (s.y - path.camAt(t));
    samples.push(screenY / 1600);
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(min > 0.28, `球跑出舒适区上部 ${min.toFixed(2)}`);
  assert.ok(max < 0.78, `球跑出舒适区下部 ${max.toFixed(2)}`);
});

test('开场镜头钉在首板：长前奏不会把板子推出画面', () => {
  const list = impacts(12);
  const path = buildNaturalPath(list, { duration: 12 });
  const firstY = path.boards[0].y;
  assert.equal(path.camAt(0), firstY);
  assert.ok(Math.abs(path.camAt(list[0].t - 0.05) - firstY) < 1e-9);
  const ballAtZero = path.ballAt(0);
  assert.ok(ballAtZero.y < firstY - 100, '球应从首板上方入场');
});

test('音高轮廓：上行向右、下行向左，大跳不会飞出赛道', () => {
  const up = Array.from({ length: 12 }, (_, i) => ({
    t: 0.5 + i * 0.7,
    power: 0.6,
    band: 'snare' as const,
    synthetic: false,
    midi: 60 + i * 2,
  }));
  const down = up.map((b, i) => ({ ...b, midi: 84 - i * 2 }));
  const jumpy = up.map((b, i) => ({ ...b, midi: i % 2 === 0 ? 48 : 84 }));
  const upPath = buildNaturalPath(up, { duration: 9 });
  const downPath = buildNaturalPath(down, { duration: 9 });
  const jumpPath = buildNaturalPath(jumpy, { duration: 9 });
  assert.ok(upPath.boards[upPath.boards.length - 1].x > upPath.boards[0].x, '上行应向右');
  assert.ok(downPath.boards[downPath.boards.length - 1].x < downPath.boards[0].x, '下行应向左');
  for (const b of jumpPath.boards) {
    assert.ok(Math.abs(b.x) <= jumpPath.trackW / 2 - 80, `大跳出界 ${b.x}`);
  }
});

test('同输入同参数完全可复现', () => {
  const list = impacts(16);
  const a = buildNaturalPath(list, { duration: 14, trackW: 900, viewH: 1600 });
  const b = buildNaturalPath(list, { duration: 14, trackW: 900, viewH: 1600 });
  assert.deepEqual(a.boards, b.boards);
  assert.deepEqual(a.impacts, b.impacts);
  for (let t = 0; t <= 14; t += 0.37) {
    const sa = a.ballAt(t);
    const sb = b.ballAt(t);
    assert.ok(close(sa.x, sb.x) && close(sa.y, sb.y) && close(sa.roll, sb.roll));
    assert.equal(a.camAt(t), b.camAt(t));
  }
});

test('撞击重复/间隔过短直接报错，不静默丢板', () => {
  assert.throws(() => buildNaturalPath([], { duration: 5 }), /撞击不足/);
  const dup: Beat[] = [
    { t: 1, power: 0.5, band: 'kick', synthetic: false },
    { t: 1, power: 0.5, band: 'snare', synthetic: false },
  ];
  assert.throws(() => buildNaturalPath(dup, { duration: 5 }), /间隔过短/);
  const tooFast: Beat[] = [
    { t: 1, power: 0.5, band: 'kick', synthetic: false },
    { t: 1.05, power: 0.5, band: 'snare', synthetic: false },
  ];
  assert.throws(() => buildNaturalPath(tooFast, { duration: 5 }), /间隔过短/);
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
